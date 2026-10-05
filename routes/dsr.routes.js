// DPDP data-subject-request intake + fulfillment. Staff-mediated only: staff log
// a request made in person/by phone/WhatsApp; there is no public self-service form.
//
//   POST   /api/dsr                        — intake a new request
//   GET    /api/dsr                        — list/filter by status — the queue a
//                                             designated handler works from
//   GET    /api/dsr/:id                    — one request's detail
//   PATCH  /api/dsr/:id                    — update status/resolution_note
//   POST   /api/dsr/:id/fulfill/access     — mark fulfilled, return the export.pdf URL
//   POST   /api/dsr/:id/fulfill/correction — apply correction_detail, mark fulfilled
//   POST   /api/dsr/:id/fulfill/erasure    — anonymize (default) or hard-delete, mark fulfilled
//
// Every fulfillment write carries request_id = this DSR's id (audit_log column from
// 061), so one id reconstructs the request's full trail.
// dsr_sla_days (organizations.metadata.dpdp) is a board decision, unset by default;
// the queue runs off admin/superadmin until a Grievance Officer role exists.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { resolveBeneficiarySpec, BENEFICIARY_UID_PREFIX_HINT } from '../lib/beneficiaryLookup.js'
import { writeAudit } from '../lib/auditMiddleware.js'
import { anonymizeBeneficiary } from './beneficiary-erasure.routes.js'
import { encryptMappedFields } from '../lib/piiCrypto.js'

const router = Router()

const REQUEST_TYPES = ['access', 'correction', 'erasure', 'portability']
const STATUSES = ['received', 'in_progress', 'fulfilled', 'rejected', 'withdrawn']

// Safe partial update, same protected-columns pattern as PUT /beneficiary-profile/:uid.
const PROTECTED_COLUMNS = new Set(['id', 'uid', 'org_id', 'created_at', 'anonymized_at', 'deleted_at'])

