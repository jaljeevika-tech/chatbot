// POST /api/mis-records/:kind/delete { ids: [...] } — admin-only removal of one or
// many rows from any MIS sub-tab (POST, not DELETE, so the id list rides in a body). :kind is the tab's list endpoint name; the map is the whitelist
// (table names never come from the request). No undo; logged to audit_log.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireAdmin } from '../lib/routeGuards.js'

const TABLES = {
  'trainings': 'trainings',
  'income': 'income',
  'input-distributions': 'input_distributions',
  'scheme-access': 'scheme_access',
  'credit-grant-access': 'credit_grant_access',
  'business-development-support': 'business_development_support',
  'compliance-support': 'compliance_support',
  'campaign': 'campaign',
  'exposure-visits': 'exposure_visits',
  'community-meeting': 'community_meeting',
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const router = Router()

router.post('/mis-records/:kind/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const table = TABLES[req.params.kind]
  if (!table) return res.status(400).json({ error: 'Unknown MIS category' })
  const ids = req.body?.ids
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(id => UUID_RE.test(id))) {
    return res.status(400).json({ error: 'ids[] required (1–500 record ids)' })
  }
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `DELETE FROM ${table} WHERE org_id = $1 AND id = ANY($2::uuid[]) RETURNING *`,
      [req.user.orgId, ids]
    )
    if (!rows.length) return res.status(404).json({ error: 'Records not found' })

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'mis_record.delete',$4,$5,$6)`,
      [req.user.orgId, req.user.uid, req.user.name, table, rows.map(r => r.id).join(','),
       JSON.stringify({ deleted: rows })]
    ).catch(() => {})

    res.json({ ok: true, deleted: rows.length })
  } catch (e) {
    console.error('[mis-records DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
