// Micro-Entrepreneur roster (041), written only by the services/micro-entrepreneur
// microservice. Mirrors individual-beneficiaries.routes.js (read-only roster,
// admin-only registration links).
//
//   GET  /api/micro-entrepreneurs                          — list + KPIs
//   GET  /api/micro-entrepreneurs/registration-link         — get-or-create link
//   POST /api/micro-entrepreneurs/registration-link/rotate  — invalidate + reissue

import { Router } from 'express'
import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { buildSearchCondition } from '../lib/searchSql.js'
import { decryptRowInPlace } from '../lib/piiCrypto.js'
import { effectiveProductionSystemsSql, productionKpiColumnsSql, productionKpis } from '../lib/productionSystemsSql.js'

const router = Router()

// GET /api/micro-entrepreneurs?state=&district=&block=&village=&gender=&production_system=&search=&page=
router.get('/micro-entrepreneurs', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { state, district, block, village, gender, category, production_system, search } = req.query
    const page     = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = 50

    const where  = ['org_id = $1']
    const values = [req.user.orgId]
    const addFilter = (col, val) => {
      if (!val) return
      values.push(val)
      where.push(`${col} = $${values.length}`)
    }
    addFilter('state', state)
    addFilter('district', district)
    addFilter('block', block)
    addFilter('village', village)
    addFilter('gender', gender)
    addFilter('category', category)
    // production_systems JSONB multiselect (069): match "has an entry of this type".
    if (production_system) {
      values.push(production_system)
      // jsonb_typeof guard: a non-array value would 500 jsonb_array_elements().
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(${effectiveProductionSystemsSql('')}) e WHERE e->>'type' = $${values.length})`)
    }
    const searchCond = buildSearchCondition(search, values, { columns: ['name','uid','village','enterprise_name'], contactHash: true })
    if (searchCond) where.push(searchCond)
    const whereSql = where.join(' AND ')

    // total_production sums Quintal quantities (Livestock's count is a headcount, not summed).
    const { rows: countRows } = await pool.query(
      `SELECT count(DISTINCT me.id)::int AS total,
              ${productionKpiColumnsSql('me')},
              count(DISTINCT me.id) FILTER (WHERE me.gender = 'Male')::int   AS male,
              count(DISTINCT me.id) FILTER (WHERE me.gender = 'Female')::int AS female
       FROM micro_entrepreneurs me
       LEFT JOIN LATERAL (
         SELECT e AS entry, e->>'type' AS type FROM jsonb_array_elements(${effectiveProductionSystemsSql('me')}) e
       ) ps ON true
       WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}
    // Summed on the un-expanded table — summing inside the LATERAL join above
    // would count an entrepreneur's employees once per production system.
    const { rows: employeeRows } = await pool.query(
      `SELECT coalesce(sum(current_employee_count), 0) AS total_employees FROM micro_entrepreneurs WHERE ${whereSql}`,
      values
    )
    const employeeTotal = Number(employeeRows[0]?.total_employees) || 0

    // Revenue is encrypted at rest, so it's aggregated in app code (fine at this org's scale).
    const { rows: revenueRows } = await pool.query(
      `SELECT current_revenue_inr, current_revenue_inr_enc FROM micro_entrepreneurs WHERE ${whereSql}`,
      values
    )
    const revenueValues = revenueRows
      .map(r => Number(decryptRowInPlace('micro_entrepreneurs', r).current_revenue_inr))
      .filter(Number.isFinite)
    const avgRevenue   = revenueValues.length ? revenueValues.reduce((a, b) => a + b, 0) / revenueValues.length : 0
    const totalRevenue = revenueValues.reduce((a, b) => a + b, 0)

    const { rows } = await pool.query(
      `SELECT id, uid, name, contact_no, contact_no_enc, state, district, block, panchayat, panchayat_enc, village,
              gender, category, enterprise_name, business_activity, current_revenue_inr, current_revenue_inr_enc,
              current_employee_count, production_systems, created_at
       FROM micro_entrepreneurs
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )
    rows.forEach(r => decryptRowInPlace('micro_entrepreneurs', r))

    // Each dropdown is scoped by its ancestor filters only (see individual-beneficiaries).
    const scopedDistinct = (column, ancestors) => {
      const where  = ['org_id = $1', `${column} IS NOT NULL`]
      const vals   = [req.user.orgId]
      for (const [col, val] of ancestors) {
        if (!val) continue
        vals.push(val)
        where.push(`${col} = $${vals.length}`)
      }
      return pool.query(`SELECT DISTINCT ${column} FROM micro_entrepreneurs WHERE ${where.join(' AND ')} ORDER BY ${column}`, vals)
    }
    const { rows: stateRows }    = await scopedDistinct('state', [])
    const { rows: districtRows } = await scopedDistinct('district', [['state', state]])
    const { rows: blockRows }    = await scopedDistinct('block', [['state', state], ['district', district]])
    const { rows: villageRows }  = await scopedDistinct('village', [['state', state], ['district', district], ['block', block]])

    res.json({
      rows,
      totalRows: kpiRow.total || 0,
      page,
      pageSize,
      kpis: {
        total:           kpiRow.total || 0,
        avgRevenue:      avgRevenue,
        totalRevenue:    totalRevenue,
        totalEmployees:  employeeTotal,
        ...productionKpis(kpiRow),
        male:            kpiRow.male || 0,
        female:          kpiRow.female || 0,
      },
      states:    stateRows.map(r => r.state),
      districts: districtRows.map(r => r.district),
      blocks:    blockRows.map(r => r.block),
      villages:  villageRows.map(r => r.village),
    })
  } catch (e) {
    console.error('[micro-entrepreneurs GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/micro-entrepreneurs/registration-link — get-or-create this org's link
router.get('/micro-entrepreneurs/registration-link', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const url = await getOrCreateLink(req.user.orgId)
    res.json({ url })
  } catch (e) {
    console.error('[eb registration-link GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/micro-entrepreneurs/registration-link/rotate — invalidate the old link, issue a new one
router.post('/micro-entrepreneurs/registration-link/rotate', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool  = getPool()
    const token = crypto.randomBytes(24).toString('hex')
    await pool.query(
      `INSERT INTO me_registration_tokens (org_id, token, rotated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET token = $2, rotated_at = now()`,
      [req.user.orgId, token]
    )
    const url = await buildLinkUrl(req.user.orgId, token)
    res.json({ url })
  } catch (e) {
    console.error('[eb registration-link rotate]', e.message)
    res.status(500).json({ error: e.message })
  }
})

async function getOrCreateLink(orgId) {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT token FROM me_registration_tokens WHERE org_id = $1`, [orgId])
  let token = rows[0]?.token
  if (!token) {
    // A concurrent insert may win; the no-op update makes RETURNING give the stored token.
    const { rows: ins } = await pool.query(
      `INSERT INTO me_registration_tokens (org_id, token) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET token = me_registration_tokens.token
       RETURNING token`,
      [orgId, crypto.randomBytes(24).toString('hex')]
    )
    token = ins[0].token
  }
  return buildLinkUrl(orgId, token)
}

async function buildLinkUrl(orgId, token) {
  const base = (process.env.EB_FORM_BASE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('EB_FORM_BASE_URL is not configured on the server')
  return `${base}/register?org=${encodeURIComponent(orgId)}&key=${encodeURIComponent(token)}`
}

export default router
