// Shared picker behind the Content Hub Org / Self / Team / Impact Report tabs: date
// range, optional project/location narrowing, output language and custom instructions.
// Each tab passes its own `variant` (icon, colours, copy); the data scoping is done by
// the caller before `reports` arrives here.

import { useMemo, useState } from 'react'
import { X, Calendar, RotateCcw, Check, Sparkles, FolderKanban, type LucideIcon } from 'lucide-react'
import { useLanguage } from '../../context/LanguageContext'
import { EmptyState } from '../ui/EmptyState'
import { KpiTile } from '../ui/KpiTile'
import { FF } from '../../theme/colors'
import { formatDate } from '../../utils/format'
import { MultiSelect } from './MultiSelect'
import { REPORT_LANGUAGES } from '../../constants/reportLanguages'
import { PERIODS, periodRange, type Period } from './reportPickerPeriods'
import type { DailyReport, ActiveFilters } from '../../types/report'

export interface ReportPickerVariant {
  icon: LucideIcon
  iconBg: string
  iconColor: string
  // Active period tile, generate button and preview counts.
  accent: string
  // Translation keys are `prpSubtitle${textKey}` etc.; the English strings below are their fallbacks.
  textKey: string
  subtitle: string
  pickDateTitle: string
  pickDateBody: string
  noRecordsBody: string
  projectHelp: string
  customHelp: string
  customPlaceholder: string
  // Appended after "Follow these in addition to the template above." (may be '').
  customRule: string
  // Only the Self tab tags its report.
  kind?: 'self'
}

export interface ReportPickerViewProps {
  reports: DailyReport[]
  reportTitle: string
  instruction: string
  onOpenReport: (
    title: string,
    reports: DailyReport[],
    instruction: string,
    options?: { filters?: ActiveFilters; kind?: 'self' | 'for_other' | 'team'; language?: string },
  ) => void
  onClose: () => void
  variant: ReportPickerVariant
}

