// Monthly plan and actual entry (spec §8) + workflow. One row per (indicator, FY,
// month, scope[, scope_value]) holding that month's increment (029); lib/misCalculations.js
// derives cumulative/achievement figures. Autosave only touches 'draft' rows; later
// states are locked until an admin reopens them.
//
//   GET    /api/projects/:projectKey/mis-entries                     — grid rows + computed metrics
//   PUT    /api/projects/:projectKey/mis-entries                     — bulk upsert (draft rows only)
//   POST   /api/projects/:projectKey/mis-entries/submit|verify|approve|reject|reopen
//   POST   /api/projects/:projectKey/mis-entries/:id/evidence         — upload (base64)
//   GET    /api/projects/:projectKey/mis-entries/:id/evidence         — list
//   GET    /api/projects/:projectKey/mis-entries/evidence/:evidenceId/content

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { computeIndicatorMetrics, MONTHS } from '../lib/misCalculations.js'

const router = Router()

// The paste grid sends '' for blank cells, which Postgres rejects for NUMERIC.
function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]*);base64,([\s\S]+)$/.exec(dataUrl)
  if (!match) throw new Error('data must be a base64 data URL')
  return { mimeType: match[1] || null, buffer: Buffer.from(match[2], 'base64') }
}

function logAudit(pool, { orgId, actorUid, actorName, action, targetId, diff }) {
  pool.query(
    `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
     VALUES ($1,$2,$3,$4,'indicator_monthly_entries',$5,$6)`,
    [orgId, actorUid, actorName, action, targetId, JSON.stringify(diff || {})]
  ).catch(() => {})
}

