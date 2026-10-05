// Individual Beneficiary roster (038). Only the services/individual-beneficiary
// microservice writes it (ib_service role); the monolith reads it and mints/rotates
// each org's registration link — admin-only, since the link is a bearer credential.
//
//   GET  /api/individual-beneficiaries                       — list + KPIs
//   GET  /api/individual-beneficiaries/registration-link      — get-or-create link
//   POST /api/individual-beneficiaries/registration-link/rotate — invalidate + reissue

import { Router } from 'express'
import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { buildSearchCondition } from '../lib/searchSql.js'
import { decryptRowInPlace } from '../lib/piiCrypto.js'
import { auditRoute } from '../lib/auditMiddleware.js'
import { effectiveProductionSystemsSql, productionKpiColumnsSql, productionKpis } from '../lib/productionSystemsSql.js'

const router = Router()

// GET /api/individual-beneficiaries?state=&district=&block=&village=&production_system=&gender=&member_of_collective=&search=&page=
router.get('/individual-beneficiaries', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { state, district, block, village, production_system, gender, category, search } = req.query
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
    // production_systems is a JSONB multiselect (067): match "has an entry of this type".
    if (production_system) {
      values.push(production_system)
      // jsonb_array_elements() throws on a non-array; the jsonb_typeof guard
      // keeps one malformed row from 500-ing the list.
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(${effectiveProductionSystemsSql('', { legacy: true })}) e WHERE e->>'type' = $${values.length})`)
    }
    // 'yes'/'no', matching the frontend <select>
    if (req.query.member_of_collective === 'yes' || req.query.member_of_collective === 'no') {
      values.push(req.query.member_of_collective === 'yes')
      where.push(`member_of_collective = $${values.length}`)
    }
    const searchCond = buildSearchCondition(search, values, { columns: ['name','uid','village'], contactHash: true })
    if (searchCond) where.push(searchCond)
    const whereSql = where.join(' AND ')

    // LEFT JOIN LATERAL keeps beneficiaries with an empty array; count(DISTINCT id)
    // undoes the row multiplication from multiple production systems.
    const { rows: countRows } = await pool.query(
      `SELECT count(DISTINCT ib.id)::int AS total,
              ${productionKpiColumnsSql('ib')},
              count(DISTINCT ib.id) FILTER (WHERE ib.member_of_collective = true)::int AS collective_members,
              count(DISTINCT ib.id) FILTER (WHERE ib.gender = 'Male')::int   AS male,
              count(DISTINCT ib.id) FILTER (WHERE ib.gender = 'Female')::int AS female
       FROM individual_beneficiaries ib
       LEFT JOIN LATERAL (
         SELECT e AS entry, e->>'type' AS type FROM jsonb_array_elements(${effectiveProductionSystemsSql('ib', { legacy: true })}) e
       ) ps ON true
       WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    // Income is encrypted at rest, so it's averaged in app code. Fine at this
    // org's scale (hundreds to low thousands); revisit for much larger rosters.
    const { rows: incomeRows } = await pool.query(
      `SELECT current_income_inr, current_income_inr_enc FROM individual_beneficiaries WHERE ${whereSql}`,
      values
    )
    const incomeValues = incomeRows
      .map(r => Number(decryptRowInPlace('individual_beneficiaries', r).current_income_inr))
      .filter(Number.isFinite)
    const avgIncome = incomeValues.length ? incomeValues.reduce((a, b) => a + b, 0) / incomeValues.length : 0

    const { rows } = await pool.query(
      `SELECT id, uid, name, contact_no, contact_no_enc, state, district, block, panchayat, panchayat_enc, village,
              gender, category, occupation, current_income_inr, current_income_inr_enc, production_type, current_production_ton,
              production_systems, member_of_collective, created_at
       FROM individual_beneficiaries
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )
    rows.forEach(r => decryptRowInPlace('individual_beneficiaries', r))

    // Each dropdown is scoped by its ancestor filters only, so picking a value
    // never removes itself and mismatched State/District picks can't happen.
    const scopedDistinct = (column, ancestors) => {
      const where  = ['org_id = $1', `${column} IS NOT NULL`]
      const vals   = [req.user.orgId]
      for (const [col, val] of ancestors) {
        if (!val) continue
        vals.push(val)
        where.push(`${col} = $${vals.length}`)
      }
      return pool.query(`SELECT DISTINCT ${column} FROM individual_beneficiaries WHERE ${where.join(' AND ')} ORDER BY ${column}`, vals)
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
        total:             kpiRow.total || 0,
        collectiveMembers: kpiRow.collective_members || 0,
        avgIncome:         avgIncome,
        ...productionKpis(kpiRow),
        male:              kpiRow.male || 0,
        female:            kpiRow.female || 0,
      },
      states:    stateRows.map(r => r.state),
      districts: districtRows.map(r => r.district),
      blocks:    blockRows.map(r => r.block),
      villages:  villageRows.map(r => r.village),
    })
  } catch (e) {
    console.error('[individual-beneficiaries GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/individual-beneficiaries/registration-link — get-or-create this org's link
router.get('/individual-beneficiaries/registration-link', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const url = await getOrCreateLink(req.user.orgId)
    res.json({ url })
  } catch (e) {
    console.error('[ib registration-link GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/individual-beneficiaries/registration-link/rotate — invalidate the old link, issue a new one
router.post('/individual-beneficiaries/registration-link/rotate',
  auditRoute('ib.registration_link.rotate', 'organization', { getTargetId: (req) => req.user?.orgId || null, getDiff: () => null }),
  async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool  = getPool()
    const token = crypto.randomBytes(24).toString('hex')
    await pool.query(
      `INSERT INTO ib_registration_tokens (org_id, token, rotated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET token = $2, rotated_at = now()`,
      [req.user.orgId, token]
    )
    const url = await buildLinkUrl(req.user.orgId, token)
    res.json({ url })
  } catch (e) {
    console.error('[ib registration-link rotate]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function getOrCreateLink(orgId) {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT token FROM ib_registration_tokens WHERE org_id = $1`, [orgId])
  let token = rows[0]?.token
  if (!token) {
    // A concurrent insert may win; the no-op update makes RETURNING give the stored token.
    const { rows: ins } = await pool.query(
      `INSERT INTO ib_registration_tokens (org_id, token) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET token = ib_registration_tokens.token
       RETURNING token`,
      [orgId, crypto.randomBytes(24).toString('hex')]
    )
    token = ins[0].token
  }
  return buildLinkUrl(orgId, token)
}

async function buildLinkUrl(orgId, token) {
  const base = (process.env.IB_FORM_BASE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('IB_FORM_BASE_URL is not configured on the server')
  return `${base}/register?org=${encodeURIComponent(orgId)}&key=${encodeURIComponent(token)}`
}

export default router
