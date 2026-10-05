import { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import {
  ChevronDown, ChevronRight, Search, MapPin, CalendarDays, TrendingUp,
  Check, Loader2, MessageSquare, Download, History as HistoryIcon, X,
  AlertTriangle, CheckCircle2, BarChart3,
  Upload, FileSpreadsheet, Trash2, Settings,
} from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts'
import actionPlanData from '../../data/actionPlanData.json'   // fallback seed when no plans exist server-side
import { useAuthContext } from '../../context/AuthContext'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { UploadActionPlanModal } from './UploadActionPlanModal'
import { ActivityTrackingPanel } from './ActivityTrackingPanel'
import { ActivityStatTiles } from './ActivityStatTiles'
import {
  C, alertFor, CATEGORIES, toNum, activityTotal,
  type Activity, type ActivityTrackingFields, type MonthData, type CategoryId, type ProgressMap,
} from './actionPlanShared'

const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']
const ALL_LOCATIONS = ['Khagaria','Alauli','Bhaptiyahi','Pipra','Kishanpur','Kusheshwar Sthan']

function currentPlanMonth(): string {
  const m = new Date().getMonth() // 0=Jan, 3=Apr
  return MONTHS[((m - 3) + 12) % 12]
}

// Small dot color for the row-level Status indicator (see ActivityTrackingPanel.tsx's
// STATUS_COLOR for the fuller badge version used in the expanded panel).
const STATUS_DOT_COLOR: Record<string, string> = {
  'Not Started': '#9CA3AF', 'In Progress': '#2563EB', 'Completed': '#3F7D5C', 'On Hold': '#B8862E', 'Cancelled': '#B0473C',
}

// Short label for a location in tight table headers — first word, capped in
// length, with the full name always available via the header's `title` tooltip.
function shortLoc(loc: string): string {
  const first = loc.split(' ')[0]
  return first.length > 8 ? first.slice(0, 8) : first
}

// Plain-language "how this activity is measured" badge. `short` uses a middle
// dot rather than "Ã—" so "500 deliverables Â· 7/yr" can't be misread as maths.
function unitBadge(act: Pick<Activity, 'unit' | 'times'>): { short: string; full: string } | null {
  if (!act.unit) return null
  const n = act.times ? Number(act.times) : 0
  if (n > 1) {
    return {
      short: `${act.unit} · ${n}×/yr`,
      full:  `Measured in: ${act.unit}. Recorded ${n} times a year.`,
    }
  }
  return { short: act.unit, full: `Measured in: ${act.unit}` }
}

function timeAgo(iso: string | null | undefined) {
  if (!iso) return ''
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ── Inline editable cell (target + achieved, both clickable) ─────────────────
function ProgressCell({
  indicator, target, achieved, notes, updatedBy, updatedAt,
  canEdit, saving, onSave, onOpenNotes,
}: {
  indicator:  string
  target:     number | null
  achieved:   number | null
  notes?:     string
  updatedBy?: string | null
  updatedAt?: string | null
  canEdit:    boolean
  saving:     boolean
  // Pass `undefined` for a field this save isn't changing, never its current
  // value â€” echoing it back would freeze that value into the DB.
  onSave:     (indicator: string, target: number | null | undefined, achieved: number | null | undefined) => void
  onOpenNotes?: (indicator: string) => void
}) {
  const [editing, setEditing] = useState<null | 'target' | 'achieved'>(null)
  const [draft, setDraft] = useState('')

  const commit = () => {
    if (editing === null) return
    const num = draft.trim() === '' ? null : Number(draft)
    if (num !== null && isNaN(num)) { setEditing(null); return }
    if (editing === 'target')   onSave(indicator, num, undefined)
    if (editing === 'achieved') onSave(indicator, undefined, num)
    setEditing(null)
  }

  // Only collapse to a dash when there is truly nothing to show â€” the "Overall"
  // column always renders with canEdit=false, so an achieved-only month must still show.
  if (!target && achieved == null && !canEdit) return <span className="text-gray-300 text-xs">—</span>

  const pct = (target && achieved != null) ? Math.min(100, Math.round((achieved / target) * 100)) : 0
  const color = pct >= 100 ? C.green : pct >= 60 ? C.amber : pct > 0 ? C.red : '#9CA3AF'

  const tooltip = [
    notes ? `📝 ${notes}` : null,
    updatedBy ? `Last edited by ${updatedBy} ${timeAgo(updatedAt)}` : null,
    canEdit && !editing ? 'Click target or achieved to edit' : null,
  ].filter(Boolean).join('\n')

  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[78px] group relative" title={tooltip || undefined}>
      <div className="text-[11px] font-semibold flex items-center gap-0.5">
        {editing === 'target' ? (
          <input
            autoFocus type="number"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(null) }}
            onBlur={commit}
            className="w-10 text-xs text-center border rounded outline-none"
            style={{ borderColor: C.purple }}
            placeholder="0"
          />
        ) : (
          <span
            className={canEdit ? 'cursor-pointer hover:bg-purple-100 px-0.5 rounded text-gray-600' : 'text-gray-400 font-normal'}
            onClick={() => { if (canEdit) { setDraft(target != null ? String(target) : ''); setEditing('target') } }}
          >
            {target ?? '—'}
          </span>
        )}
        <span className="text-gray-400 font-normal">/</span>
        {editing === 'achieved' ? (
          <input
            autoFocus type="number"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(null) }}
            onBlur={commit}
            className="w-10 text-xs text-center border rounded outline-none"
            style={{ borderColor: C.purple }}
            placeholder="0"
          />
        ) : (
          <span
            className={canEdit ? 'cursor-pointer hover:bg-purple-100 px-0.5 rounded' : ''}
            style={{ color }}
            onClick={() => { if (canEdit) { setDraft(achieved != null ? String(achieved) : ''); setEditing('achieved') } }}
          >
            {achieved ?? '—'}
          </span>
        )}
        {saving && <Loader2 size={9} className="animate-spin text-gray-400 ml-0.5" />}
      </div>

      <div className="w-full h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>

      {/* Anyone can open this to read a note; the modal itself restricts editing to editors. */}
      {onOpenNotes && (canEdit || notes) && (
        <button
          onMouseDown={e => { e.preventDefault(); onOpenNotes(indicator) }}
          className={`absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full text-[8px] transition ${notes ? 'bg-amber-400 text-white opacity-100' : 'bg-gray-300 text-white opacity-40 group-hover:opacity-90'}`}
          title={notes ? `Note: ${notes}` : 'Add a note'}
        >
          💬
        </button>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
interface Props {
  // Globally-selected project; each project has its own Action Plan, so this tab follows it.
  projectKey?: string
}

export function ActionPlanTab({ projectKey }: Props) {
  const { user } = useAuthContext()
  const role = user?.role ?? 'employee'
  const canEdit = role === 'admin' || role === 'superadmin' || role === 'manager'

  const [search, setSearch]           = useState('')
  const [monthFilter, setMonthFilter] = useState<string>('All')   // default to all months — full grid visible
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [expanded, setExpanded]       = useState<Set<number>>(new Set())
  const [progress, setProgress]       = useState<ProgressMap>({})
  const [saving, setSaving]           = useState<Set<string>>(new Set())
  const [loading, setLoading]         = useState(true)
  const [notesFor, setNotesFor]       = useState<string | null>(null)
  const [notesDraft, setNotesDraft]   = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [history, setHistory]         = useState<Array<{ actor_name: string; indicator: string; diff: any; created_at: string }>>([])

  // Last-selected plan is persisted in localStorage.
  type PlanMeta = { id: string; project_key: string; name: string; year: number | null; start_month: number; locations: string[]; activity_count: number }
  const [plans, setPlans]               = useState<PlanMeta[]>([])
  const [activePlanKey, setActivePlanKey] = useState<string>(() => projectKey || localStorage.getItem('actionPlan.activeKey') || '')

  useEffect(() => {
    if (projectKey && projectKey !== activePlanKey) setActivePlanKey(projectKey)
  }, [projectKey]) // eslint-disable-line
  const [planActivities, setPlanActivities] = useState<Activity[] | null>(null)
  const [showUpload, setShowUpload]         = useState(false)
  const [deletingPlan, setDeletingPlan]     = useState(false)
  const [showQuickfill, setShowQuickfill]   = useState(false)   // collapsed by default — avoid confusion with view filters above
  const [manageOpen, setManageOpen]         = useState(false)   // ⚙ Manage popover open state
  const manageRef                           = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!manageOpen) return
    const onDown = (e: MouseEvent) => {
      if (manageRef.current && !manageRef.current.contains(e.target as Node)) setManageOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [manageOpen])
  const [lastSavedAt, setLastSavedAt]       = useState<number | null>(null)
  // Open by default for first-time users; remembered once hidden.
  const [guideOpen, setGuideOpen]           = useState<boolean>(() => localStorage.getItem('actionPlan.guideCollapsed') !== '1')
  // Surface load failures rather than falling back to seed data, which would
  // look like an empty plan. Bumping `reloadToken` re-runs the fetches below.
  const [loadError, setLoadError]           = useState<string | null>(null)
  const [reloadToken, setReloadToken]       = useState(0)
  const retryLoad = () => { setLoadError(null); setReloadToken(t => t + 1) }

  useEffect(() => { localStorage.setItem('actionPlan.guideCollapsed', guideOpen ? '0' : '1') }, [guideOpen])

  async function errorFromResponse(r: Response, fallback: string): Promise<Error> {
    const body = await r.json().catch(() => ({}))
    return new Error(body?.error || `${fallback} (error ${r.status})`)
  }

  const reloadPlans = () => {
    apiFetch('/api/action-plans')
      .then(async r => { if (!r.ok) throw await errorFromResponse(r, "Couldn't load your plans"); return r.json() })
      .then((d: { plans: PlanMeta[] }) => { setPlans(d.plans || []); setLoadError(null) })
      .catch((e: any) => setLoadError(e.message || "Couldn't load your plans"))
  }

  // Clears only the uploaded Action Plan, never the project itself. Saved
  // target/achieved numbers are kept and re-attach by indicator on re-upload.
  const handleClearCurrent = async () => {
    const current = plans.find(p => p.project_key === activePlanKey)
    if (!current) return
    if (!confirm(`Clear the uploaded Action Plan for "${current.name}"?\n\nThis only removes the activities/months you uploaded here — the project itself (its budget, donor, status) and your saved target/achieved numbers stay exactly as they are. You can upload a fresh plan file right after.`)) return
    setDeletingPlan(true)
    try {
      const r = await apiFetch(`/api/action-plans/${current.id}/clear-plan`, { method: 'POST' })
      if (!r.ok) throw new Error('Clear failed')
      setPlans(prev => prev.map(p => p.id === current.id ? { ...p, activity_count: 0, locations: [] } : p))
      setPlanActivities([])
    } catch (e: any) {
      alert('Clear failed: ' + (e.message || 'unknown'))
    }
    setDeletingPlan(false)
  }

  const handleUploaded = (_: { id: string; name: string }) => {
    setShowUpload(false)
    reloadPlans()
  }

  useEffect(() => {
    apiFetch('/api/action-plans')
      .then(async r => { if (!r.ok) throw await errorFromResponse(r, "Couldn't load your plans"); return r.json() })
      .then((d: { plans: PlanMeta[] }) => {
        setPlans(d.plans || [])
        setLoadError(null)
        if (d.plans?.length) {
          const remembered = d.plans.find(p => p.project_key === activePlanKey)
          const next = remembered || d.plans[0]
          if (next.project_key !== activePlanKey) setActivePlanKey(next.project_key)
        }
      })
      .catch((e: any) => setLoadError(e.message || "Couldn't load your plans"))
  }, [reloadToken])  // eslint-disable-line

  // Reset filters that may not apply when switching plans
  useEffect(() => {
    setSearch('')

    if (!activePlanKey) {
      setPlanActivities(actionPlanData as Activity[])
      return
    }
    localStorage.setItem('actionPlan.activeKey', activePlanKey)
    const plan = plans.find(p => p.project_key === activePlanKey)
    if (!plan) return
    let cancelled = false
    apiFetch(`/api/action-plans/${plan.id}`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r, "Couldn't load this plan"); return r.json() })
      .then(d => {
        if (!cancelled && d?.activities) { setPlanActivities(d.activities as Activity[]); setLoadError(null) }
      })
      .catch((e: any) => { if (!cancelled) setLoadError(e.message || "Couldn't load this plan") })
    return () => { cancelled = true }
  }, [activePlanKey, plans, reloadToken])

  const activities = planActivities ?? (actionPlanData as Activity[])

  const planLocations: string[] = useMemo(() => {
    const plan = plans.find(p => p.project_key === activePlanKey)
    return plan?.locations?.length ? plan.locations : ALL_LOCATIONS
  }, [plans, activePlanKey])

  useEffect(() => {
    if (!planActivities) return  // wait until activities are ready
    const q = activePlanKey ? `?plan=${encodeURIComponent(activePlanKey)}` : ''
    let cancelled = false
    apiFetch(`/api/action-plan/progress${q}`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r, "Couldn't load saved progress"); return r.json() })
      .then(data => { if (!cancelled) { setProgress(data || {}); setLoadError(null) } })
      .catch((e: any) => { if (!cancelled) setLoadError(e.message || "Couldn't load saved progress") })
      .finally(() => { if (!cancelled) setLoading(false) })

    // History is supplementary, so its failures are swallowed.
    apiFetch(`/api/action-plan/history?limit=50${q ? '&' + q.slice(1) : ''}`)
      .then(r => r.ok ? r.json() : { history: [] })
      .then(d => { if (!cancelled) setHistory(d.history || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [planActivities, activePlanKey, reloadToken])

  // target/achieved are `undefined` when unchanged by this save and must not be
  // sent â€” echoing the displayed value would freeze it into project_deliverables,
  // so later plan re-uploads would stop updating that cell's target.
  const handleSave = async (indicator: string, target: number | null | undefined, achieved: number | null | undefined, notes?: string): Promise<boolean> => {
    const before = progress[indicator]
    setProgress(prev => ({
      ...prev,
      [indicator]: {
        ...(prev[indicator] || {}),
        ...(target    !== undefined ? { target }    : {}),
        ...(achieved  !== undefined ? { achieved }   : {}),
        ...(notes     !== undefined ? { notes }      : {}),
        updatedBy: user?.name || 'you',
        updatedAt: new Date().toISOString(),
      },
    }))
    setSaving(prev => new Set(prev).add(indicator))
    try {
      const body: any = { indicator, plan: activePlanKey }
      if (target   !== undefined) body.target   = target
      if (achieved !== undefined) body.achieved = achieved
      if (notes    !== undefined) body.notes    = notes
      const res = await apiFetch('/api/action-plan/progress', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error || `Save failed (${res.status})`)
      }
      setLastSavedAt(Date.now())
      const hq = activePlanKey ? `&plan=${encodeURIComponent(activePlanKey)}` : ''
      apiFetch(`/api/action-plan/history?limit=50${hq}`)
        .then(r => r.ok ? r.json() : { history: [] })
        .then(d => setHistory(d.history || []))
        .catch(() => {})
      return true
    } catch (e: any) {
      setProgress(prev => {
        const next = { ...prev }
        if (before) next[indicator] = before
        else delete next[indicator]
        return next
      })
      alert(`Couldn't save "${indicator}": ${e.message || 'unknown error'}`)
      return false
    } finally {
      setSaving(prev => { const next = new Set(prev); next.delete(indicator); return next })
    }
  }

  const openNotes = (indicator: string) => {
    setNotesFor(indicator)
    setNotesDraft(progress[indicator]?.notes || '')
  }
  const saveNotes = async () => {
    if (!notesFor) return
    setSavingNotes(true)
    const ok = await handleSave(notesFor, undefined, undefined, notesDraft)
    setSavingNotes(false)
    if (ok) setNotesFor(null)
  }

  // null while on the bundled seed data, which has no server-side row.
  const currentPlan  = plans.find(p => p.project_key === activePlanKey) ?? null
  const activePlanId = currentPlan?.id ?? null

  // `patch` must contain only the fields being changed, so a concurrent edit to
  // another field isn't overwritten.
  const handleActivityUpdate = async (sn: number, patch: ActivityTrackingFields) => {
    if (!activePlanId) return
    setPlanActivities(prev => prev
      ? prev.map(a => a.sn === sn ? { ...a, ...patch } : a)
      : prev)
    const res = await apiFetch(`/api/action-plans/${activePlanId}/activities/${sn}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Update failed (${res.status})`)
    }
  }

  const filtered = useMemo(() =>
    activities.filter(a => {
      const q = search.toLowerCase()
      if (q && !a.activity.toLowerCase().includes(q) && !a.responsibility.toLowerCase().includes(q)) return false
      return true
    }),
  [search, activities])

  const grouped = useMemo(() => {
    const out: Record<string, Activity[]> = {}
    for (const c of CATEGORIES) out[c.id] = []
    for (const a of filtered) {
      const cid = ((a as any).category || 'capacity') as CategoryId
      ;(out[cid] = out[cid] || []).push(a)
    }
    return out
  }, [filtered])

  const categoryStats = useMemo(() => {
    const out: Record<string, { target: number; achieved: number; pct: number }> = {}
    for (const cat of CATEGORIES) {
      let target = 0, achieved = 0
      for (const a of grouped[cat.id] || []) {
        const t = activityTotal(a, progress, null, monthFilter === 'All' ? null : monthFilter)
        target += t.target; achieved += t.achieved
      }
      out[cat.id] = { target, achieved, pct: target > 0 ? Math.round((achieved / target) * 100) : 0 }
    }
    return out
  }, [grouped, progress, monthFilter])

  // Charts cover the whole plan, ignoring search and month filter, so they stay a stable overview.
  const monthlyTrend = useMemo(() => MONTHS.map(m => {
    let target = 0, achieved = 0
    for (const a of activities) {
      const t = activityTotal(a, progress, null, m)
      target += t.target; achieved += t.achieved
    }
    return { month: m, target, achieved }
  }), [activities, progress])

  const cumulativeTrend = useMemo(() => {
    let runTarget = 0, runAchieved = 0
    return monthlyTrend.map(m => {
      runTarget += m.target; runAchieved += m.achieved
      return { month: m.month, target: runTarget, achieved: runAchieved }
    })
  }, [monthlyTrend])

  const categoryChartData = useMemo(() => CATEGORIES.map(cat => {
    let target = 0, achieved = 0
    for (const a of activities) {
      if (((a as any).category || 'capacity') !== cat.id) continue
      const t = activityTotal(a, progress, null, null)
      target += t.target; achieved += t.achieved
    }
    const pct = target > 0 ? Math.round((achieved / target) * 100) : 0
    return { name: cat.label, pct, target, achieved, color: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red }
  }).filter(c => c.target > 0 || c.achieved > 0), [activities, progress])

  const locationChartData = useMemo(() => planLocations.map(loc => {
    let target = 0, achieved = 0
    for (const a of activities) {
      const t = activityTotal(a, progress, loc, null)
      target += t.target; achieved += t.achieved
    }
    const pct = target > 0 ? Math.round((achieved / target) * 100) : 0
    return { name: loc, pct, target, achieved, color: pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red }
  }).filter(l => l.target > 0 || l.achieved > 0), [activities, progress, planLocations])

  const displayMonths = monthFilter === 'All' ? MONTHS : [monthFilter]
  const displayLocs   = planLocations

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold" style={{ color: C.purple }}>
            {plans.find(p => p.project_key === activePlanKey)?.name || plans[0]?.name || 'Kosi Sahjivan — Action Plan 2026'}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Monthly Target vs Achieved
            {canEdit && <span className="ml-2 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px] font-semibold">✏ Editable</span>}
            {plans.length === 0 && (
              <span className="ml-2 text-amber-700">· Click <strong>⚙ Manage → Upload Plan</strong> to add your first project</span>
            )}
          </p>
        </div>

        {canEdit && (
          <div ref={manageRef} className="relative shrink-0">
            <button
              onClick={() => setManageOpen(v => !v)}
              className="flex items-center gap-1.5 border rounded-lg px-3 py-1.5 bg-white text-sm hover:bg-purple-50 transition"
              style={{
                borderColor: manageOpen ? C.purple : C.border,
                color:       manageOpen ? C.purple : '#6B7280',
                background:  manageOpen ? '#F5F3FB' : 'white',
              }}
              title="Manage action plans"
            >
              <Settings className="w-3.5 h-3.5" /> Manage
            </button>

            {manageOpen && (
              <div
                className="absolute right-0 top-full mt-1 bg-white rounded-xl border shadow-lg overflow-hidden z-30 min-w-[200px]"
                style={{ borderColor: C.border }}
              >
                <button
                  onClick={() => { setShowUpload(true); setManageOpen(false) }}
                  className="w-full text-left text-sm flex items-center gap-2 px-3 py-2 hover:bg-purple-50 transition"
                  style={{ color: C.purple }}
                >
                  <Upload className="w-3.5 h-3.5" /> Upload new plan
                </button>
                <button
                  onClick={() => {
                    setManageOpen(false)
                    authedDownload('/api/action-plans/template.xlsx', 'action-plan-template.xlsx')
                      .catch(e => alert('Download failed: ' + e.message))
                  }}
                  className="w-full text-left text-sm flex items-center gap-2 px-3 py-2 hover:bg-purple-50 transition"
                  style={{ color: C.purple }}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Download template
                </button>
                {plans.length > 0 && activePlanKey && (
                  <>
                    <div className="h-px" style={{ background: C.border }} />
                    <button
                      onClick={() => { handleClearCurrent(); setManageOpen(false) }}
                      disabled={deletingPlan}
                      className="w-full text-left text-sm flex items-center gap-2 px-3 py-2 hover:bg-red-50 transition text-red-600 disabled:opacity-50"
                      title="Removes the uploaded activities so you can upload a fresh file — the project itself is not affected"
                    >
                      {deletingPlan ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Clear uploaded plan
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {loadError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">Couldn't load your plan's numbers: {loadError}</span>
          <button onClick={retryLoad} className="text-xs font-semibold underline shrink-0">Try again</button>
        </div>
      )}

      <HowToUseGuide open={guideOpen} onToggle={() => setGuideOpen(v => !v)} canEdit={canEdit} />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 border rounded-lg px-3 py-1.5 bg-white text-sm" style={{ borderColor: C.border }}>
          <Search size={13} className="text-gray-400" />
          <input className="outline-none w-36 text-sm" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex items-center gap-1.5 border rounded-lg px-3 py-1.5 bg-white" style={{ borderColor: C.border }}>
          <CalendarDays size={12} className="text-gray-400" />
          <select className="outline-none text-sm bg-transparent" value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
            <option value="All">All Months</option>
            {MONTHS.map(m => <option key={m} value={m}>{m === currentPlanMonth() ? `${m} (now)` : m}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        {canEdit && (
          <button
            onClick={() => {
              const q = activePlanKey ? `?plan=${encodeURIComponent(activePlanKey)}` : ''
              const fname = `action-plan-${activePlanKey || 'current'}-${new Date().toISOString().slice(0,10)}.xlsx`
              authedDownload(`/api/action-plan/export.xlsx${q}`, fname).catch(e => alert('Download failed: ' + e.message))
            }}
            className="flex items-center gap-1.5 border rounded-lg px-3 py-1.5 bg-white text-sm hover:bg-purple-50 transition"
            style={{ borderColor: C.border, color: C.purple }}
            title="Download current state in the same format as the upload template — edit in Excel, then re-upload"
          >
            <Download size={13} /> Export
          </button>
        )}
      </div>

      <ActivityStatTiles activities={activities} />

      <AnalysisSection
        monthlyTrend={monthlyTrend}
        cumulativeTrend={cumulativeTrend}
        categoryChartData={categoryChartData}
        locationChartData={locationChartData}
      />

      {canEdit && activities.length > 0 && (
        <div className="hidden md:block">
          {!showQuickfill ? (
            <button
              onClick={() => setShowQuickfill(true)}
              className="text-[11px] font-semibold text-purple-700 hover:text-purple-900 flex items-center gap-1.5 px-2.5 py-1 rounded-lg hover:bg-purple-50 transition"
              title="Open bulk-edit bar to set many cells at once"
            >
              ⚡ Quickfill — bulk update many cells at once
            </button>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-purple-700 font-semibold uppercase tracking-widest">⚡ Quickfill — bulk update</span>
                <button onClick={() => setShowQuickfill(false)} className="text-[10px] text-gray-400 hover:text-gray-700">Hide</button>
              </div>
              <BulkFillBar
                activities={activities}
                planLocations={planLocations}
                planKey={activePlanKey}
                onDone={() => {
                  // Refresh saved progress after a bulk update
                  const q = activePlanKey ? `?plan=${encodeURIComponent(activePlanKey)}` : ''
                  apiFetch(`/api/action-plan/progress${q}`)
                    .then(r => r.ok ? r.json() : {})
                    .then(data => setProgress(data || {}))
                    .catch(() => {})
                  setLastSavedAt(Date.now())
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block bg-white rounded-xl border overflow-hidden" style={{ borderColor: C.border }}>
        {loading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-gray-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading progress…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: C.purple }}>
                  <th className="px-2 py-2 lg:px-3 lg:py-2.5 text-left text-white text-xs font-semibold w-10 sticky left-0 z-20" style={{ background: C.purple }}>#</th>
                  <th className="px-2 py-2 lg:px-3 lg:py-2.5 text-left text-white text-xs font-semibold min-w-[150px] lg:min-w-[190px] sticky left-10 z-20 border-r" style={{ background: C.purple, borderColor: 'rgba(255,255,255,0.18)' }}>Activity</th>
                  <th className="px-2 py-2 lg:px-3 lg:py-2.5 text-left text-white text-xs font-semibold w-20">By</th>
                  <th className="px-2 py-2 lg:px-3 lg:py-2.5 text-center text-white text-xs font-semibold w-20" title="Target / Achieved for the whole year">
                    <TrendingUp size={11} className="inline mr-1" />Progress
                    <div className="opacity-60 text-[9px] font-normal">Target/Achieved</div>
                  </th>
                  {displayLocs.map(loc =>
                    displayMonths.map(m => (
                      <th key={`${loc}-${m}`} className="px-1.5 py-1 lg:px-2 text-center text-white text-[10px] font-medium whitespace-nowrap min-w-[64px] lg:min-w-[78px]" title={loc}>
                        <div className="font-semibold">{m}</div>
                        <div className="opacity-60 text-[9px]">{shortLoc(loc)}</div>
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows: React.ReactNode[] = []
                  for (const cat of CATEGORIES) {
                  const inCat = grouped[cat.id] || []
                  if (inCat.length === 0) continue
                  const isCollapsed = collapsedCats.has(cat.id)
                  const cs = categoryStats[cat.id]
                  const totalCols = 4 + displayLocs.length * displayMonths.length
                  const headerRow = (
                    <tr key={`cat-${cat.id}`} className="border-b" style={{ borderColor: C.border, background: '#F9FAFB' }}>
                      <td
                        colSpan={totalCols}
                        className="px-3 py-2 sticky left-0 z-10"
                        style={{ borderLeft: `3px solid ${cat.color}` }}
                      >
                        <button
                          onClick={() => setCollapsedCats(prev => {
                            const n = new Set(prev); n.has(cat.id) ? n.delete(cat.id) : n.add(cat.id); return n
                          })}
                          className="flex items-center gap-2 w-full text-left"
                        >
                          {isCollapsed ? <ChevronRight size={12} className="text-gray-400" /> : <ChevronDown size={12} className="text-gray-400" />}
                          <span className="text-base">{cat.icon}</span>
                          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-800">{cat.label}</span>
                          <span className="text-[10px] text-gray-400">({inCat.length} activities)</span>
                          {(cs.target > 0 || cs.achieved > 0) && (
                            <span className="ml-auto flex items-center gap-2 text-[11px]">
                              <span className="text-gray-500">{cs.target}/{cs.achieved}</span>
                              <span className="font-bold" style={{ color: cs.pct >= 80 ? C.green : cs.pct >= 50 ? C.amber : C.red }}>
                                {cs.pct}%
                              </span>
                              <span className="w-24 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                                <span className="block h-full" style={{ width: `${Math.min(100, cs.pct)}%`, background: cs.pct >= 80 ? C.green : cs.pct >= 50 ? C.amber : C.red }} />
                              </span>
                            </span>
                          )}
                        </button>
                      </td>
                    </tr>
                  )
                  rows.push(headerRow)
                  if (isCollapsed) continue

                  const activityRows = inCat.map((act, idx) => {
                    const isExp   = expanded.has(act.sn)
                    const overall = activityTotal(act, progress, null, monthFilter === 'All' ? null : monthFilter)
                    const rowBg   = idx % 2 === 0 ? '#FAFAFA' : '#fff'
                    const alert_  = alertFor(act)
                    const ub      = unitBadge(act)
                    return (
                      <Fragment key={`row-${act.sn}`}>
                      <tr
                        key={act.sn}
                        className="border-b hover:bg-purple-50 transition-colors"
                        style={{ borderColor: C.border, background: rowBg }}
                      >
                        <td
                          className="px-1.5 py-1.5 lg:px-2 lg:py-2 text-gray-400 text-xs sticky left-0 z-10 cursor-pointer select-none"
                          style={{ background: rowBg, ...(act.priority === 'High' ? { borderLeft: `3px solid ${C.red}` } : {}) }}
                          onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(act.sn) ? n.delete(act.sn) : n.add(act.sn); return n })}
                          title={act.priority === 'High' ? 'High priority' : undefined}
                        >
                          <div className="flex items-center gap-0.5">
                            {isExp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            {act.sn}
                          </div>
                        </td>
                        <td
                          className="px-2 py-1.5 lg:px-3 lg:py-2 font-medium text-xs max-w-[150px] lg:max-w-[190px] sticky left-10 z-10 cursor-pointer border-r"
                          style={{ background: rowBg, color: C.purple, borderColor: C.border }}
                          onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(act.sn) ? n.delete(act.sn) : n.add(act.sn); return n })}
                        >
                          <div className="flex items-center gap-1.5">
                            {act.status && (
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: STATUS_DOT_COLOR[act.status] }}
                                title={act.status}
                              />
                            )}
                            <div className="line-clamp-1 font-medium" title={act.activity}>{act.activity}</div>
                          </div>
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            {ub && (
                              <span
                                className="inline-block max-w-[140px] truncate align-bottom text-[9px] font-normal text-purple-700 bg-purple-50 border border-purple-100 rounded px-1.5 py-0.5"
                                title={ub.full}
                              >
                                📏 {ub.short}
                              </span>
                            )}
                            {alert_ && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[9px] font-semibold rounded px-1.5 py-0.5"
                                style={{ background: alert_ === 'Overdue' ? '#F5E1DD' : '#F5EBD3', color: alert_ === 'Overdue' ? C.red : C.amber }}
                                title={`Due ${act.due_date ? new Date(act.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}`}
                              >
                                <AlertTriangle className="w-2 h-2" /> {alert_}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 lg:px-3 lg:py-2 text-gray-500 text-xs">
                          <div className="line-clamp-1" title={act.responsibility}>{act.responsibility}</div>
                        </td>
                        <td className="px-2 py-1.5 lg:px-3 lg:py-2 text-center">
                          <ProgressCell
                            indicator={`${act.sn}|ALL|ALL`}
                            target={overall.target}
                            achieved={overall.achieved}
                            canEdit={false}
                            saving={false}
                            onSave={() => {}}
                          />
                        </td>
                        {displayLocs.map(loc =>
                          displayMonths.map(m => {
                            const indicator = `${act.sn}|${loc}|${m}`
                            const locData = act.locations.find(l => l.location === loc)
                            const base = locData?.monthly[m as keyof typeof locData.monthly] as MonthData | undefined
                            const override = progress[indicator]
                            const targetRaw   = override?.target   ?? base?.target   ?? null
                            const achievedRaw = override?.achieved ?? base?.achieved ?? null
                            const target   = targetRaw   == null ? null : toNum(targetRaw)
                            const achieved = achievedRaw == null ? null : toNum(achievedRaw)
                            return (
                              <td key={indicator} className="px-1.5 py-1.5 lg:px-2 lg:py-2 text-center">
                                <ProgressCell
                                  indicator={indicator}
                                  target={target}
                                  achieved={achieved}
                                  notes={override?.notes}
                                  updatedBy={override?.updatedBy}
                                  updatedAt={override?.updatedAt}
                                  canEdit={canEdit}
                                  saving={saving.has(indicator)}
                                  onSave={handleSave}
                                  onOpenNotes={openNotes}
                                />
                              </td>
                            )
                          })
                        )}
                      </tr>

                      {isExp && (
                        <tr key={`${act.sn}-exp`} style={{ background: '#F5F3FB', borderBottom: `1px solid ${C.border}` }}>
                          <td />
                          <td colSpan={3 + displayLocs.length * displayMonths.length} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              {act.description && (
                                <div>
                                  <div className="font-semibold text-gray-600 mb-1">Description</div>
                                  <div className="text-gray-500 leading-relaxed whitespace-pre-wrap">{act.description.replace(/ \| /g, '\n')}</div>
                                </div>
                              )}
                              {act.process && (
                                <div>
                                  <div className="font-semibold text-gray-600 mb-1">Process / Steps</div>
                                  <div className="text-gray-500 leading-relaxed whitespace-pre-wrap">{act.process.replace(/ \| /g, '\n')}</div>
                                </div>
                              )}
                            </div>

                            <ActivityTrackingPanel
                              activity={act}
                              canEdit={canEdit && planActivities != null}
                              onSave={handleActivityUpdate}
                            />
                            {act.locations.length > 0 && (
                              <div className="mt-3">
                                <div className="font-semibold text-gray-600 text-xs mb-2">Location Breakdown</div>
                                <div className="flex flex-wrap gap-3">
                                  {act.locations
                                    .map(l => {
                                      const { target, achieved } = activityTotal(act, progress, l.location, monthFilter === 'All' ? null : monthFilter)
                                      const pct = target > 0 ? Math.round((achieved / target) * 100) : 0
                                      const col = pct >= 100 ? C.green : pct >= 60 ? C.amber : pct > 0 ? C.red : '#9CA3AF'
                                      return (
                                        <div key={l.location} className="flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border" style={{ borderColor: C.border }}>
                                          <MapPin size={11} style={{ color: C.purple }} />
                                          <span className="text-gray-700 font-medium text-[11px]">{l.location}</span>
                                          <span className="text-[11px] font-bold" style={{ color: col }}>{target}/{achieved}</span>
                                          {target > 0 && <span className="text-[10px] text-gray-400">({pct}%)</span>}
                                        </div>
                                      )
                                    })}
                                </div>
                              </div>
                            )}

                            {(() => {
                              const recent = history.filter(h => h.indicator.startsWith(`${act.sn}|`)).slice(0, 5)
                              if (recent.length === 0) return null
                              return (
                                <div className="mt-3 pt-3 border-t" style={{ borderColor: C.border }}>
                                  <div className="font-semibold text-gray-600 text-xs mb-1.5 flex items-center gap-1">
                                    <HistoryIcon size={11} /> Recent edits
                                  </div>
                                  <div className="space-y-0.5">
                                    {recent.map((h, i) => {
                                      const [, loc, mon] = h.indicator.split('|')
                                      const diff = h.diff || {}
                                      const parts: string[] = []
                                      if (diff.achieved) parts.push(`achieved ${diff.achieved.before ?? '—'} → ${diff.achieved.after ?? '—'}`)
                                      if (diff.target)   parts.push(`target ${diff.target.before ?? '—'} → ${diff.target.after ?? '—'}`)
                                      if (diff.notes)    parts.push('note edited')
                                      return (
                                        <div key={i} className="text-[11px] text-gray-500 flex items-center gap-2 flex-wrap">
                                          <span className="text-gray-400">{timeAgo(h.created_at)}</span>
                                          <span className="font-medium text-gray-700">{h.actor_name}</span>
                                          <span className="text-gray-400">on {loc}/{mon}:</span>
                                          <span>{parts.join(' · ') || 'edited'}</span>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )
                            })()}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )
                  })
                  rows.push(...activityRows)
                  }
                  return rows
                })()}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="py-16 text-center text-gray-400 text-sm">No activities match your search.</div>
        )}

        <div className="px-4 py-2 border-t text-xs text-gray-400 flex justify-between" style={{ borderColor: C.border }}>
          <span>{filtered.length} of {activities.length} activities</span>
          <span>
            {canEdit ? '✏ Click a number to edit · 💬 click a cell\'s note icon to add a note' : '👁 View only'} · Click any row for full details
          </span>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-gray-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : (
          <MobileCards
            filtered={filtered}
            progress={progress}
            saving={saving}
            canEdit={canEdit}
            canEditTracking={canEdit && planActivities != null}
            displayLocs={displayLocs}
            displayMonths={displayMonths}
            onSave={handleSave}
            onOpenNotes={openNotes}
            onActivityUpdate={handleActivityUpdate}
          />
        )}
      </div>

      {/* Pinning existingPlanKey while a plan is open makes the upload update that
          plan instead of creating a new one from the file's own Plan Info sheet. */}
      {showUpload && (
        <UploadActionPlanModal
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
          existingPlanKey={currentPlan ? activePlanKey : undefined}
          existingPlanName={currentPlan?.name}
        />
      )}

      <SaveIndicator savingCount={saving.size} lastSavedAt={lastSavedAt} />


      {notesFor && (() => {
        // notesFor is an internal "sn|location|month" key; show the activity name instead.
        const [snStr, noteLoc, noteMonth] = notesFor.split('|')
        const noteAct   = activities.find(a => a.sn === Number(snStr))
        const existing  = progress[notesFor]
        return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !savingNotes && setNotesFor(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <MessageSquare className="w-4 h-4" style={{ color: C.purple }} /> {canEdit ? 'Add a Note' : 'Note'}
              </h3>
              <button onClick={() => !savingNotes && setNotesFor(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              For <strong className="text-gray-700">{noteAct?.activity || `Activity ${snStr}`}</strong> — {noteLoc} · {noteMonth}
            </p>

            {canEdit ? (
              <textarea
                rows={4}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
                placeholder="e.g. Rains delayed start by 2 weeks; will catch up in May"
                value={notesDraft}
                onChange={e => setNotesDraft(e.target.value)}
                autoFocus
              />
            ) : (
              <div className="w-full rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap min-h-[80px]">
                {notesDraft || <span className="text-gray-400">No note yet.</span>}
              </div>
            )}
            {existing?.updatedBy && (
              <p className="text-[10px] text-gray-400 mt-1.5">Last edited by {existing.updatedBy} {timeAgo(existing.updatedAt)}</p>
            )}

            <div className="flex justify-end gap-2 mt-3">
              {canEdit ? (
                <>
                  <button onClick={() => setNotesFor(null)} disabled={savingNotes}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={saveNotes} disabled={savingNotes}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                    style={{ background: C.purple }}>
                    {savingNotes ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Save note
                  </button>
                </>
              ) : (
                <button onClick={() => setNotesFor(null)}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white"
                  style={{ background: C.purple }}>
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

// Plan vs actual by month, cumulative, and category/location breakdowns.
function AnalysisSection({ monthlyTrend, cumulativeTrend, categoryChartData, locationChartData }: {
  monthlyTrend:      Array<{ month: string; target: number; achieved: number }>
  cumulativeTrend:   Array<{ month: string; target: number; achieved: number }>
  categoryChartData: Array<{ name: string; pct: number; target: number; achieved: number; color: string }>
  locationChartData: Array<{ name: string; pct: number; target: number; achieved: number; color: string }>
}) {
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem('actionPlan.analysisCollapsed') !== '1')
  useEffect(() => { localStorage.setItem('actionPlan.analysisCollapsed', open ? '0' : '1') }, [open])

  return (
    <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: C.border }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-purple-50/50 transition"
      >
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <BarChart3 size={15} style={{ color: C.purple }} />
        <span className="text-[11px] font-bold uppercase tracking-widest text-gray-800">Analysis — Plan vs Achieved</span>
      </button>

      {open && (
        <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartBox title="Monthly Target vs Achieved" hint="Bars show what was planned vs what was actually done, month by month.">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="target"   name="Target"   fill="#D9D2EC" radius={[4, 4, 0, 0]} />
                <Bar dataKey="achieved" name="Achieved" fill={C.purple} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartBox>

          <ChartBox title="Running Total Over the Year" hint="Same numbers, added up as the year goes on — like a running balance.">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={cumulativeTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="target"   name="Target"   stroke="#B8ABDA" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="achieved" name="Achieved" stroke={C.purple} strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </ChartBox>

          {categoryChartData.length > 0 && (
            <ChartBox title="Achievement by Category" hint="What % of the target has been achieved so far, for each type of activity.">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={categoryChartData} layout="vertical" margin={{ left: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis type="number" unit="%" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: any) => [`${v}%`, 'Achieved']} />
                  <Bar dataKey="pct" name="pct" radius={[0, 4, 4, 0]}>
                    {categoryChartData.map((c, i) => <Cell key={i} fill={c.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
          )}

          {locationChartData.length > 1 && (
            <ChartBox title="Achievement by Location" hint="What % of the target has been achieved so far, for each location.">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={locationChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis unit="%" tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => `${v}%`} />
                  <Bar dataKey="pct" name="Achieved %" radius={[4, 4, 0, 0]}>
                    {locationChartData.map((l, i) => <Cell key={i} fill={l.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartBox>
          )}
        </div>
      )}
    </div>
  )
}

function ChartBox({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-3" style={{ borderColor: C.border }}>
      <div className="text-xs font-semibold text-gray-700 mb-0.5">{title}</div>
      <div className="text-[10.5px] text-gray-400 mb-2">{hint}</div>
      {children}
    </div>
  )
}

// Plain-language guide card explaining how to read the table.
function HowToUseGuide({ open, onToggle, canEdit }: { open: boolean; onToggle: () => void; canEdit: boolean }) {
  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs font-semibold text-purple-700 hover:text-purple-900"
      >
        <ChevronRight size={13} /> How to use this page
      </button>
    )
  }
  return (
    <div className="bg-purple-50/70 border rounded-xl p-3.5" style={{ borderColor: '#c084fc' }}>
      <button onClick={onToggle} className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest mb-2" style={{ color: C.purple }}>
        <ChevronDown size={13} /> How to use this page
      </button>
      <ul className="space-y-1.5 text-[12.5px] text-gray-700 leading-snug">
        <li>• Each row below is one <strong>planned activity</strong>. Click anywhere on a row to open it and see the full description, steps, status and past notes.</li>
        <li>• Numbers are shown as <strong>Target / Achieved</strong> — for example <strong>20 / 15</strong> means 20 was planned and 15 has been done so far.</li>
        <li>• The colour tells you the status at a glance: <span style={{ color: C.green }}>🟢 on track</span>, <span style={{ color: C.amber }}>🟠 a little behind</span>, <span style={{ color: C.red }}>🔴 needs attention</span>, <span className="text-gray-400">⚪ not started</span>.</li>
        <li>• Use <strong>Search</strong> to find an activity by name, or the <strong>Month</strong> box to see just one month instead of the whole year.</li>
        <li>• A small 💬 icon on a cell means someone left a note there — click it to read what they wrote.</li>
        {canEdit ? (
          <>
            <li>• You can edit this plan. Click any number to type a new value, then press Enter to save.</li>
            <li>• Click the 💬 icon on any cell to add a note explaining a delay or change.</li>
          </>
        ) : (
          <li>• You are viewing this plan. Only admins and managers can change the numbers or add notes.</li>
        )}
      </ul>
    </div>
  )
}

// Bulk-fill bar â€” set target/achieved on many cells at once
function BulkFillBar({
  activities, planLocations, planKey, onDone,
}: {
  activities:    Activity[]
  planLocations: string[]
  planKey:       string
  onDone:        () => void   // called after a successful bulk apply (to refresh progress)
}) {
  const [field, setField]       = useState<'target' | 'achieved'>(() => (localStorage.getItem('actionPlan.bulk.field') as any) || 'achieved')
  const [scopeLoc, setScopeLoc] = useState<string>(() => localStorage.getItem('actionPlan.bulk.loc') || 'All')
  const [scopeMon, setScopeMon] = useState<string>(() => localStorage.getItem('actionPlan.bulk.month') || 'All')
  const [scopeAct, setScopeAct] = useState<string>(() => localStorage.getItem('actionPlan.bulk.act') || 'All')
  const [val, setVal]           = useState('')
  const [busy, setBusy]         = useState(false)
  const [result, setResult]     = useState<string | null>(null)

  useEffect(() => { localStorage.setItem('actionPlan.bulk.field', field) }, [field])
  useEffect(() => { localStorage.setItem('actionPlan.bulk.loc',   scopeLoc) }, [scopeLoc])
  useEffect(() => { localStorage.setItem('actionPlan.bulk.month', scopeMon) }, [scopeMon])
  useEffect(() => { localStorage.setItem('actionPlan.bulk.act',   scopeAct) }, [scopeAct])

  const targetIndicators = useMemo(() => {
    const out: string[] = []
    const wantLocs    = scopeLoc === 'All' ? planLocations          : [scopeLoc]
    const wantMonths  = scopeMon === 'All' ? MONTHS                  : [scopeMon]
    const wantActs    = scopeAct === 'All' ? activities.map(a => a.sn) : [parseInt(scopeAct)]
    for (const a of activities) {
      if (!wantActs.includes(a.sn)) continue
      for (const loc of wantLocs) {
        // Only include locations the activity actually has a row for
        if (!a.locations.some(l => l.location === loc)) continue
        for (const m of wantMonths) {
          out.push(`${a.sn}|${loc}|${m}`)
        }
      }
    }
    return out
  }, [activities, planLocations, scopeLoc, scopeMon, scopeAct])

  async function apply() {
    if (!val.trim() && val !== '0') { setResult('Enter a value'); return }
    const num = val.trim() === '' ? null : Number(val)
    if (num !== null && isNaN(num)) { setResult('Value must be a number'); return }
    if (targetIndicators.length === 0) { setResult('No cells match — try a wider scope'); return }
    if (targetIndicators.length > 200 && !confirm(`This will update ${targetIndicators.length} cells. Continue?`)) return

    setBusy(true); setResult(null)
    try {
      const body: any = { plan: planKey, indicators: targetIndicators }
      body[field] = num
      const r = await apiFetch('/api/action-plan/progress/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Bulk update failed')
      setResult(`✓ Updated ${d.updated} cells`)
      setVal('')
      onDone()
      setTimeout(() => setResult(null), 4000)
    } catch (e: any) {
      setResult('Failed: ' + (e.message || 'unknown'))
    }
    setBusy(false)
  }

  return (
    <div className="bg-purple-50/60 border rounded-xl px-3 py-2.5 flex items-center gap-2 flex-wrap text-sm" style={{ borderColor: '#c084fc' }}>
      <span className="text-gray-600 text-xs whitespace-nowrap">Set the</span>
      <select
        value={field} onChange={e => setField(e.target.value as 'target' | 'achieved')}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
      >
        <option value="achieved">Achieved</option>
        <option value="target">Target</option>
      </select>
      <span className="text-gray-600 text-xs">value of every cell where Location =</span>
      <select
        value={scopeLoc} onChange={e => setScopeLoc(e.target.value)}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
      >
        <option value="All">Any</option>
        {planLocations.map(l => <option key={l} value={l}>{l}</option>)}
      </select>
      <span className="text-gray-600 text-xs">Month =</span>
      <select
        value={scopeMon} onChange={e => setScopeMon(e.target.value)}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
      >
        <option value="All">Any</option>
        {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <span className="text-gray-600 text-xs">Activity =</span>
      <select
        value={scopeAct} onChange={e => setScopeAct(e.target.value)}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300 max-w-[180px]"
      >
        <option value="All">Any</option>
        {activities.map(a => <option key={a.sn} value={a.sn}>{a.sn}. {a.activity.slice(0, 30)}</option>)}
      </select>
      <span className="text-gray-600 text-xs">to</span>
      <input
        type="number"
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') apply() }}
        className="w-20 text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
        placeholder="0"
        disabled={busy}
      />
      <button
        onClick={apply}
        disabled={busy}
        className="text-xs font-semibold px-3 py-1 rounded-lg text-white disabled:opacity-50"
        style={{ background: C.purple }}
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Apply'}
      </button>
      <span className="text-[10px] text-gray-500 ml-1">
        will update <strong>{targetIndicators.length}</strong> cells
      </span>
      {result && (
        <span className="text-[11px] font-semibold ml-auto" style={{ color: result.startsWith('✓') ? C.green : C.red }}>
          {result}
        </span>
      )}
    </div>
  )
}

function SaveIndicator({ savingCount, lastSavedAt }: {
  savingCount: number
  lastSavedAt: number | null
}) {
  const [now, setNow] = useState(Date.now())
  const [visible, setVisible] = useState(false)

  // Tick every second so "X sec ago" stays fresh; hide 5s after the last save.
  useEffect(() => {
    if (savingCount > 0) { setVisible(true); return }
    if (!lastSavedAt) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), 5000)
    return () => clearTimeout(t)
  }, [savingCount, lastSavedAt])

  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [visible])

  if (!visible) return null

  const saving = savingCount > 0
  const sec = lastSavedAt ? Math.floor((now - lastSavedAt) / 1000) : 0
  const ago = sec < 2 ? 'just now' : `${sec} sec ago`

  return (
    <div className="fixed bottom-4 right-4 z-40 pointer-events-none">
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-full shadow-lg text-xs font-semibold border"
        style={{
          background: saving ? '#FEF3C7' : '#dcfce7',
          color:      saving ? '#92400e' : '#166534',
          borderColor: saving ? '#fcd34d' : '#86efac',
        }}
      >
        {saving ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving {savingCount} change{savingCount === 1 ? '' : 's'}…
          </>
        ) : (
          <>
            <CheckCircle2 className="w-3 h-3" />
            Saved · {ago}
          </>
        )}
      </div>
    </div>
  )
}

function MobileCards({
  filtered, progress, saving, canEdit, canEditTracking, displayLocs, displayMonths, onSave, onOpenNotes, onActivityUpdate,
}: {
  filtered:      Activity[]
  progress:      ProgressMap
  saving:        Set<string>
  canEdit:       boolean
  canEditTracking: boolean
  displayLocs:   string[]
  displayMonths: string[]
  onSave:        (indicator: string, target: number | null | undefined, achieved: number | null | undefined) => void
  onOpenNotes:   (indicator: string) => void
  onActivityUpdate: (sn: number, patch: ActivityTrackingFields) => Promise<void>
}) {
  const [pickerLoc, setPickerLoc]     = useState(displayLocs[0])
  const [pickerMonth, setPickerMonth] = useState(displayMonths[0])
  const [openId, setOpenId]           = useState<number | null>(null)

  useEffect(() => {
    if (!displayLocs.includes(pickerLoc))     setPickerLoc(displayLocs[0])
    if (!displayMonths.includes(pickerMonth)) setPickerMonth(displayMonths[0])
  }, [displayLocs, displayMonths]) // eslint-disable-line

  return (
    <>
      <div className="flex gap-2 mb-2 sticky top-0 bg-gray-50 py-2 z-10">
        <select value={pickerLoc} onChange={e => setPickerLoc(e.target.value)}
          className="flex-1 rounded-lg border px-2 py-1.5 text-sm bg-white" style={{ borderColor: C.border }}>
          {displayLocs.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={pickerMonth} onChange={e => setPickerMonth(e.target.value)}
          className="flex-1 rounded-lg border px-2 py-1.5 text-sm bg-white" style={{ borderColor: C.border }}>
          {displayMonths.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {filtered.map(act => {
        const indicator = `${act.sn}|${pickerLoc}|${pickerMonth}`
        const locData = act.locations.find(l => l.location === pickerLoc)
        const base    = locData?.monthly[pickerMonth as keyof typeof locData.monthly] as MonthData | undefined
        const override = progress[indicator]
        const targetRaw   = override?.target   ?? base?.target   ?? null
        const achievedRaw = override?.achieved ?? base?.achieved ?? null
        const target   = targetRaw   == null ? null : toNum(targetRaw)
        const achieved = achievedRaw == null ? null : toNum(achievedRaw)
        const isOpen   = openId === act.sn

        return (
          <div key={act.sn} className="bg-white rounded-xl border p-3" style={{ borderColor: C.border }}>
            <button className="w-full flex items-center justify-between gap-2 text-left" onClick={() => setOpenId(isOpen ? null : act.sn)}>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: C.purple }}>
                  {act.status && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT_COLOR[act.status] }} title={act.status} />
                  )}
                  <span className="line-clamp-1">{act.sn}. {act.activity}</span>
                </div>
                {act.responsibility && <div className="text-[10px] text-gray-400 mt-0.5">By: {act.responsibility}</div>}
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {unitBadge(act) && (
                    <span
                      className="inline-block max-w-[200px] truncate align-bottom text-[9px] font-normal text-purple-700 bg-purple-50 border border-purple-100 rounded px-1.5 py-0.5"
                      title={unitBadge(act)!.full}
                    >
                      📏 {unitBadge(act)!.short}
                    </span>
                  )}
                  {alertFor(act) && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[9px] font-semibold rounded px-1.5 py-0.5"
                      style={{ background: alertFor(act) === 'Overdue' ? '#F5E1DD' : '#F5EBD3', color: alertFor(act) === 'Overdue' ? C.red : C.amber }}
                    >
                      <AlertTriangle className="w-2 h-2" /> {alertFor(act)}
                    </span>
                  )}
                </div>
              </div>
              {isOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
            </button>

            <div className="mt-2 flex items-center justify-center">
              <ProgressCell
                indicator={indicator}
                target={target}
                achieved={achieved}
                notes={override?.notes}
                updatedBy={override?.updatedBy}
                updatedAt={override?.updatedAt}
                canEdit={canEdit}
                saving={saving.has(indicator)}
                onSave={onSave}
                onOpenNotes={onOpenNotes}
              />
            </div>

            {isOpen && (
              <div className="mt-2 pt-2 border-t text-[11px] text-gray-500 space-y-1" style={{ borderColor: C.border }}>
                {act.description && (
                  <div><strong className="text-gray-700">Description:</strong> {act.description.replace(/ \| /g, ' • ')}</div>
                )}
                {override?.notes && (
                  <div className="bg-amber-50 rounded px-2 py-1 mt-1"><strong>📝 Note:</strong> {override.notes}</div>
                )}
                {override?.updatedBy && (
                  <div className="text-[10px] text-gray-400">Last edited by {override.updatedBy} {timeAgo(override.updatedAt)}</div>
                )}
                <ActivityTrackingPanel activity={act} canEdit={canEditTracking} onSave={onActivityUpdate} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
