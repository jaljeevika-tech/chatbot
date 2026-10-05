// Collective roster (042), written only by the services/collective microservice.
// Mirrors individual-beneficiaries.routes.js (read-only roster, admin-only links).
//
//   GET  /api/collectives                          — list + KPIs
//   GET  /api/collectives/registration-link         — get-or-create link
//   POST /api/collectives/registration-link/rotate  — invalidate + reissue

import { Router } from 'express'
import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { buildSearchCondition } from '../lib/searchSql.js'
import { decryptRowInPlace } from '../lib/piiCrypto.js'
import { effectiveProductionSystemsSql, productionKpiColumnsSql, productionKpis } from '../lib/productionSystemsSql.js'

const router = Router()

const COLLECTIVE_TYPES = ['FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective']

// GET /api/collectives?state=&district=&block=&village=&collective_type=&search=&page=
router.get('/collectives', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { state, district, block, village, collective_type, search } = req.query
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
    addFilter('collective_type', collective_type)
    const searchCond = buildSearchCondition(search, values, { columns: ['collective_name','uid','lead_person_name','village'], contactHash: true })
    if (searchCond) where.push(searchCond)
    const whereSql = where.join(' AND ')

    // total_production sums Quintal quantities (Livestock's count is a headcount, not summed).
    const { rows: countRows } = await pool.query(
      `SELECT count(DISTINCT cb.id)::int AS total,
              ${productionKpiColumnsSql('cb')}
       FROM collectives cb
       LEFT JOIN LATERAL (
         SELECT e AS entry, e->>'type' AS type FROM jsonb_array_elements(${effectiveProductionSystemsSql('cb', { legacy: true })}) e
       ) ps ON true
       WHERE ${whereSql}`,
      values
    )
    // Totals on the un-expanded table; inside the LATERAL join they'd repeat per production system.
    const { rows: totalsRows } = await pool.query(
      `SELECT coalesce(sum(male_count), 0)::int AS total_male,
              coalesce(sum(female_count), 0)::int AS total_female,
              coalesce(avg(current_revenue_inr), 0) AS avg_revenue,
              coalesce(sum(current_revenue_inr), 0) AS total_revenue,
              coalesce(sum(credit_access_inr), 0) AS total_credit_access
       FROM collectives WHERE ${whereSql}`,
      values
    )
    const kpiRow = { ...(countRows[0] || {}), ...(totalsRows[0] || {}) }

    // per_capita_income_inr is encrypted at rest, so it's averaged in app code.
    // Revenue and credit stay plaintext: group-level metrics, not personal income
    // (same split as lib/anonymizeSpecs.js).
    const { rows: incomeRows } = await pool.query(
      `SELECT per_capita_income_inr, per_capita_income_inr_enc FROM collectives WHERE ${whereSql}`,
      values
    )
    const incomeValues = incomeRows
      .map(r => Number(decryptRowInPlace('collectives', r).per_capita_income_inr))
      .filter(Number.isFinite)
    const avgPerCapitaIncome = incomeValues.length ? incomeValues.reduce((a, b) => a + b, 0) / incomeValues.length : 0

    const { rows: typeRows } = await pool.query(
      `SELECT collective_type, count(*)::int AS total
       FROM collectives WHERE ${whereSql} AND collective_type IS NOT NULL
       GROUP BY collective_type ORDER BY total DESC`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, uid, collective_name, collective_type, lead_person_name, contact_no, contact_no_enc,
              state, district, block, panchayat, panchayat_enc, village, male_count, female_count,
              focus_area, current_revenue_inr, production_type, current_production_ton, production_systems,
              per_capita_income_inr, per_capita_income_inr_enc, credit_access_inr, created_at
       FROM collectives
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )
    rows.forEach(r => decryptRowInPlace('collectives', r))

    // Each dropdown is scoped by its ancestor filters only (see individual-beneficiaries).
    const scopedDistinct = (column, ancestors) => {
      const where  = ['org_id = $1', `${column} IS NOT NULL`]
      const vals   = [req.user.orgId]
      for (const [col, val] of ancestors) {
        if (!val) continue
        vals.push(val)
        where.push(`${col} = $${vals.length}`)
      }
      return pool.query(`SELECT DISTINCT ${column} FROM collectives WHERE ${where.join(' AND ')} ORDER BY ${column}`, vals)
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
        total:              kpiRow.total || 0,
        totalMale:          kpiRow.total_male || 0,
        totalFemale:        kpiRow.total_female || 0,
        avgRevenue:         Number(kpiRow.avg_revenue) || 0,
        totalRevenue:       Number(kpiRow.total_revenue) || 0,
        totalProduction:    Number(kpiRow.total_production) || 0,
        avgPerCapitaIncome: avgPerCapitaIncome,
        totalCreditAccess:  Number(kpiRow.total_credit_access) || 0,
        ...productionKpis(kpiRow),
      },
      byType:    typeRows.map(r => ({ label: r.collective_type, total: r.total })),
      states:    stateRows.map(r => r.state),
      districts: districtRows.map(r => r.district),
      blocks:    blockRows.map(r => r.block),
      villages:  villageRows.map(r => r.village),
      collectiveTypes: COLLECTIVE_TYPES,
    })
  } catch (e) {
    console.error('[collectives GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/collectives/registration-link — get-or-create this org's link
router.get('/collectives/registration-link', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const url = await getOrCreateLink(req.user.orgId)
    res.json({ url })
  } catch (e) {
    console.error('[cb registration-link GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/collectives/registration-link/rotate — invalidate the old link, issue a new one
router.post('/collectives/registration-link/rotate', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool  = getPool()
    const token = crypto.randomBytes(24).toString('hex')
    await pool.query(
      `INSERT INTO cb_registration_tokens (org_id, token, rotated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET token = $2, rotated_at = now()`,
      [req.user.orgId, token]
    )
    const url = await buildLinkUrl(req.user.orgId, token)
    res.json({ url })
  } catch (e) {
    console.error('[cb registration-link rotate]', e.message)
    res.status(500).json({ error: e.message })
  }
})

async function getOrCreateLink(orgId) {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT token FROM cb_registration_tokens WHERE org_id = $1`, [orgId])
  let token = rows[0]?.token
  if (!token) {
    // A concurrent insert may win; the no-op update makes RETURNING give the stored token.
    const { rows: ins } = await pool.query(
      `INSERT INTO cb_registration_tokens (org_id, token) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET token = cb_registration_tokens.token
       RETURNING token`,
      [orgId, crypto.randomBytes(24).toString('hex')]
    )
    token = ins[0].token
  }
  return buildLinkUrl(orgId, token)
}

async function buildLinkUrl(orgId, token) {
  const base = (process.env.CB_FORM_BASE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('CB_FORM_BASE_URL is not configured on the server')
  return `${base}/register?org=${encodeURIComponent(orgId)}&key=${encodeURIComponent(token)}`
}

export default router
