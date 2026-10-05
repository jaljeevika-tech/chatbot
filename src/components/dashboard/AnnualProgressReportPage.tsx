// Annual Progress Report: cumulative per-FY/month snapshots in the uploaded template's
// own columns. See UploadAnnualProgressModal.tsx for why this isn't the monthly grid.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Upload, Link as LinkIcon, Sparkles, Newspaper, Trash2 } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { useProjectDailyReports } from '../../hooks/useProjectDailyReports'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { TabPill } from '../ui/TabPill'
import { SectionCard } from '../ui/SectionCard'
import { StatusBadge } from '../ui/StatusBadge'
import { ReportCard } from '../cards/ReportCard'
import { UploadAnnualProgressModal } from './UploadAnnualProgressModal'

const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']

// Mirrors AP_CATEGORIES in routes/action-plan.routes.js, so a label always gets the same colour.
const CATEGORY_COLORS: Record<string, { bg: string; fg: string }> = {
  'Training':                     { bg: '#EDE9FE', fg: '#7C3AED' },
  'Exposure Visit':                { bg: '#DBEAFE', fg: '#2563EB' },
  'Community Mobilization':        { bg: '#FCE7F3', fg: '#DB2777' },
  'Enterprise & Livelihood':       { bg: FF.greenBg, fg: FF.green },
  'Infrastructure':                { bg: '#FEF3C7', fg: '#D97706' },
  'Financial Literacy':            { bg: '#CFFAFE', fg: '#0891B2' },
  'Livestock & Animal Husbandry':  { bg: '#FFEDD5', fg: '#EA580C' },
  'Knowledge & Content':           { bg: '#E0E7FF', fg: '#4F46E5' },
  'Other':                         { bg: FF.borderSoft, fg: FF.textMuted },
}

