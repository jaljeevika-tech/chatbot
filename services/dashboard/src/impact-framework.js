// services/dashboard/src/impact-framework.js
//
// Read-only rollup for the Impact Dashboard's 17-indicator framework panel.
// Keys match IMPACT_FRAMEWORK[].key in src/utils/impactMetrics.ts; indicators
// with no data source return null (rendered "—", never a fabricated zero).
//
// ?projectKey= scoping: MIS tables filter on their own project_key; registries
// and resources have none, so they match via beneficiary_project_links.
//
//   GET /api/impact/framework[?projectKey=<key>]   (requireEditor)

import { Router } from 'express'
import { getPool } from './pool.js'
import { requireEditor } from '../../../lib/routeGuards.js'
import { decryptRowInPlace } from '../../../lib/piiCrypto.js'

const router = Router()

// A female gender value, tolerant of the free-text casing/abbreviations the MIS
// upload templates allow ("Female", "female", "F").
const FEMALE_PREDICATE = `LOWER(TRIM(COALESCE(gender, ''))) IN ('female', 'f', 'woman', 'women')`

// Project-scope fragment for a beneficiary registry (no project_key of its
// own): match uid against a link row for the fixed beneficiary_type.
// typeLiteral is a CHECK-constrained constant, never user input, so it's
// safe to inline. Empty string when org-wide.
function benefScope(uidCol, typeLiteral, projectKey) {
  return projectKey
    ? `AND ${uidCol} IN (SELECT beneficiary_uid FROM beneficiary_project_links
         WHERE org_id = $1 AND beneficiary_type = '${typeLiteral}' AND project_key = $2)`
    : ''
}

// Project-scope fragment for the resources registry, which spans every
// beneficiary_type — match on the (uid, type) pair rather than a fixed type.
function resourceScope(projectKey) {
  return projectKey
    ? `AND (beneficiary_uid, beneficiary_type) IN (
         SELECT beneficiary_uid, beneficiary_type FROM beneficiary_project_links
         WHERE org_id = $1 AND project_key = $2)`
    : ''
}

// Project-scope fragment for a MIS activity table (has its own project_key).
function misScope(projectKey) {
  return projectKey ? `AND project_key = $2` : ''
}