// GET /api/projects/:projectKey/mis-entries?fy_start_year=&month=&level=&search=&scope=&scope_value=
router.get('/projects/:projectKey/mis-entries', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const fyStartYear = parseInt(req.query.fy_start_year)
    const month = req.query.month
    if (!Number.isInteger(fyStartYear)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${MONTHS.join(', ')}` })
    const scope = req.query.scope || 'project'
    const scopeValue = req.query.scope_value || null
    const level = (req.query.level || '').trim()
    const search = (req.query.search || '').trim()

    const where = ['org_id = $1', 'project_key = $2', 'archived_at IS NULL']
    const params = [orgId, projectKey]
    if (level) { params.push(level); where.push(`level = $${params.length}`) }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(code ILIKE $${params.length} OR name ILIKE $${params.length})`)
    }
    const { rows: indicators } = await pool.query(
      `SELECT * FROM indicators WHERE ${where.join(' AND ')} ORDER BY level, code`,
      params
    )
    if (!indicators.length) return res.json({ rows: [] })

    const indicatorIds = indicators.map(i => i.id)
    // Filter entries by org_id/project_key too: the unique key has no org_id, and
    // older rows may pair one org's stamp with another org's indicator_id.
    const { rows: allEntries } = await pool.query(
      `SELECT * FROM indicator_monthly_entries
       WHERE indicator_id = ANY($1::uuid[]) AND fy_start_year = $2 AND scope = $3
         AND COALESCE(scope_value, '') = COALESCE($4, '')
         AND org_id = $5 AND project_key = $6`,
      [indicatorIds, fyStartYear, scope, scopeValue, orgId, projectKey]
    )
    const { rows: allTargets } = await pool.query(
      `SELECT * FROM indicator_targets WHERE indicator_id = ANY($1::uuid[]) AND fy_start_year = $2`,
      [indicatorIds, fyStartYear]
    )
    const { rows: evidenceCounts } = await pool.query(
      `SELECT entry_id, count(*)::int AS count FROM indicator_entry_evidence
       WHERE entry_id IN (SELECT id FROM indicator_monthly_entries WHERE indicator_id = ANY($1::uuid[]) AND org_id = $2)
       GROUP BY entry_id`,
      [indicatorIds, orgId]
    )
    const evidenceByEntry = new Map(evidenceCounts.map(e => [e.entry_id, e.count]))

    const rows = indicators.map(ind => {
      const entriesForIndicator = allEntries.filter(e => e.indicator_id === ind.id)
      const currentEntry = entriesForIndicator.find(e => e.month === month) || null
      // Prefer this scope's target; fall back to the project-wide one.
      const target = allTargets.find(t => t.indicator_id === ind.id && t.scope === scope && (t.scope_value || null) === scopeValue)
        || allTargets.find(t => t.indicator_id === ind.id && t.scope === 'project')
        || null

      const metrics = computeIndicatorMetrics({
        frequency: ind.frequency,
        aggregationMethod: ind.aggregation_method,
        entries: entriesForIndicator,
        uptoMonth: month,
        target: target?.annual_target ?? null,
      })

      return {
        indicator: {
          id: ind.id, code: ind.code, name: ind.name, level: ind.level, unit: ind.unit,
          frequency: ind.frequency, aggregation_method: ind.aggregation_method,
          responsible_person: ind.responsible_person,
        },
        entry: currentEntry ? {
          id: currentEntry.id, plan: currentEntry.plan, actual: currentEntry.actual,
          remarks: currentEntry.remarks, status: currentEntry.status,
          submitted_at: currentEntry.submitted_at, verified_at: currentEntry.verified_at,
          approved_at: currentEntry.approved_at, rejected_at: currentEntry.rejected_at,
          rejected_reason: currentEntry.rejected_reason,
          evidenceCount: evidenceByEntry.get(currentEntry.id) || 0,
        } : null,
        target: target?.annual_target ?? null,
        metrics,
      }
    })

    res.json({ rows, fy_start_year: fyStartYear, month, scope, scope_value: scopeValue })
  } catch (e) {
    console.error('[mis-entries GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/projects/:projectKey/mis-entries
// Body: { fy_start_year, month, scope?, scope_value?, entries: [{ indicator_id, plan?, actual?, remarks? }] }
// Creates 'draft' rows or updates existing drafts; anything further along is reported as locked.
router.put('/projects/:projectKey/mis-entries', async (req, res) => {
  if (!requireEditor(req, res)) return
  const { fy_start_year, month, entries } = req.body || {}
  const scope = req.body?.scope || 'project'
  const scopeValue = req.body?.scope_value || null
  if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
  if (!MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${MONTHS.join(', ')}` })
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries[] required' })

  const pool = getPool()
  const orgId = req.user.orgId
  const projectKey = req.params.projectKey
  const client = await pool.connect()
  const saved = []
  const locked = []
  const rejected = []
  try {
    await client.query('BEGIN')

    // indicator_id is client-controlled: confirm each belongs to this org+project,
    // or a caller could overwrite another org's draft or plant entries that show on
    // its dashboard (mis-dashboard resolves entries by indicator ownership).
    const candidateIds = [...new Set(entries.map(e => e.indicator_id).filter(Boolean))]
    const { rows: ownedIndicators } = candidateIds.length
      ? await client.query(
          `SELECT id FROM indicators WHERE id = ANY($1::uuid[]) AND org_id = $2 AND project_key = $3`,
          [candidateIds, orgId, projectKey]
        )
      : { rows: [] }
    const ownedIds = new Set(ownedIndicators.map(r => r.id))

    for (const e of entries) {
      if (!e.indicator_id) continue
      if (!ownedIds.has(e.indicator_id)) { rejected.push({ indicator_id: e.indicator_id, error: 'not found in this project' }); continue }
      const { rows: [existing] } = await client.query(
        `SELECT id, status FROM indicator_monthly_entries
         WHERE indicator_id = $1 AND org_id = $2 AND project_key = $3
           AND fy_start_year = $4 AND month = $5 AND scope = $6 AND COALESCE(scope_value,'') = COALESCE($7,'')`,
        [e.indicator_id, orgId, projectKey, fy_start_year, month, scope, scopeValue]
      )
      if (existing && existing.status !== 'draft') { locked.push({ indicator_id: e.indicator_id, status: existing.status }); continue }

      if (existing) {
        const { rows: [row] } = await client.query(
          `UPDATE indicator_monthly_entries SET plan = $1, actual = $2, remarks = $3, updated_at = NOW()
           WHERE id = $4 AND org_id = $5 AND project_key = $6 RETURNING id, plan, actual, remarks, status`,
          [numOrNull(e.plan), numOrNull(e.actual), e.remarks ?? null, existing.id, orgId, projectKey]
        )
        saved.push(row)
      } else {
        const { rows: [row] } = await client.query(
          `INSERT INTO indicator_monthly_entries
             (org_id, project_key, indicator_id, fy_start_year, month, scope, scope_value, plan, actual, remarks, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, plan, actual, remarks, status`,
          [orgId, projectKey, e.indicator_id, fy_start_year, month, scope, scopeValue, numOrNull(e.plan), numOrNull(e.actual), e.remarks ?? null, req.user.name || 'unknown']
        )
        saved.push(row)
      }
    }
    await client.query('COMMIT')
    res.json({ ok: true, saved: saved.length, locked, rejected })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[mis-entries PUT]', e)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// Checked up front so a bad id is a 400, not a Postgres uuid cast error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadEntries(pool, ids, orgId, projectKey) {
  const { rows } = await pool.query(
    `SELECT * FROM indicator_monthly_entries WHERE id = ANY($1::uuid[]) AND org_id = $2 AND project_key = $3`,
    [ids, orgId, projectKey]
  )
  return rows
}

function transitionHandler({ fromStatuses, toStatus, guard, extraSetSql = '', extraParams = () => [], auditAction }) {
  return async (req, res) => {
    if (!guard(req, res)) return
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => UUID_RE.test(String(id)))) return res.status(400).json({ error: 'ids[] must be a non-empty list of entry UUIDs' })

    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const entries = await loadEntries(pool, ids, orgId, projectKey)
    const transitioned = []
    const rejected = []
    for (const entry of entries) {
      if (!fromStatuses.includes(entry.status)) { rejected.push({ id: entry.id, reason: `current status is ${entry.status}` }); continue }
      const extra = extraParams(req)
      await pool.query(
        `UPDATE indicator_monthly_entries SET status = $1 ${extraSetSql}, updated_at = NOW() WHERE id = $2`,
        [toStatus, entry.id, ...extra]
      )
      transitioned.push(entry.id)
      logAudit(pool, { orgId, actorUid: req.user.uid, actorName: req.user.name, action: auditAction, targetId: entry.id, diff: { from: entry.status, to: toStatus } })
    }
    res.json({ ok: true, transitioned, rejected })
  }
}

router.post('/projects/:projectKey/mis-entries/submit', transitionHandler({
  fromStatuses: ['draft'], toStatus: 'submitted', guard: requireEditor,
  extraSetSql: ', submitted_at = NOW(), submitted_by = $3', extraParams: req => [req.user.name || 'unknown'],
  auditAction: 'mis_entry.submit',
}))

router.post('/projects/:projectKey/mis-entries/verify', transitionHandler({
  fromStatuses: ['submitted'], toStatus: 'verified', guard: requireAdmin,
  extraSetSql: ', verified_at = NOW(), verified_by = $3', extraParams: req => [req.user.name || 'unknown'],
  auditAction: 'mis_entry.verify',
}))

router.post('/projects/:projectKey/mis-entries/approve', transitionHandler({
  fromStatuses: ['verified'], toStatus: 'approved', guard: requireAdmin,
  extraSetSql: ', approved_at = NOW(), approved_by = $3', extraParams: req => [req.user.name || 'unknown'],
  auditAction: 'mis_entry.approve',
}))

// Reject needs a reason, so it doesn't fit the generic ids-only transitionHandler shape.
router.post('/projects/:projectKey/mis-entries/reject', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { ids, reason } = req.body || {}
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => UUID_RE.test(String(id)))) return res.status(400).json({ error: 'ids[] must be a non-empty list of entry UUIDs' })
  const pool = getPool()
  const entries = await loadEntries(pool, ids, req.user.orgId, req.params.projectKey)
  const transitioned = []
  const rejected = []
  for (const entry of entries) {
    if (!['submitted', 'verified'].includes(entry.status)) { rejected.push({ id: entry.id, reason: `current status is ${entry.status}` }); continue }
    await pool.query(
      `UPDATE indicator_monthly_entries SET status = 'rejected', rejected_at = NOW(), rejected_by = $1, rejected_reason = $2, updated_at = NOW() WHERE id = $3`,
      [req.user.name || 'unknown', reason || null, entry.id]
    )
    transitioned.push(entry.id)
    logAudit(pool, { orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'mis_entry.reject', targetId: entry.id, diff: { from: entry.status, to: 'rejected', reason: reason || null } })
  }
  res.json({ ok: true, transitioned, rejected })
})

router.post('/projects/:projectKey/mis-entries/reopen', transitionHandler({
  fromStatuses: ['submitted', 'verified', 'approved', 'rejected'], toStatus: 'draft', guard: requireAdmin,
  auditAction: 'mis_entry.reopen',
}))

// ── Evidence ──────────────────────────────────────────────────────────────
router.post('/projects/:projectKey/mis-entries/:id/evidence', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { filename, data } = req.body || {}
    if (!filename || !data) return res.status(400).json({ error: 'filename and data (base64) required' })
    const pool = getPool()
    const [entry] = await loadEntries(pool, [req.params.id], req.user.orgId, req.params.projectKey)
    if (!entry) return res.status(404).json({ error: 'Not found' })

    const { mimeType, buffer } = decodeDataUrl(data)
    const { rows: [evidence] } = await pool.query(
      `INSERT INTO indicator_entry_evidence (entry_id, filename, mime_type, size_bytes, data_base64, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mime_type, size_bytes, created_at`,
      [entry.id, filename, mimeType, buffer.length, data, req.user.name || 'unknown']
    )
    res.status(201).json({ ok: true, evidence })
  } catch (e) {
    console.error('[mis-entries evidence POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/projects/:projectKey/mis-entries/:id/evidence', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const [entry] = await loadEntries(pool, [req.params.id], req.user.orgId, req.params.projectKey)
    if (!entry) return res.status(404).json({ error: 'Not found' })
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at FROM indicator_entry_evidence WHERE entry_id = $1 ORDER BY created_at DESC`,
      [entry.id]
    )
    res.json({ evidence: rows })
  } catch (e) {
    console.error('[mis-entries evidence GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/projects/:projectKey/mis-entries/evidence/:evidenceId/content', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT ev.filename, ev.mime_type, ev.data_base64
       FROM indicator_entry_evidence ev
       JOIN indicator_monthly_entries e ON e.id = ev.entry_id
       WHERE ev.id = $1 AND e.org_id = $2 AND e.project_key = $3`,
      [req.params.evidenceId, req.user.orgId, req.params.projectKey]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const { mimeType, buffer } = decodeDataUrl(rows[0].data_base64)
    res.setHeader('Content-Type', mimeType || rows[0].mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rows[0].filename)}"`)
    res.send(buffer)
  } catch (e) {
    console.error('[mis-entries evidence content GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
