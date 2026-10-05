import { apiFetch } from '../../utils/apiFetch'
import { fileToBase64 } from '../../utils/fileToBase64'
import { useEffect, useRef, useState } from 'react'
import { Upload, Link, FileText, X, Loader2, File, BarChart2, ChevronDown, ChevronUp, Filter, CheckSquare, Square, PlusCircle, Database, Search, Target, Wallet, ClipboardList } from 'lucide-react'
import type { NotebookSource } from '../../types/notebook'
import type { DailyReport, ActiveFilters } from '../../types/report'
import { useProjectContext } from '../../context/ProjectContext'
import { jsonToReadableText } from '../../utils/notebookSourceText'

const C = {
  sidebar: '#341272',
  dark:    '#0E3A46',
  lime:    '#341272',
  bg:      '#F2F7F8',
  white:   '#FFFFFF',
}

interface Props {
  sources:         NotebookSource[]
  onAdd:           (src: NotebookSource) => void
  onRemove:        (id: string) => void
  baseReports:     DailyReport[]
  filteredReports: DailyReport[]
  filters:         ActiveFilters
}

function formatSize(chars: number) {
  if (chars < 1000) return `${chars} chars`
  return `${(chars / 1000).toFixed(1)}k chars`
}

// /mis-dashboard requires fy_start_year + month (400s otherwise) and optionally
// takes scope/scope_value; same params as MisDashboardPage.tsx.
const MIS_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'] as const
function defaultMisFYStartYear() {
  const now = new Date()
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1
}
function defaultMisMonth(): typeof MIS_MONTHS[number] {
  const short = new Date().toLocaleDateString('en-US', { month: 'short' }) as typeof MIS_MONTHS[number]
  return MIS_MONTHS.includes(short) ? short : 'Apr'
}

/** Per-project/area breakdown over every row, so totals stay accurate beyond the listed sample. */
function breakdownBy(rows: DailyReport[], key: 'project' | 'areaOfIntervention'): string {
  const map = new Map<string, { count: number; benef: number }>()
  for (const r of rows) {
    const k = String(r[key] || 'Unspecified')
    const n = parseInt(String(r.beneficiaries ?? 0), 10)
    const entry = map.get(k) || { count: 0, benef: 0 }
    entry.count++
    entry.benef += isNaN(n) ? 0 : n
    map.set(k, entry)
  }
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `${k} (${v.count} reports, ${v.benef.toLocaleString('en-IN')} beneficiaries)`)
    .join('; ')
}

/** Convert a set of DailyReport rows into structured plain text for the AI. */
function reportsToText(label: string, rows: DailyReport[]): string {
  // Totals use the full row set, never the capped sample below.
  const totalBenef = rows.reduce((s, r) => {
    const n = parseInt(String(r.beneficiaries ?? 0), 10)
    return s + (isNaN(n) ? 0 : n)
  }, 0)
  const sortedAsc = [...rows].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
  const dateRange = sortedAsc.length > 0
    ? `${String(sortedAsc[0].timestamp).slice(0, 10)} → ${String(sortedAsc[sortedAsc.length - 1].timestamp).slice(0, 10)}`
    : ''

  const header = [
    `DAILY FIELD REPORTS — ${label}`,
    `Total records: ${rows.length} | Total beneficiaries: ${totalBenef.toLocaleString('en-IN')} | Period: ${dateRange}`,
    `States: ${[...new Set(rows.map(r => r.state).filter(Boolean))].join(', ')}`,
    `By project: ${breakdownBy(rows, 'project')}`,
    `By area of intervention: ${breakdownBy(rows, 'areaOfIntervention')}`,
    '',
  ].join('\n')

  // Narrative sample spread evenly across the full date range (oldest and newest
  // always included) so cited incidents represent the whole period.
  const SAMPLE_SIZE = 300
  const sample = sortedAsc.length <= SAMPLE_SIZE
    ? sortedAsc
    : Array.from({ length: SAMPLE_SIZE }, (_, i) =>
        sortedAsc[Math.min(sortedAsc.length - 1, Math.round(i * (sortedAsc.length - 1) / (SAMPLE_SIZE - 1)))]
      )

  const body = sample.map((r, i) =>
    [
      `[${i + 1}] ${new Date(String(r.timestamp)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} | ${r.location}, ${r.state}`,
      `    Project: ${r.project || 'N/A'} | Area: ${r.areaOfIntervention || 'N/A'} | Beneficiaries: ${r.beneficiaries ?? 0}${r.name ? ` | Reported by: ${r.name}` : ''}`,
      `    ${String(r.description || '').slice(0, 350)}`,
    ].join('\n')
  ).join('\n\n')

  return header + body
}