router.get('/impact/framework', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = String(req.query.projectKey || '').trim() || null
    const args = projectKey ? [orgId, projectKey] : [orgId]

    // A failed query yields null (the panel shows "—") and is listed in
    // `warnings`, rather than passing for a real zero.
    const warnings = []
    const fail = (label) => (e) => {
      console.error(`[impact/framework] ${label} failed:`, e)
      warnings.push(label)
      return null
    }
    const q = (sql, label) => pool.query(sql, args).then(r => r.rows[0] || {}).catch(fail(label))

    const IB  = benefScope('uid', 'Individual Beneficiary', projectKey)
    const ME  = benefScope('uid', 'Micro-Entrepreneur',     projectKey)
    const CB  = benefScope('uid', 'Collective',             projectKey)
    const IND = benefScope('uid', 'Indirect Beneficiary',   projectKey)
    const RES = resourceScope(projectKey)
    const MIS = misScope(projectKey)

    const [
      benef, women, production, institutions, income, credit,
      scheme, revenue, employment, training, campaigns, wetland,
      projectsResult, meRevenueRows,
    ] = await Promise.all([
      // Beneficiary reach — every registered beneficiary across the four registries.
      q(`SELECT (
           (SELECT count(*) FROM individual_beneficiaries WHERE org_id = $1 ${IB}) +
           (SELECT count(*) FROM micro_entrepreneurs      WHERE org_id = $1 ${ME}) +
           (SELECT count(*) FROM collectives              WHERE org_id = $1 ${CB}) +
           (SELECT count(*) FROM indirect_beneficiaries   WHERE org_id = $1 ${IND})
         )::int AS v`, 'beneficiary_reach'),
      // Women engagement — female IBs + female MEs + collective female headcount.
      q(`SELECT (
           (SELECT count(*) FROM individual_beneficiaries WHERE org_id = $1 AND ${FEMALE_PREDICATE} ${IB}) +
           (SELECT count(*) FROM micro_entrepreneurs      WHERE org_id = $1 AND ${FEMALE_PREDICATE} ${ME}) +
           (SELECT COALESCE(SUM(female_count), 0) FROM collectives WHERE org_id = $1 ${CB})
         )::int AS v`, 'women_engagement'),
      // Production enhancement (MT) — registered production tonnage.
      q(`SELECT (
           (SELECT COALESCE(SUM(current_production_ton), 0) FROM individual_beneficiaries WHERE org_id = $1 ${IB}) +
           (SELECT COALESCE(SUM(current_production_ton), 0) FROM collectives              WHERE org_id = $1 ${CB})
         )::float8 AS v`, 'production_enhancement'),
      // Institution strengthening / building — count of collectives (FPO/SHG/Coop…).
      q(`SELECT count(*)::int AS v FROM collectives WHERE org_id = $1 ${CB}`, 'institution_building'),
      // HH income enhanced (INR) — realised income logged in the MIS Income activity.
      q(`SELECT COALESCE(SUM(income_realised), 0)::float8 AS v FROM income WHERE org_id = $1 ${MIS}`, 'hh_income'),
      // Access to credit (INR) — credit/grant amounts logged in the MIS activity.
      q(`SELECT COALESCE(SUM(amount), 0)::float8 AS v FROM credit_grant_access WHERE org_id = $1 ${MIS}`, 'credit_access'),
      // Scheme access — count of scheme-access records.
      q(`SELECT count(*)::int AS v FROM scheme_access WHERE org_id = $1 ${MIS}`, 'scheme_access'),
      // Revenue enhanced (INR) — enterprise + collective revenue.
      // micro_entrepreneurs.current_revenue_inr is encrypted for newer rows,
      // so that half is decrypted and summed below instead of in SQL.
      q(`SELECT COALESCE(SUM(current_revenue_inr), 0)::float8 AS v FROM collectives WHERE org_id = $1 ${CB}`, 'revenue_enhanced'),
      // Employment generated — headcount employed by micro-entrepreneurs.
      q(`SELECT COALESCE(SUM(current_employee_count), 0)::int AS v FROM micro_entrepreneurs WHERE org_id = $1 ${ME}`, 'employment_generated'),
      // Training engagement — count of training records.
      q(`SELECT count(*)::int AS v FROM trainings WHERE org_id = $1 ${MIS}`, 'training_engagement'),
      // No. of campaigns — count of campaign events.
      q(`SELECT count(*)::int AS v FROM campaign WHERE org_id = $1 ${MIS}`, 'campaigns'),
      // Wetland rejuvenation (Acre) — mapped wetland area.
      q(`SELECT COALESCE(SUM(area_acre), 0)::float8 AS v FROM resources WHERE org_id = $1 AND resource_type = 'Wetland' ${RES}`, 'wetland_rejuvenation'),
      // Project list for the panel's selector (org-wide; always $1 only).
      pool.query(
        `SELECT project_key, name FROM action_plans
         WHERE org_id = $1 AND active = true
         ORDER BY year DESC, name`,
        [orgId]
      ).then(r => r.rows).catch(e => { fail('projects')(e); return [] }),
      pool.query(
        `SELECT current_revenue_inr, current_revenue_inr_enc FROM micro_entrepreneurs WHERE org_id = $1 ${ME}`,
        args
      ).then(r => r.rows).catch(fail('revenue_enhanced')),
    ])

    const num = (r) => (r === null ? null : r.v != null ? Number(r.v) : 0)
    const meRevenue = meRevenueRows === null ? null : meRevenueRows.reduce(
      (sum, r) => sum + (Number(decryptRowInPlace('micro_entrepreneurs', r).current_revenue_inr) || 0), 0)

    res.json({
      projectKey,
      projects: projectsResult.map(p => ({ project_key: p.project_key, name: p.name || p.project_key })),
      values: {
        beneficiary_reach:        num(benef),
        training_engagement:      num(training),
        campaigns:                num(campaigns),
        production_enhancement:   num(production),
        institution_building:     num(institutions),
        women_engagement:         num(women),
        partnership_govt:         null, // no MIS source yet
        resources_published:      null, // no MIS source yet
        partnership_institutions: null, // no MIS source yet
        hh_income:                num(income),
        productivity_pct:         null, // needs baseline/endline — no MIS source yet
        credit_access:            num(credit),
        scheme_access:            num(scheme),
        revenue_enhanced:         num(revenue) === null || meRevenue === null ? null : num(revenue) + meRevenue,
        employment_generated:     num(employment),
        wetland_rejuvenation:     num(wetland),
        adoption_govt:            null, // no MIS source yet
      },
      generatedAt: new Date().toISOString(),
      warnings,
    })
  } catch (e) {
    console.error('[impact/framework GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