export function ReportPickerView({ reports: baseReports, reportTitle, instruction, onOpenReport, onClose, variant }: ReportPickerViewProps) {
  const { t } = useLanguage()
  const PERIOD_LABELS: Record<Period, string> = {
    monthly: t.prpThisMonth, previousMonth: t.prpPreviousMonth, quarterly: t.prpThisQuarter,
    halfYearly: t.prpHalfYearly, annual: t.prpThisYear,
  }
  const { icon: VariantIcon, accent } = variant
  // Some strings fall back to English until they get a translation pass.
  const tAny = t as unknown as Record<string, string>
  const subtitleLabel      = tAny[`prpSubtitle${variant.textKey}`]      || variant.subtitle
  const pickDateTitleLabel = tAny[`prpPickDateTitle${variant.textKey}`] || variant.pickDateTitle
  const pickDateBodyLabel  = tAny[`prpPickDateBody${variant.textKey}`]  || variant.pickDateBody
  const noRecordsBodyLabel = tAny[`prpNoRecordsBody${variant.textKey}`] || variant.noRecordsBody
  const projectsCoveredLabel = tAny.prpProjectsCovered || 'Projects covered'
  const noProjectDataLabel   = tAny.prpNoProjectData   || 'No project data on these records.'
  const stepLocationLabel  = tAny.prpStepLocation  || '3. Location'
  const locationDescLabel  = tAny.prpLocationDesc  || 'Narrow to one or more villages/locations, or leave blank to include every location.'
  const filterLocationLabel = tAny.filterLocation  || 'Location'

  const [from,                setFrom]                = useState('')
  const [to,                  setTo]                  = useState('')
  const [period,              setPeriod]              = useState<Period | null>(null)
  // Optional: empty means everything in `reports`.
  const [selectedProjects,    setSelectedProjects]    = useState<string[]>([])
  const [locations,           setLocations]           = useState<string[]>([])
  // Appended to the base instruction at generate time.
  const [customInstructions,  setCustomInstructions]  = useState('')
  // Output language of the report, not the UI language.
  const [reportLanguage,      setReportLanguage]      = useState<string>('English')

  function applyPeriod(p: Period) {
    const { from: f, to: tt } = periodRange(p, new Date())
    setFrom(f)
    setTo(tt)
    setPeriod(p)
  }

  const projectOptions = useMemo(
    () => [...new Set(baseReports.map(r => r.project).filter(Boolean))].sort(),
    [baseReports]
  )

  const periodCounts = useMemo(() => {
    const now = new Date()
    const counts: Record<Period, number> = { monthly: 0, previousMonth: 0, quarterly: 0, halfYearly: 0, annual: 0 }
    for (const { key } of PERIODS) {
      const { from: f, to: tt } = periodRange(key, now)
      counts[key] = baseReports.filter(r => {
        if (selectedProjects.length > 0 && !selectedProjects.includes(r.project)) return false
        const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''
        return date && date >= f && date <= tt
      }).length
    }
    return counts
  }, [baseReports, selectedProjects])

  // Project + date filtered; the pool Location options are drawn from.
  const projectDateData = useMemo(() => {
    if (selectedProjects.length === 0 && !from && !to) return baseReports
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

  const dateSpan = useMemo(() => {
    if (matchingData.length === 0) return null
    const dates = matchingData
      .map(r => (typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''))
      .filter(Boolean)
      .sort()
    if (dates.length === 0) return null
    return { min: dates[0], max: dates[dates.length - 1] }
  }, [matchingData])

  const topProjects = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of matchingData) {
      const project = (r.project || '').trim()
      if (!project) continue
      counts.set(project, (counts.get(project) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [matchingData])

  function reset() {
    setFrom('')
    setTo('')
    setPeriod(null)
    setSelectedProjects([])
    setLocations([])
    setCustomInstructions('')
    setReportLanguage('English')
  }

  // Appends rather than replaces, so the admin-edited report prompt stays intact.
  function buildAugmentedInstruction(): string {
    const custom = customInstructions.trim()
    if (!custom) return instruction
    return `${instruction}\n\n**Additional instructions for this report (user-specified):** ${custom}\nFollow these in addition to the template above.${variant.customRule}`
  }

  function generate() {
    if (matchingData.length === 0) return
    const scopedFilters: ActiveFilters = {
      project: selectedProjects, state: [], area: [], workerName: [], dateFrom: from, dateTo: to,
      location: locations,
    }
    const options = variant.kind
      ? { filters: scopedFilters, kind: variant.kind, language: reportLanguage }
      : { filters: scopedFilters, language: reportLanguage }
    onOpenReport(reportTitle, matchingData, buildAugmentedInstruction(), options)
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4">
      <header className="flex items-center justify-between mb-6 pt-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: variant.iconBg }}>
            <VariantIcon className="w-4 h-4" style={{ color: variant.iconColor }} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>{reportTitle}</h1>
            <p className="text-xs mt-0.5" style={{ color: FF.textFaint }}>
              {subtitleLabel}
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

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">

        {/* Left: controls */}
        <div className="rounded-2xl border p-5 sm:p-6 space-y-5" style={{ borderColor: FF.border, background: '#FFFFFF' }}>
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              1. Date range
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-2">
              {PERIODS.map(({ key, icon: Icon }) => {
                const active = period === key
                const count = periodCounts[key]
                return (
                  <button
                    key={key}
                    onClick={() => applyPeriod(key)}
                    className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border transition text-center"
                    style={active
                      ? { background: accent, borderColor: accent, color: '#fff' }
                      : { background: '#fff', borderColor: FF.border, color: FF.textMuted }
                    }
                  >
                    <span className="relative">
                      <Icon className="w-4 h-4" />
                      {active && (
                        <Check className="w-2.5 h-2.5 absolute -top-1 -right-1.5 rounded-full p-[1px]" style={{ background: '#fff', color: accent }} />
                      )}
                    </span>
                    <span className="text-[11px] font-bold leading-tight">{PERIOD_LABELS[key]}</span>
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                      style={active ? { background: 'rgba(255,255,255,0.2)', color: '#fff' } : { background: FF.bg, color: FF.textFaint }}
                    >
                      {count} {count === 1 ? t.prpRecord : t.prpRecords}
                    </span>
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
            {!period && (from || to) ? (
              <p className="text-[11px] mt-1.5 font-medium" style={{ color: FF.textFaint }}>
                {t.prpCustomRange} — {from ? formatDate(from, { year: false }) : t.prpAnyStart} → {to ? formatDate(to, { year: false }) : t.prpAnyEnd}
              </p>
            ) : !period && !from && !to ? (
              <p className="text-[11px] mt-1.5 font-medium" style={{ color: FF.textFaint }}>
                {pickDateBodyLabel}
              </p>
            ) : null}
          </div>

          {/* Project (optional) */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              2. Project <span className="font-medium normal-case" style={{ color: FF.textMuted }}>{t.prpOptional}</span>
            </label>
            <p className="text-[11px] mt-1 mb-2" style={{ color: FF.textFaint }}>
              {variant.projectHelp}
            </p>
            <MultiSelect
              label="Project"
              placeholder="Project"
              options={projectOptions}
              selected={selectedProjects}
              onChange={sel => { setSelectedProjects(sel); setLocations([]) }}
            />
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              {stepLocationLabel} <span className="font-medium normal-case" style={{ color: FF.textMuted }}>{t.prpOptional}</span>
            </label>
            <p className="text-[11px] mt-1 mb-2" style={{ color: FF.textFaint }}>
              {locationDescLabel}
            </p>
            <MultiSelect
              label={filterLocationLabel}
              placeholder={filterLocationLabel}
              options={locationOptions}
              selected={locations}
              onChange={setLocations}
            />
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-widest flex items-center gap-1.5" style={{ color: FF.textFaint }}>
              <Sparkles className="w-3 h-3" style={{ color: '#d97706' }} />
              4. Custom instructions <span className="font-medium normal-case" style={{ color: FF.textMuted }}>{t.prpOptional}</span>
            </label>
            <p className="text-[11px] mt-1 mb-2" style={{ color: FF.textFaint }}>
              {variant.customHelp}
            </p>
            <textarea
              value={customInstructions}
              onChange={e => setCustomInstructions(e.target.value)}
              placeholder={variant.customPlaceholder}
              rows={3}
              className="w-full text-sm rounded-xl border px-3.5 py-2.5 bg-white focus:outline-none transition"
              style={{ borderColor: FF.border, color: FF.tealDark }}
            />
          </div>

          {/* Output language; pre-fills GenerateReportPage's language step */}
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: FF.textFaint }}>
              5. Language
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

          {matchingData.length === 0 && (from || to || selectedProjects.length > 0 || locations.length > 0) && (
            <p className="text-xs flex items-start gap-1.5" style={{ color: FF.red }}>
              {noRecordsBodyLabel}
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
              disabled={matchingData.length === 0}
              className="w-full sm:w-auto text-xs font-bold px-5 py-2.5 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed transition hover:opacity-90"
              style={{ background: accent }}
            >
              {`${t.grGenerateBtn} (${matchingData.length})`}
            </button>
          </div>
        </div>

        {/* Right: live preview */}
        <div className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: FF.border, background: FF.bg }}>
          {matchingData.length === 0 ? (
            <EmptyState
              icon={<Calendar className="w-8 h-8" />}
              title={t.prpNoRecordsTitle}
              body={noRecordsBodyLabel}
            />
          ) : (
            <div className="space-y-4">
              <KpiTile label={t.prpMatchingRecords} value={matchingData.length} valueSize={28} />

              {!from && !to && selectedProjects.length === 0 && locations.length === 0 && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl" style={{ background: '#FFFFFF', border: `1px solid ${FF.border}` }}>
                  <VariantIcon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: FF.textFaint }} />
                  <p className="text-xs" style={{ color: FF.textMuted }}>{pickDateTitleLabel}</p>
                </div>
              )}

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
                  <FolderKanban className="w-4 h-4" style={{ color: FF.textFaint }} />
                  <p className="font-bold uppercase tracking-widest text-[10px]" style={{ color: FF.textFaint }}>{projectsCoveredLabel}</p>
                </div>
                {topProjects.length === 0 ? (
                  <p className="text-xs" style={{ color: FF.textMuted }}>{noProjectDataLabel}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {topProjects.map(([project, count]) => (
                      <li key={project} className="flex items-center justify-between text-xs">
                        <span className="font-semibold" style={{ color: FF.tealDark }}>{project}</span>
                        <span className="flex items-center gap-1 font-bold" style={{ color: accent }}>
                          {count}
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
