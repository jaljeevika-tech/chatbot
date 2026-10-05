// MIS dashboard (spec §10): KPIs, chart series and the indicator table, computed by
// lib/misCalculations.js from mis-entries' rows. Never mixes units: cross-indicator
// charts use percentages or counts; raw plan/actual needs a focusIndicatorId.
//
//   GET /api/projects/:projectKey/mis-dashboard?fy_start_year=&month=&level=&scope=&scope_value=&focusIndicatorId=
//   GET /api/projects/:projectKey/indicators/:id/drilldown?fy_start_year=

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { computeIndicatorMetrics, MONTHS } from '../lib/misCalculations.js'

const router = Router()

function average(nums) {
  const vals = nums.filter(n => n !== null && n !== undefined)
  if (!vals.length) return null
  return vals.reduce((s, n) => s + n, 0) / vals.length
}

router.get('/projects/:projectKey/mis-dashboard', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const fyStartYear = parseInt(req.query.fy_start_year)
    const month = req.query.month
    if (!Number.isInteger(fyStartYear)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${MONTHS.join(', ')}` })
    const level = (req.query.level || '').trim()
    const scope = req.query.scope || 'project'
    const scopeValue = req.query.scope_value || null

    const where = ['org_id = $1', 'project_key = $2', 'archived_at IS NULL']
    const params = [orgId, projectKey]
    if (level) { params.push(level); where.push(`level = $${params.length}`) }
    const { rows: indicators } = await pool.query(
      `SELECT * FROM indicators WHERE ${where.join(' AND ')} ORDER BY level, code`,
      params
    )

    if (!indicators.length) {
      return res.json({ kpis: emptyKpis(), charts: emptyCharts(), table: [] })
    }

    const indicatorIds = indicators.map(i => i.id)
    const { rows: allEntries } = await pool.query(
      `SELECT * FROM indicator_monthly_entries
       WHERE indicator_id = ANY($1::uuid[]) AND fy_start_year = $2 AND org_id = $3 AND project_key = $4`,
      [indicatorIds, fyStartYear, orgId, projectKey]
    )
    const { rows: allTargets } = await pool.query(
      `SELECT * FROM indicator_targets WHERE indicator_id = ANY($1::uuid[]) AND fy_start_year = $2`,
      [indicatorIds, fyStartYear]
    )

    // Per-indicator metrics at the requested scope/scope_value, as of `month`.
    const table = indicators.map(ind => {
      const entriesForIndicator = allEntries.filter(e => e.indicator_id === ind.id && e.scope === scope && (e.scope_value || null) === scopeValue)
      const target = allTargets.find(t => t.indicator_id === ind.id && t.scope === scope && (t.scope_value || null) === scopeValue)
        || allTargets.find(t => t.indicator_id === ind.id && t.scope === 'project')
        || null
      const currentEntry = entriesForIndicator.find(e => e.month === month) || null
      const metrics = computeIndicatorMetrics({
        frequency: ind.frequency, aggregationMethod: ind.aggregation_method,
        entries: entriesForIndicator, uptoMonth: month, target: target?.annual_target ?? null,
      })
      return {
        indicator: { id: ind.id, code: ind.code, name: ind.name, level: ind.level, unit: ind.unit, frequency: ind.frequency, responsible_person: ind.responsible_person, updated_at: ind.updated_at },
        entry: currentEntry ? { status: currentEntry.status, remarks: currentEntry.remarks } : null,
        target: target?.annual_target ?? null,
        metrics,
      }
    })

    // ── KPIs ──────────────────────────────────────────────────────────────
    const withPct = table.filter(r => r.metrics.achievementPct !== null)
    const withTargetPct = table.filter(r => r.metrics.targetAchievementPct !== null)
    const byLevel = level => table.filter(r => r.indicator.level === level && r.metrics.achievementPct !== null)

    const statusCounts = table.reduce((acc, r) => { acc[r.metrics.status] = (acc[r.metrics.status] || 0) + 1; return acc }, {})
    const withEntryThisMonth = table.filter(r => r.entry !== null)
    const verifiedCount = withEntryThisMonth.filter(r => ['verified', 'approved'].includes(r.entry.status)).length

    const { rows: [beneficiaryAgg] } = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(DISTINCT COALESCE(farmer_id, id::text))::int AS unique_total,
         count(*) FILTER (WHERE lower(trim(attributes->>'gender')) = 'female')::int AS women_total
       FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2`,
      [orgId, projectKey]
    )
    const { rows: geoRows } = await pool.query(
      `SELECT DISTINCT scope_value FROM indicator_targets t
       JOIN indicators i ON i.id = t.indicator_id
       WHERE i.org_id = $1 AND i.project_key = $2 AND t.scope = 'geography' AND t.scope_value IS NOT NULL`,
      [orgId, projectKey]
    )

    const kpis = {
      overallAchievementPct: average(withPct.map(r => r.metrics.achievementPct)),
      targetAchievementPct: average(withTargetPct.map(r => r.metrics.targetAchievementPct)),
      activityAchievementPct: average(byLevel('activity').map(r => r.metrics.achievementPct)),
      outputAchievementPct: average(byLevel('output').map(r => r.metrics.achievementPct)),
      outcomeAchievementPct: average(byLevel('outcome').map(r => r.metrics.achievementPct)),
      impactAchievementPct: average(byLevel('impact').map(r => r.metrics.achievementPct)),
      onTrackCount: statusCounts.on_track || 0,
      needsAttentionCount: statusCounts.needs_attention || 0,
      behindCount: statusCounts.behind || 0,
      noDataCount: (statusCounts.not_started || 0) + (statusCounts.data_pending || 0),
      overachievedCount: statusCounts.overachieved || 0,
      verifiedDataPct: withEntryThisMonth.length ? Math.round((verifiedCount / withEntryThisMonth.length) * 100) : null,
      beneficiariesReached: beneficiaryAgg.total,
      uniqueBeneficiariesReached: beneficiaryAgg.unique_total,
      womenBeneficiaries: beneficiaryAgg.women_total,
      geographyCoverage: geoRows.length,
    }

    // ── Charts ────────────────────────────────────────────────────────────
    const focusIndicatorId = req.query.focusIndicatorId || indicators[0]?.id
    const focusEntries = allEntries.filter(e => e.indicator_id === focusIndicatorId && e.scope === scope && (e.scope_value || null) === scopeValue)
    const monthlyPlanVsActual = MONTHS.slice(0, MONTHS.indexOf(month) + 1).map(m => {
      const e = focusEntries.find(x => x.month === m)
      return { month: m, plan: e?.plan ?? null, actual: e?.actual ?? null }
    })

    const achievementByLevel = ['activity', 'output', 'outcome', 'impact'].map(l => ({
      level: l, achievementPct: average(byLevel(l).map(r => r.metrics.achievementPct)),
    }))

    const statusDistribution = Object.entries(statusCounts).map(([status, count]) => ({ status, count }))

    const ranked = withPct.slice().sort((a, b) => (b.metrics.achievementPct ?? 0) - (a.metrics.achievementPct ?? 0))
    const topPerforming = ranked.slice(0, 5).map(r => ({ code: r.indicator.code, name: r.indicator.name, achievementPct: r.metrics.achievementPct }))
    const lagging = ranked.slice(-5).reverse().map(r => ({ code: r.indicator.code, name: r.indicator.name, achievementPct: r.metrics.achievementPct }))

    const geoEntries = allEntries.filter(e => e.scope === 'geography' && e.scope_value)
    const geoGroups = new Map()
    for (const e of geoEntries) {
      const ind = indicators.find(i => i.id === e.indicator_id)
      if (!ind) continue
      const metrics = computeIndicatorMetrics({
        frequency: ind.frequency, aggregationMethod: ind.aggregation_method,
        entries: geoEntries.filter(x => x.indicator_id === e.indicator_id && x.scope_value === e.scope_value),
        uptoMonth: month, target: null,
      })
      if (metrics.achievementPct === null) continue
      const bucket = geoGroups.get(e.scope_value) || []
      bucket.push(metrics.achievementPct)
      geoGroups.set(e.scope_value, bucket)
    }
    const geographyWiseAchievement = Array.from(geoGroups.entries()).map(([geo, pcts]) => ({ geography: geo, achievementPct: average(pcts) }))

    function disaggregationBreakdown(scopeKey) {
      const entries = allEntries.filter(e => e.scope === scopeKey && e.scope_value)
      const groups = new Map()
      for (const e of entries) {
        const bucket = groups.get(e.scope_value) || []
        bucket.push(e)
        groups.set(e.scope_value, bucket)
      }
      return Array.from(groups.entries()).map(([value, es]) => {
        const totalActual = es.reduce((s, e) => s + (Number(e.actual) || 0), 0)
        return { value, count: es.length, totalActual }
      })
    }
    const genderDisaggregation = disaggregationBreakdown('gender')
    const categoryDisaggregation = disaggregationBreakdown('beneficiary_category')

    const cumulativeProgressTrend = MONTHS.slice(0, MONTHS.indexOf(month) + 1).map(m => {
      const pcts = indicators.map(ind => {
        const entriesForIndicator = allEntries.filter(e => e.indicator_id === ind.id && e.scope === scope && (e.scope_value || null) === scopeValue)
        const target = allTargets.find(t => t.indicator_id === ind.id && t.scope === 'project')
        const metrics = computeIndicatorMetrics({
          frequency: ind.frequency, aggregationMethod: ind.aggregation_method,
          entries: entriesForIndicator, uptoMonth: m, target: target?.annual_target ?? null,
        })
        return metrics.achievementPct
      })
      return { month: m, achievementPct: average(pcts) }
    })

    // beneficiary_mis_records has no enrollment date, so reach trend uses
    // created_at (upload date) — a known approximation.
    const { rows: reachTrendRows } = await pool.query(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS count
       FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2
       GROUP BY 1 ORDER BY 1`,
      [orgId, projectKey]
    )

    const { rows: submissionStatusRows } = await pool.query(
      `SELECT status, count(*)::int AS count FROM indicator_monthly_entries
       WHERE indicator_id = ANY($1::uuid[]) AND fy_start_year = $2 AND month = $3
         AND org_id = $4 AND project_key = $5
       GROUP BY status`,
      [indicatorIds, fyStartYear, month, orgId, projectKey]
    )

    res.json({
      kpis,
      charts: {
        monthlyPlanVsActual, focusIndicatorId,
        achievementByLevel,
        statusDistribution,
        topPerforming,
        lagging,
        geographyWiseAchievement,
        genderDisaggregation,
        categoryDisaggregation,
        cumulativeProgressTrend,
        beneficiaryReachTrend: reachTrendRows,
        submissionStatus: submissionStatusRows,
      },
      table,
    })
  } catch (e) {
    console.error('[mis-dashboard GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

function emptyKpis() {
  return {
    overallAchievementPct: null, targetAchievementPct: null, activityAchievementPct: null,
    outputAchievementPct: null, outcomeAchievementPct: null, impactAchievementPct: null,
    onTrackCount: 0, needsAttentionCount: 0, behindCount: 0, noDataCount: 0, overachievedCount: 0,
    verifiedDataPct: null, beneficiariesReached: 0, uniqueBeneficiariesReached: 0, womenBeneficiaries: 0, geographyCoverage: 0,
  }
}
function emptyCharts() {
  return {
    monthlyPlanVsActual: [], focusIndicatorId: null, achievementByLevel: [], statusDistribution: [],
    topPerforming: [], lagging: [], geographyWiseAchievement: [], genderDisaggregation: [],
    categoryDisaggregation: [], cumulativeProgressTrend: [], beneficiaryReachTrend: [], submissionStatus: [],
  }
}

// GET /api/projects/:projectKey/indicators/:id/drilldown?fy_start_year=
router.get('/projects/:projectKey/indicators/:id/drilldown', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const fyStartYear = parseInt(req.query.fy_start_year) || undefined

    const { rows: [indicator] } = await pool.query(
      `SELECT * FROM indicators WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, orgId, req.params.projectKey]
    )
    if (!indicator) return res.status(404).json({ error: 'Not found' })

    const { rows: disaggregations } = await pool.query(
      `SELECT dimension FROM indicator_disaggregations WHERE indicator_id = $1`, [indicator.id]
    )
    const { rows: targets } = await pool.query(
      `SELECT * FROM indicator_targets WHERE indicator_id = $1 ORDER BY fy_start_year DESC`, [indicator.id]
    )
    const { rows: entries } = await pool.query(
      `SELECT * FROM indicator_monthly_entries WHERE indicator_id = $1 AND org_id = $2 ${fyStartYear ? 'AND fy_start_year = $3' : ''} ORDER BY fy_start_year DESC, month`,
      fyStartYear ? [indicator.id, orgId, fyStartYear] : [indicator.id, orgId]
    )
    const { rows: evidence } = await pool.query(
      `SELECT ev.id, ev.filename, ev.mime_type, ev.size_bytes, ev.uploaded_by, ev.created_at, e.month, e.fy_start_year
       FROM indicator_entry_evidence ev JOIN indicator_monthly_entries e ON e.id = ev.entry_id
       WHERE e.indicator_id = $1 AND e.org_id = $2 ORDER BY ev.created_at DESC`,
      [indicator.id, orgId]
    )

    const monthlyTrend = MONTHS.map(m => {
      const e = entries.find(x => x.month === m && x.scope === 'project' && (fyStartYear ? x.fy_start_year === fyStartYear : true))
      return { month: m, plan: e?.plan ?? null, actual: e?.actual ?? null }
    })
    const geographyEntries = entries.filter(e => e.scope === 'geography')
    const geographyBreakdown = Array.from(new Set(geographyEntries.map(e => e.scope_value))).map(geo => ({
      geography: geo,
      totalActual: geographyEntries.filter(e => e.scope_value === geo).reduce((s, e) => s + (Number(e.actual) || 0), 0),
    }))

    res.json({
      indicator,
      disaggregations: disaggregations.map(d => d.dimension),
      targets,
      monthlyTrend,
      geographyBreakdown,
      entries,
      evidence,
    })
  } catch (e) {
    console.error('[indicators drilldown]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