function buildFilterSummary(filters: ActiveFilters): string {
  const parts: string[] = []
  if (filters.project.length)    parts.push(`Project: ${filters.project.slice(0, 2).join(', ')}${filters.project.length > 2 ? ` +${filters.project.length - 2}` : ''}`)
  if (filters.state.length)      parts.push(`State: ${filters.state.slice(0, 2).join(', ')}${filters.state.length > 2 ? ` +${filters.state.length - 2}` : ''}`)
  if (filters.area.length)       parts.push(`Area: ${filters.area.slice(0, 2).join(', ')}${filters.area.length > 2 ? ` +${filters.area.length - 2}` : ''}`)
  if (filters.workerName.length) parts.push(`Team Member: ${filters.workerName.slice(0, 2).join(', ')}${filters.workerName.length > 2 ? ` +${filters.workerName.length - 2}` : ''}`)
  if (filters.dateFrom || filters.dateTo) {
    const from = filters.dateFrom ? new Date(filters.dateFrom).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '…'
    const to   = filters.dateTo   ? new Date(filters.dateTo).toLocaleDateString('en-IN',   { day: 'numeric', month: 'short' }) : '…'
    parts.push(`${from} → ${to}`)
  }
  return parts.join(' • ')
}

export function SourcePanel({ sources, onAdd, onRemove, baseReports, filteredReports, filters }: Props) {
  const { projects, selectedProjectKey } = useProjectContext()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput]             = useState('')
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [showUrl, setShowUrl]               = useState(false)
  const [showReports, setShowReports]       = useState(false)
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set())

  // Project-data picker defaults to the app-wide project but is independent of it,
  // since Ask AI is usually opened standalone rather than under a project view.
  const [showProjectData, setShowProjectData]       = useState(false)
  const [loadingProjectData, setLoadingProjectData] = useState<string | null>(null)
  const [projectDataKey, setProjectDataKey]         = useState<string | null>(selectedProjectKey)
  useEffect(() => {
    if (projectDataKey === null && selectedProjectKey) setProjectDataKey(selectedProjectKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectKey])
  const selectedProject = projects.find(p => p.project_key === projectDataKey) || null

  const [misFyStartYear, setMisFyStartYear] = useState(defaultMisFYStartYear())
  const [misMonth, setMisMonth]             = useState<typeof MIS_MONTHS[number]>(defaultMisMonth())
  const [misGeography, setMisGeography]     = useState('')

  // Beneficiary profile search across all three types (org-wide, not project-scoped).
  const [showBeneficiary, setShowBeneficiary]         = useState(false)
  const [beneficiaryQuery, setBeneficiaryQuery]       = useState('')
  const [beneficiaryResults, setBeneficiaryResults]   = useState<{ uid: string; name: string; type: string }[]>([])
  const [searchingBeneficiary, setSearchingBeneficiary] = useState(false)

  const filtersActive = filteredReports.length < baseReports.length
  const filterSummary = filtersActive ? buildFilterSummary(filters) : ''

  const activeReports = filtersActive ? filteredReports : baseReports
  const projectGroups = (() => {
    const map = new Map<string, DailyReport[]>()
    for (const r of activeReports) {
      const key = r.project || 'Unassigned'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  })()

  function addReportSource(label: string, rows: DailyReport[]) {
    const content   = reportsToText(label, rows)
    // Drive photo URLs from report attachments, each paired with its row's description
    // so photos can be matched to the relevant slide/segment.
    const imageUrls: string[] = []
    const imageCaptions: Record<string, string> = {}
    const imageMeta: Record<string, { date?: string; place?: string }> = {}
    const seen = new Set<string>()
    // Bounded: far more than any output uses (Video Overview takes 16), and it
    // keeps the source's save request well inside the server's body limit.
    const MAX_PHOTOS = 100
    for (const r of rows) {
      if (imageUrls.length >= MAX_PHOTOS) break
      if (!r.attachmentUrl || seen.has(r.attachmentUrl)) continue
      seen.add(r.attachmentUrl)
      imageUrls.push(r.attachmentUrl)
      if (r.description) imageCaptions[r.attachmentUrl] = String(r.description).slice(0, 200)
      // Provenance for the documentary's on-screen photo label.
      const date = r.timestamp ? String(r.timestamp).slice(0, 10) : ''
      const place = [r.location, r.state].filter(Boolean).join(', ')
      if (date || place) imageMeta[r.attachmentUrl] = { ...(date ? { date } : {}), ...(place ? { place } : {}) }
    }
    onAdd({
      id:        crypto.randomUUID(),
      name:      `Reports: ${label}`,
      type:      'txt',
      content,
      charCount: content.length,
      addedAt:   new Date().toISOString(),
      ...(imageUrls.length > 0 ? { imageUrls, imageCaptions, imageMeta } : {}),
    })
    setShowReports(false)
    setSelectedProjects(new Set())
  }

  function addSelectedProjects() {
    if (selectedProjects.size === 0) return
    const rows = activeReports.filter(r => selectedProjects.has(r.project || 'Unassigned'))
    const label = [...selectedProjects].join(', ')
    addReportSource(label, rows)
  }

  function toggleProject(project: string) {
    setSelectedProjects(prev => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
  }

  const PROJECT_DATA_LABELS: Record<'mis' | 'target' | 'financial' | 'plan', string> = {
    mis: 'MIS Indicators', target: 'Annual Targets', financial: 'Financials', plan: 'Action Plan',
  }

  /** Adds one project-scoped data type as a source. `selectedProject.id` is the
   *  action_plan_id (a project IS an action_plans row); MIS is keyed by project_key. */
  async function addProjectDataSource(kind: 'mis' | 'target' | 'financial' | 'plan') {
    if (!selectedProject) return
    setLoadingProjectData(kind)
    setError(null)
    try {
      let content = ''
      let nameSuffix = ''
      if (kind === 'mis') {
        const params = new URLSearchParams({ fy_start_year: String(misFyStartYear), month: misMonth })
        if (misGeography.trim()) { params.set('scope', 'geography'); params.set('scope_value', misGeography.trim()) }
        const periodLabel = `FY ${misFyStartYear}-${String((misFyStartYear + 1) % 100).padStart(2, '0')}, ${misMonth}${misGeography.trim() ? `, ${misGeography.trim()}` : ''}`
        nameSuffix = ` (${periodLabel})`
        const [dashRes, tabsRes] = await Promise.all([
          apiFetch(`/api/projects/${selectedProject.project_key}/mis-dashboard?${params.toString()}`),
          apiFetch(`/api/projects/${selectedProject.project_key}/mis-tabs-dashboard`),
        ])
        const [dash, tabs] = await Promise.all([dashRes.json(), tabsRes.json()])
        content = [
          jsonToReadableText(`MIS DASHBOARD — ${selectedProject.name} (${periodLabel})`, dash),
          jsonToReadableText(`MIS CATEGORY SUMMARY — ${selectedProject.name}`, tabs),
        ].join('\n\n')
      } else if (kind === 'target') {
        const res = await apiFetch(`/api/action-plans/${selectedProject.id}/annual-progress/latest`)
        content = jsonToReadableText(`ANNUAL TARGETS & PROGRESS — ${selectedProject.name}`, await res.json())
      } else if (kind === 'financial') {
        const res = await apiFetch(`/api/action-plans/${selectedProject.id}/budget-utilisation`)
        content = jsonToReadableText(`BUDGET & FINANCIALS — ${selectedProject.name}`, await res.json())
      } else {
        const res = await apiFetch(`/api/action-plans/${selectedProject.id}`)
        content = jsonToReadableText(`ACTION PLAN — ${selectedProject.name}`, await res.json())
      }
      if (!content.trim()) { setError('No data returned for this project'); return }
      onAdd({
        id:        crypto.randomUUID(),
        name:      `${PROJECT_DATA_LABELS[kind]}: ${selectedProject.name}${nameSuffix}`,
        type:      'txt',
        content,
        charCount: content.length,
        addedAt:   new Date().toISOString(),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project data')
    } finally {
      setLoadingProjectData(null)
    }
  }

  async function searchBeneficiaries() {
    const q = beneficiaryQuery.trim()
    if (!q) return
    setSearchingBeneficiary(true)
    setError(null)
    setBeneficiaryResults([])
    try {
      const qs = `search=${encodeURIComponent(q)}&page=0`
      const [ibRes, meRes, colRes] = await Promise.all([
        apiFetch(`/api/individual-beneficiaries?${qs}`),
        apiFetch(`/api/micro-entrepreneurs?${qs}`),
        apiFetch(`/api/collectives?${qs}`),
      ])
      const [ib, me, col] = await Promise.all([ibRes.json(), meRes.json(), colRes.json()])
      type Row = { uid: string; name?: string }
      const toResult = (r: Row, type: string) => ({ uid: r.uid, name: r.name || r.uid, type })
      setBeneficiaryResults([
        ...(ib.rows || []).slice(0, 10).map((r: Row) => toResult(r, 'Individual')),
        ...(me.rows || []).slice(0, 10).map((r: Row) => toResult(r, 'Micro-Entrepreneur')),
        ...(col.rows || []).slice(0, 10).map((r: Row) => toResult(r, 'Collective')),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearchingBeneficiary(false)
    }
  }

  async function addBeneficiaryProfile(uid: string, name: string) {
    setError(null)
    try {
      const res  = await apiFetch(`/api/beneficiary-profile/${uid}`)
      const data = await res.json()
      if (data.error) { setError(data.error); return }
      const content = jsonToReadableText(`BENEFICIARY PROFILE — ${name} (${uid})`, data)
      onAdd({
        id:        crypto.randomUUID(),
        name:      `Beneficiary: ${name}`,
        type:      'txt',
        content,
        charCount: content.length,
        addedAt:   new Date().toISOString(),
      })
      setShowBeneficiary(false)
      setBeneficiaryQuery('')
      setBeneficiaryResults([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profile')
    }
  }

  // Extensions the server can extract text from (lib/extractDocumentText.js);
  // anything else falls back to a client-side UTF-8 read or is rejected.
  const OFFICE_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'csv', 'md', 'rtf'])
  /** Matches MAX_UPLOAD_BYTES in routes/notebook.routes.js. */
  const MAX_UPLOAD_MB = 20

  /** Process multiple files sequentially; every failure is reported, not just the last. */
  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    setError(null)
    setUploadProgress({ done: 0, total: list.length })
    const errors: string[] = []
    const fail = (msg: string) => { errors.push(msg); setError(errors.join(' · ')) }

    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      try {
        const ext = file.name.split('.').pop()?.toLowerCase()
        if (ext === 'txt') {
          const text = await file.text()
          onAdd({
            id:        crypto.randomUUID(),
            name:      file.name,
            type:      'txt',
            content:   text.slice(0, 200_000),
            charCount: text.length,
            addedAt:   new Date().toISOString(),
          })
        } else if (ext && OFFICE_EXTENSIONS.has(ext)) {
          if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            fail(`${file.name}: too large (${(file.size / 1024 / 1024).toFixed(1)} MB — max ${MAX_UPLOAD_MB} MB)`)
          } else {
            const b64 = await fileToBase64(file)
            const res  = await apiFetch('/api/notebook/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, type: ext, dataBase64: b64 }),
            })
            // A gateway/size error comes back as HTML, not JSON — say what happened instead of "Unexpected token <".
            const data = await res.json().catch(() => ({ error: res.status === 413 ? `too large (max ${MAX_UPLOAD_MB} MB)` : `upload failed (HTTP ${res.status})` }))
            if (data.error || !res.ok) fail(`${file.name}: ${data.error || `upload failed (HTTP ${res.status})`}`)
            else onAdd({ ...data, addedAt: new Date().toISOString() })
          }
        } else {
          fail(`${file.name}: unsupported format (use PDF, Word, PowerPoint, Excel, OpenDocument, CSV, Markdown, RTF or TXT)`)
        }
      } catch (e) {
        fail(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`)
      }
      setUploadProgress({ done: i + 1, total: list.length })
    }

    setUploadProgress(null)
  }

  async function handleUrl() {
    const url = urlInput.trim()
    if (!url) return
    setError(null)
    setUploadProgress({ done: 0, total: 1 })
    try {
      const res  = await apiFetch('/api/notebook/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (data.error) { setError(data.error); return }
      onAdd({ ...data, addedAt: new Date().toISOString() })
      setUrlInput('')
      setShowUrl(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed')
    } finally {
      setUploadProgress(null)
    }
  }

  const isLoading    = uploadProgress !== null
  const totalChars   = sources.reduce((s, src) => s + src.charCount, 0)
  const selectedRows = activeReports.filter(r => selectedProjects.has(r.project || 'Unassigned'))

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-black" style={{ color: C.dark }}>Sources</h2>
            <p className="text-[11px] mt-0.5" style={{ color: '#86A0A5' }}>
              {sources.length} source{sources.length !== 1 ? 's' : ''} · {formatSize(totalChars)}
            </p>
          </div>
        </div>

        <div className="flex gap-2 mb-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{ background: C.dark, color: C.white }}
          >
            {isLoading && uploadProgress && uploadProgress.total > 0
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{uploadProgress.done}/{uploadProgress.total}</>
              : <><Upload className="w-3.5 h-3.5" />Upload</>
            }
          </button>
          <button
            onClick={() => { setShowUrl(v => !v); setShowReports(false); setShowProjectData(false); setShowBeneficiary(false) }}
            disabled={isLoading}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{ background: C.bg, color: C.dark, border: `1.5px solid #D9E6E8` }}
          >
            <Link className="w-3.5 h-3.5" />
            URL
          </button>
        </div>

        {baseReports.length > 0 && (
          <button
            onClick={() => { setShowReports(v => !v); setShowUrl(false); setShowProjectData(false); setShowBeneficiary(false); setSelectedProjects(new Set()) }}
            className="w-full flex items-center justify-between gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{
              background: showReports ? C.sidebar : C.lime + '22',
              color:      showReports ? C.white   : C.sidebar,
              border:     `1.5px solid ${showReports ? C.sidebar : C.lime}`,
            }}
          >
            <span className="flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5" />
              Use Daily Reports
            </span>
            <span className="flex items-center gap-1" style={{ color: showReports ? 'rgba(255,255,255,0.6)' : '#86A0A5' }}>
              {filtersActive && <Filter className="w-2.5 h-2.5" />}
              <span className="font-bold">{filtersActive ? filteredReports.length : baseReports.length}</span> records
              {showReports ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
            </span>
          </button>
        )}

        {showReports && baseReports.length > 0 && (
          <div className="mt-2 rounded-xl overflow-hidden border" style={{ borderColor: '#D9E6E8', background: C.white }}>

            {filtersActive && (
              <button
                onClick={() => addReportSource('Current View', filteredReports)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold hover:opacity-90 transition border-b"
                style={{ background: C.sidebar, color: C.white, borderColor: '#D9E6E8' }}
              >
                <div className="flex flex-col items-start gap-0.5 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <Filter className="w-3 h-3 shrink-0" />
                    Current View
                  </span>
                  {filterSummary && (
                    <span className="text-[10px] font-normal truncate max-w-full" style={{ color: 'rgba(255,255,255,0.65)' }}>
                      {filterSummary}
                    </span>
                  )}
                </div>
                <span
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ml-2"
                  style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.85)' }}
                >
                  {filteredReports.length}
                </span>
              </button>
            )}

            <button
              onClick={() => addReportSource('All My Reports', baseReports)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold hover:opacity-80 transition border-b"
              style={{
                background: filtersActive ? C.bg : C.dark,
                color:      filtersActive ? C.dark : C.white,
                borderColor: '#D9E6E8',
              }}
            >
              <span>All My Reports</span>
              <span
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                style={{
                  background: filtersActive ? '#D9E6E8' : 'rgba(255,255,255,0.15)',
                  color:      filtersActive ? '#5C7378'  : 'rgba(255,255,255,0.8)',
                }}
              >
                {baseReports.length}
              </span>
            </button>

            <div className="px-3 py-1.5 flex items-center justify-between" style={{ borderBottom: '1px solid #E4F0F1' }}>
              <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: '#86A0A5' }}>
                Select projects
              </span>
              {selectedProjects.size > 0 && (
                <button
                  onClick={() => setSelectedProjects(new Set())}
                  className="text-[10px]"
                  style={{ color: '#86A0A5' }}
                >
                  Clear
                </button>
              )}
            </div>

            <div className="max-h-44 overflow-auto">
              {projectGroups.map(([project, rows]) => {
                const checked = selectedProjects.has(project)
                return (
                  <button
                    key={project}
                    onClick={() => toggleProject(project)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-semibold hover:opacity-80 transition border-b last:border-0"
                    style={{ borderColor: '#E4F0F1', color: C.dark, textAlign: 'left', background: checked ? C.lime + '18' : 'transparent' }}
                  >
                    {checked
                      ? <CheckSquare className="w-3.5 h-3.5 shrink-0" style={{ color: C.sidebar }} />
                      : <Square      className="w-3.5 h-3.5 shrink-0" style={{ color: '#D1D5DB' }} />}
                    <span className="flex-1 truncate">{project}</span>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                      style={{ background: checked ? C.lime + '33' : C.bg, color: checked ? C.sidebar : '#5C7378' }}
                    >
                      {rows.length}
                    </span>
                  </button>
                )
              })}
            </div>

            {selectedProjects.size > 0 && (
              <div className="p-2 border-t" style={{ borderColor: '#D9E6E8' }}>
                <button
                  onClick={addSelectedProjects}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all"
                  style={{ background: C.sidebar, color: C.white }}
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  Add {selectedProjects.size} project{selectedProjects.size > 1 ? 's' : ''} ({selectedRows.length} records)
                </button>
              </div>
            )}
          </div>
        )}

        {/* Project data: MIS / Annual Targets / Financials / Action Plan */}
        {projects.length > 0 && (
          <button
            onClick={() => { setShowProjectData(v => !v); setShowReports(false); setShowUrl(false); setShowBeneficiary(false) }}
            className="w-full flex items-center justify-between gap-1.5 px-3 py-2 mt-2 rounded-xl text-xs font-semibold transition-all"
            style={{
              background: showProjectData ? C.sidebar : C.lime + '22',
              color:      showProjectData ? C.white   : C.sidebar,
              border:     `1.5px solid ${showProjectData ? C.sidebar : C.lime}`,
            }}
          >
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5" />
              Use Project Data
            </span>
            <span className="flex items-center gap-1 min-w-0" style={{ color: showProjectData ? 'rgba(255,255,255,0.6)' : '#86A0A5' }}>
              <span className="truncate max-w-[110px]">{selectedProject?.name ?? 'Select a project'}</span>
              {showProjectData ? <ChevronUp className="w-3 h-3 ml-0.5 shrink-0" /> : <ChevronDown className="w-3 h-3 ml-0.5 shrink-0" />}
            </span>
          </button>
        )}

        {showProjectData && projects.length > 0 && (
          <div className="mt-2 rounded-xl overflow-hidden border p-2 flex flex-col gap-1.5" style={{ borderColor: '#D9E6E8', background: C.white }}>
            <select
              value={projectDataKey ?? ''}
              onChange={e => setProjectDataKey(e.target.value || null)}
              className="w-full text-xs px-3 py-2 rounded-lg border outline-none font-semibold"
              style={{ borderColor: '#D9E6E8', background: C.bg, color: C.dark }}
            >
              <option value="" disabled>Choose a project…</option>
              {projects.map(p => (
                <option key={p.project_key} value={p.project_key}>{p.name}</option>
              ))}
            </select>

            {/* FY/month/geography filters; only the MIS button uses these */}
            <div className="rounded-lg p-2 flex flex-col gap-1.5" style={{ background: C.bg }}>
              <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: '#86A0A5' }}>
                MIS Indicators — date &amp; location
              </span>
              <div className="flex gap-1.5">
                <select
                  value={misFyStartYear}
                  onChange={e => setMisFyStartYear(Number(e.target.value))}
                  className="flex-1 text-[11px] px-2 py-1.5 rounded-lg border outline-none"
                  style={{ borderColor: '#D9E6E8', background: C.white, color: C.dark }}
                >
                  {[misFyStartYear - 1, misFyStartYear, misFyStartYear + 1].map(y => (
                    <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>
                  ))}
                </select>
                <select
                  value={misMonth}
                  onChange={e => setMisMonth(e.target.value as typeof MIS_MONTHS[number])}
                  className="flex-1 text-[11px] px-2 py-1.5 rounded-lg border outline-none"
                  style={{ borderColor: '#D9E6E8', background: C.white, color: C.dark }}
                >
                  {MIS_MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <input
                value={misGeography}
                onChange={e => setMisGeography(e.target.value)}
                placeholder="Geography (e.g. a block/district) — optional"
                className="w-full text-[11px] px-2 py-1.5 rounded-lg border outline-none"
                style={{ borderColor: '#D9E6E8', background: C.white, color: C.dark }}
              />
            </div>

            {([
              { key: 'mis' as const,       label: 'MIS Indicators', icon: BarChart2 },
              { key: 'target' as const,    label: 'Annual Targets', icon: Target },
              { key: 'financial' as const, label: 'Financials',     icon: Wallet },
              { key: 'plan' as const,      label: 'Action Plan',    icon: ClipboardList },
            ]).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => addProjectDataSource(key)}
                disabled={loadingProjectData !== null || !selectedProject}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-left hover:opacity-80 transition disabled:opacity-50"
                style={{ background: C.bg, color: C.dark }}
              >
                {loadingProjectData === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" style={{ color: C.sidebar }} />}
                {label}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => { setShowBeneficiary(v => !v); setShowReports(false); setShowUrl(false); setShowProjectData(false) }}
          className="w-full flex items-center justify-between gap-1.5 px-3 py-2 mt-2 rounded-xl text-xs font-semibold transition-all"
          style={{
            background: showBeneficiary ? C.sidebar : C.lime + '22',
            color:      showBeneficiary ? C.white   : C.sidebar,
            border:     `1.5px solid ${showBeneficiary ? C.sidebar : C.lime}`,
          }}
        >
          <span className="flex items-center gap-1.5">
            <Search className="w-3.5 h-3.5" />
            Add Beneficiary Profile
          </span>
          {showBeneficiary ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        {showBeneficiary && (
          <div className="mt-2 rounded-xl overflow-hidden border p-2" style={{ borderColor: '#D9E6E8', background: C.white }}>
            <div className="flex gap-2">
              <input
                value={beneficiaryQuery}
                onChange={e => setBeneficiaryQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchBeneficiaries()}
                placeholder="Search by name, UID, or village…"
                className="flex-1 text-xs px-3 py-2 rounded-xl border outline-none"
                style={{ borderColor: '#D9E6E8', background: C.bg }}
              />
              <button
                onClick={searchBeneficiaries}
                disabled={searchingBeneficiary || !beneficiaryQuery.trim()}
                className="px-3 py-2 rounded-xl text-xs font-semibold"
                style={{ background: C.sidebar, color: C.white }}
              >
                {searchingBeneficiary ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Search'}
              </button>
            </div>
            {beneficiaryResults.length > 0 && (
              <div className="mt-2 max-h-44 overflow-auto flex flex-col gap-1">
                {beneficiaryResults.map(r => (
                  <button
                    key={r.uid}
                    onClick={() => addBeneficiaryProfile(r.uid, r.name)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-left hover:opacity-80 transition"
                    style={{ background: C.bg, color: C.dark }}
                  >
                    <span className="truncate">{r.name}</span>
                    <span className="text-[10px] shrink-0" style={{ color: '#86A0A5' }}>{r.type} · {r.uid}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showUrl && (
          <div className="mt-2 flex gap-2">
            <input
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUrl()}
              placeholder="https://..."
              className="flex-1 text-xs px-3 py-2 rounded-xl border outline-none"
              style={{ borderColor: '#D9E6E8', background: C.bg }}
            />
            <button
              onClick={handleUrl}
              disabled={isLoading || !urlInput.trim()}
              className="px-3 py-2 rounded-xl text-xs font-semibold"
              style={{ background: C.sidebar, color: C.white }}
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add'}
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.docx,.pptx,.xlsx,.odt,.ods,.odp,.csv,.md,.rtf"
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {sources.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: C.bg }}>
              <FileText className="w-5 h-5" style={{ color: C.lime }} />
            </div>
            <div>
              <p className="text-xs font-semibold" style={{ color: C.dark }}>No sources yet</p>
              <p className="text-[11px] mt-1" style={{ color: '#86A0A5' }}>
                Upload files, add a URL,<br />or use your Daily Reports
              </p>
            </div>
          </div>
        )}

        {sources.map(src => (
          <div
            key={src.id}
            className="flex items-start gap-2.5 p-3 rounded-xl group"
            style={{ background: C.white }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
              style={{ background: src.name.startsWith('Reports:') ? C.lime + '22' : C.bg }}
            >
              {src.name.startsWith('Reports:')
                ? <BarChart2 className="w-3.5 h-3.5" style={{ color: C.sidebar }} />
                : src.type === 'url'
                  ? <Link className="w-3.5 h-3.5" style={{ color: C.sidebar }} />
                  : <File  className="w-3.5 h-3.5" style={{ color: C.sidebar }} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate" style={{ color: C.dark }}>{src.name}</p>
              <p className="text-[11px] mt-0.5" style={{ color: '#86A0A5' }}>
                {src.type.toUpperCase()} · {formatSize(src.charCount)}
              </p>
            </div>
            <button
              onClick={() => onRemove(src.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-red-50"
            >
              <X className="w-3.5 h-3.5 text-red-400" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
