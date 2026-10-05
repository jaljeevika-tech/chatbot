// Resource roster (043): Wetland / Agricultural Land mapped to a beneficiary,
// written only by the services/resource microservice. Mirrors
// individual-beneficiaries.routes.js (read-only roster, admin-only links).
//
//   GET  /api/resources                          — list + KPIs
//   GET  /api/resources/registration-link         — get-or-create link
//   POST /api/resources/registration-link/rotate  — invalidate + reissue

import { Router } from 'express'
import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'

const router = Router()

// GET /api/resources?resource_type=&beneficiary_type=&search=&page=
router.get('/resources', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { resource_type, beneficiary_type, search } = req.query
    const page     = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = 50

    const where  = ['org_id = $1']
    const values = [req.user.orgId]
    const addFilter = (col, val) => {
      if (!val) return
      values.push(val)
      where.push(`${col} = $${values.length}`)
    }
    addFilter('resource_type', resource_type)
    addFilter('beneficiary_type', beneficiary_type)
    if (search) {
      values.push(`%${search}%`)
      where.push(`(uid ILIKE $${values.length} OR beneficiary_uid ILIKE $${values.length} OR beneficiary_name ILIKE $${values.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE resource_type = 'Freshwater Wetland')::int AS freshwater_wetland,
              count(*) FILTER (WHERE resource_type = 'Coastal Wetland')::int AS coastal_wetland,
              count(*) FILTER (WHERE resource_type = 'Agricultural Land')::int AS agricultural_land,
              count(*) FILTER (WHERE resource_type = 'Brackish Water')::int AS brackish_water,
              coalesce(sum(area_acre), 0) AS total_area,
              coalesce(sum(raft_count), 0) AS total_raft_count
       FROM resources WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    // Resource Utility is a JSONB array whose shape varies by branch (045), so
    // per-utility totals need unnesting.
    const { rows: utilityRows } = await pool.query(
      `SELECT u->>'utility' AS utility, count(*)::int AS resource_count,
              coalesce(sum((u->>'production_kg')::numeric), 0) AS total_kg
       FROM resources, jsonb_array_elements(resource_utility) AS u
       WHERE ${whereSql}
       GROUP BY u->>'utility'
       ORDER BY total_kg DESC`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, uid, resource_type, beneficiary_uid, beneficiary_type, beneficiary_name,
              latitude, longitude, area_acre, water_body_type, resource_access,
              wetland_structure, raft_count, resource_utility, created_at
       FROM resources
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )

    res.json({
      rows,
      totalRows: kpiRow.total || 0,
      page,
      pageSize,
      kpis: {
        total:              kpiRow.total || 0,
        freshwaterWetland:  kpiRow.freshwater_wetland || 0,
        coastalWetland:     kpiRow.coastal_wetland || 0,
        agriculturalLand:   kpiRow.agricultural_land || 0,
        brackishWater:      kpiRow.brackish_water || 0,
        totalArea:          Number(kpiRow.total_area) || 0,
        totalRaftCount:     kpiRow.total_raft_count || 0,
      },
      utilityBreakdown: utilityRows.map(r => ({
        utility: r.utility, resourceCount: r.resource_count, totalKg: Number(r.total_kg) || 0,
      })),
    })
  } catch (e) {
    console.error('[resources GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/resources/registration-link — get-or-create this org's link
router.get('/resources/registration-link', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const url = await getOrCreateLink(req.user.orgId)
    res.json({ url })
  } catch (e) {
    console.error('[rs registration-link GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/resources/registration-link/rotate — invalidate the old link, issue a new one
router.post('/resources/registration-link/rotate', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool  = getPool()
    const token = crypto.randomBytes(24).toString('hex')
    await pool.query(
      `INSERT INTO rs_registration_tokens (org_id, token, rotated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET token = $2, rotated_at = now()`,
      [req.user.orgId, token]
    )
    const url = await buildLinkUrl(req.user.orgId, token)
    res.json({ url })
  } catch (e) {
    console.error('[rs registration-link rotate]', e.message)
    res.status(500).json({ error: e.message })
  }
})

async function getOrCreateLink(orgId) {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT token FROM rs_registration_tokens WHERE org_id = $1`, [orgId])
  let token = rows[0]?.token
  if (!token) {
    // A concurrent insert may win; the no-op update makes RETURNING give the stored token.
    const { rows: ins } = await pool.query(
      `INSERT INTO rs_registration_tokens (org_id, token) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET token = rs_registration_tokens.token
       RETURNING token`,
      [orgId, crypto.randomBytes(24).toString('hex')]
    )
    token = ins[0].token
  }
  return buildLinkUrl(orgId, token)
}

async function buildLinkUrl(orgId, token) {
  const base = (process.env.RS_FORM_BASE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('RS_FORM_BASE_URL is not configured on the server')
  return `${base}/register?org=${encodeURIComponent(orgId)}&key=${encodeURIComponent(token)}`
}

export default router
