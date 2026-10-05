// routes/indirect-beneficiaries.routes.js
//
// Read-only registry of people who appear in an MIS upload without a Beneficiary
// UID. Rows are minted by the MIS upload routes (routes/trainings.routes.js), never via a form.
//
//   GET /api/indirect-beneficiaries?search=&page=  — list + KPI

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { buildSearchCondition } from '../lib/searchSql.js'

const router = Router()

router.get('/indirect-beneficiaries', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { search } = req.query
    const page     = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = 50

    const where  = ['org_id = $1']
    const values = [req.user.orgId]
    const searchCond = buildSearchCondition(search, values, { columns: ['uid','name','contact_no'] })
    if (searchCond) where.push(searchCond)
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total FROM indirect_beneficiaries WHERE ${whereSql}`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, uid, name, contact_no, place, source, created_at
       FROM indirect_beneficiaries
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )

    res.json({
      rows,
      totalRows: countRows[0]?.total || 0,
      page,
      pageSize,
      kpis: { total: countRows[0]?.total || 0 },
    })
  } catch (e) {
    console.error('[indirect-beneficiaries GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
