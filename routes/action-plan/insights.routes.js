// AI narrative + anomaly flags: annual-progress insights and project dashboard insights.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { requireEditor } from '../../lib/routeGuards.js'
import { runAI } from '../../lib/ai/runAI.js'
import { AP_MONTHS, resolveProjectKey } from './helpers.js'

const router = Router()

// POST /api/action-plans/:id/annual-progress/insights — AI narrative + anomaly flags
// for one FY+month snapshot (same layering as budget-utilisation insights).
// Field reports live in a Google Sheet fetched client-side only, so the frontend
// sends dailyReportCount in the body.
const ACH_DECREASE_TOLERANCE = 0 // achievement is cumulative, so any decrease is suspicious
const LOW_EVIDENCE_REPORT_FLOOR = 2 // min field reports expected when achievement grows

router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/insights', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { fy_start_year, month } = req.body || {}
    const dailyReportCount = Number.isInteger(req.body?.daily_report_count) ? req.body.daily_report_count : null
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: current } = await pool.query(
      `SELECT activity_name, category, target::float8 AS target, achievement_total::float8 AS achievement_total
       FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!current.length) return res.status(404).json({ error: 'No activities found for this snapshot' })

    // Previous snapshot with data may be in the prior FY (Apr → last FY's Mar).
    const fiscalSeq = (fy, m) => fy * 12 + AP_MONTHS.indexOf(m)
    const { rows: allMonths } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    const curSeq = fiscalSeq(fy_start_year, month)
    const prior = allMonths
      .filter(m => fiscalSeq(m.fy_start_year, m.month) < curSeq)
      .sort((a, b) => fiscalSeq(b.fy_start_year, b.month) - fiscalSeq(a.fy_start_year, a.month))[0]

    let priorByName = new Map()
    if (prior) {
      const { rows: priorRows } = await pool.query(
        `SELECT activity_name, achievement_total::float8 AS achievement_total
         FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
        [req.user.orgId, projectKey, prior.fy_start_year, prior.month]
      )
      priorByName = new Map(priorRows.map(r => [r.activity_name, r.achievement_total]))
    }

    // ── Deterministic checks ────────────────────────────────────────────────
    const flags = []
    let growthThisPeriod = 0
    for (const r of current) {
      const target = Number(r.target) || 0
      const achievement = Number(r.achievement_total) || 0
      if (target <= 0 && achievement > 0) {
        flags.push({ activity: r.activity_name, category: r.category, type: 'no_target',
          reason: `${achievement.toLocaleString('en-IN')} achieved with no target set for this activity` })
      }
      const priorAchievement = priorByName.get(r.activity_name)
      if (priorAchievement != null) {
        growthThisPeriod += Math.max(0, achievement - priorAchievement)
        if (achievement < priorAchievement - ACH_DECREASE_TOLERANCE) {
          flags.push({ activity: r.activity_name, category: r.category, type: 'achievement_decreased',
            reason: `Cumulative achievement dropped from ${priorAchievement.toLocaleString('en-IN')} (${prior.month}) to ${achievement.toLocaleString('en-IN')} — this figure should never decrease` })
        }
      }
    }

    // ── Cross-reference with daily field report volume ──────────────────────
    // Only flag real progress with thin evidence; no positive non-findings.
    if (dailyReportCount != null && growthThisPeriod > 0 && dailyReportCount < LOW_EVIDENCE_REPORT_FLOOR) {
      flags.push({ activity: null, category: null, type: 'low_field_evidence',
        reason: `Achievement grew by ${Math.round(growthThisPeriod).toLocaleString('en-IN')} this period but only ${dailyReportCount} daily field report(s) were filed for it — consider verifying the reported figures` })
    }

    // ── Category-level pace vs elapsed fiscal year ──────────────────────────
    const elapsedPct = Math.round(((AP_MONTHS.indexOf(month) + 1) / 12) * 100)
    const categoryMap = new Map()
    for (const r of current) {
      const cat = r.category || 'Uncategorized'
      const cur = categoryMap.get(cat) || { target: 0, achievement: 0 }
      cur.target += Number(r.target) || 0
      cur.achievement += Number(r.achievement_total) || 0
      categoryMap.set(cat, cur)
    }
    const categories = Array.from(categoryMap.entries()).map(([category, v]) => {
      const achievedPct = v.target > 0 ? Math.round((v.achievement / v.target) * 100) : null
      const gap = achievedPct != null ? achievedPct - elapsedPct : null
      const pace = gap == null ? 'unknown' : gap > 20 ? 'ahead' : gap < -20 ? 'behind' : 'on_track'
      return { category, target: v.target, achievement: v.achievement, achievedPct, pace }
    })
    const aheadCategories = categories.filter(c => c.pace === 'ahead')
    const behindCategories = categories.filter(c => c.pace === 'behind')

    // ── Templated fallback (used verbatim if AI is unavailable) ─────────────
    const fallbackNarrative = [
      `${elapsedPct}% of the fiscal year has elapsed.`,
      aheadCategories.length ? `${aheadCategories.length} of ${categories.length} categor${aheadCategories.length === 1 ? 'y is' : 'ies are'} ahead of pace (${aheadCategories.map(c => c.category).join(', ')}).` : null,
      behindCategories.length ? `${behindCategories.length} categor${behindCategories.length === 1 ? 'y is' : 'ies are'} behind pace (${behindCategories.map(c => c.category).join(', ')}).` : null,
      dailyReportCount != null ? `${dailyReportCount} daily field report(s) on record for this period.` : null,
      flags.length ? `${flags.length} item(s) flagged for review.` : 'No anomalies detected.',
    ].filter(Boolean).join(' ')

    let narrative = fallbackNarrative
    let rankedFlags = flags

    if (flags.length || aheadCategories.length || behindCategories.length) {
      try {
        const systemPrompt =
          `You are a program analyst assistant for an NGO. Given computed activity-progress statistics ` +
          `for one project's fiscal-year-to-date, including daily field report volume as supporting evidence, ` +
          `write a SHORT (2-4 sentence) plain-English narrative summarizing overall pace and highlighting the ` +
          `most important flagged items. Then re-rank the given flags by importance (most concerning first) ` +
          `and give each a one-line reason in plain English, non-technical. Respond with strict JSON only: ` +
          `{"narrative": "...", "flags": [{"activity": "..."|null, "category": "..."|null, "type": "...", "reason": "..."}]}. ` +
          `Include every flag given, do not invent new ones.`
        const userPrompt = JSON.stringify({ elapsedPct, categories, flags, dailyReportCount })
        const out = await runAI({
          feature: 'annual_progress',
          operation: 'insights',
          prompt: userPrompt,
          systemPrompt,
          orgId: req.user.orgId,
          userId: req.user.uid,
        }, { jsonMode: true, maxTokens: 1024, temperature: 0.3 })

        const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
        if (parsed?.narrative && Array.isArray(parsed?.flags)) {
          narrative = parsed.narrative
          rankedFlags = parsed.flags
        }
      } catch (e) {
        console.warn('[annual-progress/insights] AI narrative unavailable, using fallback:', e.message)
      }
    }

    res.json({ narrative, flags: rankedFlags, elapsedPct, categories })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/insights POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/dashboard-insights — cross-report AI narrative for
