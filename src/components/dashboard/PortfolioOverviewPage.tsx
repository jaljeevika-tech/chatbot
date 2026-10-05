// Portfolio Overview: card grid of the org's projects (action_plans rows) with
// health/compliance badges and budget/target progress.

import { useState, type ComponentType } from 'react'
import {
  FileSpreadsheet, Trash2, Pencil, RefreshCw, Loader2,
  Calendar, ChevronRight, CheckCircle2, Plus, AlertTriangle, XCircle,
  ShieldCheck, ShieldAlert, ShieldX, Building2, MapPin, Wallet,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { NewProjectModal } from './NewProjectModal'
import { EditProjectModal } from './EditProjectModal'
import { FF, ffStatusColors, statusForPct, type FFStatus } from '../../theme/colors'
import { ProgressBar } from '../ui/ProgressBar'
import { RadialProgress } from '../ui/RadialProgress'
import { useProjectContext, type PortfolioProject } from '../../context/ProjectContext'
import { useAuthContext } from '../../context/AuthContext'

const HEALTH_LABEL: Record<FFStatus, string> = { green: 'On Track', amber: 'At Risk', red: 'Critical' }
const COMPLIANCE_LABEL: Record<FFStatus, string> = { green: 'Compliant', amber: 'Attention Needed', red: 'Overdue' }
// Status is never colour-alone: every badge pairs its colour with an icon.
const HEALTH_ICON: Record<FFStatus, ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  green: CheckCircle2, amber: AlertTriangle, red: XCircle,
}
const COMPLIANCE_ICON: Record<FFStatus, ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  green: ShieldCheck, amber: ShieldAlert, red: ShieldX,
}

