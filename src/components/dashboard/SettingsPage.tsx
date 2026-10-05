import { useState, useEffect } from 'react'
import {
  Users, ShieldCheck, BookmarkCheck, Trash2, Loader2,
  FileText, Sparkles, Eye, X, Download, Copy, Check,
  Settings, ChevronRight, LayoutGrid, Receipt, Cpu,
  FolderOpen, Pencil, AlertTriangle, Tags, Image as ImageIcon, Upload,
} from 'lucide-react'
import { useReportContext } from '../../context/ReportContext'
import { useOrg } from '../../context/OrgContext'
import { useAuthContext } from '../../context/AuthContext'
import { UserManagementTab } from './UserManagementTab'
import { ContentHubSettings } from './ContentHubSettings'
import type { PermissionsMap } from './ContentHubSettings'
import { TabAccessSettings, DEFAULT_TAB_PERMISSIONS } from './TabAccessSettings'
import type { TabPermMap } from './TabAccessSettings'
import { ReportCategoriesSettings, DEFAULT_REPORT_CATEGORIES } from './ReportCategoriesSettings'
import { PromptManager } from '../superadmin/PromptManager'
import { BillingDashboard } from '../superadmin/BillingDashboard'
import { AILearningCenter } from './AILearningCenter'
import { CorrectnessDashboard } from '../admin/CorrectnessDashboard'
import { apiFetch } from '../../utils/apiFetch'
import type { ProjectDef } from '../../types/org'

type Section = 'users' | 'projects' | 'branding' | 'tab-access' | 'content-hub' | 'saved-reports' | 'ai-prompts' | 'billing' | 'ai-intelligence' | 'data-correctness' | 'report-categories'

const NAV_BASE: { id: Section; icon: typeof Users; label: string; sub: string; adminOnly?: boolean; superadminOnly?: boolean; color: string; bg: string }[] = [
  {
    id:    'users',
    icon:  Users,
    label: 'User Management',
    sub:   'Add, edit and manage team access',
    color: '#341272',
    bg:    '#FBF9F4',
  },
  {
    id:        'projects',
    icon:      FolderOpen,
    label:     'Projects',
    sub:       'Manage programme and project list for field reporting',
    adminOnly: true,
    color:     '#B45309',
    bg:        '#FEF9C3',
  },
  {
    id:        'branding',
    icon:      ImageIcon,
    label:     'Branding',
    sub:       'Upload your organisation’s logo — used on login, the sidebar and printed beneficiary ID cards',
    adminOnly: true,
    color:     '#0E7490',
    bg:        '#ECFEFF',
  },
  {
    id:    'tab-access',
    icon:  LayoutGrid,
    label: 'Tab Access',
    sub:   'Control which tabs each role can see',
    color: '#7C3AED',
    bg:    '#F5F3FF',
  },
  {
    id:    'content-hub',
    icon:  ShieldCheck,
    label: 'Content Hub',
    sub:   'Role permissions for AI features',
    color: '#1D4ED8',
    bg:    '#EFF6FF',
  },
  {
    id:        'report-categories',
    icon:      Tags,
    label:     'Report Categories',
    sub:       'Manage the Document Vault report category list',
    adminOnly: true,
    color:     '#7C3AED',
    bg:        '#F5F3FF',
  },
  {
    id:        'ai-prompts',
    icon:      Sparkles,
    label:     'AI Prompts',
    sub:       'Customise AI instructions for your org',
    adminOnly: true,
    color:     '#B45309',
    bg:        '#FFFBEB',
  },
  {
    id:    'saved-reports',
    icon:  BookmarkCheck,
    label: 'Saved Reports',
    sub:   'AI-generated reports saved by your team',
    color: '#15803D',
    bg:    '#F0FDF4',
  },
  {
    id:        'ai-intelligence',
    icon:      Cpu,
    label:     'AI Intelligence',
    sub:       'Local AI settings, learning candidates, provider health',
    adminOnly: true,
    color:     '#6D28D9',
    bg:        '#F5F3FF',
  },
  {
    id:        'data-correctness',
    icon:      AlertTriangle,
    label:     'Data Correctness',
    sub:       'Anomaly flags, reconciliation history, photo-text checks',
    adminOnly: true,
    color:     '#B91C1C',
    bg:        '#FEF2F2',
  },
  {
    id:             'billing',
    icon:           Receipt,
    label:          'Billing & Usage',
    sub:            'AI cost breakdown by org, service, and period',
    superadminOnly: true,
    color:          '#0F766E',
    bg:             '#F0FDFA',
  },
]

