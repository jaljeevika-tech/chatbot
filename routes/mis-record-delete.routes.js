// DELETE /api/mis-records/:kind/:id — admin-only removal of one MIS row from any
// MIS sub-tab. :kind is the tab's list endpoint name; the map is the whitelist
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

router.delete('/mis-records/:kind/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const table = TABLES[req.params.kind]
  if (!table) return res.status(400).json({ error: 'Unknown MIS category' })
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid record id' })
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `DELETE FROM ${table} WHERE org_id = $1 AND id = $2 RETURNING *`,
      [req.user.orgId, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Record not found' })

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'mis_record.delete',$4,$5,$6)`,
      [req.user.orgId, req.user.uid, req.user.name, table, req.params.id, JSON.stringify(rows[0])]
    ).catch(() => {})

    res.json({ ok: true })
  } catch (e) {
    console.error('[mis-records DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
