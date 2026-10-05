// Project report picker tab: controls on the left, live preview of matching data
// on the right.

import { useEffect, useMemo, useState } from 'react'
import { TrendingUp, X, MapPin, Calendar, Hash, RotateCcw, Check, FileSpreadsheet, Infinity as InfinityIcon } from 'lucide-react'
import { useLanguage } from '../../context/LanguageContext'
import { useProjectContext } from '../../context/ProjectContext'
import { apiFetch } from '../../utils/apiFetch'
import { EmptyState } from '../ui/EmptyState'
import { KpiTile } from '../ui/KpiTile'
import { FF } from '../../theme/colors'
import { formatDate } from '../../utils/format'
import { MultiSelect } from './MultiSelect'
import { REPORT_LANGUAGES } from '../../constants/reportLanguages'
import { PERIODS as DATED_PERIODS, periodRange, type Period as DatedPeriod } from './reportPickerPeriods'
import type { DailyReport, ActiveFilters } from '../../types/report'

interface Props {
  baseReports: DailyReport[]
  reportTitle: string
  instruction: string
  onOpenReport: (
    title: string,
    reports: DailyReport[],
    instruction: string,
    options?: { filters?: ActiveFilters; language?: string },
  ) => void
  onClose: () => void
}

// Adds an "All" preset (no date bounds) ahead of the shared presets.
type Period = 'all' | DatedPeriod

const PERIODS: { key: Period; icon: typeof InfinityIcon }[] = [
  { key: 'all', icon: InfinityIcon },
  ...DATED_PERIODS,
]