interface SavedReport {
  id: string
  title: string
  report_count: number
  created_by: string
  created_at: string
  // Content Hub "Generate Report for Other" attribution (null on legacy rows)
  subject_employee_ids?:   string[] | null
  subject_employee_names?: string[] | null
  generated_by_name?:      string | null
  report_kind?:            'self' | 'for_other' | 'team' | null
  quality_flag?:           string | null
}
interface SavedReportFull extends SavedReport { content: string }

function ReportViewerModal({ report, onClose }: { report: SavedReportFull; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(report.content).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = report.content; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
    })
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  function handleDownload() {
    const blob = new Blob([report.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${report.title.replace(/[^a-z0-9]/gi, '_')}.txt`
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden w-full sm:max-w-3xl" style={{ maxHeight: '90vh' }}>
        <div className="flex items-center gap-3 px-4 sm:px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-green-50 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-green-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-gray-900 text-sm truncate">{report.title}</h2>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {report.report_count} records &nbsp;·&nbsp;
              {new Date(report.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <button onClick={handleCopy} className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-100 transition">
              {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button onClick={handleDownload} className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-100 transition">
              <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Download</span>
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition text-gray-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
          <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans leading-relaxed">{report.content}</pre>
        </div>
      </div>
    </div>
  )
}

function SavedReportsSection() {
  const { user } = useAuthContext()
  const [reports, setReports] = useState<SavedReport[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [opening,  setOpening]  = useState<string | null>(null)
  const [viewer,   setViewer]   = useState<SavedReportFull | null>(null)
  // on_me: current user is a subject of the report; by_me: current user generated it.
  const [filter,   setFilter]   = useState<'all' | 'on_me' | 'by_me'>('all')
  // Set by the "Saved reports" links in the Performance panel/review modal.
  const [subject,  setSubject]  = useState<string | null>(() => {
    try { return sessionStorage.getItem('ff_saved_reports_filter_subject') } catch { return null }
  })
  useEffect(() => { try { sessionStorage.removeItem('ff_saved_reports_filter_subject') } catch { /* ignore */ } }, [])

  useEffect(() => {
    apiFetch('/api/saved-reports').then(r => r.json())
      .then(d => setReports(d.reports ?? []))
      .catch(() => {}).finally(() => setLoading(false))
  }, [])

  const myUid  = user?.uid
  const myName = (user?.name ?? '').toLowerCase().trim()
  const subjectKey = subject?.toLowerCase().trim()
  const visibleReports = reports.filter(r => {
    if (subjectKey && !r.subject_employee_names?.some(n => n.toLowerCase().trim() === subjectKey)) return false
    if (filter === 'all') return true
    if (filter === 'by_me') return r.created_by === myUid
    // Matched by name: subject UUIDs aren't sent to the client list for privacy.
    if (!Array.isArray(r.subject_employee_names) || !myName) return false
    return r.subject_employee_names.some(n => n.toLowerCase().trim() === myName)
  })

  async function handleOpen(id: string) {
    if (opening) return
    setOpening(id)
    try {
      const res = await apiFetch(`/api/saved-reports/${id}`)
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      setViewer(data)
    } catch (e: any) { alert('Failed to open: ' + (e?.message ?? 'Unknown error')) }
    finally { setOpening(null) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this saved report?')) return
    setDeleting(id)
    try { await apiFetch(`/api/saved-reports/${id}`, { method: 'DELETE' }); setReports(p => p.filter(r => r.id !== id)) }
    catch {} finally { setDeleting(null) }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-gray-300" /></div>

  if (!reports.length) return (
    <div className="text-center py-20 text-gray-400">
      <div className="text-5xl mb-3">🔖</div>
      <p className="font-semibold text-gray-500">No saved reports yet</p>
      <p className="text-sm mt-1 text-gray-400">Generate an AI report and click "Save" to store it here.</p>
    </div>
  )

  return (
    <>
      <div className="px-4 sm:px-6 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-gray-100">
        {([
          ['all',   `All (${reports.length})`],
          ['on_me', `On you (${reports.filter(r => Array.isArray(r.subject_employee_names) && myName && r.subject_employee_names.some(n => n.toLowerCase().trim() === myName)).length})`],
          ['by_me', `By you (${reports.filter(r => r.created_by === myUid).length})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`text-xs font-medium px-3 py-1 rounded-full border transition ${filter === key
              ? 'bg-purple-700 text-white border-purple-700'
              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
          >
            {label}
          </button>
        ))}
        {subject && (
          <button
            onClick={() => setSubject(null)}
            className="text-xs font-medium px-3 py-1 rounded-full border bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100"
            title="Clear this filter"
          >
            On {subject} ✕
          </button>
        )}
      </div>
      <div className="divide-y divide-gray-50">
        {visibleReports.length === 0 ? (
          <div className="text-center py-12 text-xs text-gray-400">
            No reports match this filter.
          </div>
        ) : visibleReports.map(r => (
          <div key={r.id} className="flex items-center gap-3 px-6 py-4 hover:bg-gray-50 transition group cursor-pointer" onClick={() => handleOpen(r.id)}>
            <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center shrink-0">
              {opening === r.id ? <Loader2 className="w-4 h-4 text-green-600 animate-spin" /> : <FileText className="w-4 h-4 text-green-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-semibold text-gray-900 truncate">{r.title}</p>
                {r.report_kind === 'for_other' && (
                  <span className="text-[9px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">Review</span>
                )}
                {r.report_kind === 'team' && (
                  <span className="text-[9px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">Team</span>
                )}
                {r.quality_flag === 'needs_review' && (
                  <span className="text-[9px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-700">Needs review</span>
                )}
              </div>
              {Array.isArray(r.subject_employee_names) && r.subject_employee_names.length > 0 && (
                <p className="text-[11px] text-purple-700 mt-0.5 truncate">
                  Report on <strong>{r.subject_employee_names.slice(0, 3).join(', ')}</strong>
                  {r.subject_employee_names.length > 3 && <span className="text-gray-500"> +{r.subject_employee_names.length - 3} more</span>}
                  {r.generated_by_name && <> &nbsp;·&nbsp; by {r.generated_by_name}</>}
                </p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">
                {r.report_count} records &nbsp;·&nbsp;
                {new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                {!r.generated_by_name && r.created_by && <> &nbsp;·&nbsp; {r.created_by}</>}
              </p>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
              <button onClick={e => { e.stopPropagation(); handleOpen(r.id) }} disabled={opening === r.id} className="p-1.5 rounded-lg hover:bg-green-50 text-gray-400 hover:text-green-600 disabled:opacity-30">
                <Eye className="w-4 h-4" />
              </button>
              <button onClick={e => { e.stopPropagation(); handleDelete(r.id) }} disabled={deleting === r.id} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 disabled:opacity-30">
                {deleting === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-300 opacity-0 group-hover:opacity-100 transition shrink-0" />
          </div>
        ))}
      </div>
      {viewer && <ReportViewerModal report={viewer} onClose={() => setViewer(null)} />}
    </>
  )
}

const PROJECT_COLORS = [
  '#f97316','#3b82f6','#8b5cf6','#14b8a6','#ec4899',
  '#10b981','#f59e0b','#6366f1','#dc2626','#0ea5e9',
]

interface ProjectFormProps {
  initial:  ProjectDef | null
  onSave:   (p: ProjectDef) => void
  onCancel: () => void
}
function ProjectForm({ initial, onSave, onCancel }: ProjectFormProps) {
  const [id,    setId]    = useState(initial?.id    ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [color, setColor] = useState(initial?.color ?? PROJECT_COLORS[0])

  function handleSave() {
    if (!id.trim() || !label.trim()) return
    onSave({ id: id.trim(), label: label.trim(), color })
  }

  return (
    <div className="p-4 rounded-xl border-2 border-amber-200 bg-amber-50 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-bold text-gray-600">
            Project ID <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={id}
            onChange={e => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            placeholder="e.g. dasara"
            disabled={!!initial}
            className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-amber-400 font-mono disabled:bg-gray-100"
          />
          <p className="text-[10px] text-gray-400 mt-0.5">Lowercase, no spaces — used internally</p>
        </div>
        <div>
          <label className="text-xs font-bold text-gray-600">
            Display Name <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Dasara Programme"
            className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-amber-400"
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-bold text-gray-600">Colour</label>
        <div className="flex flex-wrap gap-2 mt-1.5">
          {PROJECT_COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-6 h-6 rounded-full transition"
              style={{
                background:   c,
                outline:      color === c ? `2px solid #341272` : 'none',
                outlineOffset: '2px',
              }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!id.trim() || !label.trim()}
          className="flex-1 py-2 rounded-lg text-white text-sm font-bold transition disabled:opacity-50"
          style={{ background: '#B45309' }}
        >
          {initial ? 'Update Project' : 'Add Project'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 transition">
          Cancel
        </button>
      </div>
    </div>
  )
}

