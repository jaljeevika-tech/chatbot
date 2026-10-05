// Financial Tracker: Section > Subsection > Line item, tracked per calendar month
// (see migration 033). Budget is FY-scoped (migration 066); `fyFilter` narrows both
// the visible month columns and the KPI row to one FY, 'all' shows lifetime totals.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Loader2, Upload, Sparkles, Trash2, Tags, ChevronRight, ChevronDown } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { useProjectContext } from '../../context/ProjectContext'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { StatusBadge } from '../ui/StatusBadge'
import { UploadBudgetUtilisationModal } from './UploadBudgetUtilisationModal'

// Fixed hues for the standard template sections, in the validated categorical order.
const SECTION_COLORS: Record<string, { bg: string; fg: string }> = {
  'PERSONNEL':     { bg: '#DCEAFB', fg: '#2A78D6' },
  'CAPITAL COST':  { bg: '#FBE3D6', fg: '#EB6834' },
  'PROGRAM COST':  { bg: '#D7F3E8', fg: '#1BAF7A' },
  'OVERHEAD COST': { bg: '#FBEACC', fg: '#EDA100' },
}
// Remaining palette slots for custom section names; hashed so the hue is stable across reloads.
const SECTION_FALLBACK_COLORS: { bg: string; fg: string }[] = [
  { bg: '#FADCE8', fg: '#E87BA4' },
  { bg: '#D6ECD6', fg: '#008300' },
  { bg: '#E3DFF6', fg: '#4A3AA7' },
  { bg: '#FBE0DE', fg: '#E34948' },
]
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
function sectionColor(section: string) {
  return SECTION_COLORS[section] || SECTION_FALLBACK_COLORS[hashString(section) % SECTION_FALLBACK_COLORS.length]
}

// Assigned in fixed order so a colour always means the same category. "Other" is a
// deliberate catch-all, so it stays muted gray.
const CATEGORY_COLORS: Record<string, { bg: string; fg: string }> = {
  'Personnel':                    { bg: '#DCEAFB', fg: '#2A78D6' },
  'Program Delivery':             { bg: '#FBE3D6', fg: '#EB6834' },
  'Travel & Field Operations':    { bg: '#D7F3E8', fg: '#1BAF7A' },
  'Training & Capacity Building': { bg: '#FBEACC', fg: '#EDA100' },
  'Equipment & Capital':          { bg: '#FADCE8', fg: '#E87BA4' },
  'Monitoring & Evaluation':      { bg: '#D6ECD6', fg: '#008300' },
  'Administrative & Overheads':   { bg: '#E3DFF6', fg: '#4A3AA7' },
  'Other':                        { bg: FF.borderSoft, fg: FF.textMuted },
}
function categoryColor(category: string) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.Other
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
function monthLabelShort(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

// String comparison works since period_month is always 'YYYY-MM-01'.
function cumExpensesUpTo(expenses: Record<string, number | null>, upTo: string): number {
  let sum = 0
  for (const [m, v] of Object.entries(expenses)) {
    if (m <= upTo && v != null) sum += Number(v)
  }
  return sum
}
// Same, restricted to one FY so cumulative spend matches that FY's budget.
function cumExpensesUpToWithinFY(expenses: Record<string, number | null>, upTo: string, fyStartYear: number): number {
  let sum = 0
  for (const [m, v] of Object.entries(expenses)) {
    if (m <= upTo && v != null && fyOfMonth(m) === fyStartYear) sum += Number(v)
  }
  return sum
}

type Row = {
  section: string
  subsection: string | null
  sr_no: string | null
  budget_head: string
  budget_line_item: string | null   // donor's own budget-line reference code (migration 075)
  budget: Record<number, number | null>            // fy_start_year -> allocation
  expenses: Record<string, number | null>         // period_month -> actual spend
  planned_expenses: Record<string, number | null>  // period_month -> planned spend
}

function budgetForScope(budget: Record<number, number | null>, fyFilter: number | 'all'): number {
  if (fyFilter === 'all') return Object.values(budget).reduce<number>((s, v) => s + (Number(v) || 0), 0)
  return Number(budget[fyFilter]) || 0
}
// Like budgetForScope() but keeps null, so an unset cell shows "—" rather than "₹0".
function fmtBudgetForScope(budget: Record<number, number | null>, fyFilter: number | 'all'): string {
  if (fyFilter === 'all') {
    return Object.keys(budget).length ? budgetForScope(budget, fyFilter).toLocaleString('en-IN') : '—'
  }
  const v = budget[fyFilter]
  return v != null ? Number(v).toLocaleString('en-IN') : '—'
}
// Tooltip for the 'all' view's summed Budget cell, showing which FYs have a figure.
function fyBudgetBreakdown(budget: Record<number, number | null>): string {
  const entries = Object.entries(budget).filter(([, v]) => v != null)
  if (!entries.length) return 'No budget set for any year yet'
  return entries
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([fy, v]) => `FY ${fyLabel(Number(fy))}: ₹${Number(v).toLocaleString('en-IN')}`)
    .join('\n')
}

// Higher % means overspending here, the opposite of statusForPct()/pctBucket(),
// so it can't reuse that helper.
function planUtilisationColor(pct: number): string {
  if (pct > 120) return FF.red
  if (pct > 100) return FF.amber
  return FF.green
}

type TrendPoint = { month: string; expenses_sum: number }
type Trend = { totalBudget: number; trend: TrendPoint[] }

type BurnRate = 'accelerating' | 'decelerating' | 'steady' | 'unknown'
const BURN_COLORS: Record<BurnRate, { bg: string; fg: string; label: string }> = {
  accelerating: { bg: FF.redBg, fg: FF.red, label: 'Spend accelerating' },
  decelerating: { bg: FF.amberBg, fg: FF.amber, label: 'Spend decelerating' },
  steady:       { bg: FF.greenBg, fg: FF.green, label: 'Steady spend' },
  unknown:      { bg: FF.borderSoft, fg: FF.textFaint, label: 'Not enough data' },
}
// Latest month vs the trailing average of up to 3 prior months.
function computeBurnRate(trend: TrendPoint[]): BurnRate {
  if (trend.length < 2) return 'unknown'
  const last = trend[trend.length - 1].expenses_sum
  const priorSlice = trend.slice(-4, -1)
  if (!priorSlice.length) return 'unknown'
  const avgPrior = priorSlice.reduce((s, t) => s + t.expenses_sum, 0) / priorSlice.length
  if (avgPrior === 0) return last > 0 ? 'accelerating' : 'unknown'
  const deltaPct = ((last - avgPrior) / avgPrior) * 100
  if (deltaPct > 15) return 'accelerating'
  if (deltaPct < -15) return 'decelerating'
  return 'steady'
}
function computeAvgMonthlySpend(trend: TrendPoint[]): number | null {
  if (!trend.length) return null
  const last3 = trend.slice(-3)
  return last3.reduce((s, t) => s + t.expenses_sum, 0) / last3.length
}