// Same Apr-start FY convention as AnnualProgressReportPage.tsx / UploadAnnualProgressModal.tsx.
function defaultFYStartYear(now: Date): number {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
}
function fyLabel(y: number): string {
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

type ApRow = { activity: string; target: number | null; achievement_total: number | null }
type ApSnapshot = { rows: ApRow[]; fyStartYear: number; month: string; exact: boolean }

export function ProjectReportPickerView({ baseReports, reportTitle, instruction, onOpenReport, onClose }: Props) {
  const { t } = useLanguage()
  const { projects } = useProjectContext()
  const PERIOD_LABELS: Record<Period, string> = {
    all: ((t as unknown as Record<string, string>).prpAllReports) || 'All Reports',
    monthly: t.prpThisMonth, previousMonth: t.prpPreviousMonth, quarterly: t.prpThisQuarter,
    halfYearly: t.prpHalfYearly, annual: t.prpThisYear,
  }

  const [selectedProjects, setSelectedProjects] = useState<string[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [from,    setFrom]    = useState('')
  const [to,      setTo]      = useState('')
  const [period,  setPeriod]  = useState<Period | null>(null)
  // The report's output language, separate from the UI language; passed on as initialLanguage.
  const [reportLanguage, setReportLanguage] = useState<string>('English')

  // Singular when exactly one project is picked, a count otherwise.
  const projectsLabel = selectedProjects.length === 1
    ? selectedProjects[0]
    : selectedProjects.length > 1
      ? `${selectedProjects.length} projects`
      : ''

  // Annual Progress Report (Target vs Achievement) is a separate source from the field
  // activity data and must never be merged into those tables; it's passed as its own
  // block. Prefers the current FY's snapshot, else the latest upload.
  const [apSnapshot, setApSnapshot] = useState<ApSnapshot | null>(null)
  const [apLoading, setApLoading] = useState(false)

  // Single project only. A string id, not the plan object, so the fetch effect doesn't
  // re-run when a background refresh replaces the `projects` array.
  const selectedPlanId = useMemo(() => {
    if (selectedProjects.length !== 1) return null
    const only = selectedProjects[0]
    return projects.find(p => p.name.trim().toLowerCase() === only.trim().toLowerCase())?.id ?? null
  }, [selectedProjects, projects])

  useEffect(() => {
    setApSnapshot(null)
    if (!selectedPlanId) return

    let cancelled = false
    setApLoading(true)
    ;(async () => {
      try {
        const fy = defaultFYStartYear(new Date())
        const exactRes = await apiFetch(`/api/action-plans/${selectedPlanId}/annual-progress?fy_start_year=${fy}`)
        const exact = await exactRes.json()
        if (cancelled) return
        if (exact.rows?.length) {
          setApSnapshot({ rows: exact.rows, fyStartYear: fy, month: exact.month, exact: true })
          return
        }

        const latestRes = await apiFetch(`/api/action-plans/${selectedPlanId}/annual-progress/latest`)
        const latest = await latestRes.json()
        if (cancelled) return
        if (latest.rows?.length) {
          setApSnapshot({ rows: latest.rows, fyStartYear: latest.fy_start_year, month: latest.month, exact: false })
        }
      } catch {
        // Optional enrichment — leave it out of the report on failure.
      } finally {
        if (!cancelled) setApLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [selectedPlanId])

  const apTotals = useMemo(() => {
    if (!apSnapshot) return null
    const targetSum = apSnapshot.rows.reduce((s, r) => s + (Number(r.target) || 0), 0)
    const achievementSum = apSnapshot.rows.reduce((s, r) => s + (Number(r.achievement_total) || 0), 0)
    return { targetSum, achievementSum }
  }, [apSnapshot])

  function applyPeriod(p: Period) {
    const { from: f, to: tt } = p === 'all' ? { from: '', to: '' } : periodRange(p, new Date())
    setFrom(f)
    setTo(tt)
    setPeriod(p)
  }

  const projectOptions = useMemo(
    () => [...new Set(baseReports.map(r => r.project).filter(Boolean))].sort(),
    [baseReports]
  )

  // Per-period record counts shown as badges so empty periods are visible before clicking.
  const periodCounts = useMemo(() => {
    if (selectedProjects.length === 0) return null
    const now = new Date()
    const counts: Record<Period, number> = { all: 0, monthly: 0, previousMonth: 0, quarterly: 0, halfYearly: 0, annual: 0 }
    for (const { key } of PERIODS) {
      if (key === 'all') {
        counts.all = baseReports.filter(r => selectedProjects.includes(r.project)).length
        continue
      }
      const { from: f, to: tt } = periodRange(key, now)
      counts[key] = baseReports.filter(r => {
        if (!selectedProjects.includes(r.project)) return false
        const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''
        return date && date >= f && date <= tt
      }).length
    }
    return counts
  }, [selectedProjects, baseReports])

  // Project + date filtered pool for the Location dropdown, so it only offers villages
  // with data in scope (same two-stage filter as CaseStudyPickerView.tsx).
  const projectDateData = useMemo(() => {
    return baseReports.filter(r => {
      if (selectedProjects.length > 0 && !selectedProjects.includes(r.project)) return false
      if (from || to) {
        const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''
        if (!date) return false
        if (from && date < from) return false
        if (to   && date > to)   return false
      }
      return true
    })
  }, [baseReports, selectedProjects, from, to])

  const locationOptions = useMemo(
    () => [...new Set(projectDateData.map(r => (r.location || '').trim()).filter(Boolean))].sort(),
    [projectDateData]
  )

  const matchingData = useMemo(() => {
    if (locations.length === 0) return projectDateData
    return projectDateData.filter(r => locations.includes((r.location || '').trim()))
  }, [projectDateData, locations])

  // Actual span of matching records; may be narrower than from/to if data is sparse.
  const dateSpan = useMemo(() => {
    if (matchingData.length === 0) return null
    const dates = matchingData
      .map(r => (typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''))
      .filter(Boolean)
      .sort()
    if (dates.length === 0) return null
    return { min: dates[0], max: dates[dates.length - 1] }
  }, [matchingData])

  // Grouped by location, not state: most projects run within one state, so the
  // village/town field is what shows coverage.
  const topLocations = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of matchingData) {
      const location = (r.location || '').trim()
      if (!location) continue
      counts.set(location, (counts.get(location) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [matchingData])

  function reset() {
    setSelectedProjects([])
    setLocations([])
    setFrom('')
    setTo('')
    setPeriod(null)
    setReportLanguage('English')
  }

  // Appends Annual Progress data as its own block; it must render as a separate table,
  // never merged into the KPI/theme tables (enforced in ContentHubModal.tsx's instruction).
  function buildAugmentedInstruction(): string {
    const parts = [instruction]

    if (apSnapshot && apTotals) {
      const periodNote = apSnapshot.exact
        ? `Financial Year ${fyLabel(apSnapshot.fyStartYear)}, cumulative as of ${apSnapshot.month}`
        : `no snapshot exists yet for the current financial year — this is the most recently uploaded one: Financial Year ${fyLabel(apSnapshot.fyStartYear)}, cumulative as of ${apSnapshot.month}`
      const table = apSnapshot.rows
        .map(r => `${r.activity} | ${r.target ?? '—'} | ${r.achievement_total ?? '—'}`)
        .join('\n')
      parts.push(`\n\n**Annual Progress Report (${periodNote}) — a SEPARATE data source from the Individual Activity Records / Field Data Summary above. This tracks project deliverable Target vs. Achievement from the org's own Excel upload, NOT daily field activity. Do not merge these figures into the KPI Snapshot or the Quantitative Intervention Summary, and do not let them affect that table's theme totals. Instead: render this data as its own standalone table in a new "Progress Report" section placed immediately after the Quantitative Intervention Summary, with columns Activity/Deliverable | Target | Achievement | % Achieved, plus a TOTAL row (Target ${apTotals.targetSum} / Achievement ${apTotals.achievementSum}). Separately, work the headline cumulative achievement figure into the Reflective Analysis narrative as qualitative context — e.g. how this period's documented field activity connects to the project's overall financial-year pace — as prose, never as a recomputed entry in the daily-report tables.**\nActivity | Target | Achievement (as of ${apSnapshot.month})\n${table}\nTOTAL | ${apTotals.targetSum} | ${apTotals.achievementSum}`)
    }

    return parts.join('')
  }

  function generate() {
    if (selectedProjects.length === 0 || matchingData.length === 0) return
    const scopedFilters: ActiveFilters = {
      project: selectedProjects, state: [], area: [], workerName: [], dateFrom: from, dateTo: to,
      location: locations,
    }
    onOpenReport(reportTitle, matchingData, buildAugmentedInstruction(), { filters: scopedFilters, language: reportLanguage })
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between mb-6 pt-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#ecfeff' }}>
            <TrendingUp className="w-4 h-4" style={{ color: '#0891b2' }} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>{reportTitle}</h1>
            <p className="text-xs mt-0.5" style={{ color: FF.textFaint }}>
              {t.prpSubtitle}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t.prpCloseAria}
          className="p-2 rounded-lg hover:bg-black/5 transition shrink-0"
        >
          <X className="w-4 h-4" style={{ color: FF.textFaint }} />
        </button>
      </header>

      {/* ── Two-column wizard ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">

        {/* ── Left: controls ───────────────────────────────────────────────── */}
        <div className="rounded-2xl border p-5 sm:p-6 space-y-5" style={{ borderColor: FF.border, background: '#FFFFFF' }}>
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              {t.prpStepProject}
            </label>
            <div className="mt-2">
              <MultiSelect
                label={t.prpStepProject}
                placeholder={t.prpSelectProject}
                options={projectOptions}
                selected={selectedProjects}
                onChange={setSelectedProjects}
              />
            </div>
            {selectedProjects.length > 0 && (
              <p className="text-[11px] mt-1.5" style={{ color: FF.textFaint }}>
                {t.prpGeoNote}
              </p>
            )}
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              {t.prpStepDateRange}
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-2">
              {PERIODS.map(({ key, icon: Icon }) => {
                const active = period === key
                const count = periodCounts?.[key]
                return (
                  <button
                    key={key}
                    onClick={() => applyPeriod(key)}
                    className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border transition text-center"
                    style={active
                      ? { background: FF.purple, borderColor: FF.purple, color: '#fff' }
                      : { background: '#fff', borderColor: FF.border, color: FF.textMuted }
                    }
                  >
                    <span className="relative">
                      <Icon className="w-4 h-4" />
                      {active && (
                        <Check className="w-2.5 h-2.5 absolute -top-1 -right-1.5 rounded-full p-[1px]" style={{ background: '#fff', color: FF.purple }} />
                      )}
                    </span>
                    <span className="text-[11px] font-bold leading-tight">{PERIOD_LABELS[key]}</span>
                    {selectedProjects.length > 0 && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                        style={active ? { background: 'rgba(255,255,255,0.2)', color: '#fff' } : { background: FF.bg, color: FF.textFaint }}
                      >
                        {count} {count === 1 ? t.prpRecord : t.prpRecords}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="flex gap-3 mt-3">
              <div className="flex-1">
                <label className="text-[10px] font-bold uppercase tracking-wide" style={{ color: FF.textFaint }}>
                  {t.filterFrom}
                </label>
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={e => { setFrom(e.target.value); setPeriod(null) }}
                  className="mt-1 w-full text-sm font-semibold rounded-lg border px-3 py-2 bg-white focus:outline-none"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] font-bold uppercase tracking-wide" style={{ color: FF.textFaint }}>
                  {t.filterTo}
                </label>
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={e => { setTo(e.target.value); setPeriod(null) }}
                  className="mt-1 w-full text-sm font-semibold rounded-lg border px-3 py-2 bg-white focus:outline-none"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                />
              </div>
            </div>
            {!period && (from || to) && (
              <p className="text-[11px] mt-1.5 font-medium" style={{ color: FF.textFaint }}>
                {t.prpCustomRange} — {from ? formatDate(from, { year: false }) : t.prpAnyStart} → {to ? formatDate(to, { year: false }) : t.prpAnyEnd}
              </p>
            )}
          </div>

          {/* Falls back to English until these keys are translated, as in CaseStudyPickerView. */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              {((t as unknown as Record<string, string>).prpStepLocation) || '3. Location'} <span className="font-medium normal-case" style={{ color: FF.textMuted }}>{t.prpOptional}</span>
            </label>
            <p className="text-[11px] mt-1 mb-2" style={{ color: FF.textFaint }}>
              {((t as unknown as Record<string, string>).prpLocationDesc) || 'Narrow to one or more villages/locations, or leave blank to include every location the project reported from.'}
            </p>
            <MultiSelect
              label={((t as unknown as Record<string, string>).filterLocation) || 'Location'}
              placeholder={((t as unknown as Record<string, string>).filterLocation) || 'Location'}
              options={locationOptions}
              selected={locations}
              onChange={setLocations}
            />
          </div>

          {selectedProjects.length === 1 && (apLoading || apSnapshot) && (
            <div className="rounded-xl p-3 flex items-start gap-2.5" style={{ background: FF.bg, border: `1px solid ${FF.border}` }}>
              <FileSpreadsheet className="w-4 h-4 shrink-0 mt-0.5" style={{ color: FF.textFaint }} />
              <p className="text-[11px]" style={{ color: FF.textMuted }}>
                {apLoading
                  ? t.prpApChecking
                  : apSnapshot && (
                      apSnapshot.exact
                        ? t.prpApFoundExact.replace('{fy}', fyLabel(apSnapshot.fyStartYear)).replace('{month}', apSnapshot.month)
                        : t.prpApFoundFallback.replace('{fy}', fyLabel(apSnapshot.fyStartYear)).replace('{month}', apSnapshot.month)
                    )}
              </p>
            </div>
          )}

          {/* Report output language, not the UI language; pre-fills GenerateReportPage. */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              4. Language
            </label>
            <select
              value={reportLanguage}
              onChange={e => setReportLanguage(e.target.value)}
              className="mt-2 w-full text-sm font-semibold rounded-xl border px-3.5 py-3 bg-white focus:outline-none transition"
              style={{ borderColor: FF.border, color: FF.tealDark }}
            >
              {REPORT_LANGUAGES.map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          {selectedProjects.length > 0 && matchingData.length === 0 && (
            <p className="text-xs flex items-start gap-1.5" style={{ color: FF.red }}>
              {t.prpNoRecordsRange.replace('{project}', projectsLabel)}
            </p>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 pt-3 border-t" style={{ borderColor: FF.borderFaint }}>
            <button
              onClick={reset}
              className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-xl hover:bg-black/5 transition"
              style={{ color: FF.textMuted }}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t.prpReset}
            </button>
            <button
              onClick={generate}
              disabled={selectedProjects.length === 0 || matchingData.length === 0}
              className="w-full sm:w-auto text-xs font-bold px-5 py-2.5 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed transition hover:opacity-90"
              style={{ background: FF.purple }}
            >
              {selectedProjects.length > 0 ? `${t.grGenerateBtn} (${matchingData.length})` : t.grGenerateBtn}
            </button>
          </div>
        </div>

        {/* ── Right: live preview ──────────────────────────────────────────── */}
        <div className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: FF.border, background: FF.bg }}>
          {selectedProjects.length === 0 ? (
            <EmptyState
              icon={<TrendingUp className="w-8 h-8" />}
              title={t.prpPickProjectTitle}
              body={t.prpPickProjectBody}
            />
          ) : matchingData.length === 0 ? (
            <EmptyState
              icon={<Calendar className="w-8 h-8" />}
              title={t.prpNoRecordsTitle}
              body={t.prpNoRecordsBody.replace('{project}', projectsLabel)}
            />
          ) : (
            <div className="space-y-4">
              <KpiTile label={t.prpMatchingRecords} value={matchingData.length} valueSize={28} />

              {dateSpan && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl" style={{ background: '#FFFFFF', border: `1px solid ${FF.border}` }}>
                  <Calendar className="w-4 h-4 shrink-0 mt-0.5" style={{ color: FF.textFaint }} />
                  <div className="text-xs">
                    <p className="font-bold uppercase tracking-widest text-[10px]" style={{ color: FF.textFaint }}>{t.prpDateSpanCovered}</p>
                    <p className="mt-1 font-semibold" style={{ color: FF.tealDark }}>
                      {formatDate(dateSpan.min, { year: false })} → {formatDate(dateSpan.max, { year: false })}
                    </p>
                  </div>
                </div>
              )}

              <div className="p-3 rounded-xl" style={{ background: '#FFFFFF', border: `1px solid ${FF.border}` }}>
                <div className="flex items-center gap-2 mb-2">
                  <MapPin className="w-4 h-4" style={{ color: FF.textFaint }} />
                  <p className="font-bold uppercase tracking-widest text-[10px]" style={{ color: FF.textFaint }}>{t.prpTopLocations}</p>
                </div>
                {topLocations.length === 0 ? (
                  <p className="text-xs" style={{ color: FF.textMuted }}>{t.prpNoLocationData}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {topLocations.map(([location, count]) => (
                      <li key={location} className="flex items-center justify-between text-xs">
                        <span className="font-semibold" style={{ color: FF.tealDark }}>{location}</span>
                        <span className="flex items-center gap-1 font-bold" style={{ color: FF.purple }}>
                          <Hash className="w-3 h-3" />{count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="h-8" />
    </div>
  )
}