function fmtDate(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtINR(n: number | null): string {
  if (n == null) return ''
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`
  return `₹${n.toLocaleString('en-IN')}`
}

// Over 100% budget means overspending, so it has its own thresholds rather than statusForPct().
function budgetColor(pct: number): string {
  if (pct > 105) return FF.red
  if (pct > 90) return FF.amber
  return FF.purple
}

interface Props {
  onOpenProject: (projectKey: string) => void
}

export function PortfolioOverviewPage({ onOpenProject }: Props) {
  const { projects, loading, loadProjects } = useProjectContext()
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [showNewProject, setShowNewProject] = useState(false)
  const [editingProject, setEditingProject] = useState<PortfolioProject | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  async function deletePlan(p: PortfolioProject) {
    const purge = confirm(
      `Delete "${p.name}"?\n\n` +
      `Click OK to delete the plan structure only (cell data preserved for restore).\n` +
      `Click Cancel to abort.`
    )
    if (!purge) return
    try {
      const r = await apiFetch(`/api/action-plans/${p.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error('Delete failed')
      setToast(`Deleted "${p.name}"`)
      setTimeout(() => setToast(null), 3000)
      loadProjects()
    } catch (e: any) {
      alert('Delete failed: ' + (e.message || 'unknown'))
    }
  }

  const handleCreated = (plan: { id: string; name: string }) => {
    setShowNewProject(false)
    setToast(`Created "${plan.name}". Open its Action Plan tab to upload activities and targets.`)
    setTimeout(() => setToast(null), 6000)
    loadProjects()
  }

  const handleSaved = (plan: { id: string; name: string }) => {
    setEditingProject(null)
    setToast(`Saved changes to "${plan.name}"`)
    setTimeout(() => setToast(null), 3000)
    loadProjects()
  }

  return (
    <div className="space-y-4" style={{ fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>
            <FileSpreadsheet className="w-5 h-5" /> Portfolio Overview
          </h2>
          <p className="text-xs mt-0.5" style={{ color: FF.textMuted }}>
            Every project across the org — health, budget, target achievement and compliance at a glance.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => loadProjects()}
            className="w-9 h-9 rounded-lg flex items-center justify-center transition"
            style={{ border: `1px solid ${FF.border}` }}
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} style={{ color: FF.textMuted }} />
          </button>
          <button
            onClick={() => setShowNewProject(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: FF.purple }}
          >
            <Plus className="w-4 h-4" /> New Project
          </button>
        </div>
      </div>

      {toast && (
        <div className="rounded-xl px-3 py-2 flex items-center gap-2 text-sm" style={{ background: FF.greenBg, color: FF.green }}>
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {toast}
        </div>
      )}
      {loading && projects.length === 0 ? (
        <div className="flex items-center justify-center py-12" style={{ color: FF.textFaint }}>
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF' }}>
          <FileSpreadsheet className="w-12 h-12 mx-auto mb-3" style={{ color: FF.border }} />
          <p className="font-semibold" style={{ color: FF.tealDark }}>No projects yet</p>
          <p className="text-xs mt-1 mb-4" style={{ color: FF.textFaint }}>Create your first project to get started</p>
          <button
            onClick={() => setShowNewProject(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white"
            style={{ background: FF.purple }}
          >
            <Plus className="w-3.5 h-3.5" /> New Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" style={{ gap: 20 }}>
          {projects.map(p => {
            const health = ffStatusColors(p.health)
            const compliance = ffStatusColors(p.compliance)
            const HealthIcon = HEALTH_ICON[p.health]
            const ComplianceIcon = COMPLIANCE_ICON[p.compliance]
            const targetStatus = statusForPct(p.target)
            const targetColor = ffStatusColors(targetStatus).fg
            const budgetBarColor = budgetColor(p.budgetUsed)
            const overBudget = p.budgetUsed > 105
            return (
              <div
                key={p.id}
                onClick={() => onOpenProject(p.project_key)}
                className="group cursor-pointer"
                style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}
              >
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition" style={{ position: 'absolute', top: 14, right: 14 }}>
                  {isAdmin && (
                    <button
                      onClick={e => { e.stopPropagation(); setEditingProject(p) }}
                      className="w-6 h-6 rounded-md flex items-center justify-center"
                      style={{ color: FF.purple, background: FF.bg }}
                      title="Edit project"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); deletePlan(p) }}
                    className="w-6 h-6 rounded-md flex items-center justify-center"
                    style={{ color: FF.red, background: FF.bg }}
                    title="Delete plan"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 24 }}>
                  <div style={{ fontFamily: "'Newsreader',serif", fontSize: 17, fontWeight: 600, lineHeight: 1.3, color: FF.tealDark }}>{p.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600,
                        padding: '3px 8px 3px 6px', borderRadius: 20, background: health.bg, color: health.fg,
                      }}
                    >
                      <HealthIcon className="w-3 h-3" /> {HEALTH_LABEL[p.health]}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5, color: FF.textMuted }}>
                    <span className="flex items-center gap-1"><Building2 className="w-3 h-3 shrink-0" /> {p.donor || 'No donor set'}</span>
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3 shrink-0" /> {p.region || 'No region set'} · {p.locations?.length ?? 0} locations</span>
                  </div>
                </div>

                {/* Target achievement as a ring, budget as a bar for comparison */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 16, padding: '12px 4px',
                    borderTop: `1px solid ${FF.borderSoft}`, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <RadialProgress
                    pct={p.target}
                    color={targetColor}
                    trackColor={FF.borderSoft}
                    labelColor={FF.tealDark}
                    label="Target"
                  />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11.5, color: FF.textMuted }}>
                      <span className="flex items-center gap-1"><Wallet className="w-3 h-3" /> Budget utilised</span>
                      <span style={{ fontWeight: 700, color: budgetBarColor }}>{p.budgetUsed}%</span>
                    </div>
                    <ProgressBar pct={p.budgetUsed} color={budgetBarColor} height={8} />
                    <div style={{ fontSize: 10.5, color: FF.textFaint }}>
                      {p.budget ? `of ${fmtINR(p.budget)} budget` : 'No budget set'}
                      {overBudget && <span style={{ color: FF.red, fontWeight: 600 }}> · over budget</span>}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600,
                      padding: '3px 8px', borderRadius: 6, background: compliance.bg, color: compliance.fg,
                    }}
                  >
                    <ComplianceIcon className="w-3 h-3" /> {COMPLIANCE_LABEL[p.compliance]}
                  </span>
                  <span className="flex items-center gap-1" style={{ fontSize: 10.5, color: FF.textFaint }}>
                    <Calendar className="w-3 h-3" />
                    {p.end_date ? `Ends ${fmtDate(p.end_date)}` : (p.year ? `Plan year ${p.year}` : 'No end date')}
                  </span>
                </div>

                <p style={{ fontSize: 10.5, color: FF.purple, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                  Open project <ChevronRight className="w-3 h-3" />
                </p>
              </div>
            )
          })}

          <button
            onClick={() => setShowNewProject(true)}
            className="flex flex-col items-center justify-center transition"
            style={{ background: '#FFFFFF', border: `2px dashed ${FF.border}`, borderRadius: 12, minHeight: 220, color: FF.textFaint }}
          >
            <Plus className="w-6 h-6 mb-1" />
            <span className="text-xs font-semibold">New Project</span>
          </button>
        </div>
      )}

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={handleCreated}
        />
      )}
      {editingProject && (
        <EditProjectModal
          projectId={editingProject.id}
          onClose={() => setEditingProject(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
