// Per-project "Dashboard" tab: a decision-focused summary. "Focus Areas" are
// computed deterministically from the page's numbers (no AI call); the AI
// narrative is an optional deeper dive. Socio-economic figures are reported
// as captured, with verbatim field-report excerpts — never AI-written impact claims.

import { useEffect, useState } from 'react'
import { Loader2, Sparkles, Users, TrendingUp, Calendar, HeartHandshake, Quote, ListChecks } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { apiFetch } from '../../utils/apiFetch'
import { FF, ffStatusColors, type FFStatus } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { StatusBadge } from '../ui/StatusBadge'
import { ProgressBar } from '../ui/ProgressBar'
import { PlanVsActualChart, type ChartMonth } from '../ui/PlanVsActualChart'
import { BuiltinLayout, Panel } from './BuiltinLayout'
import { useProjectContext } from '../../context/ProjectContext'
import { useProjectDailyReports } from '../../hooks/useProjectDailyReports'
import type { DashboardKpis } from '../../types/misEntry'
import { ActivityStatTiles } from './ActivityStatTiles'
import { CATEGORIES, activityTotal, alertFor, type Activity, type ProgressMap } from './actionPlanShared'

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']

function defaultFYStartYear() {
  const now = new Date()
  const y = now.getFullYear()
  return now.getMonth() + 1 >= 4 ? y : y - 1
}

function defaultMonth() {
  const short = new Date().toLocaleDateString('en-US', { month: 'short' })
  return MONTHS.includes(short) ? short : 'Apr'
}

function fmtDate(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
}

function truncate(s: string, max = 180): string {
  const t = (s || '').trim()
  return t.length > max ? t.slice(0, max).trim() + '…' : t
}

// Fixed per-category colors so the trend chart and breakdown bars match.
const MIS_CATEGORY_COLORS: Record<string, string> = {
  training: FF.tealDark, income: '#059669', inputdistribution: '#2563EB', schemeaccess: '#7C3AED',
  creditgrant: '#D97706', bds: '#16A34A', compliance: '#DC2626',
  exposurevisit: '#0891B2', campaign: '#DB2777', communitymeeting: '#65A30D',
}

// selectedProject.health/compliance arrive already computed from GET /api/action-plans.
const HEALTH_LABEL: Record<FFStatus, string> = { green: 'On Track', amber: 'At Risk', red: 'Critical' }
const COMPLIANCE_LABEL: Record<FFStatus, string> = { green: 'Compliant', amber: 'Attention Needed', red: 'Overdue' }

// `status: null` means "no data" — gray, outside the green/amber/red scale.
const INDICATOR_STATUS_META: { key: keyof DashboardKpis; label: string; status: FFStatus | null }[] = [
  { key: 'onTrackCount', label: 'On Track', status: 'green' },
  { key: 'needsAttentionCount', label: 'Needs Attention', status: 'amber' },
  { key: 'behindCount', label: 'Behind', status: 'red' },
  { key: 'noDataCount', label: 'No Data', status: null },
]

interface BeneficiaryKpis { total: number; pgMembers: number; incomeSum: number; convergenceSum: number; avgIncomePerAcre: number }
interface CountItem { label: string; total: number }
interface ComplianceItem { id: string; item: string; status: 'overdue' | 'upcoming' | 'valid'; dueLabel: string }

interface MisCategorySummary {
  key: string; label: string; total: number; uniqueBeneficiaries: number | null
  lastActivityDate: string | null; lastUpload: string | null
  totalAmount?: number; totalAttendees?: number
}
interface MisMonthRow { month: string; total: number; [key: string]: number | string }
interface MisTabsTotals {
  totalRecords: number; uniqueBeneficiariesReached: number
  totalEvents: number; totalEventAttendees: number; totalCreditGrantAmount: number
  totalIncomeAmount: number
}

interface FocusItem { status: FFStatus; text: string }

