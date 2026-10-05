import { streamWorkerAnalysis, draftReview } from '../../utils/performanceReviewClient'
import type { WorkerStats } from './PerformanceReviewModal'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import { useState, useMemo } from 'react'
import { PerformanceReviewModal } from './PerformanceReviewModal'
import { PerformancePanelSection } from './PerformancePanelSection'
import { useAuthContext } from '../../context/AuthContext'
import {
  Sparkles, Loader2, ChevronDown, ChevronUp,
  User, ShieldCheck, UserCheck, BarChart2,
  MapPin, Calendar, Camera, FileText, Users,
} from 'lucide-react'
import { useReportContext } from '../../context/ReportContext'
import { useLanguage } from '../../context/LanguageContext'
import { AnalysisRenderer } from './AnalysisRenderer'
import { apiFetch } from '../../utils/apiFetch'

import type { DailyReport } from '../../types/report'
import type { AuthUser } from '../../context/AuthContext'

const C = {
  dark:    '#0E3A46',
  sidebar: '#341272',
  lime:    '#16a34a',   // green — beneficiary/impact accent
  surface: '#D9E6E8',
  faint:   'rgba(217,230,232,0.7)',
  muted:   '#86A0A5',
  green:   '#3F7D5C',
  amber:   '#B8862E',
  red:     '#B0473C',
}

const ROLE_CFG: Record<string, { label: string; bg: string; color: string; icon: React.ReactNode }> = {
  admin:    { label: 'Admin',    bg: '#FBF9F4', color: '#341272', icon: <ShieldCheck className="w-3 h-3" /> },
  manager:  { label: 'Manager',  bg: '#EFF6FF', color: '#1D4ED8', icon: <UserCheck   className="w-3 h-3" /> },
  employee: { label: 'Employee', bg: '#F0FDF4', color: '#15803D', icon: <User        className="w-3 h-3" /> },
}
function roleCfg(role: string) {
  return ROLE_CFG[role?.toLowerCase()] ?? { label: role || 'Unknown', bg: '#F9FAFB', color: '#5C7378', icon: <User className="w-3 h-3" /> }
}

function pct(a: number, b: number) { return b ? Math.round((a / b) * 100) : 0 }

function scoreColor(s: number) { return s >= 75 ? C.green : s >= 50 ? C.amber : C.red }

function MiniBar({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  const color = scoreColor(value)
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: C.muted }}>{icon}</span>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.surface }}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="text-[10px] font-bold w-8 text-right tabular-nums" style={{ color }}>{value}%</span>
      <span className="text-[10px] w-20 truncate" style={{ color: C.muted }}>{label}</span>
    </div>
  )
}

function AreaBar({ area, count, max }: { area: string; count: number; max: number }) {
  const w = max ? Math.round((count / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: C.surface }}>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: C.lime }} />
      </div>
      <span className="text-[10px] font-semibold tabular-nums w-4 text-right" style={{ color: C.dark }}>{count}</span>
      <span className="text-[10px] w-28 truncate" style={{ color: C.muted }}>{area}</span>
    </div>
  )
}



interface WorkerData {
  name: string
  phone: string
  employee_id: string
  role: string
  reports: DailyReport[]
  reportCount: number
  recentCount: number        // last 30 days
  totalBenef: number
  lastDate: string
  states: string[]
  projects: string[]
  topAreas: { area: string; count: number }[]
  quality: {
    overall: number
    description: number
    beneficiaries: number
    photo: number
    location: number
  }
}

interface AnalysisState {
  status: 'idle' | 'loading' | 'done' | 'error'
  text: string
  error: string
  open: boolean
}

interface PerfPanelState {
  open:     boolean
  aiStatus: 'idle' | 'loading' | 'done' | 'error'
  aiText:   string
  aiError:  string
}

const PERF_PANEL_INIT: PerfPanelState = {
  open: false, aiStatus: 'idle', aiText: '', aiError: '',
}

