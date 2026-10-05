// services/dashboard/src/org-dashboard.js
//
// Read-only, org-scoped roll-up for OrgDashboardPage: projects/budgets,
// financial utilisation, beneficiary footprint, MIS impact indicators and
// income. Action-plan target/achieved stays in /api/action-plans/org-dashboard;
// this supplies the data around it.
//
// Never fabricate: a metric with no backing table returns
// { available: false, value: null }. The FY filter applies only to
// time-stamped data; registry counts are cumulative.
//
//   GET /api/org-dashboard/overview?fy=<fyStartYear>

import { Router } from 'express'
import { getPool } from './pool.js'
import { requireEditor } from '../../../lib/routeGuards.js'
import { decryptRowInPlace } from '../../../lib/piiCrypto.js'

const router = Router()

// Wetland-type resources stand in for "waterbodies" (agricultural land is
// excluded) — same resource_type vocabulary as beneficiary-dashboard.routes.js.
const WATERBODY_TYPES = ['Freshwater Wetland', 'Coastal Wetland', 'Brackish Water']

// FY runs Apr 1 → Mar 31 (same convention as action_plans.year /
// periodMath.currentFY). Returns half-open [start, end) DATE strings.
function fyBounds(fyStartYear) {
  const y = Number(fyStartYear)
  return { start: `${y}-04-01`, end: `${y + 1}-04-01` }
}

// Default FY start year for "today" (IST) under an Apr–Mar fiscal calendar.
// Servers run UTC, so shift by +5:30 before reading the calendar fields.
function defaultFyStartYear() {
  const ist = new Date(Date.now() + 330 * 60 * 1000)
  const y = ist.getUTCFullYear()
  return ist.getUTCMonth() + 1 >= 4 ? y : y - 1
}

function fyLabel(startYear) {
  const end = String((startYear + 1) % 100).padStart(2, '0')
  return `FY${startYear}-${end}`
}

// Run a query, returning its first row (or {}), so one missing table never
// takes down the dashboard. Failures are pushed onto `warnings` so the zeros
// they leave aren't mistaken for real data.
async function safeRow(pool, warnings, label, sql, params) {
  const rows = await safeRows(pool, warnings, label, sql, params)
  return rows[0] || {}
}
async function safeRows(pool, warnings, label, sql, params) {
  try {
    const { rows } = await pool.query(sql, params)
    return rows
  } catch (e) {
    console.error(`[org-dashboard] ${label} failed:`, e)
    warnings.push(label)
    return []
  }
}

const num = v => Number(v) || 0