// "What needs a decision this month" flags, ordered red → amber → green and
// capped; says so explicitly when nothing is flagged.
function buildFocusAreas(input: {
  hasAnnualProgress: boolean; overallPct: number; plannedToDate: number
  hasBudgetData: boolean; budgetUsedPct: number
  overdueCount: number
  hasIndicatorData: boolean; indicatorBehindCount: number
  misMonthlyTrend: MisMonthRow[]
  hasDailyReports: boolean; reportsThisMonth: number
  hasActionPlan: boolean; actionPlanOverdueCount: number; actionPlanOverdueHighPriorityCount: number
}): FocusItem[] {
  const items: FocusItem[] = []

  if (input.hasAnnualProgress) {
    const diff = input.overallPct - input.plannedToDate
    if (diff <= -15) items.push({ status: 'red', text: `Behind schedule — ${Math.abs(diff)} pts under the pace planned for this point in the year.` })
    else if (diff <= -5) items.push({ status: 'amber', text: `Slightly behind pace (${Math.abs(diff)} pts under plan) — worth a check-in with the team.` })
    else if (diff >= 15) items.push({ status: 'green', text: `Well ahead of schedule — ${diff} pts above the planned pace.` })
    else items.push({ status: 'green', text: `On pace with the annual plan.` })
  }

  if (input.hasBudgetData && input.hasAnnualProgress) {
    const diff = input.budgetUsedPct - input.plannedToDate
    if (diff >= 20) items.push({ status: 'red', text: `Spending is ${diff} pts ahead of the year's pace — budget may run out before the project ends.` })
    else if (diff >= 8) items.push({ status: 'amber', text: `Spending is running a little ahead of pace (${diff} pts) — keep an eye on the burn rate.` })
    else if (diff <= -15) items.push({ status: 'amber', text: `Spending is lagging the timeline by ${Math.abs(diff)} pts — check whether implementation has slowed.` })
  } else if (input.hasBudgetData && input.budgetUsedPct >= 90) {
    items.push({ status: 'amber', text: `${input.budgetUsedPct}% of the total budget is already used.` })
  }

  if (input.overdueCount > 0) {
    items.push({ status: 'red', text: `${input.overdueCount} compliance item${input.overdueCount === 1 ? '' : 's'} overdue — needs immediate action.` })
  }

  if (input.hasIndicatorData && input.indicatorBehindCount > 0) {
    items.push({ status: 'amber', text: `${input.indicatorBehindCount} indicator${input.indicatorBehindCount === 1 ? '' : 's'} behind target.` })
  }

  if (input.misMonthlyTrend.length >= 2) {
    const last = Number(input.misMonthlyTrend[input.misMonthlyTrend.length - 1].total) || 0
    const prev = Number(input.misMonthlyTrend[input.misMonthlyTrend.length - 2].total) || 0
    if (prev > 0) {
      const pctChange = Math.round(((last - prev) / prev) * 100)
      if (pctChange <= -30) items.push({ status: 'amber', text: `Field activity (MIS records) dropped ${Math.abs(pctChange)}% last month — worth checking with ground teams.` })
      else if (pctChange >= 30) items.push({ status: 'green', text: `Field activity (MIS records) is up ${pctChange}% last month.` })
    }
  }

  if (input.hasDailyReports && input.reportsThisMonth === 0) {
    items.push({ status: 'amber', text: `No field reports filed yet this month.` })
  }

  if (input.hasActionPlan && input.actionPlanOverdueHighPriorityCount > 0) {
    items.push({ status: 'red', text: `${input.actionPlanOverdueHighPriorityCount} high-priority action plan ${input.actionPlanOverdueHighPriorityCount === 1 ? 'activity is' : 'activities are'} overdue.` })
  } else if (input.hasActionPlan && input.actionPlanOverdueCount > 0) {
    items.push({ status: 'amber', text: `${input.actionPlanOverdueCount} action plan ${input.actionPlanOverdueCount === 1 ? 'activity is' : 'activities are'} overdue.` })
  }

  if (items.length === 0) {
    items.push({ status: 'green', text: `No major flags — this project looks on track across progress, budget and compliance.` })
  }

  const order: Record<FFStatus, number> = { red: 0, amber: 1, green: 2 }
  return items.sort((a, b) => order[a.status] - order[b.status]).slice(0, 6)
}

interface Props {
  projectKey: string
}