// POST /api/dsr — intake
router.post('/dsr', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { beneficiaryUid, requestType, requestedBy, intakeChannel, correctionDetail } = req.body || {}
    const spec = resolveBeneficiarySpec(beneficiaryUid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })
    if (!REQUEST_TYPES.includes(requestType)) {
      return res.status(400).json({ error: `requestType must be one of: ${REQUEST_TYPES.join(', ')}` })
    }

    const pool = getPool()
    const { rows: orgRows } = await pool.query(
      `SELECT (metadata->'dpdp'->>'dsr_sla_days')::int AS sla_days FROM organizations WHERE id = $1`,
      [req.user.orgId]
    )
    const slaDays = orgRows[0]?.sla_days || null
    const dueAt = slaDays ? new Date(Date.now() + slaDays * 86400000) : null

    const { rows } = await pool.query(
      `INSERT INTO dsr_requests
         (org_id, beneficiary_uid, beneficiary_type, request_type, requested_by, intake_channel, correction_detail, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.user.orgId, spec.normalizedUid, spec.type, requestType,
        requestedBy || null, intakeChannel || null,
        correctionDetail ? JSON.stringify(correctionDetail) : null, dueAt,
      ]
    )
    writeAudit({
      orgId: req.user.orgId, actorUid: req.user.uid, action: 'dsr.create',
      targetType: 'dsr_request', targetId: rows[0].id, diff: { requestType, beneficiaryUid: spec.normalizedUid },
      requestId: rows[0].id,
    })
    res.json({ ...rows[0], slaConfigured: !!slaDays })
  } catch (e) {
    console.error('[dsr POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/dsr?status=&beneficiaryUid= — the DSR queue
router.get('/dsr', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const where  = ['org_id = $1']
    const values = [req.user.orgId]
    if (req.query.status && STATUSES.includes(req.query.status)) {
      values.push(req.query.status)
      where.push(`status = $${values.length}`)
    }
    if (req.query.beneficiaryUid) {
      values.push(String(req.query.beneficiaryUid).trim().toUpperCase())
      where.push(`beneficiary_uid = $${values.length}`)
    }
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT * FROM dsr_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      values
    )
    res.json({ rows })
  } catch (e) {
    console.error('[dsr GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/dsr/:id
router.get('/dsr/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(`SELECT * FROM dsr_requests WHERE id = $1 AND org_id = $2`, [req.params.id, req.user.orgId])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error('[dsr detail GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

async function loadDsr(pool, orgId, id) {
  const { rows } = await pool.query(`SELECT * FROM dsr_requests WHERE id = $1 AND org_id = $2`, [id, orgId])
  return rows[0] || null
}

async function markFulfilled(pool, dsr, req, extraDiff) {
  await pool.query(
    `UPDATE dsr_requests SET status = 'fulfilled', fulfilled_at = now(), handled_by_uid = $1, handled_by_name = $2, updated_at = now() WHERE id = $3`,
    [req.user.uid, req.user.name || '', dsr.id]
  )
  writeAudit({
    orgId: req.user.orgId, actorUid: req.user.uid, action: 'dsr.fulfill',
    targetType: 'dsr_request', targetId: dsr.id, diff: extraDiff || null, requestId: dsr.id,
  })
}

// PATCH /api/dsr/:id — status/resolution_note updates that aren't a fulfillment
router.patch('/dsr/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const dsr = await loadDsr(pool, req.user.orgId, req.params.id)
    if (!dsr) return res.status(404).json({ error: 'Not found' })

    const { status, resolutionNote } = req.body || {}
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` })
    }
    // 'fulfilled' only via the admin-only /fulfill/* routes that actually do the work;
    // otherwise an erasure could be closed with the PII still in place (and retention
    // would later purge the evidence).
    if (status === 'fulfilled') {
      return res.status(400).json({ error: 'Use the fulfil action to complete a request — it cannot be marked fulfilled directly.' })
    }
    const { rows } = await pool.query(
      `UPDATE dsr_requests SET status = COALESCE($1, status), resolution_note = COALESCE($2, resolution_note),
              handled_by_uid = $3, handled_by_name = $4, updated_at = now()
       WHERE id = $5 AND org_id = $6 RETURNING *`,
      [status || null, resolutionNote || null, req.user.uid, req.user.name || '', dsr.id, req.user.orgId]
    )
    writeAudit({
      orgId: req.user.orgId, actorUid: req.user.uid, action: 'dsr.update',
      targetType: 'dsr_request', targetId: dsr.id, diff: { status, resolutionNote }, requestId: dsr.id,
    })
    res.json(rows[0])
  } catch (e) {
    console.error('[dsr PATCH]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/dsr/:id/fulfill/access
// Marks the request fulfilled and returns the export.pdf URL (generated by
// beneficiary-profile's loadFullProfile), tagged with this request id for the audit trail.
router.post('/dsr/:id([0-9a-fA-F-]{36})/fulfill/access', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const dsr = await loadDsr(pool, req.user.orgId, req.params.id)
    if (!dsr) return res.status(404).json({ error: 'Not found' })
    if (dsr.request_type !== 'access') return res.status(400).json({ error: `This request is type '${dsr.request_type}', not 'access'` })

    await markFulfilled(pool, dsr, req, { fulfillmentType: 'access' })
    res.json({
      ok: true,
      exportUrl: `/api/beneficiary-profile/${encodeURIComponent(dsr.beneficiary_uid)}/export.pdf?purpose=dsr_fulfillment&dsrRequestId=${dsr.id}`,
    })
  } catch (e) {
    console.error('[dsr fulfill access]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/dsr/:id/fulfill/correction
// Applies the request's stored correction_detail JSONB directly.
router.post('/dsr/:id([0-9a-fA-F-]{36})/fulfill/correction', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool = getPool()
    const dsr = await loadDsr(pool, req.user.orgId, req.params.id)
    if (!dsr) return res.status(404).json({ error: 'Not found' })
    if (dsr.request_type !== 'correction') return res.status(400).json({ error: `This request is type '${dsr.request_type}', not 'correction'` })

    const rawUpdates = dsr.correction_detail
    if (!rawUpdates || typeof rawUpdates !== 'object') {
      return res.status(400).json({ error: 'This request has no correction_detail to apply' })
    }
    const spec = resolveBeneficiarySpec(dsr.beneficiary_uid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })

    const { rows: existingRows } = await pool.query(`SELECT * FROM ${spec.table} WHERE org_id = $1 AND uid = $2`, [req.user.orgId, spec.normalizedUid])
    const existing = existingRows[0]
    if (!existing) return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })

    // Same field encryption as beneficiary-profile.routes.js's PUT.
    const preFilterEntries = Object.entries(rawUpdates).filter(
      ([key]) => Object.prototype.hasOwnProperty.call(existing, key) && !PROTECTED_COLUMNS.has(key)
    )
    if (!preFilterEntries.length) return res.status(400).json({ error: 'correction_detail has no editable/matching fields' })
    const updates = encryptMappedFields(spec.table, Object.fromEntries(preFilterEntries))

    const setEntries = Object.entries(updates)
    const setClause = setEntries.map(([key], i) => `"${key}" = $${i + 3}`).join(', ')
    const values = setEntries.map(([, value]) => value)
    await pool.query(`UPDATE ${spec.table} SET ${setClause} WHERE org_id = $1 AND uid = $2`, [req.user.orgId, spec.normalizedUid, ...values])

    // Report requested field names, not the _enc/_hash columns they map to.
    const correctedFields = preFilterEntries.map(([k]) => k)
    await markFulfilled(pool, dsr, req, { fulfillmentType: 'correction', fields: correctedFields })
    res.json({ ok: true, uid: spec.normalizedUid, correctedFields })
  } catch (e) {
    console.error('[dsr fulfill correction]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/dsr/:id/fulfill/erasure
// Always anonymizes. Hard-delete goes through /api/beneficiary-erasure/:uid/hard-delete,
// which has its own reference check and explicit confirmation.
router.post('/dsr/:id([0-9a-fA-F-]{36})/fulfill/erasure', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool = getPool()
    const dsr = await loadDsr(pool, req.user.orgId, req.params.id)
    if (!dsr) return res.status(404).json({ error: 'Not found' })
    if (dsr.request_type !== 'erasure') return res.status(400).json({ error: `This request is type '${dsr.request_type}', not 'erasure'` })

    const result = await anonymizeBeneficiary(req.user.orgId, dsr.beneficiary_uid)
    if (!result.ok) return res.status(result.status).json({ error: result.reason })

    await markFulfilled(pool, dsr, req, { fulfillmentType: 'erasure', columns: result.columns })
    res.json({ ok: true, uid: result.spec.normalizedUid, anonymizedColumns: result.columns })
  } catch (e) {
    console.error('[dsr fulfill erasure]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