function ProjectsSection() {
  const { org, loadOrg, firebaseToken } = useOrg()
  const [projects, setProjects] = useState<ProjectDef[]>(org?.projects ?? [])
  const [editing,  setEditing]  = useState<ProjectDef | null>(null)
  const [adding,   setAdding]   = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [saved,    setSaved]    = useState(false)

  async function persist(updated: ProjectDef[]) {
    setSaving(true); setError(null)
    try {
      const res = await apiFetch('/api/org/metadata', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ projects: updated }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save')
      }
      setProjects(updated)
      await loadOrg(firebaseToken ?? '').catch(() => {})
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleAdd(p: ProjectDef) {
    if (projects.some(x => x.id === p.id)) { setError('A project with this ID already exists.'); return }
    persist([...projects, p])
    setAdding(false)
  }
  function handleUpdate(p: ProjectDef) {
    persist(projects.map(x => x.id === p.id ? p : x))
    setEditing(null)
  }
  function handleDelete(id: string) {
    if (!confirm("Remove this project? Existing field reports won't be affected.")) return
    persist(projects.filter(p => p.id !== id))
  }

  return (
    <div className="p-6 space-y-3">
      <p className="text-xs text-gray-400 -mt-1 mb-4">
        Projects appear in field report dropdowns and are used for filtering and assignment.
        Use the format <span className="font-mono">donor_programme_location</span> for the ID.
      </p>

      {projects.map(p => (
        <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-gray-200 transition">
          <div className="w-4 h-4 rounded-full shrink-0" style={{ background: p.color }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">{p.label}</p>
            <p className="text-[11px] text-gray-400 font-mono">{p.id}</p>
          </div>
          {saving ? null : (
            <>
              <button
                onClick={() => { setEditing(p); setAdding(false) }}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition"
                title="Edit project"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDelete(p.id)}
                className="p-1.5 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 transition"
                title="Remove project"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      ))}

      {projects.length === 0 && !adding && (
        <div className="text-center py-8 text-gray-400">
          <div className="text-4xl mb-2">📁</div>
          <p className="text-sm text-gray-500 font-medium">No projects yet</p>
          <p className="text-xs mt-1">Projects let workers tag field activities to specific programmes.</p>
        </div>
      )}

      {editing && !adding && (
        <ProjectForm initial={editing} onSave={handleUpdate} onCancel={() => setEditing(null)} />
      )}
      {adding && (
        <ProjectForm initial={null} onSave={handleAdd} onCancel={() => setAdding(false)} />
      )}

      {!adding && !editing && (
        <button
          onClick={() => setAdding(true)}
          disabled={saving}
          className="w-full py-2.5 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-amber-300 hover:text-amber-600 transition font-semibold disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : '+ '}
          {saving ? 'Saving…' : 'Add Project'}
        </button>
      )}

      {error && <p className="text-xs text-red-500 text-center mt-1">{error}</p>}
      {saved && !saving && <p className="text-xs text-green-600 text-center font-semibold mt-1">✓ Projects saved</p>}
    </div>
  )
}

// Branding: logo upload via PUT /api/org/branding, stored as a data: URI in
// metadata.branding.logo_url, which login, sidebar and beneficiary ID card already read.
const LOGO_MAX_BYTES = 1.5 * 1024 * 1024 // keep in sync with routes/org.routes.js MAX_LOGO_BYTES
const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

function BrandingSection() {
  const { org, loadOrg, firebaseToken } = useOrg()
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [saved,  setSaved]  = useState(false)

  const currentLogo = org?.branding.logo_url || null

  async function persist(logoUrl: string) {
    setSaving(true); setError(null)
    try {
      const res = await apiFetch('/api/org/branding', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ logo_url: logoUrl }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save logo')
      }
      await loadOrg(firebaseToken ?? '').catch(() => {})
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file next time
    if (!file) return
    setError(null)
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      setError('Please choose a PNG, JPEG, WEBP or GIF image.')
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError(`Logo is too large (max ${Math.round(LOGO_MAX_BYTES / 1024)}kb) — please use a smaller image.`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') persist(reader.result) }
    reader.onerror = () => setError('Could not read that file — please try again.')
    reader.readAsDataURL(file)
  }

  return (
    <div className="p-6 space-y-4">
      <p className="text-xs text-gray-400 -mt-1 mb-2">
        This logo appears on the login page, the dashboard sidebar and every printed beneficiary ID card.
        PNG, JPEG, WEBP or GIF, up to {Math.round(LOGO_MAX_BYTES / 1024)}kb.
      </p>

      <div className="flex items-center gap-5">
        <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center shrink-0 overflow-hidden bg-gray-50">
          {currentLogo
            ? <img src={currentLogo} alt="Current logo" className="w-full h-full object-contain" />
            : <ImageIcon className="w-7 h-7 text-gray-300" />}
        </div>

        <div className="flex flex-col gap-2">
          <label
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition disabled:opacity-50"
            style={{ background: '#0E7490', color: '#fff', opacity: saving ? 0.5 : 1, pointerEvents: saving ? 'none' : 'auto' }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {saving ? 'Uploading…' : currentLogo ? 'Change Logo' : 'Upload Logo'}
            <input type="file" accept={LOGO_ACCEPT} onChange={handleFile} disabled={saving} className="hidden" />
          </label>

          {currentLogo && (
            <button
              onClick={() => persist('')}
              disabled={saving}
              className="text-xs font-semibold text-gray-400 hover:text-red-500 transition disabled:opacity-50 text-left"
            >
              Remove logo (use default)
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      {saved && !saving && <p className="text-xs text-green-600 font-semibold mt-1">✓ Logo saved</p>}
    </div>
  )
}

export function SettingsPage() {
  // '#settings/saved-reports' deep link (PerformancePanelSection / PerformanceReviewModal)
  const [section, setSection] = useState<Section>(() => window.location.hash === '#settings/saved-reports' ? 'saved-reports' : 'users')
  useEffect(() => {
    if (window.location.hash === '#settings/saved-reports') history.replaceState(null, '', '#settings')
  }, [])
  const { reports } = useReportContext()
  const { org, firebaseToken } = useOrg()
  const { user } = useAuthContext()

  const isAdmin      = user?.role === 'admin' || user?.role === 'superadmin'
  const isSuperAdmin = user?.role === 'superadmin'
  const NAV = NAV_BASE.filter(n => {
    if (n.superadminOnly && !isSuperAdmin) return false
    if (n.adminOnly && !isAdmin)           return false
    return true
  })
  const activeNav = NAV.find(n => n.id === section)!

  const savedPerms: PermissionsMap = (org?.contentHubPermissions as PermissionsMap) ?? {}
  const savedTabPerms: TabPermMap  = (org?.tabPermissions as TabPermMap) ?? DEFAULT_TAB_PERMISSIONS
  const savedReportCategories: string[] = org?.reportCategories ?? DEFAULT_REPORT_CATEGORIES

  return (
    <div className="flex flex-col gap-5">

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0" style={{ background: '#FBF9F4' }}>
          <Settings className="w-5 h-5" style={{ color: '#341272' }} />
        </div>
        <div>
          <h1 className="text-lg font-black text-gray-900 leading-tight">Settings</h1>
          <p className="text-xs text-gray-400 mt-0.5">{activeNav?.sub}</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
        {NAV.map(({ id, icon: Icon, label, color, bg }) => {
          const active = section === id
          return (
            <button
              key={id}
              onClick={() => setSection(id)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold shrink-0 transition-all border"
              style={active
                ? { background: color, color: '#fff', borderColor: color, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }
                : { background: bg, color, borderColor: 'transparent' }
              }
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          )
        })}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100" style={{ background: activeNav?.bg + '66' }}>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: activeNav?.color }}>
            {activeNav && <activeNav.icon className="w-4 h-4 text-white" />}
          </div>
          <div>
            <p className="font-bold text-gray-900 text-sm">{activeNav?.label}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{activeNav?.sub}</p>
          </div>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: section === 'billing' ? 'calc(100vh - 200px)' : 'calc(100vh - 280px)' }}>

          {section === 'users' && (
            <div className="p-4">
              <UserManagementTab reports={reports} />
            </div>
          )}

          {section === 'projects' && isAdmin && (
            <ProjectsSection />
          )}

          {section === 'branding' && isAdmin && (
            <BrandingSection />
          )}

          {section === 'tab-access' && (
            <TabAccessSettings
              initialPermissions={savedTabPerms}
              token={firebaseToken ?? ''}
            />
          )}

          {section === 'content-hub' && (
            <ContentHubSettings
              initialPermissions={savedPerms}
              token={firebaseToken ?? ''}
              showBackButton={false}
              onBack={() => {}}
              onSaved={() => {}}
            />
          )}

          {section === 'report-categories' && (
            <ReportCategoriesSettings
              initialCategories={savedReportCategories}
              token={firebaseToken ?? ''}
            />
          )}

          {section === 'ai-prompts' && isAdmin && (
            <PromptManager />
          )}

          {section === 'saved-reports' && (
            <SavedReportsSection />
          )}

          {section === 'billing' && isSuperAdmin && (
            <BillingDashboard />
          )}

          {section === 'ai-intelligence' && isAdmin && (
            <AILearningCenter isSuperAdmin={isSuperAdmin} />
          )}

          {section === 'data-correctness' && isAdmin && (
            <CorrectnessDashboard />
          )}

        </div>
      </div>
    </div>
  )
}