function WorkerCard({ worker, viewerRole }: { worker: WorkerData; viewerRole: string }) {
  const { t } = useLanguage()

  const { user } = useAuthContext()
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle', text: '', error: '', open: false })
  const [panel, setPanel] = useState<PerfPanelState>(PERF_PANEL_INIT)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewEverOpened, setReviewEverOpened] = useState(false)
  const [cachedReviewId, setCachedReviewId] = useState<string | null>(null)
  const [exportingDocx, setExportingDocx] = useState(false)
  const canReview = ['admin', 'superadmin', 'manager'].includes(viewerRole)
  const cfg = roleCfg(worker.role)

  const workerStats: WorkerStats = useMemo(() => {
    const areaMap = new Map<string, { reports: number; benef: number; photos: number; located: number }>()
    for (const r of worker.reports) {
      const area = r.areaOfIntervention || 'Unknown'
      const e = areaMap.get(area) ?? { reports: 0, benef: 0, photos: 0, located: 0 }
      e.reports++
      e.benef    += parseInt(String(r.beneficiaries ?? 0)) || 0
      if (r.attachmentUrl) e.photos++
      if ((r.location || '').trim().split(/\s+/).length >= 2) e.located++
      areaMap.set(area, e)
    }
    return {
      reportCount: worker.reportCount,
      recentCount: worker.recentCount,
      totalBenef:  worker.totalBenef,
      quality:     worker.quality,
      areaBreakdown: Array.from(areaMap.entries())
        .sort((a, b) => b[1].reports - a[1].reports)
        .map(([area, d]) => ({
          area,
          reports:    d.reports,
          benef:      d.benef,
          photosPct:  d.reports ? Math.round((d.photos  / d.reports) * 100) : 0,
          locatedPct: d.reports ? Math.round((d.located / d.reports) * 100) : 0,
        })),
    }
  }, [worker.reports, worker.reportCount, worker.recentCount, worker.totalBenef, worker.quality])
  const initials = worker.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const daysSince = worker.lastDate
    ? Math.floor((Date.now() - new Date(worker.lastDate).getTime()) / 86_400_000)
    : null
  const maxArea = worker.topAreas[0]?.count ?? 1

  function handlePerfOpen() {
    // Guard double-click while loading
    if (panel.aiStatus === 'loading') return
    // Already loaded: just toggle
    if (panel.aiStatus !== 'idle') {
      setPanel(prev => ({ ...prev, open: !prev.open }))
      return
    }

    // First open: start AI analysis + background review draft
    setPanel(prev => ({ ...prev, open: true, aiStatus: 'loading' }))

    let full = ''
    streamWorkerAnalysis(worker.name, worker.reports, viewerRole, chunk => {
      full += chunk
      setPanel(prev => ({ ...prev, aiText: full }))
    })
      .then(() => setPanel(prev => ({ ...prev, aiStatus: 'done' })))
      .catch((e: any) => setPanel(prev => ({ ...prev, aiStatus: 'error', aiError: e.message || 'AI analysis failed' })))

    // Pre-draft the performance review so "Full Review" opens instantly
    draftReview(
      { id: worker.employee_id || undefined, phone: worker.phone || undefined, name: worker.name },
      'currentQuarter'
    ).then(out => setCachedReviewId(out.id)).catch(() => {})
  }

  async function handleAnalyse() {
    if (analysis.status === 'loading') return
    setAnalysis({ status: 'loading', text: '', error: '', open: true })
    try {
      let full = ''
      await streamWorkerAnalysis(worker.name, worker.reports, viewerRole, chunk => {
        full += chunk
        setAnalysis(prev => ({ ...prev, text: full }))
      })
      setAnalysis(prev => ({ ...prev, status: 'done' }))
    } catch (e: any) {
      setAnalysis(prev => ({ ...prev, status: 'error', error: e.message, open: true }))
    }
  }

  function toggleAI() {
    if (analysis.status === 'idle') { handleAnalyse(); return }
    setAnalysis(prev => ({ ...prev, open: !prev.open }))
  }

  async function handleExportDocx() {
    if (exportingDocx) return
    setExportingDocx(true)
    try {
      let rid = cachedReviewId
      if (!rid) {
        const out = await draftReview(
          { id: worker.employee_id || undefined, phone: worker.phone || undefined, name: worker.name },
          'currentQuarter'
        )
        rid = out.id
        setCachedReviewId(rid)
      }
      const r = await apiFetch(`/api/performance/reviews/${rid}/export.docx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_stats: workerStats, ai_analysis: panel.aiText }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${worker.name}_performance.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) {
      console.error('Export failed:', e.message)
    } finally {
      setExportingDocx(false)
    }
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: '#fff', border: `1.5px solid ${C.surface}` }}>
      <div className="p-4 flex flex-col gap-3">

        <div className="flex items-start gap-3">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white font-black text-sm"
            style={{ background: C.sidebar }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-sm truncate" style={{ color: C.dark }}>{worker.name}</p>
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full mt-0.5"
              style={{ background: cfg.bg, color: cfg.color }}
            >
              {cfg.icon}{cfg.label}
            </span>
          </div>
          {daysSince !== null && (
            <span
              className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 mt-0.5"
              style={{
                background: daysSince <= 7 ? '#F0FDF4' : daysSince <= 30 ? '#FFFBEB' : '#FEF2F2',
                color:      daysSince <= 7 ? C.green    : daysSince <= 30 ? C.amber    : C.red,
              }}
            >
              {daysSince === 0 ? t.prToday : `${daysSince}d ago`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 py-2 border-t border-b text-center" style={{ borderColor: C.surface }}>
          <div>
            <div className="text-base font-black" style={{ color: C.dark }}>{worker.reportCount}</div>
            <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.reports}</div>
          </div>
          <div>
            <div className="text-base font-black" style={{ color: C.lime }}>
              {worker.recentCount}
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.prLast30d}</div>
          </div>
          <div>
            <div className="text-base font-black" style={{ color: C.dark }}>
              {worker.totalBenef > 999
                ? `${(worker.totalBenef / 1000).toFixed(1)}k`
                : worker.totalBenef || '—'}
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.reached}</div>
          </div>
          <div>
            <div className="text-base font-black" style={{ color: C.dark }}>{worker.states.length}</div>
            <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.statsStates}</div>
          </div>
        </div>

        {(worker.projects.length > 0 || worker.states.length > 0) && (
          <div className="flex flex-col gap-1">
            {worker.states.length > 0 && (
              <div className="flex items-start gap-1.5">
                <MapPin className="w-3 h-3 shrink-0 mt-0.5" style={{ color: C.muted }} />
                <p className="text-[10px] leading-snug" style={{ color: C.muted }}>
                  {worker.states.join(', ')}
                </p>
              </div>
            )}
            {worker.projects.length > 0 && (
              <div className="flex items-start gap-1.5">
                <FileText className="w-3 h-3 shrink-0 mt-0.5" style={{ color: C.muted }} />
                <p className="text-[10px] leading-snug" style={{ color: C.muted }}>
                  {worker.projects.slice(0, 3).join(', ')}{worker.projects.length > 3 ? ` +${worker.projects.length - 3}` : ''}
                </p>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>{t.prReportQuality}</span>
            <span className="text-xs font-black" style={{ color: scoreColor(worker.quality.overall) }}>
              {worker.quality.overall}%
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <MiniBar label="Description"   value={worker.quality.description}   icon={<FileText className="w-3 h-3" />} />
            <MiniBar label="Outreach"      value={worker.quality.beneficiaries} icon={<Users    className="w-3 h-3" />} />
            <MiniBar label="Photo"         value={worker.quality.photo}         icon={<Camera   className="w-3 h-3" />} />
            <MiniBar label="Location"      value={worker.quality.location}      icon={<MapPin   className="w-3 h-3" />} />
          </div>
        </div>

        {worker.topAreas.length > 0 && (
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wide block mb-1.5" style={{ color: C.muted }}>
              {t.prActivityBreakdown}
            </span>
            <div className="flex flex-col gap-1.5">
              {worker.topAreas.slice(0, 5).map(a => (
                <AreaBar key={a.area} area={a.area} count={a.count} max={maxArea} />
              ))}
            </div>
          </div>
        )}

        {worker.lastDate && (
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" style={{ color: C.muted }} />
            <span className="text-[10px]" style={{ color: C.muted }}>
              {t.prLastReport}: {new Date(worker.lastDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
        )}

        {canReview ? (
          /* Managers/admins: Performance Analysis */
          <button
            onClick={handlePerfOpen}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-all"
            style={{
              background: panel.open ? C.faint : C.sidebar,
              color:      panel.open ? C.sidebar : '#fff',
            }}
          >
            <span className="flex items-center gap-1.5">
              {panel.aiStatus === 'loading'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Sparkles className="w-3.5 h-3.5" />}
              {panel.aiStatus === 'idle' ? 'Performance Analysis'
               : panel.open ? 'Hide Analysis'
               : 'Show Analysis'}
            </span>
            {panel.aiStatus !== 'idle' && (
              panel.open
                ? <ChevronUp className="w-3.5 h-3.5" />
                : <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          /* Others: simple AI analysis */
          <SubscriptionGate featureName="AI Team Member Analysis">
            <button
              onClick={toggleAI}
              className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold transition-all"
              style={{
                background: analysis.status === 'idle' ? C.sidebar : C.faint,
                color:      analysis.status === 'idle' ? '#fff'    : C.sidebar,
              }}
            >
              <span className="flex items-center gap-1.5">
                {analysis.status === 'loading'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Sparkles className="w-3.5 h-3.5" />}
                {analysis.status === 'idle'      ? t.prAiAnalysis
                 : analysis.status === 'loading' ? t.prAnalysing
                 : t.prViewAiAnalysis}
              </span>
              {analysis.status !== 'idle' && (
                analysis.open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          </SubscriptionGate>
        )}
      </div>

      {/* Stays mounted after first open so review data isn't refetched */}
      {reviewEverOpened && user && (
        <div style={{ display: reviewOpen ? undefined : 'none' }}>
          <PerformanceReviewModal
            employeeId={worker.employee_id || undefined}
            employeePhone={worker.phone}
            reviewId={cachedReviewId || undefined}
            viewerRole={viewerRole as 'admin' | 'superadmin' | 'manager' | 'employee'}
            viewerUid={user.uid}
            onClose={() => setReviewOpen(false)}
            onReviewDrafted={(id) => setCachedReviewId(id)}
            workerName={worker.name}
            panelAiText={panel.aiText}
            panelAiStatus={panel.aiStatus}
            workerStats={workerStats}
          />
        </div>
      )}

      {/* Manager/admin: performance analysis panel */}
      {canReview && panel.open && (
        <div className="border-t" style={{ borderColor: C.surface }}>
          <PerformancePanelSection
            aiStatus={panel.aiStatus}
            aiText={panel.aiText}
            aiError={panel.aiError}
            worker={worker}
            exportingDocx={exportingDocx}
            onExportDocx={handleExportDocx}
            onOpenFullReview={() => { setReviewEverOpened(true); setReviewOpen(true) }}
          />
        </div>
      )}

      {/* Others: simple AI analysis panel */}
      {!canReview && analysis.open && analysis.status !== 'idle' && (
        <div className="border-t" style={{ borderColor: C.surface, background: '#FAFAFA' }}>
          {analysis.status === 'error' ? (
            <p className="text-xs text-red-500 px-4 py-3">{analysis.error || 'Analysis failed — please try again.'}</p>
          ) : analysis.status === 'done' && !analysis.text ? (
            <p className="text-xs text-gray-400 px-4 py-3">No analysis generated — please try again.</p>
          ) : (
            <AnalysisRenderer text={analysis.text} streaming={analysis.status === 'loading'} />
          )}
        </div>
      )}
    </div>
  )
}

interface Props {
  baseReports: DailyReport[]
  user: AuthUser | null
}

export function WorkerAnalyticsTab({ baseReports, user }: Props) {
  const { users } = useReportContext()
  const { t } = useLanguage()
  const [search, setSearch] = useState('')

  const normalise = (p: string | null | undefined) => {
    const c = String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
    return c.length === 10 ? '91' + c : c
  }

  const workers = useMemo<WorkerData[]>(() => {
    const byPhone = new Map<string, DailyReport[]>()
    baseReports.forEach(r => {
      const key = normalise(r.phone)
      if (!byPhone.has(key)) byPhone.set(key, [])
      byPhone.get(key)!.push(r)
    })
    const userMap = new Map(users.map(u => [normalise(u.phone), u]))
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    return Array.from(byPhone.entries())
      .map(([phone, rpts]) => {
        const u = userMap.get(phone)
        const n = rpts.length
        const totalBenef = rpts.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
        const lastDate   = rpts.reduce((best, r) => { const d = String(r.timestamp).slice(0, 10); return d > best ? d : best }, '')
        const recentCount = rpts.filter(r => new Date(String(r.timestamp).slice(0, 10)) >= thirtyDaysAgo).length

        const areaCounts = new Map<string, number>()
        rpts.forEach(r => { if (r.areaOfIntervention) areaCounts.set(r.areaOfIntervention, (areaCounts.get(r.areaOfIntervention) ?? 0) + 1) })
        const topAreas = Array.from(areaCounts.entries()).sort((a, b) => b[1] - a[1]).map(([area, count]) => ({ area, count }))

        const states   = [...new Set(rpts.map(r => r.state).filter(Boolean))]
        const projects = [...new Set(rpts.map(r => r.project).filter(Boolean))]

        const descPct  = pct(rpts.filter(r => String(r.description || '').length >= 30).length, n)
        const benefPct = pct(rpts.filter(r => parseInt(String(r.beneficiaries ?? 0)) > 0).length, n)
        const photoPct = pct(rpts.filter(r => r.attachmentUrl).length, n)
        const locPct   = pct(rpts.filter(r => (r.location || '').trim().split(/\s+/).length >= 2).length, n)

        return {
          name:        u?.name || rpts[0]?.name || phone,
          phone,
          employee_id: u?.employee_id || '',
          role:        u?.role || 'employee',
          reports:     rpts,
          reportCount: n,
          recentCount,
          totalBenef,
          lastDate,
          states,
          projects,
          topAreas,
          quality: {
            overall:       Math.round((descPct + benefPct + photoPct + locPct) / 4),
            description:   descPct,
            beneficiaries: benefPct,
            photo:         photoPct,
            location:      locPct,
          },
        }
      })
      .sort((a, b) => b.reportCount - a.reportCount)
  }, [baseReports, users])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return workers
    return workers.filter(w =>
      w.name.toLowerCase().includes(q) ||
      w.role.toLowerCase().includes(q) ||
      w.states.some(s => s.toLowerCase().includes(q)) ||
      w.topAreas.some(a => a.area.toLowerCase().includes(q))
    )
  }, [workers, search])

  const totalReports = workers.reduce((s, w) => s + w.reportCount, 0)
  const totalBenef   = workers.reduce((s, w) => s + w.totalBenef, 0)
  const avgQuality   = workers.length ? Math.round(workers.reduce((s, w) => s + w.quality.overall, 0) / workers.length) : 0

  if (baseReports.length === 0) {
    return (
      <div className="text-center py-20 bg-white rounded-xl border border-dashed border-gray-200">
        <BarChart2 className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500 font-medium">No report data available</p>
        <p className="text-sm text-gray-400 mt-1">Contributor analytics will appear once reports are submitted.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-8">

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: t.prWorkers,            value: workers.length,                    icon: <User      className="w-4 h-4" /> },
          { label: t.prTotalReports,       value: totalReports,                      icon: <BarChart2 className="w-4 h-4" /> },
          { label: t.statsBeneficiaries,   value: totalBenef.toLocaleString('en-IN'), icon: <Users    className="w-4 h-4" /> },
          { label: t.prAvgQuality,         value: `${avgQuality}%`,                  icon: <Sparkles  className="w-4 h-4" /> },
        ].map(s => (
          <div key={s.label} className="rounded-xl p-3 flex items-center gap-3" style={{ background: C.faint }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white" style={{ background: C.sidebar }}>
              {s.icon}
            </div>
            <div>
              <div className="text-xl font-black" style={{ color: C.dark }}>{s.value}</div>
              <div className="text-[10px] font-semibold" style={{ color: C.muted }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {workers.length > 1 && (
        <input
          type="text"
          placeholder={t.prSearchPlaceholder}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full text-sm px-4 py-2.5 rounded-xl border outline-none bg-white"
          style={{ borderColor: C.surface, color: C.dark }}
        />
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16" style={{ color: C.muted }}>
          <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">{t.prNoWorkers}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(w => (
            <WorkerCard key={w.phone} worker={w} viewerRole={user?.role ?? 'employee'} />
          ))}
        </div>
      )}
    </div>
  )
}