router.get('/org-dashboard/overview', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId

    const fyStartYear = req.query.fy ? Number(req.query.fy) : defaultFyStartYear()
    if (!Number.isInteger(fyStartYear) || fyStartYear < 2000 || fyStartYear > 2100) {
      return res.status(400).json({ error: 'fy must be a 4-digit FY start year' })
    }
    const warnings = []
    const { start, end } = fyBounds(fyStartYear)
    // income.financial_year is free text (e.g. "2025-26"); loosely match the FY
    // start year in it.
    const fyTextMatch = `%${fyStartYear}%`

    // ── Projects + budget (all active projects; time-based metrics filter by FY) ──
    const projectsRaw = await safeRows(
      pool, warnings, 'projects',
      `SELECT project_key, name, donor, region, year, COALESCE(budget, 0)::float8 AS budget
       FROM action_plans WHERE org_id = $1 AND active
       ORDER BY name`,
      [orgId]
    )

    // Budget/utilised per project follow the Financial Tracker's FY rule
    // (BudgetUtilisationPage.tsx's activeGrant): this FY's grant, else one whose
    // upload period overlaps it, with spend summed over that grant's period.
    // No covering grant → action_plans.budget against this FY's spend.
    const monthRows = await safeRows(
      pool, warnings, 'utilisation',
      `SELECT project_key, period_month::text AS m, COALESCE(SUM(expenses), 0)::float8 AS spent
       FROM budget_utilisation_reports WHERE org_id = $1 GROUP BY 1, 2`,
      [orgId]
    )
    const spendByProject = new Map()
    for (const r of monthRows) {
      if (!spendByProject.has(r.project_key)) spendByProject.set(r.project_key, [])
      spendByProject.get(r.project_key).push(r)
    }
    const grantRows = await safeRows(
      pool, warnings, 'grants',
      `SELECT project_key, fy_start_year, total_budget::float8 AS total_budget,
              period_from::text AS period_from, period_to::text AS period_to
       FROM budget_utilisation_fy_grants WHERE org_id = $1`,
      [orgId]
    )
    const grantsByProject = new Map()
    for (const g of grantRows) {
      if (!grantsByProject.has(g.project_key)) grantsByProject.set(g.project_key, [])
      grantsByProject.get(g.project_key).push(g)
    }
    const fyLastMonth = `${fyStartYear + 1}-03-01`
    const spentBetween = (projectKey, from, to) => (spendByProject.get(projectKey) || [])
      .reduce((s, r) => (r.m >= from && r.m <= to ? s + num(r.spent) : s), 0)

    const projects = projectsRaw.map(p => {
      const grants = grantsByProject.get(p.project_key) || []
      const grant = grants.find(g => g.fy_start_year === fyStartYear)
        || grants.find(g => g.period_from && g.period_to && g.period_from <= fyLastMonth && g.period_to >= start)
      let budget, utilised
      if (grant) {
        budget = num(grant.total_budget)
        utilised = grant.period_from && grant.period_to
          ? spentBetween(p.project_key, grant.period_from, grant.period_to)
          : spentBetween(p.project_key, start, fyLastMonth)
      } else {
        // No grant covers this FY — fall back to action_plans.budget.
        budget = num(p.budget)
        utilised = spentBetween(p.project_key, start, fyLastMonth)
      }
      return {
        project_key: p.project_key,
        name: p.name,
        programPartner: p.donor || '—',
        region: p.region || '—',
        budget,
        budgetFmt: '₹' + Math.round(budget).toLocaleString('en-IN'),
        utilised,
        utilisedFmt: '₹' + Math.round(utilised).toLocaleString('en-IN'),
        utilisedPct: budget > 0 ? Math.round((utilised / budget) * 100) : 0,
      }
    })
    const totalBudget = projects.reduce((s, p) => s + p.budget, 0)
    const totalUtilised = projects.reduce((s, p) => s + p.utilised, 0)

    // ── Footprint (cumulative — registries are current-state rosters) ──
    const coverage = await safeRow(
      pool, warnings, 'coverage',
      `SELECT count(DISTINCT state) AS states, count(DISTINCT district) AS districts,
              count(DISTINCT block) AS blocks, count(DISTINCT panchayat) AS panchayats,
              count(DISTINCT village) AS villages
       FROM (
         SELECT state, district, block, panchayat, village FROM individual_beneficiaries WHERE org_id = $1
         UNION ALL
         SELECT state, district, block, panchayat, village FROM micro_entrepreneurs      WHERE org_id = $1
         UNION ALL
         SELECT state, district, block, panchayat, village FROM collectives              WHERE org_id = $1
       ) c`,
      [orgId]
    )

    const ib = await safeRow(
      pool, warnings, 'ib',
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE gender = 'Female')::int AS female,
              COALESCE(SUM(current_production_ton), 0)::float8 AS production
       FROM individual_beneficiaries WHERE org_id = $1`,
      [orgId]
    )
    // current_revenue_inr is encrypted at rest for newer rows (piiCrypto.js),
    // so SQL can't SUM it — decrypt and add up here, like the ME list route.
    const meRows = await safeRows(
      pool, warnings, 'me',
      `SELECT current_revenue_inr, current_revenue_inr_enc, current_employee_count
       FROM micro_entrepreneurs WHERE org_id = $1`,
      [orgId]
    )
    const me = {
      total: meRows.length,
      revenue: meRows.reduce((sum, r) => sum + num(decryptRowInPlace('micro_entrepreneurs', r).current_revenue_inr), 0),
      employees: meRows.reduce((sum, r) => sum + num(r.current_employee_count), 0),
    }
    const cb = await safeRow(
      pool, warnings, 'cb',
      `SELECT count(*)::int AS total,
              COALESCE(SUM(female_count), 0)::int AS female,
              COALESCE(SUM(current_revenue_inr), 0)::float8 AS revenue,
              COALESCE(SUM(current_production_ton), 0)::float8 AS production,
              COALESCE(SUM(credit_access_inr), 0)::float8 AS credit
       FROM collectives WHERE org_id = $1`,
      [orgId]
    )

    const directBeneficiaries = num(ib.total) + num(me.total) + num(cb.total)

    const waterbodies = await safeRow(
      pool, warnings, 'waterbodies',
      `SELECT count(*)::int AS total, COALESCE(SUM(area_acre), 0)::float8 AS area
       FROM resources WHERE org_id = $1 AND resource_type = ANY($2)`,
      [orgId, WATERBODY_TYPES]
    )

    // ── Impact activity tables (FY-filtered on their own date columns) ──
    const income = await safeRow(
      pool, warnings, 'income',
      `SELECT COALESCE(SUM(income_realised), 0)::float8 AS total,
              count(DISTINCT beneficiary_uid)::int AS beneficiaries
       FROM income WHERE org_id = $1 AND financial_year ILIKE $2`,
      [orgId, fyTextMatch]
    )
    const credit = await safeRow(
      pool, warnings, 'credit',
      `SELECT count(*)::int AS total, COALESCE(SUM(amount), 0)::float8 AS amount,
              count(DISTINCT beneficiary_uid)::int AS beneficiaries
       FROM credit_grant_access
       WHERE org_id = $1 AND access_date >= $2 AND access_date < $3`,
      [orgId, start, end]
    )
    const scheme = await safeRow(
      pool, warnings, 'scheme',
      `SELECT count(*)::int AS total, count(DISTINCT beneficiary_uid)::int AS beneficiaries
       FROM scheme_access
       WHERE org_id = $1 AND access_date >= $2 AND access_date < $3`,
      [orgId, start, end]
    )
    const training = await safeRow(
      pool, warnings, 'training',
      `SELECT count(*)::int AS total, count(DISTINCT beneficiary_uid)::int AS beneficiaries
       FROM trainings
       WHERE org_id = $1 AND training_date >= $2 AND training_date < $3`,
      [orgId, start, end]
    )
    const campaign = await safeRow(
      pool, warnings, 'campaign',
      `SELECT count(*)::int AS total, COALESCE(SUM(total_attendees), 0)::int AS attendees
       FROM campaign
       WHERE org_id = $1 AND campaign_date >= $2 AND campaign_date < $3`,
      [orgId, start, end]
    )
    const convergence = await safeRow(
      pool, warnings, 'convergence',
      `SELECT COALESCE(SUM(convergence_amount), 0)::float8 AS amount
       FROM beneficiary_mis_records WHERE org_id = $1`,
      [orgId]
    )
    const waContacts = await safeRow(
      pool, warnings, 'wa_contacts',
      `SELECT count(*)::int AS total FROM wa_contacts WHERE org_id = $1`,
      [orgId]
    )

    const womenEngaged = num(ib.female) + num(cb.female)
    const totalRevenue = num(me.revenue) + num(cb.revenue)
    const totalProduction = num(ib.production) + num(cb.production)
    const totalCredit = num(credit.amount) + num(cb.credit)

    // ── Impact indicator grid (the user's spec order). `available:false` for
    //    anything with no backing data — the UI renders those as "Not tracked". ─
    const rupees = v => '₹' + Math.round(v).toLocaleString('en-IN')
    const impact = [
      { key: 'income',        label: 'Income Enhanced',            value: rupees(num(income.total)), available: num(income.total) > 0 || num(income.beneficiaries) > 0, note: `${num(income.beneficiaries)} beneficiaries, ${fyLabel(fyStartYear)}` },
      { key: 'enterprises',   label: 'Enterprises Supported',      value: String(num(me.total)),     available: true, note: 'Registered micro-entrepreneurs' },
      { key: 'convergence',   label: 'Convergence Support',        value: rupees(num(convergence.amount)), available: num(convergence.amount) > 0, note: 'From MIS records' },
      { key: 'reach',         label: 'Beneficiary Reach',          value: String(directBeneficiaries), available: true, note: 'Direct beneficiaries (all registries)' },
      { key: 'hhIncome',      label: 'Avg HH Income',              value: rupees(num(income.beneficiaries) > 0 ? num(income.total) / num(income.beneficiaries) : 0), available: num(income.beneficiaries) > 0, note: 'Realised income per beneficiary' },
      { key: 'production',    label: 'Production',                  value: `${Math.round(totalProduction).toLocaleString('en-IN')} t`, available: totalProduction > 0, note: 'Current production (tonnes)' },
      { key: 'productivity',  label: 'Productivity Enhanced',      value: null, available: false, note: 'Not tracked yet' },
      { key: 'credit',        label: 'Access to Credit',           value: rupees(totalCredit), available: totalCredit > 0, note: `${num(credit.beneficiaries)} beneficiaries` },
      { key: 'scheme',        label: 'Scheme Access',              value: String(num(scheme.total)), available: num(scheme.total) > 0, note: `${num(scheme.beneficiaries)} beneficiaries` },
      { key: 'institution',   label: 'Institution Strengthening',  value: null, available: false, note: 'Not tracked yet' },
      { key: 'women',         label: 'Women Engagement',           value: String(womenEngaged), available: womenEngaged > 0, note: 'Female beneficiaries + collective members' },
      { key: 'revenue',       label: 'Revenue Enhanced',           value: rupees(totalRevenue), available: totalRevenue > 0, note: 'Enterprises + collectives' },
      { key: 'employment',    label: 'Employment Generated',       value: String(num(me.employees)), available: num(me.employees) > 0, note: 'Jobs at supported enterprises' },
      { key: 'wetland',       label: 'Wetland Rejuvenation',       value: null, available: false, note: 'Not tracked yet' },
      { key: 'training',      label: 'Training Engagement',        value: String(num(training.total)), available: num(training.total) > 0, note: `${num(training.beneficiaries)} beneficiaries trained` },
      { key: 'campaigns',     label: 'Campaigns',                  value: String(num(campaign.total)), available: num(campaign.total) > 0, note: `${num(campaign.attendees).toLocaleString('en-IN')} attendees` },
      { key: 'govtProgram',   label: 'Partnership w/ Govt',        value: null, available: false, note: 'Not tracked yet' },
      { key: 'adoption',      label: 'Govt Adoption of Approach',  value: null, available: false, note: 'Not tracked yet' },
      { key: 'resources',     label: 'Resources Published',        value: null, available: false, note: 'Not tracked yet' },
      { key: 'partnerships',  label: 'Institutional Partnerships', value: null, available: false, note: 'Not tracked yet' },
    ]

    // ── System drops: beneficiary → outcome funnel ──────────────────────────
    // Where the biggest step-to-step % fall is = the org's biggest leak.
    const funnel = [
      { key: 'registered', label: 'Registered',        count: directBeneficiaries },
      { key: 'trained',    label: 'Trained',           count: num(training.beneficiaries) },
      { key: 'supported',  label: 'Credit / Scheme',   count: num(credit.beneficiaries) + num(scheme.beneficiaries) },
      { key: 'income',     label: 'Income Recorded',   count: num(income.beneficiaries) },
    ].map((s, i, arr) => {
      const prev = i === 0 ? s.count : arr[i - 1].count
      return {
        ...s,
        pctOfStart: directBeneficiaries > 0 ? Math.round((s.count / directBeneficiaries) * 100) : 0,
        dropFromPrev: i === 0 ? 0 : (prev > 0 ? Math.round(((prev - s.count) / prev) * 100) : 0),
      }
    })

    // ── Derived barriers (rule-based, data-backed) ──────────────────────────
    const barriers = []
    const underspent = projects.filter(p => p.budget > 0 && p.utilisedPct < 40)
    if (underspent.length) {
      barriers.push({
        severity: underspent.length > projects.length / 2 ? 'red' : 'amber',
        title: 'Budget under-utilisation',
        detail: `${underspent.length} project${underspent.length > 1 ? 's' : ''} below 40% spend this FY (${underspent.slice(0, 3).map(p => `${p.name} ${p.utilisedPct}%`).join(', ')}${underspent.length > 3 ? '…' : ''}). Funds are not converting into field activity.`,
      })
    }
    const trainedGap = directBeneficiaries - num(training.beneficiaries)
    if (directBeneficiaries > 0 && num(training.beneficiaries) / directBeneficiaries < 0.5) {
      barriers.push({
        severity: 'amber',
        title: 'Low training coverage',
        detail: `${trainedGap.toLocaleString('en-IN')} of ${directBeneficiaries.toLocaleString('en-IN')} registered beneficiaries have no recorded training this FY (${Math.round((num(training.beneficiaries) / directBeneficiaries) * 100)}% covered).`,
      })
    }
    if (num(training.beneficiaries) > 0 && num(income.beneficiaries) / Math.max(1, num(training.beneficiaries)) < 0.4) {
      barriers.push({
        severity: 'red',
        title: 'Outcome conversion drop',
        detail: `Only ${num(income.beneficiaries).toLocaleString('en-IN')} beneficiaries have recorded income vs ${num(training.beneficiaries).toLocaleString('en-IN')} trained — training is not yet translating into income.`,
      })
    }
    const noBudget = projects.filter(p => p.budget === 0)
    if (noBudget.length) {
      barriers.push({
        severity: 'amber',
        title: 'Missing budget data',
        detail: `${noBudget.length} active project${noBudget.length > 1 ? 's have' : ' has'} no budget recorded, so utilisation can't be tracked (${noBudget.slice(0, 3).map(p => p.name).join(', ')}${noBudget.length > 3 ? '…' : ''}).`,
      })
    }

    // ── Next steps (actionable, from barriers + funnel) ─────────────────────
    const nextSteps = []
    if (underspent.length) {
      const worst = underspent.reduce((a, b) => (a.utilisedPct <= b.utilisedPct ? a : b))
      nextSteps.push(`Accelerate spend on ${worst.name} (only ${worst.utilisedPct}% utilised) — review disbursement blockers with the project lead.`)
    }
    // Biggest funnel drop → the step to fix first
    const biggestDrop = funnel.slice(1).reduce((a, b) => (b.dropFromPrev > a.dropFromPrev ? b : a), { dropFromPrev: 0, label: '' })
    if (biggestDrop.dropFromPrev >= 40 && biggestDrop.label) {
      nextSteps.push(`Plug the largest drop-off at the "${biggestDrop.label}" stage (${biggestDrop.dropFromPrev}% fall) — target the beneficiaries who reached the previous stage but not this one.`)
    }
    if (trainedGap > 0 && directBeneficiaries > 0 && num(training.beneficiaries) / directBeneficiaries < 0.5) {
      nextSteps.push(`Schedule training for the ${trainedGap.toLocaleString('en-IN')} registered-but-untrained beneficiaries to lift coverage above 50%.`)
    }
    if (impact.filter(m => !m.available).length >= 5) {
      nextSteps.push(`Start capturing the ${impact.filter(m => !m.available).length} indicators still marked "Not tracked yet" (e.g. productivity, govt partnerships, resources published) to complete the impact picture.`)
    }
    if (!nextSteps.length) {
      nextSteps.push('No critical gaps detected for this FY — maintain current reporting cadence and keep MIS entries up to date.')
    }

    // Available FYs for the filter dropdown (from action plans + finance).
    const fyRows = await safeRows(
      pool, warnings, 'availableFYs',
      `SELECT DISTINCT year FROM action_plans WHERE org_id = $1 AND year IS NOT NULL
       UNION
       SELECT DISTINCT EXTRACT(YEAR FROM (period_month - INTERVAL '3 months'))::int AS year
       FROM budget_utilisation_reports WHERE org_id = $1
       ORDER BY year DESC`,
      [orgId]
    )
    const availableFYs = fyRows.map(r => Number(r.year)).filter(Boolean)
    if (!availableFYs.includes(fyStartYear)) availableFYs.unshift(fyStartYear)

    res.json({
      filters: { fyStartYear, fyLabel: fyLabel(fyStartYear), availableFYs },
      totals: {
        activeProjects: projects.length,
        totalBudget,
        totalBudgetFmt: '₹' + Math.round(totalBudget).toLocaleString('en-IN'),
        totalUtilised,
        totalUtilisedFmt: '₹' + Math.round(totalUtilised).toLocaleString('en-IN'),
        utilisedPct: totalBudget > 0 ? Math.round((totalUtilised / totalBudget) * 100) : 0,
      },
      projects,
      footprint: {
        districts: num(coverage.districts),
        blocks: num(coverage.blocks),
        panchayats: num(coverage.panchayats),
        villages: num(coverage.villages),
        directBeneficiaries,
        institutionalPartnerships: { value: num(cb.total), available: num(cb.total) > 0, note: 'Collectives (proxy)' },
        waterbodies: { value: num(waterbodies.total), available: num(waterbodies.total) > 0, note: `${Math.round(num(waterbodies.area)).toLocaleString('en-IN')} acre` },
      },
      digitalFootprint: [
        { key: 'chatbot',  label: 'Chatbot Users', value: num(waContacts.total) ? String(num(waContacts.total)) : null, available: num(waContacts.total) > 0, note: 'WhatsApp contacts' },
        { key: 'resolved', label: '% Query Resolved', value: null, available: false, note: 'Not tracked yet' },
        { key: 'lms',      label: 'LMS Users', value: null, available: false, note: 'Not tracked yet' },
        { key: 'aquatalk', label: 'Aquatalk Users', value: null, available: false, note: 'Not tracked yet' },
      ],
      impact,
      funnel,
      barriers,
      nextSteps,
      warnings,
    })
  } catch (e) {
    console.error('[org-dashboard/overview]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
