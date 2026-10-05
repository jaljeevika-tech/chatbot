// Org-wide roll-ups across all active plans: /action-plans/impact (Impact Dashboard)
// and /action-plans/org-dashboard.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { currentFY, toSqlDate } from '../../lib/dataCorrectness/periodMath.js'
import { requireEditor } from '../../lib/routeGuards.js'
import { healthFromTargets, aggregateActionPlans } from './helpers.js'

const router = Router()

// GET /api/action-plans/impact — org-wide aggregation across ALL action plans.
// Returns per-project totals, category breakdown, location breakdown, monthly trend.
// Used by the Impact Dashboard to show "all projects at a glance".
router.get('/action-plans/impact', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId

    const { perProject, byCategory, byLocation, byMonth, byActivity, MONTHS } = await aggregateActionPlans(orgId)

    // Beneficiaries from daily_reports over the org's fiscal year
    // (metadata.fiscal_year_start, default April); rolling 12 months if that lookup fails.
    const { rows: orgMetaRows } = await pool.query(
      `SELECT metadata FROM organizations WHERE id = $1 LIMIT 1`,
      [orgId]
    ).catch(() => ({ rows: [] }))
    const orgMeta = orgMetaRows[0]?.metadata || {}
    const fy = currentFY(orgMeta)
    const { rows: benefRows } = await pool.query(
      `SELECT COALESCE(SUM(beneficiaries), 0)::int AS total,
              COUNT(*)::int AS reports
       FROM daily_reports
       WHERE org_id = $1
         AND report_date >= $2::date
         AND report_date <  $3::date`,
      [orgId, toSqlDate(fy.start), toSqlDate(fy.end)]
    ).catch(() => ({ rows: [{ total: 0, reports: 0 }] }))

    // ── Totals + sort ───────────────────────────────────────────────────────
    const projects = Array.from(perProject.values())
      .map(p => ({ ...p, pct: p.target > 0 ? Math.round((p.achieved / p.target) * 100) : 0 }))
      .sort((a, b) => (b.target || 0) - (a.target || 0))

    const totalTarget   = projects.reduce((s, p) => s + p.target,   0)
    const totalAchieved = projects.reduce((s, p) => s + p.achieved, 0)

    const categoryArr = Object.entries(byCategory)
      .map(([id, v]) => ({ id, ...v, pct: v.target > 0 ? Math.round((v.achieved / v.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    const locationArr = Object.entries(byLocation)
      .map(([name, v]) => ({ name, ...v, pct: v.target > 0 ? Math.round((v.achieved / v.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    const monthArr = MONTHS.map(m => ({
      month: m,
      target:   byMonth[m].target,
      achieved: byMonth[m].achieved,
    }))

    const activitiesArr = Array.from(byActivity.values())
      .map(a => ({ ...a, pct: a.target > 0 ? Math.round((a.achieved / a.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    // Top 3 activity names per category, for compact display on Category cards
    const topActivitiesByCategory = {}
    for (const a of activitiesArr) {
      const c = a.category || 'capacity'
      if (!topActivitiesByCategory[c]) topActivitiesByCategory[c] = []
      if (topActivitiesByCategory[c].length < 3) topActivitiesByCategory[c].push(a.name)
    }
    const categoryArrEnriched = categoryArr.map(c => ({
      ...c,
      activities_count: activitiesArr.filter(a => (a.category || 'capacity') === c.id).length,
      top_activities:   topActivitiesByCategory[c.id] || [],
    }))

    res.json({
      totals: {
        projects_count: projects.length,
        activities_count: activitiesArr.length,
        target:   totalTarget,
        achieved: totalAchieved,
        pct:      totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0,
        beneficiaries_reached: benefRows[0]?.total ?? 0,
        reports_filed:         benefRows[0]?.reports ?? 0,
      },
      projects,
      by_category: categoryArrEnriched,
      by_location: locationArr,
      by_month:    monthArr,
      activities:  activitiesArr,
    })
  } catch (e) {
    console.error('[action-plans/impact]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/org-dashboard — the /impact aggregation reshaped for the
// Org Dashboard (KPIs, growth chart, health summary, comparison table).
router.get('/action-plans/org-dashboard', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId

    // Seed-merged target/achieved, as in GET /api/action-plans.
    const { plans, perProject, byMonth, MONTHS } = await aggregateActionPlans(orgId)
    const projectKeys = plans.map(p => p.project_key)

    // `utilised` live from budget_utilisation_reports — see GET /api/action-plans.
    const { rows: budgetRows } = await pool.query(
      `SELECT project_key, COALESCE(SUM(expenses), 0)::numeric AS utilised
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = ANY($2) GROUP BY project_key`,
      [orgId, projectKeys]
    ).catch(() => ({ rows: [] }))
    const utilisedByProject = new Map(budgetRows.map(r => [r.project_key, Number(r.utilised)]))

    const totalTarget = Array.from(perProject.values()).reduce((s, v) => s + v.target, 0)
    let cumTarget = 0, cumAchieved = 0
    const combinedChart = MONTHS.map(m => {
      cumTarget   += byMonth[m].target
      cumAchieved += byMonth[m].achieved
      return {
        month: m,
        planPct:   totalTarget > 0 ? Math.round((cumTarget   / totalTarget) * 100) : 0,
        actualPct: totalTarget > 0 ? Math.round((cumAchieved / totalTarget) * 100) : 0,
      }
    })

    const healthCounts = { green: 0, amber: 0, red: 0 }
    const projectRows = plans.map(p => {
      const t = perProject.get(p.project_key) || { target: 0, achieved: 0 }
      const budget = Number(p.budget) || 0
      const utilised = utilisedByProject.get(p.project_key) || 0
      const target = t.target > 0 ? Math.round((t.achieved / t.target) * 100) : 0
      const budgetUsed = budget > 0 ? Math.round((utilised / budget) * 100) : 0
      const health = p.health_override || healthFromTargets(t.target, t.achieved)
      healthCounts[health] = (healthCounts[health] || 0) + 1
      return {
        project_key: p.project_key,
        name: p.name,
        budgetFmt: '₹' + Math.round(budget).toLocaleString('en-IN'),
        budgetUsed, target, health,
      }
    })

    const totalAchieved = Array.from(perProject.values()).reduce((s, v) => s + v.achieved, 0)
    res.json({
      kpis: [
        { label: 'Active Projects', value: String(plans.length), note: '', fg: '#5C7378' },
        { label: 'Annual Target', value: String(Math.round(totalTarget)), note: '', fg: '#5C7378' },
        { label: 'Achieved', value: String(Math.round(totalAchieved)), note: '', fg: '#5C7378' },
        { label: 'Overall Achievement', value: `${totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0}%`, note: '', fg: '#5C7378' },
      ],
      combinedChart,
      healthSummary: [
        { key: 'green', label: 'On Track',   count: healthCounts.green },
        { key: 'amber', label: 'At Risk',    count: healthCounts.amber },
        { key: 'red',   label: 'Critical',   count: healthCounts.red },
      ],
      projectRows,
    })
  } catch (e) {
    console.error('[action-plans/org-dashboard]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
