// DPDP erasure. Anonymize-in-place is the default: MIS/resource rows join by the
// beneficiary_uid string (no FK), so keeping the row and uid preserves reporting
// while the identifying fields are nulled. Hard-delete is admin-only and rejects
// while any record references the beneficiary (cascade policy is still undecided).
//
//   POST /api/beneficiary-erasure/:uid/anonymize     — default path
//   POST /api/beneficiary-erasure/:uid/hard-delete   — { confirm: true } required; rejects if referenced

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireAdmin } from '../lib/routeGuards.js'
import { resolveBeneficiarySpec, BENEFICIARY_UID_PREFIX_HINT } from '../lib/beneficiaryLookup.js'
import { writeAudit } from '../lib/auditMiddleware.js'
import { ANONYMIZE_SPECS, clearLinkedPii } from '../lib/anonymizeSpecs.js'

const router = Router()

// Everything a hard-delete must check for references: the MIS category tables
// (as in beneficiary-profile's MIS_CATEGORIES), resources, income, project links, consent.
const REFERENCING_TABLES = [
  'trainings', 'input_distributions', 'scheme_access', 'credit_grant_access',
  'business_development_support', 'compliance_support', 'exposure_visits', 'resources',
  'income', 'beneficiary_project_links', 'consent_records',
]

export async function findReferences(pool, orgId, uid) {
  const found = []
  for (const table of REFERENCING_TABLES) {
    const { rows } = await pool.query(
      `SELECT 1 FROM ${table} WHERE org_id = $1 AND beneficiary_uid = $2 LIMIT 1`,
      [orgId, uid]
    )
    if (rows.length) found.push(table)
  }
  return found
}

/**
 * Anonymize logic, shared with dsr.routes.js's fulfill/erasure.
 * @returns {Promise<{ ok: true, columns: string[] } | { ok: false, reason: string }>}
 */
export async function anonymizeBeneficiary(orgId, uidRaw) {
  const spec = resolveBeneficiarySpec(uidRaw)
  if (!spec) return { ok: false, status: 400, reason: BENEFICIARY_UID_PREFIX_HINT }
  const columns = ANONYMIZE_SPECS[spec.table]
  if (!columns) return { ok: false, status: 400, reason: `Anonymization is not defined for ${spec.type}` }

  const setSql = columns.map((c, i) => `${c.column} = $${i + 3}`).join(', ')
  const values = [orgId, spec.normalizedUid, ...columns.map(c => c.value)]
  // One transaction so the registry row and its MIS copies are cleared together.
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `UPDATE ${spec.table} SET ${setSql}, anonymized_at = now()
       WHERE org_id = $1 AND uid = $2 AND anonymized_at IS NULL`,
      values
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return { ok: false, status: 404, reason: `No ${spec.type} found for UID "${spec.normalizedUid}", or it was already anonymized` }
    }
    await clearLinkedPii(client, orgId, [spec.normalizedUid])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return { ok: true, spec, columns: columns.map(c => c.column) }
}

// POST /api/beneficiary-erasure/:uid/anonymize
router.post('/beneficiary-erasure/:uid/anonymize', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const result = await anonymizeBeneficiary(req.user.orgId, req.params.uid)
    if (!result.ok) return res.status(result.status).json({ error: result.reason })

    writeAudit({
      orgId: req.user.orgId, actorUid: req.user.uid, action: 'beneficiary.anonymize',
      targetType: result.spec.type, targetId: result.spec.normalizedUid,
      diff: { columns: result.columns },
      requestId: req.body?.dsrRequestId || null,
    })
    res.json({ ok: true, uid: result.spec.normalizedUid, type: result.spec.type, anonymizedColumns: result.columns })
  } catch (e) {
    console.error('[beneficiary-erasure anonymize]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/beneficiary-erasure/:uid/hard-delete
// Body: { confirm: true, dsrRequestId? }
router.post('/beneficiary-erasure/:uid/hard-delete', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'Body must include { "confirm": true } to hard-delete — this is irreversible' })
    }
    const spec = resolveBeneficiarySpec(req.params.uid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })

    const pool = getPool()
    const referencedIn = await findReferences(pool, req.user.orgId, spec.normalizedUid)
    if (referencedIn.length) {
      return res.status(409).json({
        error: `${spec.type} ${spec.normalizedUid} is referenced by MIS/resource records and cannot be hard-deleted — use /anonymize instead, or resolve the referencing records first`,
        referencedIn,
      })
    }

    const { rowCount } = await pool.query(
      `DELETE FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
      [req.user.orgId, spec.normalizedUid]
    )
    if (!rowCount) return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })

    writeAudit({
      orgId: req.user.orgId, actorUid: req.user.uid, action: 'beneficiary.hard_delete',
      targetType: spec.type, targetId: spec.normalizedUid, diff: null,
      requestId: req.body?.dsrRequestId || null,
    })
    res.json({ ok: true, uid: spec.normalizedUid, type: spec.type })
  } catch (e) {
    console.error('[beneficiary-erasure hard-delete]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