// ProjectDashboardPage.tsx, looking for mismatches between budget, annual progress,
// daily reports and compliance (e.g. spend outpacing delivery). Figures come in
// the body because the client already computed them (daily reports are sheet-backed)
// and the narrative must agree with what's on screen.
const DASHBOARD_PACE_GAP_THRESHOLD = 20 // percentage points between budget% and progress%
const DASHBOARD_LOW_EVIDENCE_FLOOR = 2  // field reports this month, despite real progress, worth flagging

router.post('/action-plans/:id([0-9a-fA-F-]{36})/dashboard-insights', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const b = req.body || {}
    const hasProgress = !!b.has_annual_progress
    const hasBudget = !!b.has_budget_data
    const overallTarget = Number(b.overall_target) || 0
    const overallAchievement = Number(b.overall_achievement) || 0
    const budgetTotal = Number(b.budget_total) || 0
    const budgetUsed = Number(b.budget_used) || 0
    const overdueComplianceCount = Number(b.overdue_compliance_count) || 0
    const dailyReportCount = Number.isInteger(b.daily_report_count) ? b.daily_report_count : null
    const dailyReportCountThisMonth = Number.isInteger(b.daily_report_count_this_month) ? b.daily_report_count_this_month : null
    const documentCount = Number.isInteger(b.document_count) ? b.document_count : null
    const beneficiaryTotal = Number.isInteger(b.beneficiary_total) ? b.beneficiary_total : null
    const indicatorsBehindCount = Number(b.indicators_behind_count) || 0
    const actionPlanOverdueCount = Number(b.action_plan_overdue_count) || 0
    const actionPlanOverdueHighPriorityCount = Number(b.action_plan_overdue_high_priority_count) || 0

    const progressPct = hasProgress && overallTarget > 0 ? Math.round((overallAchievement / overallTarget) * 100) : null
    const budgetPct = hasBudget && budgetTotal > 0 ? Math.round((budgetUsed / budgetTotal) * 100) : null

    // ── Deterministic checks ────────────────────────────────────────────────
    const flags = []
    if (progressPct != null && budgetPct != null) {
      const gap = budgetPct - progressPct
      if (gap >= DASHBOARD_PACE_GAP_THRESHOLD) {
        flags.push({ type: 'spend_ahead_of_delivery',
          reason: `${budgetPct}% of budget used but only ${progressPct}% of program targets achieved — spend is outpacing delivery` })
      } else if (gap <= -DASHBOARD_PACE_GAP_THRESHOLD) {
        flags.push({ type: 'delivery_ahead_of_spend',
          reason: `${progressPct}% of targets achieved with only ${budgetPct}% of budget used — delivery is ahead of disbursement` })
      }
    }
    if (overdueComplianceCount > 0) {
      flags.push({ type: 'compliance_overdue',
        reason: `${overdueComplianceCount} compliance item${overdueComplianceCount === 1 ? '' : 's'} overdue` })
    }
    if (progressPct != null && progressPct > 0 && dailyReportCountThisMonth != null && dailyReportCountThisMonth < DASHBOARD_LOW_EVIDENCE_FLOOR) {
      flags.push({ type: 'low_field_evidence',
        reason: `Only ${dailyReportCountThisMonth} field report(s) filed this month despite ongoing program progress` })
    }
    if (documentCount === 0) {
      flags.push({ type: 'no_documents', reason: 'No documents uploaded to the vault yet.' })
    }
    if (indicatorsBehindCount > 0) {
      flags.push({ type: 'indicators_behind',
        reason: `${indicatorsBehindCount} indicator(s) behind target this month` })
    }
    if (actionPlanOverdueHighPriorityCount > 0) {
      flags.push({ type: 'action_plan_overdue_high_priority',
        reason: `${actionPlanOverdueHighPriorityCount} high-priority Action Plan activit${actionPlanOverdueHighPriorityCount === 1 ? 'y is' : 'ies are'} overdue` })
    } else if (actionPlanOverdueCount > 0) {
      flags.push({ type: 'action_plan_overdue',
        reason: `${actionPlanOverdueCount} Action Plan activit${actionPlanOverdueCount === 1 ? 'y is' : 'ies are'} overdue` })
    }

    // ── Templated fallback (used verbatim if AI is unavailable) ─────────────
    const fallbackNarrative = [
      progressPct != null ? `Program progress is at ${progressPct}%.` : 'No Annual Progress Report uploaded yet.',
      budgetPct != null ? `Budget utilisation is at ${budgetPct}%.` : 'No Budget Utilisation report uploaded yet.',
      flags.length ? `${flags.length} item(s) flagged for review.` : 'No cross-cutting anomalies detected.',
    ].join(' ')

    let narrative = fallbackNarrative
    let rankedFlags = flags

    if (flags.length) {
      try {
        const systemPrompt =
          `You are a program + finance analyst assistant for an NGO, looking across a single project's ` +
          `Financial Tracker, Action Plan, Annual Progress Report, and Daily field reports together. Given the computed ` +
          `cross-cutting statistics and flags below, write a SHORT (2-4 sentence) plain-English executive ` +
          `summary for a program manager, and re-rank the flags by importance (most concerning first) with a ` +
          `one-line plain-English reason each. Respond with strict JSON only: ` +
          `{"narrative": "...", "flags": [{"type": "...", "reason": "..."}]}. ` +
          `Include every flag given, do not invent new ones.`
        const userPrompt = JSON.stringify({
          progressPct, budgetPct, overdueComplianceCount, dailyReportCount, dailyReportCountThisMonth,
          documentCount, beneficiaryTotal, indicatorsBehindCount,
          actionPlanOverdueCount, actionPlanOverdueHighPriorityCount, flags,
        })
        const out = await runAI({
          feature: 'project_dashboard',
          operation: 'insights',
          prompt: userPrompt,
          systemPrompt,
          orgId: req.user.orgId,
          userId: req.user.uid,
        }, { jsonMode: true, maxTokens: 1024, temperature: 0.3 })

        const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
        if (parsed?.narrative && Array.isArray(parsed?.flags)) {
          narrative = parsed.narrative
          rankedFlags = parsed.flags
        }
      } catch (e) {
        console.warn('[dashboard-insights] AI narrative unavailable, using fallback:', e.message)
      }
    }

    res.json({ narrative, flags: rankedFlags, progressPct, budgetPct })
  } catch (e) {
    console.error('[action-plans/:id/dashboard-insights POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
