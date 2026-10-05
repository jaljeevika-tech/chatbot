// routes/compliance.routes.js
//
// Compliance Calendar — org-level and per-project compliance/renewal items.
// Status (overdue/upcoming/valid) is derived from due_date vs NOW() unless
// manual_status overrides it.
//
//   GET    /api/compliance-items?project=<key>   — list (project optional — omit for org-level-only items)
//   POST   /api/compliance-items                  — create { item, due_date, project_key?, manual_status? }
//   PUT    /api/compliance-items/:id               — update
//   DELETE /api/compliance-items/:id                — delete

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'

const router = Router()

// Admins and managers (requireEditor), plus Finance-team members
// (fm_profiles.is_finance) — the Finance Management tab lets the Finance team
// keep the compliance calendar up to date even without a manager role.
async function canManage(req, res) {
  if (['admin', 'superadmin', 'manager'].includes(req.user?.role)) return true
  if (req.user?.orgId && req.user?.uid) {
    try {
      const { rows } = await getPool().query(
        `SELECT 1 FROM users u JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
          WHERE u.org_id = $1 AND u.firebase_uid = $2 AND p.is_finance LIMIT 1`, [req.user.orgId, req.user.uid])
      if (rows[0]) return true
    } catch { /* fm_profiles not migrated yet → not Finance */ }
  }
  return requireEditor(req, res) // sends the 403
}

function statusFor(dueDate) {
  if (!dueDate) return 'valid'
  const due = new Date(dueDate)
  const now = new Date()
  if (due < now) return 'overdue'
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30)
  if (due < in30) return 'upcoming'
  return 'valid'
}

function dueLabel(item) {
  const status = item.manual_status || statusFor(item.due_date)
  if (status === 'valid' && !item.due_date) return 'Valid'
  if (status === 'valid') return `Valid till ${new Date(item.due_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`
  return `Due ${new Date(item.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

router.get('/compliance-items', async (req, res) => {
  if (!(await canManage(req, res))) return
  try {
    const pool = getPool()
    const project = req.query.project
    const { rows } = await pool.query(
      `SELECT id, project_key, item, due_date, due_date::text AS due_date_text, manual_status
       FROM compliance_items
       WHERE org_id = $1 ${project ? 'AND (project_key = $2 OR project_key IS NULL)' : ''}
       ORDER BY due_date ASC NULLS LAST`,
      project ? [req.user.orgId, project] : [req.user.orgId]
    )
    const items = rows.map(r => ({
      id: r.id,
      item: r.item,
      status: r.manual_status || statusFor(r.due_date),
      due: r.due_date,
      due_date: r.due_date_text, // 'YYYY-MM-DD' — never via a JS Date (shifts a day east of UTC)
      project_key: r.project_key,
      manual_status: r.manual_status,
      dueLabel: dueLabel(r),
    }))
    res.json({ items })
  } catch (e) {
    console.error('[compliance-items GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/compliance-items', async (req, res) => {
  if (!(await canManage(req, res))) return
  try {
    const { item, due_date, project_key, manual_status } = req.body || {}
    if (!item) return res.status(400).json({ error: 'item is required' })
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO compliance_items (org_id, project_key, item, due_date, manual_status)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, project_key, item, due_date, manual_status`,
      [req.user.orgId, project_key || null, item, due_date || null, manual_status || null]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[compliance-items POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.put('/compliance-items/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!(await canManage(req, res))) return
  try {
    const { item, due_date, manual_status } = req.body || {}
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE compliance_items
       SET item = COALESCE($1, item), due_date = COALESCE($2, due_date), manual_status = $3
       WHERE id = $4 AND org_id = $5
       RETURNING id, project_key, item, due_date, manual_status`,
      [item, due_date, manual_status ?? null, req.params.id, req.user.orgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error('[compliance-items PUT]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/compliance-items/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!(await canManage(req, res))) return
  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM compliance_items WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[compliance-items DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