export function ProjectDashboardPage({ projectKey }: Props) {
  const { selectedProject } = useProjectContext()
  const { reports: dailyReports, loading: dailyReportsLoading } = useProjectDailyReports(selectedProject?.name ?? '', projectKey)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ComplianceItem[]>([])
  const [chart, setChart] = useState<ChartMonth[]>([])
  const [overallTarget, setOverallTarget] = useState(0)
  const [overallAchievement, setOverallAchievement] = useState(0)
  const [hasAnnualProgress, setHasAnnualProgress] = useState(false)
  const [budgetTotal, setBudgetTotal] = useState(0)
  const [budgetUsedAmt, setBudgetUsedAmt] = useState(0)
  const [hasBudgetData, setHasBudgetData] = useState(false)

  const [hasBeneficiaryData, setHasBeneficiaryData] = useState(false)
  const [beneficiaryKpis, setBeneficiaryKpis] = useState<BeneficiaryKpis>({ total: 0, pgMembers: 0, incomeSum: 0, convergenceSum: 0, avgIncomePerAcre: 0 })
  const [topBlocks, setTopBlocks] = useState<CountItem[]>([])
  const [topBenfTypes, setTopBenfTypes] = useState<CountItem[]>([])

  const [hasIndicatorData, setHasIndicatorData] = useState(false)
  const [indicatorKpis, setIndicatorKpis] = useState<DashboardKpis | null>(null)

  // Rollup across all MIS category tabs (GET .../mis-tabs-dashboard).
  const [hasMisTabsData, setHasMisTabsData] = useState(false)
  const [misCategories, setMisCategories] = useState<MisCategorySummary[]>([])
  const [misTotals, setMisTotals] = useState<MisTabsTotals>({ totalRecords: 0, uniqueBeneficiariesReached: 0, totalEvents: 0, totalEventAttendees: 0, totalCreditGrantAmount: 0, totalIncomeAmount: 0 })
  const [misMonthlyTrend, setMisMonthlyTrend] = useState<MisMonthRow[]>([])

  // Same sources as ActionPlanTab.tsx: plan activities + saved target/achieved overrides.
  const [hasActionPlan, setHasActionPlan] = useState(false)
  const [planActivities, setPlanActivities] = useState<Activity[]>([])
  const [planProgress, setPlanProgress] = useState<ProgressMap>({})

  const [insights, setInsights] = useState<{ narrative: string; flags: { type: string; reason: string }[] } | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState('')

  useEffect(() => {
    const planId = selectedProject?.id
    if (!planId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    const fy = defaultFYStartYear()

    Promise.all([
      apiFetch(`/api/compliance-items?project=${encodeURIComponent(projectKey)}`).then(r => r.json()),
      apiFetch(`/api/action-plans/${planId}/annual-progress/months?fy_start_year=${fy}`).then(r => r.json()),
      apiFetch(`/api/action-plans/${planId}/budget-utilisation`).then(r => r.json()),
      apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/beneficiary-mis?pageSize=1`).then(r => r.json()),
      apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/mis-dashboard?fy_start_year=${fy}&month=${defaultMonth()}`).then(r => r.json()),
      apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/mis-tabs-dashboard`).then(r => r.json()),
      apiFetch(`/api/action-plans/${planId}`).then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch(`/api/action-plan/progress?plan=${encodeURIComponent(projectKey)}`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]).then(async ([complianceData, apMonthsData, budgetData, beneficiaryData, misDashboardData, misTabsData, actionPlanData, actionPlanProgress]) => {
      if (cancelled) return
      setItems(complianceData.items || [])

      setHasMisTabsData((misTabsData.totals?.totalRecords || 0) > 0)
      setMisCategories(misTabsData.categories || [])
      setMisTotals(misTabsData.totals || { totalRecords: 0, uniqueBeneficiariesReached: 0, totalEvents: 0, totalEventAttendees: 0, totalCreditGrantAmount: 0, totalIncomeAmount: 0 })
      setMisMonthlyTrend(misTabsData.monthlyTrend || [])

      const bKpis = beneficiaryData.kpis || { total: 0, pgMembers: 0, incomeSum: 0, convergenceSum: 0, avgIncomePerAcre: 0 }
      setHasBeneficiaryData(bKpis.total > 0)
      setBeneficiaryKpis(bKpis)
      setTopBlocks((beneficiaryData.blockCounts || []).slice(0, 3))
      setTopBenfTypes((beneficiaryData.benfTypeCounts || []).slice(0, 3))

      const misKpis: DashboardKpis | null = misDashboardData.kpis || null
      setHasIndicatorData((misDashboardData.table || []).length > 0)
      setIndicatorKpis(misKpis)

      const activities: Activity[] = actionPlanData?.activities || []
      setHasActionPlan(activities.length > 0)
      setPlanActivities(activities)
      setPlanProgress(actionPlanProgress || {})

      // Each expense cell is that month's own spend (not cumulative), so spend
      // to date sums every month — same math as the Financial Tracker's total.
      const budgetRows: { budget: number | null; expenses: Record<string, number | null> }[] = budgetData.rows || []
      setHasBudgetData(budgetRows.length > 0)
      // Headline budget (action_plans.budget), not a sum of line-item budgets.
      setBudgetTotal(Number(selectedProject?.budget) || 0)
      setBudgetUsedAmt(budgetRows.reduce((s: number, r) => {
        const monthly: (number | null)[] = Object.values(r.expenses)
        return s + monthly.reduce((s2: number, v) => s2 + (Number(v) || 0), 0)
      }, 0))

      // The report only has an annual target, so "plan" is elapsed-FY pace and
      // "actual" is each month's cumulative achievement vs the latest target.
      const apMonths: string[] = (apMonthsData.months || []).slice().sort((a: string, b: string) => MONTHS.indexOf(a) - MONTHS.indexOf(b))
      setHasAnnualProgress(apMonths.length > 0)
      if (apMonths.length) {
        const snapshots = await Promise.all(apMonths.map(m =>
          apiFetch(`/api/action-plans/${planId}/annual-progress?fy_start_year=${fy}&month=${encodeURIComponent(m)}`).then(r => r.json())
        ))
        const latestRows = snapshots[snapshots.length - 1]?.rows || []
        const latestTarget = latestRows.reduce((s: number, r: any) => s + (Number(r.target) || 0), 0)
        setOverallTarget(latestTarget)
        setOverallAchievement(latestRows.reduce((s: number, r: any) => s + (Number(r.achievement_total) || 0), 0))

        setChart(apMonths.map((m, i) => {
          const rows = snapshots[i]?.rows || []
          const achievement = rows.reduce((s: number, r: any) => s + (Number(r.achievement_total) || 0), 0)
          const planPct = Math.round(((MONTHS.indexOf(m) + 1) / 12) * 100)
          const actualPct = latestTarget > 0 ? Math.round((achievement / latestTarget) * 100) : 0
          return { month: m, planPct, actualPct }
        }))
      } else {
        setOverallTarget(0); setOverallAchievement(0); setChart([])
      }
    }).catch(() => {
      // leave items/chart/KPIs at their initial empty state on network/parse failure
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectKey, selectedProject?.id])

  if (loading) {
    return <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }

  const overdueCount = items.filter(i => i.status === 'overdue').length
  const nextDeadline = items.find(i => i.status === 'upcoming')
  const overallPct = overallTarget > 0 ? Math.round((overallAchievement / overallTarget) * 100) : 0
  const budgetUsedPct = budgetTotal > 0 ? Math.round((budgetUsedAmt / budgetTotal) * 100) : 0
  const fmtInr = (n: number) => `₹${n.toLocaleString('en-IN')}`
  const plannedToDate = chart.length ? chart[chart.length - 1].planPct : 0
  const alerts = items.filter(i => i.status !== 'valid').slice(0, 4)
  const reportsThisMonth = (() => {
    const now = new Date()
    return dailyReports.filter(r => {
      const t = new Date(r.timestamp)
      return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth()
    }).length
  })()

  // Same rollup as ActionPlanTab.tsx's categoryStats (whole year, all locations).
  const planCategoryStats = CATEGORIES.map(cat => {
    let target = 0, achieved = 0
    for (const a of planActivities) {
      if ((a.category || 'capacity') !== cat.id) continue
      const t = activityTotal(a, planProgress, null, null)
      target += t.target; achieved += t.achieved
    }
    return { ...cat, target, achieved, pct: target > 0 ? Math.round((achieved / target) * 100) : 0 }
  }).filter(c => c.target > 0 || c.achieved > 0)
  const overdueActivities = planActivities.filter(a => alertFor(a) === 'Overdue')
  const overdueHighPriorityActivities = overdueActivities.filter(a => a.priority === 'High')

  const focusAreas = buildFocusAreas({
    hasAnnualProgress, overallPct, plannedToDate,
    hasBudgetData, budgetUsedPct,
    overdueCount,
    hasIndicatorData, indicatorBehindCount: indicatorKpis?.behindCount ?? 0,
    misMonthlyTrend,
    hasDailyReports: !dailyReportsLoading && dailyReports.length > 0, reportsThisMonth,
    hasActionPlan, actionPlanOverdueCount: overdueActivities.length, actionPlanOverdueHighPriorityCount: overdueHighPriorityActivities.length,
  })

  const beneficiariesReachedValue = hasMisTabsData
    ? misTotals.uniqueBeneficiariesReached
    : (hasBeneficiaryData ? beneficiaryKpis.total : null)

  const pgMembershipPct = beneficiaryKpis.total > 0 ? Math.round((beneficiaryKpis.pgMembers / beneficiaryKpis.total) * 100) : 0
  const schemeAccessCount = misCategories.find(c => c.key === 'schemeaccess')?.total ?? 0
  const hasSocioEconomicData = hasBeneficiaryData || misTotals.totalCreditGrantAmount > 0 || schemeAccessCount > 0
  const groundStories = dailyReports.filter(r => (r.description || '').trim().length > 0).slice(0, 3)

  const handleGenerateInsights = async () => {
    if (!selectedProject?.id) return
    setInsightsLoading(true); setInsightsError('')
    try {
      const r = await apiFetch(`/api/action-plans/${selectedProject.id}/dashboard-insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          has_annual_progress: hasAnnualProgress,
          overall_target: overallTarget,
          overall_achievement: overallAchievement,
          has_budget_data: hasBudgetData,
          budget_total: budgetTotal,
          budget_used: budgetUsedAmt,
          overdue_compliance_count: overdueCount,
          daily_report_count: dailyReports.length,
          daily_report_count_this_month: reportsThisMonth,
          beneficiary_total: beneficiaryKpis.total,
          document_count: 0,
          media_count: 0,
          indicators_behind_count: indicatorKpis?.behindCount ?? 0,
          action_plan_overdue_count: overdueActivities.length,
          action_plan_overdue_high_priority_count: overdueHighPriorityActivities.length,
        }),
      })
      const d = await r.json()
      if (!r.ok) { setInsightsError(d.error || 'Could not generate insights'); setInsightsLoading(false); return }
      setInsights({ narrative: d.narrative, flags: d.flags || [] })
    } catch (e: any) {
      setInsightsError(e.message || 'Network error')
    }
    setInsightsLoading(false)
  }

  const health = selectedProject ? ffStatusColors(selectedProject.health) : null
  const compliance = selectedProject ? ffStatusColors(selectedProject.compliance) : null

  return (
    <BuiltinLayout dash="project" projectKey={projectKey} style={{ display: 'flex', flexDirection: 'column', gap: 26, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <Panel id="summary">
      {selectedProject && (
        <SectionCard>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div style={{ fontSize: 12.5, color: FF.textMuted }}>
                {[selectedProject.donor, selectedProject.region].filter(Boolean).join(' · ') || 'No donor/region set'}
              </div>
              <div className="flex items-center gap-2 mt-1.5">
                {health && <StatusBadge bg={health.bg} fg={health.fg} label={HEALTH_LABEL[selectedProject.health]} shape="pill" />}
                {compliance && <StatusBadge bg={compliance.bg} fg={compliance.fg} label={COMPLIANCE_LABEL[selectedProject.compliance]} />}
              </div>
            </div>
            <div className="flex items-center gap-6 flex-wrap">
              <div>
                <div style={{ fontSize: 11, color: FF.textFaint }}>Budget</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: FF.tealDark }}>{fmtInr(Number(selectedProject.budget) || 0)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: FF.textFaint }}>End Date</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: FF.tealDark }}>{selectedProject.end_date ? fmtDate(selectedProject.end_date) : (selectedProject.year ? `Plan year ${selectedProject.year}` : '—')}</div>
              </div>
              <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: FF.textFaint }}>
                <Calendar className="w-3.5 h-3.5" /> {selectedProject.locations?.length ?? 0} locations
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: FF.textMuted, marginBottom: 4 }}>
                <span>Target achievement</span><span style={{ fontWeight: 600, color: FF.tealDark }}>{hasAnnualProgress ? `${overallPct}%` : '—'}</span>
              </div>
              <ProgressBar pct={hasAnnualProgress ? overallPct : 0} color={FF.tealDark} />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: FF.textMuted, marginBottom: 4 }}>
                <span>Budget utilised</span><span style={{ fontWeight: 600, color: FF.tealDark }}>{selectedProject.budgetUsed}%</span>
              </div>
              <ProgressBar pct={selectedProject.budgetUsed} color={FF.purple} />
            </div>
          </div>
        </SectionCard>
      )}
      </Panel>

      <Panel id="focus">
      <SectionCard
        title="Focus Areas"
        titleRight={
          <button
            onClick={handleGenerateInsights}
            disabled={insightsLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
            style={{ border: `1px solid ${FF.border}`, color: FF.purple, background: '#FFFFFF' }}
            title="Use AI to write a narrative summary of this project's progress, budget, compliance, and field reports together"
          >
            {insightsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            AI Narrative
          </button>
        }
      >
        <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 14 }}>
          What this project needs a decision on right now — computed from progress, budget, compliance and field activity together.
        </div>
        <div className="flex flex-col gap-2.5">
          {focusAreas.map((f, i) => {
            const c = ffStatusColors(f.status)
            return (
              <div key={i} className="flex items-start gap-2.5">
                <span style={{ width: 8, height: 8, borderRadius: 999, background: c.fg, marginTop: 5, flexShrink: 0 }} />
                <span style={{ fontSize: 13.5, color: FF.tealDark, lineHeight: 1.5 }}>{f.text}</span>
              </div>
            )
          })}
        </div>

        {insightsError && (
          <div className="rounded-xl px-3 py-2 text-sm mt-4" style={{ background: FF.redBg, color: FF.red }}>{insightsError}</div>
        )}
        {insights && (
          <div className="rounded-2xl p-5 mt-4" style={{ background: `linear-gradient(135deg, ${FF.tealDark} 0%, #1A5F75 100%)`, color: '#fff' }}>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4" style={{ color: '#5DD5F5' }} />
              <span className="text-sm font-bold">AI Narrative</span>
            </div>
            <p className="text-sm mb-3" style={{ color: '#C0E8F5', lineHeight: 1.6 }}>{insights.narrative}</p>
            {insights.flags.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.15)' }}>
                {insights.flags.map((f, i) => (
                  <div key={i} className="text-xs" style={{ color: '#E7F2F3' }}>{f.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </SectionCard>
      </Panel>

      <Panel id="kpis">
      <KpiGrid cols={4}>
        <KpiTile
          label="Overall Progress" value={hasAnnualProgress ? `${overallPct}%` : '—'}
          note={hasAnnualProgress ? `vs ${plannedToDate}% planned to date` : 'No Annual Progress Report uploaded yet'}
          noteColor={hasAnnualProgress ? (overallPct >= plannedToDate ? FF.green : FF.amber) : FF.textFaint}
          valueSize={28}
        />
        <KpiTile
          label="Budget Utilised" value={hasBudgetData ? `${budgetUsedPct}%` : '—'}
          note={hasBudgetData ? `${fmtInr(budgetUsedAmt)} of ${fmtInr(budgetTotal)}` : 'No Budget Utilisation report uploaded yet'}
          noteColor={hasBudgetData ? undefined : FF.textFaint}
          valueSize={28}
        />
        <KpiTile
          label="Compliance Status" value={overdueCount > 0 ? `${overdueCount} Overdue` : 'Compliant'}
          note={overdueCount > 0 ? `${overdueCount} item${overdueCount === 1 ? '' : 's'} past due date` : 'No items overdue'}
          noteColor={overdueCount > 0 ? FF.red : FF.green}
          valueSize={28}
        />
        <KpiTile
          label="Beneficiaries Reached" value={beneficiariesReachedValue ?? '—'}
          note={beneficiariesReachedValue != null ? 'Unique people reached, across all MIS data' : 'No beneficiary data uploaded yet'}
          noteColor={beneficiariesReachedValue != null ? undefined : FF.textFaint}
          valueSize={28}
        />
      </KpiGrid>
      </Panel>

      <Panel id="progress">
      <SectionCard title="Cumulative Progress — Plan vs Actual">
        <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 18 }}>
          % of total project target achieved, from Annual Progress Report snapshots this FY
        </div>
        {chart.length > 0 ? (
          <PlanVsActualChart data={chart} />
        ) : (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '24px 0' }}>
            No Annual Progress Report snapshots yet this Financial Year.
          </div>
        )}
      </SectionCard>
      </Panel>

      <Panel id="actionplan">
      <SectionCard title="Action Plan Progress" titleRight={<ListChecks className="w-4 h-4" style={{ color: FF.textFaint }} />}>
        {!hasActionPlan ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>
            No Action Plan uploaded yet for this project.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 14 }}>
              Activity-level target vs achieved, from the uploaded Action Plan — all locations, whole plan year.
            </div>
            <ActivityStatTiles activities={planActivities} />

            {planCategoryStats.length > 0 && (
              <div className="mt-5">
                <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 10, fontWeight: 600 }}>Progress by Category</div>
                <div className="flex flex-col gap-2.5">
                  {planCategoryStats.map(c => (
                    <div key={c.id}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{c.icon} {c.label}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>{c.achieved}/{c.target} · {c.pct}%</span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div
                          style={{
                            height: 8,
                            width: `${Math.max(Math.min(c.pct, 100), c.target ? 3 : 0)}%`,
                            background: c.color,
                            borderRadius: 999, transition: 'width .3s',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {overdueActivities.length > 0 && (
              <div className="mt-6">
                <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 10, fontWeight: 600 }}>
                  Overdue Activities ({overdueActivities.length})
                </div>
                <div className="flex flex-col gap-2.5">
                  {overdueActivities.slice(0, 5).map(a => (
                    <div key={a.sn} className="flex items-center justify-between gap-3">
                      <div style={{ fontSize: 13, color: FF.tealDark }}>
                        {a.priority === 'High' && <strong style={{ color: FF.red }}>● </strong>}
                        {a.activity}
                      </div>
                      <span style={{ fontSize: 11, color: FF.textFaint, flexShrink: 0 }}>{a.responsibility}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>
      </Panel>

      <Panel id="beneficiaries">
      <SectionCard title="Beneficiaries" titleRight={<Users className="w-4 h-4" style={{ color: FF.textFaint }} />}>
        {!hasBeneficiaryData ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>No beneficiary data uploaded yet for this project.</div>
        ) : (
          <>
            <KpiGrid cols={4}>
              <KpiTile label="Total Beneficiaries" value={beneficiaryKpis.total} valueSize={26} />
              <KpiTile label="PG Members" value={beneficiaryKpis.pgMembers} valueSize={26} />
              <KpiTile label="Income Realised" value={fmtInr(beneficiaryKpis.incomeSum)} valueSize={26} />
              <KpiTile label="Avg Income / Acre" value={fmtInr(Math.round(beneficiaryKpis.avgIncomePerAcre))} valueSize={26} />
            </KpiGrid>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <div>
                <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 8, fontWeight: 600 }}>Top Blocks</div>
                {topBlocks.length === 0 ? (
                  <div style={{ fontSize: 12, color: FF.textFaint }}>—</div>
                ) : topBlocks.map(b => (
                  <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: FF.tealDark, padding: '4px 0' }}>
                    <span>{b.label}</span><span style={{ fontWeight: 600 }}>{b.total}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 8, fontWeight: 600 }}>Top Beneficiary Types</div>
                {topBenfTypes.length === 0 ? (
                  <div style={{ fontSize: 12, color: FF.textFaint }}>—</div>
                ) : topBenfTypes.map(t => (
                  <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: FF.tealDark, padding: '4px 0' }}>
                    <span>{t.label}</span><span style={{ fontWeight: 600 }}>{t.total}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </SectionCard>
      </Panel>

      <Panel id="socio">
      <SectionCard title="Socio-Economic Impact" titleRight={<HeartHandshake className="w-4 h-4" style={{ color: FF.textFaint }} />}>
        {!hasSocioEconomicData && groundStories.length === 0 ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>
            No income, entitlement-access or field-report data yet for this project.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 16 }}>
              How this project is changing people's economic position — real numbers only, no projected or invented outcomes.
            </div>
            {hasSocioEconomicData && (
              <KpiGrid cols={4}>
                <KpiTile label="Income Realised" value={fmtInr(beneficiaryKpis.incomeSum)} note="Reported across beneficiary MIS" valueSize={26} />
                <KpiTile label="Avg Income / Acre" value={fmtInr(Math.round(beneficiaryKpis.avgIncomePerAcre))} valueSize={26} />
                <KpiTile
                  label="PG / Collective Membership" value={beneficiaryKpis.pgMembers}
                  note={beneficiaryKpis.total > 0 ? `${pgMembershipPct}% of reached beneficiaries` : undefined}
                  valueSize={26}
                />
                <KpiTile
                  label="Govt. Scheme Convergence" value={fmtInr(beneficiaryKpis.convergenceSum)}
                  note={schemeAccessCount > 0 ? `${schemeAccessCount} beneficiaries connected to schemes` : 'Value of entitlements accessed'}
                  valueSize={26}
                />
              </KpiGrid>
            )}

            {misTotals.totalCreditGrantAmount > 0 && (
              <div className="mt-4" style={{ fontSize: 12.5, color: FF.textMuted }}>
                Plus <strong style={{ color: FF.tealDark }}>{fmtInr(misTotals.totalCreditGrantAmount)}</strong> in credit/grant access recorded this project — a further sign of financial inclusion on the ground.
              </div>
            )}

            {groundStories.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 10, fontWeight: 600 }}>
                  <Quote className="w-3.5 h-3.5" /> Voices from the Field
                </div>
                <div className="flex flex-col gap-3">
                  {groundStories.map(r => (
                    <div key={r.id} style={{ borderLeft: `3px solid ${FF.borderSoft}`, paddingLeft: 12 }}>
                      <div style={{ fontSize: 13, color: FF.tealDark, lineHeight: 1.55, fontStyle: 'italic' }}>“{truncate(r.description)}”</div>
                      <div className="mt-1" style={{ fontSize: 11, color: FF.textFaint }}>
                        {[r.name, r.location, fmtDate(r.timestamp)].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>
      </Panel>

      <Panel id="mis">
      <SectionCard title="MIS Activity" titleRight={<TrendingUp className="w-4 h-4" style={{ color: FF.textFaint }} />}>
        {!hasMisTabsData ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>
            No MIS data uploaded yet for this project. Upload a sheet under any MIS tab (Training, Input Distribution, …) to see it summarized here.
          </div>
        ) : (
          <>
            <KpiGrid cols={4}>
              <KpiTile label="Total MIS Records" value={misTotals.totalRecords} note="Across all 10 categories" />
              <KpiTile label="Beneficiaries Reached" value={misTotals.uniqueBeneficiariesReached} note="Unique, across 8 linked categories" />
              <KpiTile label="Events Held" value={misTotals.totalEvents} note="Campaigns + Community Meetings" />
              <KpiTile label="Credit/Grant Disbursed" value={fmtInr(misTotals.totalCreditGrantAmount)} note="Total amount recorded" />
            </KpiGrid>

            <div className="mt-5">
              <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 10, fontWeight: 600 }}>Activity by Category</div>
              <div className="flex flex-col gap-2.5">
                {misCategories.map(c => {
                  const maxTotal = Math.max(...misCategories.map(x => x.total), 1)
                  return (
                    <div key={c.key}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{c.label}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>
                          {c.total}{c.uniqueBeneficiaries != null ? ` · ${c.uniqueBeneficiaries} beneficiaries` : ''}
                        </span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div
                          style={{
                            height: 8,
                            width: `${c.total ? Math.max((c.total / maxTotal) * 100, 3) : 0}%`,
                            background: MIS_CATEGORY_COLORS[c.key] || FF.purple,
                            borderRadius: 999, transition: 'width .3s',
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {misMonthlyTrend.length > 0 && (
              <div className="mt-6" style={{ width: '100%', height: 280 }}>
                <div style={{ fontSize: 11.5, color: FF.textMuted, marginBottom: 10, fontWeight: 600 }}>Monthly Activity Trend</div>
                <ResponsiveContainer>
                  <BarChart data={misMonthlyTrend.map(m => ({ ...m, monthLabel: fmtMonth(m.month) }))} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={FF.borderSoft} vertical={false} />
                    <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: FF.textMuted }} axisLine={{ stroke: FF.border }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: FF.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${FF.border}` }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} formatter={(key: string) => misCategories.find(c => c.key === key)?.label || key} />
                    {misCategories.map(c => (
                      <Bar key={c.key} dataKey={c.key} stackId="mis" fill={MIS_CATEGORY_COLORS[c.key] || FF.purple} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </SectionCard>
      </Panel>

      <Panel id="indicators">
      <SectionCard title="Indicator Performance" titleRight={<TrendingUp className="w-4 h-4" style={{ color: FF.textFaint }} />}>
        {!hasIndicatorData || !indicatorKpis ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>No indicators configured for this project yet.</div>
        ) : (
          <>
            <KpiGrid cols={3}>
              <KpiTile label="Overall Achievement" value={indicatorKpis.overallAchievementPct != null ? `${indicatorKpis.overallAchievementPct}%` : '—'} valueSize={26} />
              <KpiTile label="Beneficiaries Reached" value={indicatorKpis.beneficiariesReached} valueSize={26} />
              <KpiTile label="Verified Data" value={indicatorKpis.verifiedDataPct != null ? `${indicatorKpis.verifiedDataPct}%` : '—'} valueSize={26} />
            </KpiGrid>
            <div className="flex items-center gap-2 flex-wrap mt-4">
              {INDICATOR_STATUS_META.map(s => {
                const count = Number(indicatorKpis[s.key]) || 0
                const c = s.status ? ffStatusColors(s.status) : { bg: FF.borderSoft, fg: FF.textFaint }
                return (
                  <StatusBadge key={s.key} bg={c.bg} fg={c.fg} label={`${s.label}: ${count}`} shape="pill" size="sm" />
                )
              })}
            </div>
          </>
        )}
      </SectionCard>
      </Panel>

      <Panel id="compliance">
      <SectionCard title="Compliance &amp; Deadlines">
        <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 14 }}>
          {nextDeadline ? <>Next up: <strong style={{ color: FF.tealDark }}>{nextDeadline.item}</strong> — {nextDeadline.dueLabel}</> : 'Nothing upcoming.'}
        </div>
        {alerts.length === 0 ? (
          <div style={{ fontSize: 13, color: FF.textFaint, textAlign: 'center', padding: '12px 0' }}>No open compliance items.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {alerts.map(a => {
              const c = ffStatusColors(a.status === 'overdue' ? 'red' : 'amber')
              return (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: FF.tealDark }}>{a.item}</div>
                    <div style={{ fontSize: 11.5, color: FF.textMuted, marginTop: 2 }}>{a.dueLabel}</div>
                  </div>
                  <StatusBadge bg={c.bg} fg={c.fg} label={a.status[0].toUpperCase() + a.status.slice(1)} shape="pill" size="sm" />
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
      </Panel>
    </BuiltinLayout>
  )
}
