// Per-project beneficiary enrollment records for the Beneficiaries page.
//
//   GET    /api/projects/:projectKey/beneficiaries          — list + KPI summary
//   POST   /api/projects/:projectKey/beneficiaries          — create
//   PUT    /api/projects/:projectKey/beneficiaries/:id      — update
//   DELETE /api/projects/:projectKey/beneficiaries/:id      — delete

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { auditRoute } from '../lib/auditMiddleware.js'

const router = Router()

router.get('/projects/:projectKey/beneficiaries', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, name, gender, location, category, enrolled_date, status
       FROM beneficiaries
       WHERE org_id = $1 AND project_key = $2
       ORDER BY enrolled_date DESC NULLS LAST, created_at DESC`,
      [req.user.orgId, req.params.projectKey]
    )
    const total     = rows.length
    const women     = rows.filter(r => (r.gender || '').toLowerCase().startsWith('f')).length
    const active    = rows.filter(r => r.status === 'Active').length
    const completed = rows.filter(r => r.status === 'Completed').length
    const dropped   = rows.filter(r => r.status === 'Dropped').length
    res.json({
      rows,
      kpis: [
        { label: 'Total Beneficiaries', value: String(total), note: '' },
        { label: 'Women', value: String(women), note: total > 0 ? `${Math.round((women / total) * 100)}% of total` : '' },
        { label: 'Active', value: String(active), note: '' },
        { label: 'Completed / Dropped', value: `${completed} / ${dropped}`, note: '' },
      ],
    })
  } catch (e) {
    console.error('[beneficiaries GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/projects/:projectKey/beneficiaries',
  auditRoute('beneficiary.create', 'beneficiary', { getTargetId: (req, body) => body?.id || null }),
  async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, gender, location, category, enrolled_date, status } = req.body || {}
    if (!name) return res.status(400).json({ error: 'name is required' })
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO beneficiaries (org_id, project_key, name, gender, location, category, enrolled_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'Active'))
       RETURNING id, name, gender, location, category, enrolled_date, status`,
      [req.user.orgId, req.params.projectKey, name, gender || null, location || null, category || null, enrolled_date || null, status || null]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[beneficiaries POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.put('/projects/:projectKey/beneficiaries/:id([0-9a-fA-F-]{36})',
  auditRoute('beneficiary.update', 'beneficiary'),
  async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, gender, location, category, enrolled_date, status } = req.body || {}
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE beneficiaries
       SET name = COALESCE($1, name), gender = COALESCE($2, gender), location = COALESCE($3, location),
           category = COALESCE($4, category), enrolled_date = COALESCE($5, enrolled_date), status = COALESCE($6, status)
       WHERE id = $7 AND org_id = $8 AND project_key = $9
       RETURNING id, name, gender, location, category, enrolled_date, status`,
      [name, gender, location, category, enrolled_date, status, req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error('[beneficiaries PUT]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/projects/:projectKey/beneficiaries/:id([0-9a-fA-F-]{36})',
  auditRoute('beneficiary.delete', 'beneficiary'),
  async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM beneficiaries WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[beneficiaries DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/projects/:projectKey/beneficiaries/:id/anonymize
// name is NOT NULL, so it gets a placeholder; location is cleared. custom_data
// (freeform JSONB) is left as-is — it can't be told apart from non-PII operational data.
router.post('/projects/:projectKey/beneficiaries/:id([0-9a-fA-F-]{36})/anonymize',
  auditRoute('beneficiary.anonymize', 'beneficiary'),
  async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `UPDATE beneficiaries SET name = '[anonymized]', location = NULL, anonymized_at = now()
       WHERE id = $1 AND org_id = $2 AND project_key = $3 AND anonymized_at IS NULL`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found, or already anonymized' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[beneficiaries anonymize]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
