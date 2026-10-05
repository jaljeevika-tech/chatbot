import React, { useState, useEffect } from 'react'
import { Target, Users, MapPin, Briefcase, Calendar, TrendingUp, CheckCircle, Activity, ListChecks } from 'lucide-react'
import type { DailyReport } from '../../types/report'
import type { AuthUser } from '../../context/AuthContext'
import { useLanguage } from '../../context/LanguageContext'
import { FF } from '../../theme/colors'
import { apiFetch } from '../../utils/apiFetch'
import {
  getToCNodes,
  getSDGsWithCounts,
  getLogicModelData,
  getDataQualityMetrics,
  getReportingPeriod,
  IMPACT_FRAMEWORK,
  IMPACT_CATEGORY_META,
  formatIndicatorValue,
  type ImpactCategory,
  type ImpactFrameworkValues,
} from '../../utils/impactMetrics'

interface Props {
  reports: DailyReport[]
  baseReports: DailyReport[]
  user: AuthUser | null
  onOpenReport: (title: string, reports: DailyReport[], instruction?: string) => void
}

function MetricCard({
  icon: Icon, label, value, sub, color,
}: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string
}) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-2 border" style={{ background: '#fff', borderColor: FF.border }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: color + '18' }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div className="text-2xl font-semibold font-serif text-gray-900 leading-none mt-1">{value}</div>
      <div className="text-xs font-bold text-gray-700">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 leading-tight">{sub}</div>}
    </div>
  )
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${Math.round(pct * 100)}%`, background: color }}
      />
    </div>
  )
}

function SectionHead({ icon: Icon, title, sub }: { icon: React.ElementType; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: '#341272' }}>
        <Icon className="w-4 h-4 text-white" />
      </div>
      <div>
        <p className="font-bold text-gray-900 text-sm">{title}</p>
        {sub && <p className="text-[11px] text-gray-400">{sub}</p>}
      </div>
    </div>
  )
}

function OutcomeIndicatorsPanel({ reports }: { reports: DailyReport[] }) {
  const { t } = useLanguage()
  const totalBenef = reports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
  const locations  = new Set(reports.map(r => r.location).filter(Boolean)).size
  const projects   = new Set(reports.map(r => r.project).filter(Boolean)).size
  const period     = getReportingPeriod(reports)

  return (
    <div className="rounded-xl p-5 border" style={{ background: FF.bgWarm, borderColor: FF.border }}>
      <SectionHead icon={Target} title={t.impOutcomeIndicators} sub={t.impOutcomeSub} />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        <MetricCard icon={Users}     label={t.impTotalBenef}       value={totalBenef.toLocaleString('en-IN')} color="#341272" />
        <MetricCard icon={MapPin}    label={t.impLocationsReached}  value={locations} color="#0891b2" />
        <MetricCard icon={Briefcase} label={t.impActiveProjects}    value={projects}  color="#16a34a" />
        <MetricCard icon={Calendar}  label={t.impReportingPeriod}   value={reports.length > 0 ? '—' : '—'} sub={period} color="#d97706" />
      </div>
    </div>
  )
}

function TheoryOfChangePanel({ reports }: { reports: DailyReport[] }) {
  const { t } = useLanguage()
  const nodes = getToCNodes(reports)
  return (
    <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
      <SectionHead icon={TrendingUp} title={t.impTheoryOfChange} sub={t.impTheoryOfChangeSub} />
      <div className="flex items-stretch gap-0 overflow-x-auto pb-2">
        {nodes.map((node, i) => (
          <React.Fragment key={node.label}>
            <div className="flex flex-col items-center min-w-[100px] flex-1">
              <div
                className="w-full rounded-xl p-3 text-center flex flex-col gap-1"
                style={{ background: node.color + '14', border: `2px solid ${node.color}30` }}
              >
                <div className="text-2xl font-semibold font-serif" style={{ color: node.color }}>
                  {typeof node.value === 'number' ? node.value.toLocaleString('en-IN') : node.value}
                </div>
                <div className="text-[11px] font-bold text-gray-700">{node.label}</div>
                <div className="text-[10px] text-gray-400 leading-tight">{node.sublabel}</div>
              </div>
            </div>
            {i < nodes.length - 1 && (
              <div className="flex items-center px-1 shrink-0">
                <span className="text-gray-300 font-bold text-lg">→</span>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function SDGProgressPanel({ reports }: { reports: DailyReport[] }) {
  const { t } = useLanguage()
  const sdgs = getSDGsWithCounts(reports)
  if (!sdgs.length) {
    return (
      <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
        <SectionHead icon={CheckCircle} title={t.impSdgProgress} sub={t.impSdgSub} />
        <p className="text-sm text-gray-400 text-center py-4">{t.impSdgNoMatch}</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
      <SectionHead icon={CheckCircle} title={t.impSdgProgress} sub={t.impSdgSubMatched.replace('{n}', String(sdgs.length))} />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {sdgs.map(sdg => {
          const pct = Math.min(sdg.count / Math.max(reports.length, 1), 1)
          return (
            <div key={sdg.sdg} className="rounded-xl p-3 border border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-[10px] font-black shrink-0"
                  style={{ background: sdg.color }}
                >
                  {sdg.sdg}
                </div>
                <p className="text-[11px] font-bold text-gray-800 leading-tight">{sdg.name}</p>
              </div>
              <ProgressBar pct={pct} color={sdg.color} />
              <p className="text-[10px] text-gray-400 mt-1.5">{sdg.count} {t.impSdgActivities}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LogicModelPanel({ reports }: { reports: DailyReport[] }) {
  const { t } = useLanguage()
  const d = getLogicModelData(reports)

  const columns = [
    {
      label: t.impInputs,
      color: '#6366f1',
      items: [`${d.inputs.contributors} contributors`, `${d.inputs.projects} projects`],
    },
    {
      label: t.impSdgActivities,
      color: '#0891b2',
      items: d.activities.topAreas.length ? d.activities.topAreas : ['—'],
    },
    {
      label: t.impOutputs,
      color: '#16a34a',
      items: [`${d.outputs.reportCount} reports`, `${d.outputs.photoCount} photos`],
    },
    {
      label: t.impOutcomes,
      color: '#d97706',
      items: [`${d.outcomes.states} states`, `${d.outcomes.locations} locations`],
    },
    {
      label: t.impImpact,
      color: '#341272',
      items: [`${d.impact.totalBenef.toLocaleString('en-IN')} beneficiaries`, `Top: ${d.impact.topProject}`],
    },
  ]

  return (
    <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
      <SectionHead icon={Activity} title={t.impLogicModel} sub={t.impLogicModelSub} />
      <div className="overflow-x-auto hidden md:block">
        <table className="w-full min-w-[500px] text-xs border-collapse">
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.label}
                  className="text-left px-3 py-2 font-black text-white rounded-t-lg text-[11px] tracking-wider uppercase"
                  style={{ background: col.color, borderRight: '4px solid white' }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {columns.map(col => (
                <td
                  key={col.label}
                  className="align-top px-3 py-3 border border-gray-100"
                  style={{ borderLeft: `3px solid ${col.color}40` }}
                >
                  {col.items.map((item, i) => (
                    <div key={i} className="text-gray-700 leading-relaxed">{item}</div>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {/* Mobile: stages stacked vertically */}
      <div className="md:hidden space-y-2.5">
        {columns.map(col => (
          <div key={col.label} className="rounded-xl border border-gray-100 overflow-hidden">
            <div
              className="px-3 py-2 font-black text-white text-[11px] tracking-wider uppercase"
              style={{ background: col.color }}
            >
              {col.label}
            </div>
            <div className="px-3 py-2.5 space-y-0.5" style={{ borderLeft: `3px solid ${col.color}40` }}>
              {col.items.map((item, i) => (
                <div key={i} className="text-xs text-gray-700 leading-relaxed">{item}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DataQualityScorecardPanel({ reports }: { reports: DailyReport[] }) {
  const { t } = useLanguage()
  const m = getDataQualityMetrics(reports)

  const metrics = [
    { label: t.impPhotoCoverage,          value: m.photoCoverage,           color: '#0891b2', note: t.impPhotoNote },
    { label: t.impDescCompleteness,       value: m.descCompleteness,        color: '#16a34a', note: t.impDescNote },
    { label: t.impContributorConsistency, value: m.contributorConsistency,  color: '#7c3aed', note: t.impContributorNote },
    { label: t.impBenefData,              value: m.beneficiaryCompleteness, color: '#d97706', note: t.impBenefDataNote },
    { label: t.impLocationSpecificity,    value: m.locationSpecificity,     color: '#341272', note: t.impLocationNote },
  ]

  return (
    <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
      <SectionHead icon={Activity} title={t.impDataQuality} sub={`${reports.length} ${t.reportsAnalysed}`} />
      <div className="space-y-4">
        {metrics.map(m => (
          <div key={m.label}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-gray-700">{m.label}</span>
              <span className="text-xs font-black" style={{ color: m.color }}>
                {Math.round(m.value * 100)}%
              </span>
            </div>
            <ProgressBar pct={m.value} color={m.color} />
            <p className="text-[10px] text-gray-400 mt-1">{m.note}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// Jaljeevika's 17-indicator impact matrix (Output → Outcome → Impact), live from
// GET /api/impact/framework; scoped by project; indicators with no MIS source show "—".
type ProjectOption = { project_key: string; name: string }

function ImpactFrameworkPanel() {
  const { t } = useLanguage()
  const [values, setValues] = useState<ImpactFrameworkValues | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectKey, setProjectKey] = useState('')   // '' = all projects (org-wide)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const url = projectKey
      ? `/api/impact/framework?projectKey=${encodeURIComponent(projectKey)}`
      : '/api/impact/framework'
    apiFetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => {
        if (cancelled) return
        setValues(d.values || {})
        if (Array.isArray(d.projects)) setProjects(d.projects)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load impact values') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectKey])

  const groups = (Object.keys(IMPACT_CATEGORY_META) as ImpactCategory[])
    .sort((a, b) => IMPACT_CATEGORY_META[a].order - IMPACT_CATEGORY_META[b].order)
    .map(category => ({
      category,
      ...IMPACT_CATEGORY_META[category],
      items: IMPACT_FRAMEWORK.filter(i => i.category === category),
    }))

  const scopeLabel = projectKey
    ? (projects.find(p => p.project_key === projectKey)?.name || projectKey)
    : t.impFrameworkAllProjects

  return (
    <div className="rounded-xl p-5 bg-white border" style={{ borderColor: FF.border }}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <SectionHead icon={ListChecks} title={t.impFramework} sub={`${t.impFrameworkSub} · ${scopeLabel}`} />
        <select
          value={projectKey}
          onChange={e => setProjectKey(e.target.value)}
          className="shrink-0 text-xs font-semibold rounded-lg border px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2"
          style={{ borderColor: FF.border }}
          aria-label={t.impFrameworkProjectLabel}
        >
          <option value="">{t.impFrameworkAllProjects}</option>
          {projects.map(p => (
            <option key={p.project_key} value={p.project_key}>{p.name}</option>
          ))}
        </select>
      </div>
      {error && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[11px] text-red-700">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {groups.map(g => (
          <div key={g.category} className="rounded-xl border overflow-hidden" style={{ borderColor: FF.border }}>
            <div
              className="px-3 py-2 flex items-center justify-between text-white"
              style={{ background: g.color }}
            >
              <div>
                <p className="text-[12px] font-black tracking-wider uppercase leading-none">{g.category}</p>
                <p className="text-[10px] opacity-80 mt-0.5">{g.sub}</p>
              </div>
              <span className="text-[11px] font-bold bg-white/20 rounded-full px-2 py-0.5">{g.items.length}</span>
            </div>
            <ul className="divide-y" style={{ borderColor: FF.border }}>
              {g.items.map(item => {
                const raw = values ? values[item.key] : undefined
                return (
                  <li key={item.key} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[12px] text-gray-700 leading-snug">{item.indicator}</p>
                      <p className="text-[9px] text-gray-400 uppercase tracking-wide mt-0.5">{item.unit}</p>
                    </div>
                    <span
                      className="shrink-0 text-[13px] font-bold font-serif tabular-nums"
                      style={{ color: raw == null ? '#9ca3af' : g.color }}
                    >
                      {loading ? '…' : formatIndicatorValue(raw, item.unit)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-3 leading-snug">
        {t.impFrameworkNote}
      </p>
    </div>
  )
}

// Impact Framework matrix on top, field-report panels below.
export function ImpactDashboard({ reports }: Props) {
  const { t } = useLanguage()

  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-center gap-2">
        <Target className="w-5 h-5" style={{ color: '#341272' }} />
        <h2 className="font-black text-gray-900 text-lg leading-none">Impact Dashboard</h2>
      </div>

      <div className="space-y-4">
        <ImpactFrameworkPanel />
        {reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-400 bg-white rounded-xl border" style={{ borderColor: FF.border }}>
            <Target className="w-10 h-10 opacity-30" />
            <p className="text-sm font-medium">{t.impNoDataSub}</p>
            <p className="text-xs">{t.mlAdjustFilters}</p>
          </div>
        ) : (
          <>
            <OutcomeIndicatorsPanel    reports={reports} />
            <TheoryOfChangePanel       reports={reports} />
            <SDGProgressPanel          reports={reports} />
            <LogicModelPanel           reports={reports} />
            <DataQualityScorecardPanel reports={reports} />
          </>
        )}
      </div>
    </div>
  )
}