// Apr–Mar FY, matching fyStartYearOfMonth() in routes/budget-utilisation.routes.js.
// Months are FY-bucketed client-side only; the server returns every month.
function fyOfMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return m >= 4 ? y : y - 1
}
function fyLabel(y: number): string {
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

// Quarter within the FY (Apr-Jun=Q1 ... Jan-Mar=Q4). Month columns collapse per
// quarter by default so multi-year projects fit on screen.
function quarterOfMonth(periodMonth: string): number {
  const [, m] = periodMonth.split('-').map(Number)
  return Math.floor((((m - 4) % 12 + 12) % 12) / 3) + 1
}
function quarterKey(periodMonth: string): string {
  return `${fyOfMonth(periodMonth)}-Q${quarterOfMonth(periodMonth)}`
}
// Spans only the months actually uploaded, which may be part of a quarter.
function quarterRangeLabel(months: string[]): string {
  return months.length === 1 ? monthLabelShort(months[0]) : `${monthLabelShort(months[0])}–${monthLabelShort(months[months.length - 1])}`
}
// null (not 0) when no month in the quarter has a value, so the cell reads "—".
function sumMonths(map: Record<string, number | null>, months: string[]): number | null {
  let sum = 0, any = false
  for (const m of months) {
    const v = map[m]
    if (v != null) { sum += Number(v); any = true }
  }
  return any ? sum : null
}

type BudgetColumn =
  | { kind: 'quarter'; key: string; fy: number; quarter: number; months: string[] }
  | { kind: 'month'; key: string; month: string }

export function BudgetUtilisationPage({ planId }: { planId: string }) {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  // Refresh the session's project list after every write so portfolio cards track this page.
  const { loadProjects } = useProjectContext()
  const [months, setMonths] = useState<string[]>([])
  const [fyFilter, setFyFilter] = useState<number | 'all'>('all')
  const [focusMonth, setFocusMonth] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  // Headline Total Budget per FY (migration 066).
  const [fyGrants, setFyGrants] = useState<Record<number, number>>({})
  // fy_start_year -> the upload period that grant was entered for (migration 077).
  const [grantPeriods, setGrantPeriods] = useState<Record<number, { from: string; to: string }>>({})
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [savingCell, setSavingCell] = useState<string | null>(null) // `${section}|${budget_head}|budget` or `...|${period_month}`
  const [cellError, setCellError] = useState('')

  const [insights, setInsights] = useState<{ narrative: string; flags: { section: string; budget_head: string; type: string; reason: string }[] } | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState('')

  // AI spend categories per line item. Not persisted; cleared whenever rows reload so a
  // stale classification can't linger.
  const [categories, setCategories] = useState<Record<string, string> | null>(null)
  const [categorizing, setCategorizing] = useState(false)
  const [categorizeError, setCategorizeError] = useState('')

  // Drop responses for a plan the user has since switched away from.
  const planIdRef = useRef(planId)
  planIdRef.current = planId
  const [loadError, setLoadError] = useState('')

  const loadData = useCallback(async () => {
    const forPlan = planId
    setLoading(true)
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Couldn't load budget utilisation (error ${r.status})`)
      if (forPlan !== planIdRef.current) return
      setLoadError('')
      const newMonths: string[] = d.months || []
      setMonths(newMonths)
      setRows(d.rows || [])
      setFyGrants(d.fyGrants || {})
      setGrantPeriods(d.grantPeriods || {})
      // focusMonth is re-validated against visibleMonths by the effect below.
    } catch (e: any) {
      if (forPlan !== planIdRef.current) return
      setMonths([]); setRows([]); setFyGrants({}); setGrantPeriods({})
      setLoadError(e.message || "Couldn't load budget utilisation")
    } finally {
      if (forPlan === planIdRef.current) setLoading(false)
    }
  }, [planId])

  const [trend, setTrend] = useState<Trend | null>(null)
  const loadTrend = useCallback(async () => {
    const forPlan = planId
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/trend`)
      if (!r.ok) throw new Error()
      const d = await r.json()
      if (forPlan === planIdRef.current) setTrend(d)
    } catch {
      if (forPlan === planIdRef.current) setTrend(null)
    }
  }, [planId])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { loadTrend() }, [loadTrend])
  useEffect(() => { setInsights(null); setInsightsError('') }, [focusMonth]) // insights are as-of a month, don't carry over
  useEffect(() => { setCategories(null); setCategorizeError('') }, [rows.length]) // new/removed line items invalidate a prior classification

  // FYs with uploaded months or a grant set (a future year's grant may precede its actuals),
  // newest first.
  const fyOptions = useMemo(() => {
    const set = new Set([...months.map(fyOfMonth), ...Object.keys(fyGrants).map(Number)])
    return Array.from(set).sort((a, b) => b - a)
  }, [months, fyGrants])

  const visibleMonths = useMemo(() => (
    fyFilter === 'all' ? months : months.filter(m => fyOfMonth(m) === fyFilter)
  ), [months, fyFilter])

  // Re-validate focusMonth when the visible set changes: an upload keeps the chosen month if
  // still visible, but changing the FY filter always jumps to that scope's latest month, or
  // the KPIs would stay stuck at the old FY's last month.
  const prevFyFilter = useRef(fyFilter)
  useEffect(() => {
    const fyChanged = prevFyFilter.current !== fyFilter
    prevFyFilter.current = fyFilter
    const latest = visibleMonths[visibleMonths.length - 1] ?? null
    setFocusMonth(prev => (!fyChanged && prev && visibleMonths.includes(prev)) ? prev : latest)
  }, [visibleMonths, fyFilter])

  // Expanded quarters, keyed `${fy}-Q${quarter}`; all start collapsed.
  const [expandedQuarters, setExpandedQuarters] = useState<Set<string>>(new Set())
  const toggleQuarter = useCallback((key: string) => {
    setExpandedQuarters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  // One collapsed column per quarter, expanded into month columns via toggleQuarter().
  const columns = useMemo<BudgetColumn[]>(() => {
    const quarterMonths = new Map<string, string[]>()
    for (const m of visibleMonths) {
      const key = quarterKey(m)
      if (!quarterMonths.has(key)) quarterMonths.set(key, [])
      quarterMonths.get(key)!.push(m)
    }
    const cols: BudgetColumn[] = []
    for (const [key, monthsInQ] of quarterMonths) {
      if (expandedQuarters.has(key)) {
        for (const m of monthsInQ) cols.push({ kind: 'month', key: m, month: m })
      } else {
        const [fyStr, qStr] = key.split('-Q')
        cols.push({ kind: 'quarter', key, fy: Number(fyStr), quarter: Number(qStr), months: monthsInQ })
      }
    }
    return cols
  }, [visibleMonths, expandedQuarters])

  const handleCategorize = async () => {
    setCategorizing(true); setCategorizeError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/categorize`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setCategorizeError(d.error || 'Could not categorize'); setCategorizing(false); return }
      setCategories(d.categories || {})
    } catch (e: any) {
      setCategorizeError(e.message || 'Network error')
    }
    setCategorizing(false)
  }

  const handleGenerateInsights = async () => {
    if (!focusMonth) return
    setInsightsLoading(true); setInsightsError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as_of_period_month: focusMonth }),
      })
      const d = await r.json()
      if (!r.ok) { setInsightsError(d.error || 'Could not generate insights'); setInsightsLoading(false); return }
      setInsights({ narrative: d.narrative, flags: d.flags || [] })
    } catch (e: any) {
      setInsightsError(e.message || 'Network error')
    }
    setInsightsLoading(false)
  }

  const handleExpenseCellSave = async (section: string, budgetHead: string, periodMonth: string, value: number | null) => {
    const cellKey = `${section}|${budgetHead}|${periodMonth}`
    setSavingCell(cellKey); setCellError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/cell`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, budget_head: budgetHead, period_month: periodMonth, expenses: value }),
      })
      const d = await r.json()
      if (!r.ok) { setCellError(d.error || 'Save failed'); setSavingCell(null); return }
      setRows(rs => rs.map(row => (row.section === section && row.budget_head === budgetHead)
        ? { ...row, expenses: { ...row.expenses, [periodMonth]: d.expenses } } : row))
      loadProjects()
    } catch (e: any) {
      setCellError(e.message || 'Network error')
    }
    setSavingCell(null)
  }

  const handlePlannedCellSave = async (section: string, budgetHead: string, periodMonth: string, value: number | null) => {
    const cellKey = `${section}|${budgetHead}|plan|${periodMonth}`
    setSavingCell(cellKey); setCellError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/cell`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, budget_head: budgetHead, period_month: periodMonth, planned_expenses: value }),
      })
      const d = await r.json()
      if (!r.ok) { setCellError(d.error || 'Save failed'); setSavingCell(null); return }
      setRows(rs => rs.map(row => (row.section === section && row.budget_head === budgetHead)
        ? { ...row, planned_expenses: { ...row.planned_expenses, [periodMonth]: d.planned_expenses } } : row))
    } catch (e: any) {
      setCellError(e.message || 'Network error')
    }
    setSavingCell(null)
  }

  const handleBudgetCellSave = async (section: string, budgetHead: string, fyStartYear: number, value: number | null) => {
    const cellKey = `${section}|${budgetHead}|budget|${fyStartYear}`
    setSavingCell(cellKey); setCellError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation/cell`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, budget_head: budgetHead, fy_start_year: fyStartYear, budget: value }),
      })
      const d = await r.json()
      if (!r.ok) { setCellError(d.error || 'Save failed'); setSavingCell(null); return }
      setRows(rs => rs.map(row => (row.section === section && row.budget_head === budgetHead)
        ? { ...row, budget: { ...row.budget, [fyStartYear]: d.budget } } : row))
      loadProjects()
    } catch (e: any) {
      setCellError(e.message || 'Network error')
    }
    setSavingCell(null)
  }

  const handleUploaded = async (info: { count: number; periods: string[]; fy_start_year: number }) => {
    setShowUpload(false)
    setToast(`Saved ${info.count} cell(s) across ${info.periods.length} month(s)`)
    setTimeout(() => setToast(null), 5000)
    setFyFilter(info.fy_start_year)
    await loadData()
    loadTrend()
    loadProjects()
  }

  const [deleting, setDeleting] = useState(false)
  const handleDelete = async () => {
    if (!focusMonth) return
    const affected = rows.filter(r => r.expenses[focusMonth] != null).length
    if (!confirm(`Delete all expense data for ${monthLabel(focusMonth)}?\n\nThis clears that month's column across ${affected} line item(s) and cannot be undone.`)) return
    setDeleting(true)
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation?period_month=${focusMonth}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) { setToast(d.error || 'Delete failed'); setTimeout(() => setToast(null), 5000); setDeleting(false); return }
      setToast(`Deleted data for ${monthLabel(focusMonth)}`)
      setTimeout(() => setToast(null), 5000)
      await loadData()
      await loadTrend()
      loadProjects()
    } catch (e: any) {
      setToast(e.message || 'Network error')
      setTimeout(() => setToast(null), 5000)
    }
    setDeleting(false)
  }

  // Wipes a whole FY (all monthly figures plus its grant). Only offered for a specific FY.
  const [deletingFy, setDeletingFy] = useState(false)
  const handleDeleteFy = async () => {
    if (fyFilter === 'all') return
    const monthCount = months.filter(m => fyOfMonth(m) === fyFilter).length
    const grantNote = fyGrants[fyFilter] != null ? ` and its ₹${fyGrants[fyFilter].toLocaleString('en-IN')} grant` : ''
    if (!confirm(`Delete ALL data for FY ${fyLabel(fyFilter)}?\n\nThis clears ${monthCount} month(s) of budget/expense data across every line item${grantNote} and cannot be undone.`)) return
    setDeletingFy(true)
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation?fy_start_year=${fyFilter}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) { setToast(d.error || 'Delete failed'); setTimeout(() => setToast(null), 5000); setDeletingFy(false); return }
      setToast(`Deleted all data for FY ${fyLabel(fyFilter)}`)
      setTimeout(() => setToast(null), 5000)
      setFyFilter('all')
      await loadData()
      await loadTrend()
      loadProjects()
    } catch (e: any) {
      setToast(e.message || 'Network error')
      setTimeout(() => setToast(null), 5000)
    }
    setDeletingFy(false)
  }

  // Total Budget is the project's headline figure, not a sum of line-item budgets (that
  // sum drifted across uploads). 'all' prefers SUM(fyGrants), falling back to the trend's
  // lifetime figure; a specific FY uses that year's grant. Expenses/Balance follow suit.
  const grantValues = Object.values(fyGrants)
  // A grant entered with an upload period covers that period, not Apr–Mar, so a selected FY
  // uses the grant whose period covers it and measures Expenses/Balance over that period.
  const activeGrant = useMemo((): { amount: number; period: { from: string; to: string } | null } | null => {
    if (fyFilter === 'all') return null
    if (fyGrants[fyFilter] != null) return { amount: fyGrants[fyFilter], period: grantPeriods[fyFilter] ?? null }
    const fyStart = `${fyFilter}-04-01`, fyEnd = `${fyFilter + 1}-03-01`
    for (const [fy, p] of Object.entries(grantPeriods)) {
      if (p.from <= fyEnd && p.to >= fyStart && fyGrants[Number(fy)] != null) return { amount: fyGrants[Number(fy)], period: p }
    }
    return null
  }, [fyFilter, fyGrants, grantPeriods])
  const grantPeriod = activeGrant?.period ?? null
  // Period-grant expenses run to the selected month, or to the period's end when the latest
  // month is selected (the period may extend past this FY's last visible month).
  const periodUpTo = grantPeriod && focusMonth
    ? (focusMonth === visibleMonths[visibleMonths.length - 1] && grantPeriod.to > focusMonth ? grantPeriod.to : (focusMonth < grantPeriod.to ? focusMonth : grantPeriod.to))
    : null
  const totalBudget = fyFilter === 'all'
    ? (grantValues.length ? grantValues.reduce((s, v) => s + (Number(v) || 0), 0) : (trend?.totalBudget ?? 0))
    : (activeGrant?.amount ?? 0)
  const totalExpenses = !focusMonth ? 0
    : fyFilter === 'all'
      ? rows.reduce((s, r) => s + cumExpensesUpTo(r.expenses, focusMonth), 0)
      : grantPeriod && periodUpTo
        ? rows.reduce((s, r) => s + Object.entries(r.expenses).reduce((t, [m, v]) => (m >= grantPeriod.from && m <= periodUpTo && v != null) ? t + Number(v) : t, 0), 0)
        : rows.reduce((s, r) => s + cumExpensesUpToWithinFY(r.expenses, focusMonth, fyFilter), 0)
  const periodLabel = grantPeriod ? `${monthLabel(grantPeriod.from)} – ${monthLabel(grantPeriod.to)}` : null
  const balance = totalBudget - totalExpenses
  const utilisedPct = totalBudget > 0 ? Math.round((totalExpenses / totalBudget) * 100) : 0

  // Same FY scope as the table, so the chart, avg spend and burn badge agree with it.
  const trendPoints = useMemo(() => {
    const all = trend?.trend ?? []
    return fyFilter === 'all' ? all : all.filter(t => fyOfMonth(t.month) === fyFilter)
  }, [trend, fyFilter])
  const avgMonthlySpend = useMemo(() => computeAvgMonthlySpend(trendPoints), [trendPoints])
  const burnRate = useMemo(() => computeBurnRate(trendPoints), [trendPoints])

  const scopedExpenses = useCallback((r: Row, upTo: string) => (
    fyFilter === 'all' ? cumExpensesUpTo(r.expenses, upTo) : cumExpensesUpToWithinFY(r.expenses, upTo, fyFilter)
  ), [fyFilter])

  const sectionTotals = useMemo(() => {
    if (!focusMonth) return []
    const map = new Map<string, { budget: number; expenses: number }>()
    for (const r of rows) {
      const cur = map.get(r.section) || { budget: 0, expenses: 0 }
      cur.budget += budgetForScope(r.budget, fyFilter)
      cur.expenses += scopedExpenses(r, focusMonth)
      map.set(r.section, cur)
    }
    return Array.from(map.entries())
      .map(([section, v]) => ({ section, ...v }))
      .sort((a, b) => b.expenses - a.expenses)
  }, [rows, focusMonth, fyFilter, scopedExpenses])

  // Same shape as sectionTotals, grouped by AI category. Empty until "AI Categorize" runs.
  const categoryTotals = useMemo(() => {
    if (!focusMonth || !categories) return []
    const map = new Map<string, { budget: number; expenses: number }>()
    for (const r of rows) {
      const cat = categories[r.budget_head] || 'Other'
      const cur = map.get(cat) || { budget: 0, expenses: 0 }
      cur.budget += budgetForScope(r.budget, fyFilter)
      cur.expenses += scopedExpenses(r, focusMonth)
      map.set(cat, cur)
    }
    return Array.from(map.entries())
      .map(([section, v]) => ({ section, ...v }))
      .sort((a, b) => b.expenses - a.expenses)
  }, [rows, focusMonth, categories, fyFilter, scopedExpenses])

  const grouped = useMemo(() => {
    const bySection = new Map<string, Map<string | null, Row[]>>()
    for (const r of rows) {
      if (!bySection.has(r.section)) bySection.set(r.section, new Map())
      const subMap = bySection.get(r.section)!
      if (!subMap.has(r.subsection)) subMap.set(r.subsection, [])
      subMap.get(r.subsection)!.push(r)
    }
    return bySection
  }, [rows])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Month cells stack Actual + Plan + %; quarter columns need extra room for the range label.
  const colTemplate = `220px 90px 100px 100px ${columns.map(c => c.kind === 'quarter' ? '128px' : '112px').join(' ')}`
  // Sticky "Budget Head" cell: negative margin + box-shadow cover the row padding and grid
  // gap so scrolled month figures don't show through either side.
  const stickyHeadStyle = (bg: string, indent = 0): CSSProperties => ({
    position: 'sticky', left: 0, zIndex: 2, background: bg,
    marginLeft: -22, paddingLeft: 22 + indent,
    boxShadow: `8px 0 0 0 ${bg}, 9px 0 0 0 ${FF.borderSoft}`,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {months.length > 0 && (
            <select
              value={fyFilter}
              onChange={e => setFyFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
              title="Scopes the KPIs, trend chart and table below to one Financial Year's own grant and spend — 'All Years' shows lifetime totals"
            >
              <option value="all">All Years</option>
              {fyOptions.map(y => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
            </select>
          )}
          {isAdmin && fyFilter !== 'all' && (
            <button
              onClick={handleDeleteFy}
              disabled={deletingFy}
              title={`Delete all data for FY ${fyLabel(fyFilter)}`}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
              style={{ border: `1px solid ${FF.red}`, color: FF.red, background: '#FFFFFF' }}
            >
              {deletingFy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete FY {fyLabel(fyFilter)} data
            </button>
          )}
          {visibleMonths.length > 0 ? (
            <>
              <select
                value={focusMonth ?? ''}
                onChange={e => setFocusMonth(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
              >
                {visibleMonths.slice().reverse().map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
              {isAdmin && focusMonth && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  title="Delete this month's expense data"
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
                  style={{ border: `1px solid ${FF.red}`, color: FF.red, background: '#FFFFFF' }}
                >
                  {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Delete {monthLabel(focusMonth)} data
                </button>
              )}
            </>
          ) : months.length > 0 ? (
            <span className="text-xs" style={{ color: FF.textFaint }}>
              No data for FY {fyLabel(fyFilter as number)} —{' '}
              <button onClick={() => setFyFilter('all')} className="underline font-semibold" style={{ color: FF.purple }}>show all years</button>
            </span>
          ) : (
            <span className="text-xs" style={{ color: FF.textFaint }}>No data uploaded yet</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCategorize}
            disabled={!focusMonth || categorizing}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
            style={{ border: `1px solid ${FF.border}`, color: FF.purple, background: '#FFFFFF' }}
            title="Use AI to classify every line item into a spend category"
          >
            {categorizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tags className="w-4 h-4" />}
            Categorize
          </button>
          <button
            onClick={handleGenerateInsights}
            disabled={!focusMonth || insightsLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
            style={{ border: `1px solid ${FF.border}`, color: FF.purple, background: '#FFFFFF' }}
            title="Use AI to summarize cumulative spend and flag unusual line items"
          >
            {insightsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            AI Insights
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: FF.purple }}
          >
            <Upload className="w-4 h-4" /> Upload / Update
          </button>
        </div>
      </div>

      {toast && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.greenBg, color: FF.green }}>{toast}</div>
      )}
      {cellError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{cellError}</div>
      )}
      {insightsError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{insightsError}</div>
      )}
      {categorizeError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{categorizeError}</div>
      )}
      {loadError && !loading && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{loadError}</div>
      )}
      {insights && (
        <div
          className="rounded-2xl p-5"
          style={{ background: `linear-gradient(135deg, ${FF.tealDark} 0%, #1A5F75 100%)`, color: '#fff' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4" style={{ color: '#5DD5F5' }} />
            <span className="text-sm font-bold">AI Insights</span>
          </div>
          <p className="text-sm mb-3" style={{ color: '#C0E8F5', lineHeight: 1.6 }}>{insights.narrative}</p>
          {insights.flags.length > 0 && (
            <div className="flex flex-col gap-1.5 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.15)' }}>
              {insights.flags.map((f, i) => {
                const color = f.type === 'over_budget' || f.type === 'spike_up' ? '#F5A3A3'
                  : f.type === 'no_budget' || f.type === 'new_spend' ? '#F5D08A'
                  : '#B8DDE8'
                return (
                  <div key={i} className="text-xs" style={{ color: '#E7F2F3' }}>
                    <span className="font-semibold" style={{ color }}>{f.section} · {f.budget_head}:</span> {f.reason}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : months.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No Budget Utilisation data uploaded yet. Click "Upload / Update" to add it.
        </div>
      ) : visibleMonths.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No months uploaded yet for FY {fyLabel(fyFilter as number)}
          {fyGrants[fyFilter as number] != null && <> (grant of ₹{fyGrants[fyFilter as number].toLocaleString('en-IN')} already set)</>}.{' '}
          <button onClick={() => setFyFilter('all')} className="underline font-semibold" style={{ color: FF.purple }}>Show all years</button> instead.
        </div>
      ) : (
        <>
          <KpiGrid cols={6}>
            <KpiTile label="Total Budget" value={totalBudget.toLocaleString('en-IN')} note={fyFilter === 'all' ? 'lifetime, all years' : periodLabel ? `for ${periodLabel}` : `FY ${fyLabel(fyFilter)} grant`} />
            <KpiTile label="Total Expenses" value={totalExpenses.toLocaleString('en-IN')} note={!focusMonth ? undefined
              : grantPeriod && periodUpTo ? `${monthLabel(grantPeriod.from)} – ${monthLabel(periodUpTo)}`
              : `cumulative as of ${monthLabel(focusMonth)}${fyFilter !== 'all' ? `, FY ${fyLabel(fyFilter)}` : ''}`} />
            <KpiTile label="Balance" value={balance.toLocaleString('en-IN')} note={fyFilter === 'all' ? 'lifetime' : periodLabel ? `of ${periodLabel} budget` : `FY ${fyLabel(fyFilter)}`} />
            <KpiTile label="% Utilised" value={`${utilisedPct}%`} note={fyFilter === 'all' ? 'cumulative to date' : periodLabel ? `of ${periodLabel} budget` : `cumulative, FY ${fyLabel(fyFilter)}`} />
            <KpiTile
              label="Avg Monthly Spend"
              value={avgMonthlySpend != null ? Math.round(avgMonthlySpend).toLocaleString('en-IN') : '—'}
              note={trendPoints.length ? `trailing ${Math.min(3, trendPoints.length)} month(s)` : 'needs data'}
            />
            <div style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textMuted }}>Burn Rate</div>
              <div style={{ marginTop: 8 }}>
                <StatusBadge bg={BURN_COLORS[burnRate].bg} fg={BURN_COLORS[burnRate].fg} label={BURN_COLORS[burnRate].label} />
              </div>
            </div>
          </KpiGrid>

          <SectionCard
            title="Monthly Spend Trend"
            titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>{fyFilter === 'all' ? 'Across every month uploaded' : `FY ${fyLabel(fyFilter)}`}</span>}
          >
            <SpendTrendChart totalBudget={totalBudget} trend={trendPoints} />
          </SectionCard>

          <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-4">
            <SectionCard title="Budget vs Cumulative Expenses by Section">
              <SectionBarChart data={sectionTotals} colorFor={sectionColor} />
            </SectionCard>
            <SectionCard title="Cumulative Expenses Distribution by Section">
              <SectionDonutChart data={sectionTotals} colorFor={sectionColor} />
            </SectionCard>
          </div>

          {categories && (
            <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-4">
              <SectionCard
                title="Budget vs Cumulative Expenses by Category"
                titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>AI-classified, independent of the sheet's own sections</span>}
              >
                <SectionBarChart data={categoryTotals} colorFor={categoryColor} />
              </SectionCard>
              <SectionCard title="Cumulative Expenses Distribution by Category">
                <SectionDonutChart data={categoryTotals} colorFor={categoryColor} />
              </SectionCard>
            </div>
          )}

          <SectionCard noPadding>
            {/* Below md the month columns become unreadable, so the same rows render as cards (md:hidden block). */}
            <div className="hidden md:flex items-center justify-between px-4 pt-3">
              <span className="text-[11px]" style={{ color: FF.textFaint }}>
                {fyFilter === 'all' ? 'Scroll to see every uploaded month' : `Showing FY ${fyLabel(fyFilter)} only`}
              </span>
              <button
                onClick={() => scrollRef.current?.scrollTo({ left: 999999, behavior: 'smooth' })}
                className="text-[11px] font-semibold px-2 py-1 rounded"
                style={{ color: FF.purple }}
              >
                Jump to latest →
              </button>
            </div>
            <div className="hidden md:block">
              <div ref={scrollRef} style={{ overflowX: 'auto' }}>
                {/* max-content so row borders and section bands span the full scrolled width. */}
                <div style={{ width: 'max-content', minWidth: '100%' }}>
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: colTemplate, gap: 8,
                      padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                      color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                    }}
                  >
                    <div style={stickyHeadStyle('#FFFFFF')}>Budget Head</div>
                    <div title={fyFilter === 'all' ? 'Sum across every year — pick a specific Financial Year above to edit' : `FY ${fyLabel(fyFilter)}`}>Budget</div>
                    <div title={focusMonth ? `Cumulative expenses as of ${monthLabel(focusMonth)}${fyFilter !== 'all' ? `, FY ${fyLabel(fyFilter)}` : ''}` : undefined}>Expense</div>
                    <div>Balance</div>
                    {columns.map(col => col.kind === 'quarter' ? (
                      <button
                        key={col.key}
                        onClick={() => toggleQuarter(col.key)}
                        className="flex items-center justify-center gap-0.5 hover:opacity-70"
                        style={{ background: 'none', border: 'none', padding: 0, color: FF.textFaint, cursor: 'pointer', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}
                        title={`Q${col.quarter} FY ${fyLabel(col.fy)} · ${quarterRangeLabel(col.months)} — click to show individual months`}
                      >
                        Q{col.quarter} {quarterRangeLabel(col.months)}
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    ) : (
                      <button
                        key={col.key}
                        onClick={() => toggleQuarter(quarterKey(col.month))}
                        className="flex items-center justify-center gap-0.5 hover:opacity-70"
                        style={{ background: 'none', border: 'none', padding: 0, color: FF.textFaint, cursor: 'pointer', font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}
                        title={`${monthLabel(col.month)} — Actual / Plan / % of Plan — click to collapse back to quarter`}
                      >
                        <ChevronDown className="w-3 h-3" />
                        {monthLabelShort(col.month)}
                      </button>
                    ))}
                  </div>
                  {Array.from(grouped.entries()).map(([section, subMap]) => {
                    const c = sectionColor(section)
                    return (
                      <div key={section}>
                        <div style={{ padding: '10px 22px', background: c.bg }}>
                          <div style={{ position: 'sticky', left: 22, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: c.fg, display: 'inline-block' }} />
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: c.fg }}>{section}</span>
                          </div>
                        </div>
                        {Array.from(subMap.entries()).map(([subsection, items]) => (
                          <div key={subsection ?? '_'}>
                            {subsection && (
                              <div style={{ padding: '8px 22px', fontSize: 12, fontWeight: 600, color: FF.textMuted }}>
                                <span style={{ position: 'sticky', left: 22 }}>{subsection}</span>
                              </div>
                            )}
                            {items.map(r => {
                              const exp = focusMonth ? scopedExpenses(r, focusMonth) : 0
                              const bal = budgetForScope(r.budget, fyFilter) - exp
                              return (
                                <div
                                  key={r.budget_head}
                                  style={{
                                    display: 'grid', gridTemplateColumns: colTemplate, gap: 8,
                                    alignItems: 'center', padding: '11px 22px',
                                    borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                                  }}
                                >
                                  <div
                                    className="flex items-center gap-1.5"
                                    style={{ ...stickyHeadStyle('#FFFFFF', subsection ? 18 : 0), color: FF.tealDark, minWidth: 0 }}
                                  >
                                    {categories && (
                                      <span
                                        title={categories[r.budget_head] || 'Other'}
                                        style={{
                                          width: 8, height: 8, borderRadius: 999, flexShrink: 0,
                                          background: categoryColor(categories[r.budget_head] || 'Other').fg,
                                        }}
                                      />
                                    )}
                                    <span className="truncate" title={[r.sr_no, r.budget_line_item].filter(Boolean).join(' · ') || undefined}>{r.budget_head}</span>
                                    {r.budget_line_item && (
                                      <span
                                        className="truncate shrink-0"
                                        style={{ fontSize: 10.5, color: FF.textFaint, background: FF.borderFaint, borderRadius: 4, padding: '1px 5px' }}
                                        title={`Budget Line Item: ${r.budget_line_item}`}
                                      >
                                        {r.budget_line_item}
                                      </span>
                                    )}
                                  </div>
                                  {isAdmin && fyFilter !== 'all' ? (
                                    <EditableCell
                                      value={r.budget[fyFilter] ?? null}
                                      saving={savingCell === `${section}|${r.budget_head}|budget|${fyFilter}`}
                                      onSave={v => handleBudgetCellSave(section, r.budget_head, fyFilter, v)}
                                    />
                                  ) : (
                                    <div
                                      style={{ color: FF.textMuted }}
                                      title={fyFilter === 'all'
                                        ? fyBudgetBreakdown(r.budget) + (isAdmin ? '\n\n(select a specific year above to edit)' : '')
                                        : undefined}
                                    >
                                      {fmtBudgetForScope(r.budget, fyFilter)}
                                    </div>
                                  )}
                                  <div style={{ color: FF.textMuted }}>{exp.toLocaleString('en-IN')}</div>
                                  <div style={{ color: bal < 0 ? FF.red : FF.textFaint }}>{bal.toLocaleString('en-IN')}</div>
                                  {columns.map(col => col.kind === 'month' ? (
                                    <MonthPlanActualCell
                                      key={col.month}
                                      actual={r.expenses[col.month] ?? null}
                                      plan={r.planned_expenses[col.month] ?? null}
                                      isAdmin={isAdmin}
                                      savingActual={savingCell === `${section}|${r.budget_head}|${col.month}`}
                                      savingPlan={savingCell === `${section}|${r.budget_head}|plan|${col.month}`}
                                      onSaveActual={v => handleExpenseCellSave(section, r.budget_head, col.month, v)}
                                      onSavePlan={v => handlePlannedCellSave(section, r.budget_head, col.month, v)}
                                    />
                                  ) : (
                                    <QuarterSummaryCell
                                      key={col.key}
                                      actual={sumMonths(r.expenses, col.months)}
                                      plan={sumMonths(r.planned_expenses, col.months)}
                                      monthCount={col.months.length}
                                    />
                                  ))}
                                </div>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="md:hidden">
              {Array.from(grouped.entries()).map(([section, subMap]) => {
                const c = sectionColor(section)
                return (
                  <div key={section}>
                    <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: c.bg }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: c.fg, display: 'inline-block' }} />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: c.fg }}>{section}</span>
                    </div>
                    {Array.from(subMap.entries()).map(([subsection, items]) => (
                      <div key={subsection ?? '_'} className="divide-y" style={{ borderColor: FF.borderFaint }}>
                        {subsection && (
                          <div className="px-4 pt-2" style={{ fontSize: 12, fontWeight: 600, color: FF.textMuted }}>
                            {subsection}
                          </div>
                        )}
                        {items.map(r => {
                          const exp = focusMonth ? scopedExpenses(r, focusMonth) : 0
                          const bal = budgetForScope(r.budget, fyFilter) - exp
                          return (
                            <div key={r.budget_head} className="p-4">
                              <div className="flex items-center gap-1.5 mb-2">
                                {categories && (
                                  <span
                                    title={categories[r.budget_head] || 'Other'}
                                    style={{
                                      width: 8, height: 8, borderRadius: 999, flexShrink: 0,
                                      background: categoryColor(categories[r.budget_head] || 'Other').fg,
                                    }}
                                  />
                                )}
                                <span style={{ color: FF.tealDark, fontWeight: 600, fontSize: 14 }}>{r.budget_head}</span>
                                {r.budget_line_item && (
                                  <span
                                    style={{ fontSize: 10.5, color: FF.textFaint, background: FF.borderFaint, borderRadius: 4, padding: '1px 5px' }}
                                    title={`Budget Line Item: ${r.budget_line_item}`}
                                  >
                                    {r.budget_line_item}
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-2" style={{ fontSize: 12.5 }}>
                                <div>
                                  <div style={{ color: FF.textFaint, fontSize: 11 }}>Budget</div>
                                  {isAdmin && fyFilter !== 'all' ? (
                                    <EditableCell
                                      value={r.budget[fyFilter] ?? null}
                                      saving={savingCell === `${section}|${r.budget_head}|budget|${fyFilter}`}
                                      onSave={v => handleBudgetCellSave(section, r.budget_head, fyFilter, v)}
                                    />
                                  ) : (
                                    <div style={{ color: FF.textMuted }} title={fyFilter === 'all' ? fyBudgetBreakdown(r.budget) : undefined}>
                                      {fmtBudgetForScope(r.budget, fyFilter)}
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <div style={{ color: FF.textFaint, fontSize: 11 }}>Expense</div>
                                  <div style={{ color: FF.textMuted }}>{exp.toLocaleString('en-IN')}</div>
                                </div>
                                <div>
                                  <div style={{ color: FF.textFaint, fontSize: 11 }}>Balance</div>
                                  <div style={{ color: bal < 0 ? FF.red : FF.textFaint }}>{bal.toLocaleString('en-IN')}</div>
                                </div>
                                {visibleMonths.map(m => (
                                  <div key={m}>
                                    <div style={{ color: FF.textFaint, fontSize: 11 }}>{monthLabel(m)}</div>
                                    <MonthPlanActualCell
                                      actual={r.expenses[m] ?? null}
                                      plan={r.planned_expenses[m] ?? null}
                                      isAdmin={isAdmin}
                                      savingActual={savingCell === `${section}|${r.budget_head}|${m}`}
                                      savingPlan={savingCell === `${section}|${r.budget_head}|plan|${m}`}
                                      onSaveActual={v => handleExpenseCellSave(section, r.budget_head, m, v)}
                                      onSavePlan={v => handlePlannedCellSave(section, r.budget_head, m, v)}
                                      align="left"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </SectionCard>
        </>
      )}

      {showUpload && (
        <UploadBudgetUtilisationModal
          planId={planId}
          fyGrants={fyGrants}
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}

// Click-to-edit numeric cell, admin-only. `small` is for the secondary Plan figure.
function EditableCell({ value, saving, onSave, bold, small }: {
  value: number | null
  saving: boolean
  onSave: (v: number | null) => void
  bold?: boolean
  small?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    setEditing(false)
    const num = draft.trim() === '' ? null : Number(draft)
    if (num !== null && isNaN(num)) return
    if (num !== value) onSave(num)
  }

  if (editing) {
    return (
      <input
        autoFocus type="number"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        onBlur={commit}
        className={`text-center border rounded outline-none ${small ? 'w-14 text-[10.5px]' : 'w-20 text-sm'}`}
        style={{ borderColor: FF.purple }}
      />
    )
  }
  return (
    <div
      className="flex items-center gap-1 cursor-pointer hover:bg-purple-50 px-1 rounded"
      style={{ color: FF.textMuted, fontWeight: bold ? 600 : 400, fontSize: small ? 10.5 : undefined }}
      title="Click to edit"
      onClick={() => { setDraft(value != null ? String(value) : ''); setEditing(true) }}
    >
      {value != null ? value.toLocaleString('en-IN') : '—'}
      {saving && <Loader2 className={small ? 'w-2.5 h-2.5 animate-spin' : 'w-3 h-3 animate-spin'} style={{ color: FF.textFaint }} />}
    </div>
  )
}

// One month's cell: editable Actual over editable Plan and the Actual-vs-Plan %.
function MonthPlanActualCell({ actual, plan, isAdmin, savingActual, savingPlan, onSaveActual, onSavePlan, align = 'right' }: {
  actual: number | null
  plan: number | null
  isAdmin: boolean
  savingActual: boolean
  savingPlan: boolean
  onSaveActual: (v: number | null) => void
  onSavePlan: (v: number | null) => void
  align?: 'left' | 'right'
}) {
  const pct = plan != null && plan > 0 && actual != null ? Math.round((actual / plan) * 100) : null
  return (
    <div className="flex flex-col gap-0.5" style={{ alignItems: align === 'right' ? 'flex-end' : 'flex-start' }}>
      {isAdmin ? (
        <EditableCell value={actual} saving={savingActual} onSave={onSaveActual} />
      ) : (
        <div style={{ color: FF.textMuted }}>{actual != null ? actual.toLocaleString('en-IN') : '—'}</div>
      )}
      <div className="flex items-center gap-1">
        {isAdmin ? (
          <EditableCell value={plan} saving={savingPlan} onSave={onSavePlan} small />
        ) : (
          <span style={{ fontSize: 10.5, color: FF.textFaint }} title="Plan">{plan != null ? plan.toLocaleString('en-IN') : '—'}</span>
        )}
        {pct != null ? (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: planUtilisationColor(pct) }} title="Actual as % of this month's Plan">
            {pct}%
          </span>
        ) : (
          <span style={{ fontSize: 10.5, color: FF.textFaint }}>{plan == null ? 'no plan' : ''}</span>
        )}
      </div>
    </div>
  )
}

// Collapsed quarter cell: sums of its months, read-only since edits need one period_month.
function QuarterSummaryCell({ actual, plan, monthCount }: { actual: number | null; plan: number | null; monthCount: number }) {
  const pct = plan != null && plan > 0 && actual != null ? Math.round((actual / plan) * 100) : null
  return (
    <div
      className="flex flex-col gap-0.5 items-end"
      title={`Sum across ${monthCount} month(s) in this quarter — click the quarter header to edit individual months`}
    >
      <div style={{ color: FF.textMuted }}>{actual != null ? actual.toLocaleString('en-IN') : '—'}</div>
      <div className="flex items-center gap-1">
        <span style={{ fontSize: 10.5, color: FF.textFaint }} title="Plan">{plan != null ? plan.toLocaleString('en-IN') : '—'}</span>
        {pct != null ? (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: planUtilisationColor(pct) }} title="Actual as % of this quarter's Plan">
            {pct}%
          </span>
        ) : (
          <span style={{ fontSize: 10.5, color: FF.textFaint }}>{plan == null ? 'no plan' : ''}</span>
        )}
      </div>
    </div>
  )
}

// Monthly expenses vs a flat budget-ceiling line. Labels thin out past ~8 points; every
// point keeps a native <title> tooltip.
function SpendTrendChart({ totalBudget, trend }: { totalBudget: number; trend: TrendPoint[] }) {
  if (trend.length === 0) {
    return (
      <div className="text-xs py-6 text-center" style={{ color: FF.textFaint }}>
        No data uploaded yet.
      </div>
    )
  }
  const w = 640, h = 160, padX = 10, padY = 16
  const maxVal = Math.max(totalBudget, ...trend.map(t => t.expenses_sum), 1)
  const xFor = (i: number) => trend.length === 1 ? w / 2 : padX + (i / (trend.length - 1)) * (w - padX * 2)
  const yFor = (v: number) => h - padY - (v / maxVal) * (h - padY * 2)
  const expensesPath = trend.map((t, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(t.expenses_sum)}`).join(' ')
  const budgetY = yFor(totalBudget)
  const step = Math.max(1, Math.ceil(trend.length / 8))
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
        <line x1={padX} y1={budgetY} x2={w - padX} y2={budgetY} stroke={FF.textFaint} strokeWidth={2} strokeDasharray="5 4" />
        <path d={expensesPath} fill="none" stroke={FF.purple} strokeWidth={2.5} />
        {trend.map((t, i) => (
          <circle key={t.month} cx={xFor(i)} cy={yFor(t.expenses_sum)} r={3.5} fill={FF.purple}>
            <title>{`${monthLabel(t.month)} — ₹${Math.round(t.expenses_sum).toLocaleString('en-IN')}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between text-[10px] mt-1" style={{ color: FF.textFaint }}>
        {trend.map((t, i) => (
          <span key={t.month} style={{ visibility: (i % step === 0 || i === trend.length - 1) ? 'visible' : 'hidden' }}>
            {monthLabelShort(t.month)}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: FF.textMuted }}>
        <span className="flex items-center gap-1.5"><span style={{ width: 14, height: 2, background: FF.textFaint, display: 'inline-block' }} /> Budget (ceiling)</span>
        <span className="flex items-center gap-1.5"><span style={{ width: 14, height: 2, background: FF.purple, display: 'inline-block' }} /> Expenses (that month)</span>
      </div>
    </div>
  )
}

// Dual bar per group (Budget outlined, cumulative Expenses filled); `colorFor` picks
// section or AI-category colours.
function SectionBarChart({ data, colorFor }: { data: { section: string; budget: number; expenses: number }[]; colorFor: (key: string) => { bg: string; fg: string } }) {
  const maxVal = Math.max(...data.flatMap(d => [d.budget, d.expenses]), 1)
  return (
    <div className="flex flex-col gap-4">
      {data.map(d => {
        const c = colorFor(d.section)
        return (
          <div key={d.section}>
            <div className="flex justify-between text-xs mb-1">
              <span style={{ color: FF.textMuted }}>{d.section}</span>
              <span style={{ fontWeight: 600, color: c.fg }}>
                {d.expenses.toLocaleString('en-IN')} spent / {d.budget.toLocaleString('en-IN')} budget
              </span>
            </div>
            <div className="flex flex-col gap-[3px]">
              <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }} title="Budget">
                <div style={{
                  height: 8, width: `${Math.max((d.budget / maxVal) * 100, d.budget > 0 ? 3 : 0)}%`,
                  background: c.bg, border: `1px solid ${c.fg}`, boxSizing: 'border-box', borderRadius: 999,
                }} />
              </div>
              <div style={{ height: 8, background: c.bg, borderRadius: 999 }} title="Expenses">
                <div style={{
                  height: 8, width: `${Math.max((d.expenses / maxVal) * 100, d.expenses > 0 ? 3 : 0)}%`,
                  background: c.fg, borderRadius: 999, transition: 'width .3s',
                }} />
              </div>
            </div>
          </div>
        )
      })}
      {data.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>No line items</div>}
    </div>
  )
}

// Cumulative-expenses share donut, by section or AI category via `colorFor`.
function SectionDonutChart({ data, colorFor }: { data: { section: string; budget: number; expenses: number }[]; colorFor: (key: string) => { bg: string; fg: string } }) {
  const total = data.reduce((s, d) => s + d.expenses, 0)
  const r = 58, cx = 75, cy = 75, circ = 2 * Math.PI * r
  let cumulative = 0
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={150} height={150} viewBox="0 0 150 150" style={{ flexShrink: 0 }}>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={FF.borderSoft} strokeWidth={22} />
          ) : data.filter(d => d.expenses > 0).map(d => {
            const frac = d.expenses / total
            const len = frac * circ
            const dashoffset = -cumulative
            cumulative += len
            return (
              <circle
                key={d.section} cx={cx} cy={cy} r={r} fill="none"
                stroke={colorFor(d.section).fg} strokeWidth={22}
                strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={dashoffset}
              />
            )
          })}
        </g>
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, fill: FF.tealDark }}>
          {total >= 100000 ? `₹${(total / 100000).toFixed(1)}L` : `₹${total.toLocaleString('en-IN')}`}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 10, fill: FF.textFaint }}>spent</text>
      </svg>
      <div className="flex flex-col gap-1.5">
        {data.map(d => (
          <div key={d.section} className="flex items-center gap-2 text-xs">
            <span style={{ width: 10, height: 10, borderRadius: 999, background: colorFor(d.section).fg, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: FF.textMuted }}>{d.section}</span>
            <span style={{ fontWeight: 600, color: FF.tealDark }}>{total > 0 ? Math.round((d.expenses / total) * 100) : 0}%</span>
          </div>
        ))}
        {data.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>No line items</div>}
      </div>
    </div>
  )
}