function defaultFYStartYear() {
  const now = new Date()
  const y = now.getFullYear()
  return now.getMonth() + 1 >= 4 ? y : y - 1
}
function fyLabel(y: number) {
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

// Plain-text links pasted without a scheme (e.g. "www.example.com") resolve
// relative to the current page and 404 instead of opening — assume https.
function normalizeLink(link: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`
}

type Row = {
  sn: number
  activity: string
  category: string | null
  target: number | null
  achievement_total: number | null
  locations: Record<string, number | null>
  related_link: string | null
  remark: string | null
}

type TrendPoint = { month: string; target_sum: number; achievement_sum: number }
type Trend = { trend: TrendPoint[]; projectedYearEnd: number | null; pace: 'ahead' | 'behind' | 'on_track' | 'unknown'; elapsedPct: number; achievedPct?: number | null }
const PACE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  ahead:    { bg: FF.greenBg, fg: FF.green, label: 'Ahead of pace' },
  on_track: { bg: FF.amberBg, fg: FF.amber, label: 'On track' },
  behind:   { bg: FF.redBg,   fg: FF.red,   label: 'Behind pace' },
  unknown:  { bg: FF.borderSoft, fg: FF.textFaint, label: 'Not enough data' },
}

async function getJson(url: string) {
  const r = await apiFetch(url)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `Couldn't load the report (error ${r.status})`)
  return d
}

export function AnnualProgressReportPage({ planId, projectName, projectKey, region, locations: projectLocations }: {
  planId: string
  projectName: string
  projectKey?: string
  region?: string | null
  locations?: string[]
}) {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [fyStartYear, setFyStartYear] = useState(defaultFYStartYear())
  const [availableMonths, setAvailableMonths] = useState<string[]>([])
  const [month, setMonth] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [categorizing, setCategorizing] = useState(false)
  const [categorizeError, setCategorizeError] = useState('')
  const [savingCell, setSavingCell] = useState<string | null>(null) // `${activity}|${field}`
  const [cellError, setCellError] = useState('')

  const [insights, setInsights] = useState<{ narrative: string; flags: { activity: string | null; category: string | null; type: string; reason: string }[] } | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState('')

  // Daily field reports from FY start through the selected month, matching the cumulative
  // window of the figures. Informational only; never feeds a calculation.
  const [reportLocationFilter, setReportLocationFilter] = useState('')
  const { reports: matchedReports, loading: reportsLoading } = useProjectDailyReports(projectName, projectKey, reportLocationFilter)

  // [FY start, end of selected month): MONTHS[0] = Apr of fyStartYear, MONTHS[9..11] = Jan-Mar of fyStartYear+1.
  const fyToMonthRange = useCallback((fy: number, m: string) => {
    const idx = MONTHS.indexOf(m)
    const calYear = idx <= 8 ? fy : fy + 1
    const calMonthNum = ((idx + 3) % 12) + 1 // Apr(0)->4 ... Dec(8)->12, Jan(9)->1 ... Mar(11)->3
    return { start: new Date(fy, 3, 1), end: new Date(calYear, calMonthNum, 1) }
  }, [])

  const dailyReports = useMemo(() => {
    if (!month) return []
    const { start, end } = fyToMonthRange(fyStartYear, month)
    return matchedReports.filter(r => {
      const t = new Date(r.timestamp).getTime()
      return t >= start.getTime() && t < end.getTime()
    })
  }, [matchedReports, fyStartYear, month, fyToMonthRange])

  const REPORTS_PER_PAGE = 6
  const [reportsPage, setReportsPage] = useState(0)
  useEffect(() => { setReportsPage(0) }, [fyStartYear, month, reportLocationFilter, projectName])
  const reportsPageCount = Math.max(1, Math.ceil(dailyReports.length / REPORTS_PER_PAGE))
  const pagedReports = dailyReports.slice(reportsPage * REPORTS_PER_PAGE, (reportsPage + 1) * REPORTS_PER_PAGE)

  // Drop responses for a plan/FY the user has since switched away from.
  const periodRef = useRef('')
  periodRef.current = `${planId}:${fyStartYear}`
  const [loadError, setLoadError] = useState('')

  const loadMonths = useCallback(async () => {
    const period = `${planId}:${fyStartYear}`
    try {
      const d = await getJson(`/api/action-plans/${planId}/annual-progress/months?fy_start_year=${fyStartYear}`)
      if (period === periodRef.current) setAvailableMonths(d.months || [])
    } catch {
      if (period === periodRef.current) setAvailableMonths([])
    }
  }, [planId, fyStartYear])

  const loadSnapshot = useCallback(async (m: string | null) => {
    const period = `${planId}:${fyStartYear}`
    setLoading(true)
    try {
      const url = `/api/action-plans/${planId}/annual-progress?fy_start_year=${fyStartYear}` + (m ? `&month=${m}` : '')
      const d = await getJson(url)
      if (period !== periodRef.current) return
      setMonth(d.month || null)
      setRows(d.rows || [])
      setLoadError('')
    } catch (e: any) {
      if (period !== periodRef.current) return
      setMonth(null)
      setRows([])
      setLoadError(e.message || "Couldn't load the report")
    } finally {
      if (period === periodRef.current) setLoading(false)
    }
  }, [planId, fyStartYear])

  const [trend, setTrend] = useState<Trend | null>(null)
  const loadTrend = useCallback(async () => {
    const period = `${planId}:${fyStartYear}`
    try {
      const d = await getJson(`/api/action-plans/${planId}/annual-progress/trend?fy_start_year=${fyStartYear}`)
      if (period === periodRef.current) setTrend(d)
    } catch {
      if (period === periodRef.current) setTrend(null)
    }
  }, [planId, fyStartYear])

  useEffect(() => { loadMonths() }, [loadMonths])
  useEffect(() => { loadSnapshot(null) }, [loadSnapshot]) // null = server picks the latest month
  useEffect(() => { loadTrend() }, [loadTrend])
  useEffect(() => { setInsights(null); setInsightsError('') }, [fyStartYear, month])

  const handleGenerateInsights = async () => {
    if (!month) return
    setInsightsLoading(true); setInsightsError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/annual-progress/insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fy_start_year: fyStartYear, month, daily_report_count: dailyReports.length }),
      })
      const d = await r.json()
      if (!r.ok) { setInsightsError(d.error || 'Could not generate insights'); setInsightsLoading(false); return }
      setInsights({ narrative: d.narrative, flags: d.flags || [] })
    } catch (e: any) {
      setInsightsError(e.message || 'Network error')
    }
    setInsightsLoading(false)
  }

  const handleCategorize = async () => {
    if (!month) return
    setCategorizing(true); setCategorizeError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/annual-progress/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fy_start_year: fyStartYear, month }),
      })
      const d = await r.json()
      if (!r.ok) { setCategorizeError(d.error || 'Categorization failed'); setCategorizing(false); return }
      setToast(`Categorized ${Object.keys(d.categories || {}).length} activities`)
      setTimeout(() => setToast(null), 5000)
      await loadSnapshot(month)
    } catch (e: any) {
      setCategorizeError(e.message || 'Network error')
    }
    setCategorizing(false)
  }

  const handleCellSave = async (activityName: string, field: 'target' | 'achievement_total', value: number | null) => {
    if (!month) return
    const cellKey = `${activityName}|${field}`
    setSavingCell(cellKey); setCellError('')
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/annual-progress/cell`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fy_start_year: fyStartYear, month, activity_name: activityName, [field]: value }),
      })
      const d = await r.json()
      if (!r.ok) { setCellError(d.error || 'Save failed'); setSavingCell(null); return }
      setRows(rs => rs.map(row => row.activity === activityName ? { ...row, [field]: d[field] } : row))
    } catch (e: any) {
      setCellError(e.message || 'Network error')
    }
    setSavingCell(null)
  }

  const handleUploaded = (info: { fy_start_year: number; month: string; count: number }) => {
    setShowUpload(false)
    setToast(`Saved ${info.count} activities for ${fyLabel(info.fy_start_year)} · ${info.month}`)
    setTimeout(() => setToast(null), 5000)
    if (info.fy_start_year !== fyStartYear) setFyStartYear(info.fy_start_year)
    loadMonths()
    loadSnapshot(info.month)
    loadTrend()
  }

  const [deleting, setDeleting] = useState(false)
  const handleDelete = async () => {
    if (!month) return
    if (!confirm(`Delete the ENTIRE Annual Progress Report snapshot for FY ${fyLabel(fyStartYear)} · ${month}?\n\nThis removes all ${rows.length} activities and cannot be undone.`)) return
    setDeleting(true)
    try {
      const r = await apiFetch(`/api/action-plans/${planId}/annual-progress?fy_start_year=${fyStartYear}&month=${month}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) { setToast(d.error || 'Delete failed'); setTimeout(() => setToast(null), 5000); setDeleting(false); return }
      setToast(`Deleted ${d.deleted} activities for ${fyLabel(fyStartYear)} · ${month}`)
      setTimeout(() => setToast(null), 5000)
      await loadMonths()
      await loadSnapshot(null)
      await loadTrend()
    } catch (e: any) {
      setToast(e.message || 'Network error')
      setTimeout(() => setToast(null), 5000)
    }
    setDeleting(false)
  }

  const locationNames = Array.from(new Set(rows.flatMap(r => Object.keys(r.locations || {}))))
  // Number(...) matters: pg returns NUMERIC as strings, and `0 + "53"` concatenates.
  const targetSum = rows.reduce((s, r) => s + (Number(r.target) || 0), 0)
  const achievedSum = rows.reduce((s, r) => s + (Number(r.achievement_total) || 0), 0)
  const overallPct = targetSum > 0 ? Math.round((achievedSum / targetSum) * 100) : 0
  const locationTotals = locationNames.map(loc => ({
    location: loc,
    total: rows.reduce((s, r) => s + (Number(r.locations?.[loc]) || 0), 0),
  }))
  const categoryTotals = (() => {
    const map = new Map<string, { target: number; achievement: number }>()
    for (const r of rows) {
      const cat = r.category || 'Uncategorized'
      const cur = map.get(cat) || { target: 0, achievement: 0 }
      cur.target += Number(r.target) || 0
      cur.achievement += Number(r.achievement_total) || 0
      map.set(cat, cur)
    }
    return Array.from(map.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.achievement - a.achievement)
  })()
  const fyOptions = [defaultFYStartYear() - 1, defaultFYStartYear(), defaultFYStartYear() + 1, fyStartYear]
    .filter((y, i, arr) => arr.indexOf(y) === i)
    .sort((a, b) => a - b)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>

      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="text-lg font-semibold" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>{projectName}</h2>
        {region && (
          <span className="text-sm" style={{ color: FF.textMuted }}>{region}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={fyStartYear}
            onChange={e => setFyStartYear(Number(e.target.value))}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
          >
            {fyOptions.map(y => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
          </select>
          {availableMonths.length > 0 ? (
            <TabPill
              tabs={availableMonths
                .slice()
                .sort((a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b))
                .map(m => ({ key: m, label: m }))}
              active={month ?? availableMonths[0]}
              onChange={m => loadSnapshot(m)}
              size="xs"
            />
          ) : (
            <span className="text-xs" style={{ color: FF.textFaint }}>No snapshots uploaded yet for FY {fyLabel(fyStartYear)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerateInsights}
            disabled={!month || insightsLoading}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
            style={{ border: `1px solid ${FF.border}`, color: FF.purple, background: '#FFFFFF' }}
            title="Use AI to summarize pace and flag unusual activity, cross-checked against daily field reports"
          >
            {insightsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            AI Insights
          </button>
          <button
            onClick={handleCategorize}
            disabled={!month || categorizing}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
            style={{ border: `1px solid ${FF.border}`, color: FF.purple, background: '#FFFFFF' }}
            title="Use AI to categorize each activity (Training, Visit, ...)"
          >
            {categorizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Categorize with AI
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: FF.purple }}
          >
            <Upload className="w-4 h-4" /> Upload / Update
          </button>
          {isAdmin && month && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="Delete this entire FY+Month snapshot"
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition disabled:opacity-50"
              style={{ border: `1px solid ${FF.red}`, color: FF.red, background: '#FFFFFF' }}
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete Snapshot
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.greenBg, color: FF.green }}>{toast}</div>
      )}
      {categorizeError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{categorizeError}</div>
      )}
      {cellError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{cellError}</div>
      )}
      {insightsError && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: FF.redBg, color: FF.red }}>{insightsError}</div>
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
                const color = f.type === 'achievement_decreased' ? '#F5A3A3'
                  : f.type === 'no_target' || f.type === 'low_field_evidence' ? '#F5D08A'
                  : '#B8DDE8'
                const label = [f.category, f.activity].filter(Boolean).join(' · ')
                return (
                  <div key={i} className="text-xs" style={{ color: '#E7F2F3' }}>
                    {label && <span className="font-semibold" style={{ color }}>{label}: </span>}
                    <span style={{ color: label ? undefined : color }}>{f.reason}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No Annual Progress Report snapshot yet for this Financial Year. Click "Upload / Update" to add one.
        </div>
      ) : (
        <>
          <KpiGrid cols={5}>
            <KpiTile label="Total Target" value={targetSum} />
            <KpiTile label="Total Achievement" value={achievedSum} note={`as of ${month}`} />
            <KpiTile label="Overall Achievement" value={`${overallPct}%`} />
            <KpiTile
              label="Projected Year-End"
              value={trend?.projectedYearEnd != null ? Math.round(trend.projectedYearEnd).toLocaleString('en-IN') : '—'}
              note={trend?.trend.length ? `from ${trend.trend.length} month(s) uploaded` : 'needs a snapshot'}
            />
            <div style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textMuted }}>Pace</div>
              <div style={{ marginTop: 8 }}>
                <StatusBadge
                  bg={(PACE_COLORS[trend?.pace ?? 'unknown']).bg}
                  fg={(PACE_COLORS[trend?.pace ?? 'unknown']).fg}
                  label={(PACE_COLORS[trend?.pace ?? 'unknown']).label}
                />
              </div>
              {trend && trend.pace !== 'unknown' && (
                <div style={{ fontSize: 12, color: FF.textFaint, marginTop: 6, fontWeight: 500 }}>
                  {trend.elapsedPct}% of FY elapsed
                </div>
              )}
            </div>
          </KpiGrid>

          <SectionCard
            title="Cumulative Achievement Trend"
            titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Across every month uploaded this FY</span>}
          >
            <AchievementTrendChart trend={trend?.trend ?? []} />
          </SectionCard>

          <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr] gap-4">
            <SectionCard title="Target vs Achievement by Activity">
              <TargetAchievementChart rows={rows} />
            </SectionCard>
            <SectionCard
              title="Achievement by Location"
              titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Target isn't tracked per location in this report</span>}
            >
              <LocationBarChart totals={locationTotals} />
            </SectionCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-4">
            <SectionCard
              title="Target vs Achievement by Category"
              titleRight={categoryTotals.some(c => c.category === 'Uncategorized') && (
                <span className="text-[11px]" style={{ color: FF.textFaint }}>Click "Categorize with AI" above to fill in the rest</span>
              )}
            >
              <CategoryBarChart data={categoryTotals} />
            </SectionCard>
            <SectionCard title="Category Distribution">
              <CategoryDonutChart data={categoryTotals} />
            </SectionCard>
          </div>

          <SectionCard noPadding>
            {/* Below md the location columns become unreadable, so rows render as cards (md:hidden block). */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 760 + locationNames.length * 100 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `40px 1.8fr 120px 90px 100px ${locationNames.map(() => '100px').join(' ')} 90px 1.4fr`,
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>S.N.</div><div>Activity</div><div>Category</div><div>Target</div><div>Achievement</div>
                  {locationNames.map(l => <div key={l} title={l} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</div>)}
                  <div>Link</div><div>Remark</div>
                </div>
                {rows.map(r => (
                  <div
                    key={r.sn}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `40px 1.8fr 120px 90px 100px ${locationNames.map(() => '100px').join(' ')} 90px 1.4fr`,
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.textFaint }}>{r.sn}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.activity}</div>
                    <div>
                      {r.category ? (
                        <StatusBadge
                          bg={(CATEGORY_COLORS[r.category] || CATEGORY_COLORS.Other).bg}
                          fg={(CATEGORY_COLORS[r.category] || CATEGORY_COLORS.Other).fg}
                          label={r.category}
                        />
                      ) : <span style={{ color: FF.textFaint, fontSize: 12 }}>—</span>}
                    </div>
                    {isAdmin ? (
                      <EditableCell
                        value={r.target}
                        saving={savingCell === `${r.activity}|target`}
                        onSave={v => handleCellSave(r.activity, 'target', v)}
                      />
                    ) : (
                      <div style={{ color: FF.textMuted }}>{r.target ?? '—'}</div>
                    )}
                    {isAdmin ? (
                      <EditableCell
                        value={r.achievement_total}
                        saving={savingCell === `${r.activity}|achievement_total`}
                        onSave={v => handleCellSave(r.activity, 'achievement_total', v)}
                        bold
                      />
                    ) : (
                      <div style={{ color: FF.textMuted, fontWeight: 600 }}>{r.achievement_total ?? '—'}</div>
                    )}
                    {locationNames.map(l => (
                      <div key={l} style={{ color: FF.textMuted }}>{r.locations?.[l] ?? '—'}</div>
                    ))}
                    <div>
                      {r.related_link ? (
                        <a href={normalizeLink(r.related_link)} target="_blank" rel="noreferrer" style={{ color: FF.purple }}>
                          <LinkIcon className="w-4 h-4" />
                        </a>
                      ) : <span style={{ color: FF.textFaint }}>—</span>}
                    </div>
                    <div style={{ color: FF.textFaint, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.remark ?? ''}>
                      {r.remark ?? ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {rows.map(r => (
                <div key={r.sn} className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="min-w-0">
                      <div style={{ color: FF.textFaint, fontSize: 11 }}>#{r.sn}</div>
                      <div style={{ color: FF.tealDark, fontWeight: 600, fontSize: 14 }}>{r.activity}</div>
                    </div>
                    {r.category ? (
                      <StatusBadge
                        bg={(CATEGORY_COLORS[r.category] || CATEGORY_COLORS.Other).bg}
                        fg={(CATEGORY_COLORS[r.category] || CATEGORY_COLORS.Other).fg}
                        label={r.category}
                      />
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 mb-2" style={{ fontSize: 12.5 }}>
                    <div>
                      <div style={{ color: FF.textFaint, fontSize: 11 }}>Target</div>
                      {isAdmin ? (
                        <EditableCell
                          value={r.target}
                          saving={savingCell === `${r.activity}|target`}
                          onSave={v => handleCellSave(r.activity, 'target', v)}
                        />
                      ) : (
                        <div style={{ color: FF.textMuted }}>{r.target ?? '—'}</div>
                      )}
                    </div>
                    <div>
                      <div style={{ color: FF.textFaint, fontSize: 11 }}>Achievement</div>
                      {isAdmin ? (
                        <EditableCell
                          value={r.achievement_total}
                          saving={savingCell === `${r.activity}|achievement_total`}
                          onSave={v => handleCellSave(r.activity, 'achievement_total', v)}
                          bold
                        />
                      ) : (
                        <div style={{ color: FF.textMuted, fontWeight: 600 }}>{r.achievement_total ?? '—'}</div>
                      )}
                    </div>
                    {locationNames.map(l => (
                      <div key={l}>
                        <div style={{ color: FF.textFaint, fontSize: 11 }} className="truncate" title={l}>{l}</div>
                        <div style={{ color: FF.textMuted }}>{r.locations?.[l] ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    {r.related_link ? (
                      <a href={normalizeLink(r.related_link)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-semibold" style={{ color: FF.purple }}>
                        <LinkIcon className="w-3.5 h-3.5" /> Link
                      </a>
                    ) : null}
                    {r.remark && (
                      <span style={{ color: FF.textFaint, fontSize: 12 }} className="truncate">{r.remark}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </>
      )}

      <SectionCard
        title="Related Field Reports"
        titleRight={(
          <div className="flex items-center gap-2">
            <Newspaper className="w-4 h-4" style={{ color: FF.textFaint }} />
            {projectLocations && projectLocations.length > 0 && (
              <select
                value={reportLocationFilter}
                onChange={e => setReportLocationFilter(e.target.value)}
                className="rounded-lg px-2 py-1 text-xs outline-none"
                style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
              >
                <option value="">All locations</option>
                {projectLocations.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
          </div>
        )}
      >
        <p className="text-xs mb-3" style={{ color: FF.textFaint }}>
          Daily field reports for {projectName}, {fyLabel(fyStartYear)} Apr through {month ?? '…'} — context for the numbers above, not part of any calculation.
        </p>
        {reportsLoading ? (
          <div className="flex items-center justify-center py-8" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : dailyReports.length === 0 ? (
          <div className="text-xs py-4" style={{ color: FF.textFaint }}>No daily field reports found for this period.</div>
        ) : (
          <>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {pagedReports.map(r => <ReportCard key={r.id} report={r} />)}
            </div>
            {reportsPageCount > 1 && (
              <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
                <button
                  onClick={() => setReportsPage(p => Math.max(0, p - 1))}
                  disabled={reportsPage === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Previous
                </button>
                <span className="text-xs" style={{ color: FF.textFaint }}>
                  Page {reportsPage + 1} of {reportsPageCount} · {dailyReports.length} reports
                </span>
                <button
                  onClick={() => setReportsPage(p => Math.min(reportsPageCount - 1, p + 1))}
                  disabled={reportsPage >= reportsPageCount - 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </SectionCard>

      {showUpload && (
        <UploadAnnualProgressModal
          planId={planId}
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}

// Click-to-edit numeric cell, admin-only. Enter/blur commits, Escape cancels.
function EditableCell({ value, saving, onSave, bold }: {
  value: number | null
  saving: boolean
  onSave: (v: number | null) => void
  bold?: boolean
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
        className="w-16 text-sm text-center border rounded outline-none"
        style={{ borderColor: FF.purple }}
      />
    )
  }
  return (
    <div
      className="flex items-center gap-1 cursor-pointer hover:bg-purple-50 px-1 rounded"
      style={{ color: FF.textMuted, fontWeight: bold ? 600 : 400 }}
      title="Click to edit"
      onClick={() => { setDraft(value != null ? String(value) : ''); setEditing(true) }}
    >
      {value ?? '—'}
      {saving && <Loader2 className="w-3 h-3 animate-spin" style={{ color: FF.textFaint }} />}
    </div>
  )
}

// Dual pill-bar per activity (Target vs Achievement).
function TargetAchievementChart({ rows }: { rows: Row[] }) {
  const chartH = 120
  const maxVal = Math.max(...rows.flatMap(r => [Number(r.target) || 0, Number(r.achievement_total) || 0]), 1)
  return (
    <div>
      <div className="flex items-end gap-3 overflow-x-auto" style={{ height: chartH + 40, paddingBottom: 4 }}>
        {rows.map(r => {
          const target = Number(r.target) || 0
          const achieved = Number(r.achievement_total) || 0
          const th = Math.max((target / maxVal) * chartH, target > 0 ? 6 : 2)
          const ah = Math.max((achieved / maxVal) * chartH, achieved > 0 ? 6 : 2)
          return (
            <div
              key={r.sn}
              className="flex flex-col items-center gap-1 shrink-0"
              title={`${r.activity}: target ${target}, achieved ${achieved}`}
              style={{ width: 28 }}
            >
              <div className="flex items-end gap-[3px]" style={{ height: chartH }}>
                <div style={{ width: 10, height: th, borderRadius: 999, background: FF.textFaint }} />
                <div style={{ width: 10, height: ah, borderRadius: 999, background: FF.purple }} />
              </div>
              <div style={{ fontSize: 10, color: FF.textFaint }}>{r.sn}</div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: FF.textMuted }}>
        <span className="flex items-center gap-1.5"><span style={{ width: 9, height: 9, borderRadius: 999, background: FF.textFaint, display: 'inline-block' }} /> Target</span>
        <span className="flex items-center gap-1.5"><span style={{ width: 9, height: 9, borderRadius: 999, background: FF.purple, display: 'inline-block' }} /> Achievement</span>
      </div>
    </div>
  )
}

// Cumulative achievement vs flat target line across this FY's months. Each stored month is
// already cumulative (migration 024), so raw per-month sums are plotted.
function AchievementTrendChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length < 2) {
    return (
      <div className="text-xs py-6 text-center" style={{ color: FF.textFaint }}>
        {trend.length === 0 ? 'No snapshots uploaded yet for this FY.' : 'Upload more than one month to see a trend.'}
      </div>
    )
  }
  const w = 640, h = 160, padX = 10, padY = 16
  const maxVal = Math.max(...trend.flatMap(t => [t.target_sum, t.achievement_sum]), 1)
  const xFor = (i: number) => padX + (i / (trend.length - 1)) * (w - padX * 2)
  const yFor = (v: number) => h - padY - (v / maxVal) * (h - padY * 2)
  const achievedPath = trend.map((t, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(t.achievement_sum)}`).join(' ')
  const targetPath = trend.map((t, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(t.target_sum)}`).join(' ')
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
        <path d={targetPath} fill="none" stroke={FF.textFaint} strokeWidth={2} strokeDasharray="5 4" />
        <path d={achievedPath} fill="none" stroke={FF.purple} strokeWidth={2.5} />
        {trend.map((t, i) => (
          <circle key={t.month} cx={xFor(i)} cy={yFor(t.achievement_sum)} r={3.5} fill={FF.purple} />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] mt-1" style={{ color: FF.textFaint }}>
        {trend.map(t => <span key={t.month}>{t.month}</span>)}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: FF.textMuted }}>
        <span className="flex items-center gap-1.5"><span style={{ width: 14, height: 2, background: FF.textFaint, display: 'inline-block' }} /> Target</span>
        <span className="flex items-center gap-1.5"><span style={{ width: 14, height: 2, background: FF.purple, display: 'inline-block' }} /> Achievement (cumulative)</span>
      </div>
    </div>
  )
}

// Total cumulative achievement per location, across all activities.
function LocationBarChart({ totals }: { totals: { location: string; total: number }[] }) {
  const maxVal = Math.max(...totals.map(t => t.total), 1)
  return (
    <div className="flex flex-col gap-3">
      {totals.map(t => (
        <div key={t.location}>
          <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
            <span title={t.location} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{t.location}</span>
            <span style={{ fontWeight: 600, color: FF.tealDark }}>{t.total}</span>
          </div>
          <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
            <div style={{ height: 8, width: `${Math.max((t.total / maxVal) * 100, t.total > 0 ? 3 : 0)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
          </div>
        </div>
      ))}
      {totals.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>No location data</div>}
    </div>
  )
}

function categoryColor(category: string) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.Other
}

// Dual Target/Achievement bar per category, in that category's colours.
function CategoryBarChart({ data }: { data: { category: string; target: number; achievement: number }[] }) {
  const maxVal = Math.max(...data.flatMap(d => [d.target, d.achievement]), 1)
  return (
    <div className="flex flex-col gap-4">
      {data.map(d => {
        const c = categoryColor(d.category)
        return (
          <div key={d.category}>
            <div className="flex justify-between text-xs mb-1">
              <span style={{ color: FF.textMuted }}>{d.category}</span>
              <span style={{ fontWeight: 600, color: c.fg }}>{d.achievement} achieved / {d.target || '—'} target</span>
            </div>
            <div className="flex flex-col gap-[3px]">
              <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }} title="Target">
                <div style={{
                  height: 8, width: `${Math.max((d.target / maxVal) * 100, d.target > 0 ? 3 : 0)}%`,
                  background: c.bg, border: `1px solid ${c.fg}`, boxSizing: 'border-box', borderRadius: 999,
                }} />
              </div>
              <div style={{ height: 8, background: c.bg, borderRadius: 999 }} title="Achievement">
                <div style={{
                  height: 8, width: `${Math.max((d.achievement / maxVal) * 100, d.achievement > 0 ? 3 : 0)}%`,
                  background: c.fg, borderRadius: 999, transition: 'width .3s',
                }} />
              </div>
            </div>
          </div>
        )
      })}
      {data.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>No activities in this snapshot</div>}
    </div>
  )
}

// Multi-slice SVG donut built from cumulative stroke-dasharray offsets.
function CategoryDonutChart({ data }: { data: { category: string; target: number; achievement: number }[] }) {
  const total = data.reduce((s, d) => s + d.achievement, 0)
  const r = 58, cx = 75, cy = 75, circ = 2 * Math.PI * r
  let cumulative = 0
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={150} height={150} viewBox="0 0 150 150" style={{ flexShrink: 0 }}>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={FF.borderSoft} strokeWidth={22} />
          ) : data.filter(d => d.achievement > 0).map(d => {
            const frac = d.achievement / total
            const len = frac * circ
            const dashoffset = -cumulative
            cumulative += len
            return (
              <circle
                key={d.category} cx={cx} cy={cy} r={r} fill="none"
                stroke={categoryColor(d.category).fg} strokeWidth={22}
                strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={dashoffset}
              />
            )
          })}
        </g>
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "'Newsreader',serif", fontSize: 20, fontWeight: 600, fill: FF.tealDark }}>{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 10, fill: FF.textFaint }}>achieved</text>
      </svg>
      <div className="flex flex-col gap-1.5">
        {data.map(d => (
          <div key={d.category} className="flex items-center gap-2 text-xs">
            <span style={{ width: 10, height: 10, borderRadius: 999, background: categoryColor(d.category).fg, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: FF.textMuted }}>{d.category}</span>
            <span style={{ fontWeight: 600, color: FF.tealDark }}>{total > 0 ? Math.round((d.achievement / total) * 100) : 0}%</span>
          </div>
        ))}
        {data.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>No activities in this snapshot</div>}
      </div>
    </div>
  )
}
