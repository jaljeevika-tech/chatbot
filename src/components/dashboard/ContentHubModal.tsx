import { useState, useEffect } from 'react'
import { X, FileText, Megaphone, Sparkles, Search, Settings, Pencil, RotateCcw, Loader2, Check } from 'lucide-react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import type { DailyReport, ActiveFilters } from '../../types/report'
import type { AuthUser } from '../../context/AuthContext'
import { useLanguage } from '../../context/LanguageContext'
import { useOrg } from '../../context/OrgContext'
import { ContentHubSettings } from './ContentHubSettings'
import type { ContentTypeInfo } from './ContentHubSettings'
import { DEFAULT_PERMISSIONS, getContentTypes, type ContentType, type PermissionsMap } from './contentHubTypes'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { StatusBadge } from '../ui/StatusBadge'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'

const SOCIAL_PLATFORMS = [
  { id: 'instagram', label: 'Instagram', emoji: '📸', color: '#e1306c', bg: '#fdf2f8' },
  { id: 'facebook',  label: 'Facebook',  emoji: '👥', color: '#1877f2', bg: '#eff6ff' },
  { id: 'linkedin',  label: 'LinkedIn',  emoji: '💼', color: '#0a66c2', bg: '#eff6ff' },
  { id: 'twitter',   label: 'Twitter/X', emoji: '🐦', color: '#000000', bg: '#f9fafb' },
]

interface Props {
  user: AuthUser | null
  filteredReports: DailyReport[]
  baseReports: DailyReport[]
  allReports: DailyReport[]
  filters: ActiveFilters
  // `options` carries subject identity for "Generate Report for Other".
  onOpenReport: (
    title: string,
    reports: DailyReport[],
    instruction: string,
    options?: {
      subjects?: { id?: string; name: string; phone?: string }[]
      kind?: 'self' | 'for_other' | 'team'
      pendingSubjectPick?: boolean
      // Overrides the dashboard's global FilterBar state for the report's title/context.
      filters?: ActiveFilters
      // Output language of the report, distinct from the site's UI language.
      language?: string
    },
  ) => void
  onOpenSocial: (scope: 'project' | 'organization', scopeName: string, reports: DailyReport[], platform?: string) => void
  // Per-tile picker routes. Each falls back to onOpenReport when undefined.
  onOpenStoryFinder?: () => void
  onOpenProjectReportPicker?: (title: string, instruction: string) => void
  onOpenCaseStudyPicker?: (title: string, instruction: string) => void
  onOpenOrgReportPicker?: (title: string, instruction: string) => void
  onOpenSelfReportPicker?: (title: string, instruction: string) => void
  onOpenTeamReportPicker?: (title: string, instruction: string) => void
  onOpenImpactReportPicker?: (title: string, instruction: string) => void
  // Generic date/project/location/language picker for Content & Comms tiles
  // that don't have a bespoke one.
  onOpenContentPicker?: (title: string, instruction: string) => void
  // Ignored in tab mode.
  onClose?: () => void
  // 'modal' (default) renders a fixed-overlay sheet; 'tab' renders inline.
  mode?: 'modal' | 'tab'
}

export function ContentHubModal({
  user, filteredReports, baseReports, allReports,
  filters,
  onOpenReport, onOpenSocial, onOpenStoryFinder, onOpenProjectReportPicker, onOpenCaseStudyPicker, onOpenOrgReportPicker, onOpenSelfReportPicker,
  onOpenTeamReportPicker, onOpenImpactReportPicker, onOpenContentPicker,
  onClose: _onCloseRaw,
  mode = 'modal',
}: Props) {
  const onClose = _onCloseRaw ?? (() => {})
  const { t } = useLanguage()
  useEscapeKey(onClose)
  const { org, firebaseToken } = useOrg()
  const role = user?.role ?? 'employee'
  const effectiveRole = role === 'superadmin' ? 'admin' : role
  const isAdmin = role === 'admin' || role === 'superadmin'
  const CONTENT_TYPES = getContentTypes(t)

  // Social posts should be scoped to whatever the user is actually looking at —
  // a single active project filter, not always "the whole organization".
  const socialScope: 'project' | 'organization' = filters?.project?.length === 1 ? 'project' : 'organization'
  const socialScopeName = socialScope === 'project' ? filters.project[0] : 'Our Organization'

  const [overridePerms, setOverridePerms] = useState<PermissionsMap | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [search, setSearch] = useState('')

  // Per-user content hub override (if admin set a custom list for this user)
  const _normPhone = (p: string) => {
    const c = String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
    return c.length === 10 ? '91' + c : c
  }
  const userChOverrides = !isAdmin
    ? (org?.userContentHubPermissions?.[_normPhone(user?.phone ?? '')] as string[] | undefined)
    : undefined

  const activePerms: PermissionsMap = overridePerms ?? (org?.contentHubPermissions as PermissionsMap ?? {})

  // Customised ch_* prompts only, keyed by prompt id
  const [promptMap, setPromptMap] = useState<Record<string, string>>({})
  const [editingId,      setEditingId]      = useState<string | null>(null)
  const [editingLabel,   setEditingLabel]   = useState('')
  const [editingDefault, setEditingDefault] = useState('')
  const [editText,       setEditText]       = useState('')
  const [isSaving,       setIsSaving]       = useState(false)
  const [promptSaved,    setPromptSaved]    = useState(false)
  const [promptReset,    setPromptReset]    = useState(false)
  const [saveError,      setSaveError]      = useState<string | null>(null)

  useEffect(() => {
    if (!firebaseToken) return
    apiFetch('/api/prompts')
      .then(r => r.json())
      .then(data => {
        const map: Record<string, string> = {}
        for (const p of (data.prompts ?? [])) {
          if (p.id.startsWith('ch_') && p.customText) {
            map[p.id] = p.customText
          }
        }
        setPromptMap(map)
      })
      .catch(() => {})
  }, [firebaseToken])

  // Pre-warm the NLP analysis cache so it's ready by the time the user clicks Generate.
  useEffect(() => {
    if (!firebaseToken || filteredReports.length === 0) return
    apiFetch('/api/prewarm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ reports: filteredReports, instruction: '' }),
    }).catch(() => {})
  }, [firebaseToken, filteredReports.length])

  function getInstruction(ct: ContentType): string {
    return promptMap['ch_' + ct.id] ?? ct.instruction
  }

  function openEditor(ct: ContentType, e: React.MouseEvent) {
    e.stopPropagation()
    const promptId = 'ch_' + ct.id
    setEditingId(promptId)
    setEditingLabel(ct.title)
    setEditingDefault(ct.instruction)
    setEditText(promptMap[promptId] ?? ct.instruction)
    setPromptSaved(false)
    setPromptReset(false)
    setSaveError(null)
  }

  async function savePrompt() {
    if (!editingId) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const res = await apiFetch(`/api/prompts/${editingId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: editText }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Error ${res.status}`)
      }
      setPromptMap(prev => ({ ...prev, [editingId]: editText }))
      setPromptSaved(true)
      setTimeout(() => setEditingId(null), 700)
    } catch (e: any) {
      setSaveError(e.message || 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function resetPrompt() {
    if (!editingId) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const res = await apiFetch(`/api/prompts/${editingId}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Error ${res.status}`)
      }
      setPromptMap(prev => { const n = { ...prev }; delete n[editingId!]; return n })
      setEditText(editingDefault)
      setPromptReset(true)
      setTimeout(() => setEditingId(null), 700)
    } catch (e: any) {
      setSaveError(e.message || 'Reset failed')
    } finally {
      setIsSaving(false)
    }
  }

  function effectivePerm(id: string): string[] {
    // A per-user allow-list wins over the role map: return a permission that
    // matches effectiveRole iff the id is in the list.
    if (userChOverrides) {
      return userChOverrides.includes(id) ? [effectiveRole] : []
    }
    return activePerms[id] ?? DEFAULT_PERMISSIONS[id] ?? ['admin']
  }

  const allContentTypeInfos: ContentTypeInfo[] = CONTENT_TYPES
    .filter(ct => ct.category !== 'social')
    .map(ct => ({ id: ct.id, title: ct.title, category: ct.category as 'report' | 'content' }))

  const normalize = (p: string | null | undefined) => {
    if (!p) return ''
    const c = p.replace(/[\s\-]/g, '').replace(/^\+/, '')
    return c.length === 10 ? '91' + c : c
  }
  const myPhone = normalize(user?.phone ?? '')
  const selfReports = baseReports.filter(r => normalize(r.phone) === myPhone)
  const teamReports = baseReports.filter(r => normalize(r.phone) !== myPhone)

  function getReportsForType(id: string): DailyReport[] {
    if (id === 'self')    return selfReports.length > 0 ? selfReports : filteredReports
    if (id === 'team')    return teamReports.length > 0 ? teamReports : baseReports
    if (id === 'org')     return allReports
    if (id === 'other') {
      // Restrict to the filtered contributors; with none picked, openReportForOther
      // asks for a subject first.
      if (!filters?.workerName?.length) return filteredReports
      const picked = new Set(filters.workerName.map(n => String(n).toLowerCase().trim()))
      return baseReports.filter(r => picked.has(String(r.name).toLowerCase().trim()))
    }
    return filteredReports
  }

  function subjectsFromFilter(): { id?: string; name: string; phone?: string }[] {
    if (!filters?.workerName?.length) return []
    const seen = new Set<string>()
    const out: { id?: string; name: string; phone?: string }[] = []
    for (const name of filters.workerName) {
      const key = String(name).toLowerCase().trim()
      if (seen.has(key)) continue
      seen.add(key)
      const sample = baseReports.find(r => String(r.name).toLowerCase().trim() === key)
      out.push({ name, phone: sample?.phone })
    }
    return out
  }

  function openReportForOther(ct: ContentType) {
    const subjects = subjectsFromFilter()
    const kind: 'for_other' | 'team' = subjects.length > 1 ? 'team' : 'for_other'
    onOpenReport(
      ct.title,
      getReportsForType('other'),
      getInstruction(ct),
      { subjects, kind, pendingSubjectPick: subjects.length === 0 },
    )
    onClose()
  }

  const visibleTypes = CONTENT_TYPES.filter(ct =>
    effectivePerm(ct.id).includes(effectiveRole) &&
    ct.category !== 'social'
  )

  const searchQuery = search.trim().toLowerCase()
  const matchesSearch = (ct: ContentType) =>
    !searchQuery ||
    ct.title.toLowerCase().includes(searchQuery) ||
    ct.description.toLowerCase().includes(searchQuery)

  const reportTypes  = visibleTypes.filter(t => t.category === 'report' && matchesSearch(t))
  const contentTypes = visibleTypes.filter(t => t.category === 'content' && matchesSearch(t))
  const noSearchResults = searchQuery !== '' && reportTypes.length === 0 && contentTypes.length === 0

  const innerCardClass = mode === 'tab'
    ? 'bg-white w-full max-w-5xl mx-auto rounded-2xl flex flex-col border shadow-sm'
    : 'bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-3xl flex flex-col'
  const innerCardStyle: React.CSSProperties = mode === 'tab'
    ? { borderColor: FF.border }
    : { maxHeight: '90vh' }

  function wrapWithOverlay(child: React.ReactNode, outerOnClick?: () => void) {
    if (mode === 'tab') return child
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center"
        onClick={outerOnClick}
      >
        {child}
      </div>
    )
  }

  if (showSettings) {
    return wrapWithOverlay(
      <div
        className={innerCardClass}
        style={mode === 'tab' ? {} : { maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        <ContentHubSettings
          contentTypes={allContentTypeInfos}
          initialPermissions={activePerms}
          token={firebaseToken ?? ''}
          onBack={() => setShowSettings(false)}
          onSaved={newPerms => { setOverridePerms(newPerms); setShowSettings(false) }}
        />
      </div>,
      onClose,
    )
  }

  return wrapWithOverlay(
    (
      <div
        className={innerCardClass}
        style={innerCardStyle}
        onClick={e => e.stopPropagation()}
      >
        {/* Tab mode only gets a slim search row: DashboardPage's page header
            already shows the title. */}
        {mode === 'tab' && !editingId ? (
          <div className="flex items-center gap-2 px-5 py-3 border-b shrink-0" style={{ borderColor: FF.border }}>
            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: FF.textFaint }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search report and content types…"
                className="w-full text-xs rounded-lg pl-8 pr-3 py-2 focus:outline-none"
                style={{ border: `1px solid ${FF.border}`, color: FF.tealText }}
              />
            </div>
            {isAdmin && (
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-black/5 transition shrink-0"
                title="Manage permissions"
              >
                <Settings className="w-4 h-4" style={{ color: FF.textFaint }} />
              </button>
            )}
          </div>
        ) : (
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: FF.purple }}>
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <h2 className="font-bold" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>
                {editingId ? `Edit Prompt — ${editingLabel}` : t.chTitle}
              </h2>
            </div>
            <p className="text-xs mt-0.5 ml-9" style={{ color: FF.textFaint }}>
              {editingId
                ? 'Customise the AI instruction for this report type'
                : t.chSubtitle}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {!editingId && isAdmin && (
              <button
                onClick={() => setShowSettings(true)}
                className="p-1.5 rounded-lg hover:bg-gray-100 transition"
                title="Manage permissions"
              >
                <Settings className="w-4 h-4 text-gray-400" />
              </button>
            )}
            <button
              onClick={editingId ? () => setEditingId(null) : onClose}
              className="p-1.5 rounded-lg hover:bg-gray-100 transition"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>
        )}

        {editingId !== null ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-xs mb-3" style={{ color: FF.textFaint }}>
                This instruction tells the AI what kind of content to generate. Saved changes apply immediately for all team members with access to this report type.
              </p>
              <textarea
                value={editText}
                onChange={e => { setEditText(e.target.value); setPromptSaved(false) }}
                className="w-full h-72 text-xs font-mono rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#341272] leading-relaxed"
                style={{ border: `1px solid ${FF.border}`, color: FF.tealText }}
                placeholder="Enter AI instruction…"
              />
              {promptMap[editingId] && (
                <p className="text-[10px] mt-1.5 font-semibold flex items-center gap-1" style={{ color: FF.purple }}>
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: FF.purple }} />
                  Custom prompt active for your organisation
                </p>
              )}
            </div>
            <div className="px-5 py-4 border-t shrink-0 space-y-2" style={{ borderColor: FF.border }}>
              {saveError && (
                <p className="text-xs text-red-500 text-center">{saveError}</p>
              )}
              <div className="flex items-center gap-2">
                {promptSaved && (
                  <span className="text-xs font-semibold flex items-center gap-1 mr-auto" style={{ color: FF.green }}>
                    <Check className="w-3.5 h-3.5" /> Saved
                  </span>
                )}
                {promptReset && (
                  <span className="text-xs font-semibold flex items-center gap-1 mr-auto" style={{ color: FF.textMuted }}>
                    <RotateCcw className="w-3.5 h-3.5" /> Reset to default
                  </span>
                )}
                {!promptSaved && !promptReset && <span className="mr-auto" />}
                <button
                  onClick={resetPrompt}
                  disabled={isSaving}
                  title="Reset to system default"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl hover:bg-black/5 transition disabled:opacity-50"
                  style={{ color: FF.textMuted, border: `1px solid ${FF.border}` }}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset to Default
                </button>
                <button
                  onClick={savePrompt}
                  disabled={isSaving || !editText.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white rounded-xl hover:opacity-90 transition disabled:opacity-50"
                  style={{ background: FF.purple }}
                >
                  {isSaving
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Check className="w-3.5 h-3.5" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : (
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-6">

          <KpiGrid cols={3}>
            <KpiTile label={String(t.chFilteredRecords)} value={filteredReports.length} valueSize={26} />
            <KpiTile label={String(t.chTotalRecords)} value={baseReports.length} valueSize={26} />
            <KpiTile label={String(t.chOrgRecords)} value={allReports.length} valueSize={26} />
          </KpiGrid>

          {noSearchResults && (
            <div className="text-center py-8 text-xs" style={{ color: FF.textFaint }}>
              No report or content types match "{search}".
            </div>
          )}

          {/* Reports */}
          {reportTypes.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-3.5 h-3.5" style={{ color: FF.textFaint }} />
                <h3 className="text-[11px] font-bold uppercase tracking-widest" style={{ color: FF.textFaint }}>{t.chSectionReports}</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {reportTypes.map(ct => (
                  <div key={ct.id} className="relative group/card">
                    <button
                      onClick={() => {
                        if (ct.id === 'project' && onOpenProjectReportPicker) {
                          onOpenProjectReportPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (ct.id === 'org' && onOpenOrgReportPicker) {
                          // Org Report → its own dedicated picker tab
                          // (date range + optional project/location + custom
                          // instructions).
                          onOpenOrgReportPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (ct.id === 'team' && onOpenTeamReportPicker) {
                          // Team Report → its own dedicated picker tab, same
                          // convention as Org Report but scoped to every team
                          // member (everyone except the logged-in user).
                          onOpenTeamReportPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (ct.id === 'impact' && onOpenImpactReportPicker) {
                          // Impact Report → its own dedicated picker tab, same
                          // convention as Org Report, scoped to whatever data
                          // the viewer is role-permitted to see.
                          onOpenImpactReportPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (ct.id === 'self' && onOpenSelfReportPicker) {
                          // Self Report → same picker convention as Org Report
                          // (date range + custom instructions), scoped to just
                          // this user's own entries.
                          onOpenSelfReportPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (ct.id === 'other') {
                          openReportForOther(ct)
                        } else if (ct.id === 'story' && onOpenStoryFinder) {
                          onOpenStoryFinder()
                          onClose()
                        } else {
                          onOpenReport(ct.title, getReportsForType(ct.id), getInstruction(ct))
                          onClose()
                        }
                      }}
                      className="flex flex-col sm:flex-row items-start gap-1.5 sm:gap-3 p-2.5 sm:p-3.5 rounded-xl border text-left transition hover:shadow-md active:scale-[0.98] w-full"
                      style={{ background: '#FFFFFF', borderColor: FF.border }}
                    >
                      <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center shrink-0 sm:mt-0.5 shadow-sm"
                        style={{ background: ct.color, color: '#fff' }}>
                        {ct.icon}
                      </div>
                      <div className="min-w-0 w-full pr-6 sm:pr-6">
                        <p className="text-xs sm:text-sm font-semibold" style={{ color: FF.tealDark }}>{ct.title}</p>
                        <p className="text-[10px] sm:text-[11px] leading-tight mt-0.5 line-clamp-2 sm:line-clamp-none" style={{ color: FF.textMuted }}>{ct.description}</p>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <p className="text-[9px] sm:text-[10px] font-bold" style={{ color: FF.purple }}>
                            {ct.id === 'other'
                              ? (subjectsFromFilter().length > 0
                                  ? `${subjectsFromFilter().length} ${subjectsFromFilter().length === 1 ? 'subject' : 'subjects'} selected`
                                  : 'Pick subject(s) →')
                              : ct.id === 'project'
                              ? 'Pick a project & date range →'
                              : ct.id === 'org' || ct.id === 'impact' || ct.id === 'team' || ct.id === 'self'
                              ? 'Pick a date range →'
                              : `${getReportsForType(ct.id).length} ${t.chRecords}`}
                          </p>
                          {promptMap['ch_' + ct.id] && (
                            <StatusBadge bg="#EDE8F9" fg={FF.purple} label="Custom" shape="pill" size="xs" />
                          )}
                        </div>
                      </div>
                    </button>
                    {isAdmin && (
                      <button
                        onClick={e => openEditor(ct, e)}
                        title="Edit AI instruction"
                        className="absolute top-2 right-2 opacity-0 group-hover/card:opacity-100 transition p-1.5 rounded-lg bg-white/90 hover:bg-white shadow-sm border border-gray-100"
                      >
                        <Pencil className="w-3 h-3 text-gray-500" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Content & Comms */}
          {contentTypes.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-3.5 h-3.5" style={{ color: FF.textFaint }} />
                <h3 className="text-[11px] font-bold uppercase tracking-widest" style={{ color: FF.textFaint }}>{t.chSectionContent}</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {contentTypes.map(ct => (
                  <div key={ct.id} className="relative group/card">
                    <button
                      onClick={() => {
                        if (ct.id === 'story' && onOpenStoryFinder) {
                          onOpenStoryFinder()
                          onClose()
                        } else if (ct.id === 'caseStudy' && onOpenCaseStudyPicker) {
                          onOpenCaseStudyPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else if (onOpenContentPicker) {
                          onOpenContentPicker(ct.title, getInstruction(ct))
                          onClose()
                        } else {
                          onOpenReport(ct.title, getReportsForType(ct.id), getInstruction(ct))
                          onClose()
                        }
                      }}
                      className="flex flex-col sm:flex-row items-start gap-1.5 sm:gap-3 p-2.5 sm:p-3.5 rounded-xl border text-left transition hover:shadow-md active:scale-[0.98] w-full"
                      style={{ background: '#FFFFFF', borderColor: FF.border }}
                    >
                      <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center shrink-0 sm:mt-0.5 shadow-sm"
                        style={{ background: ct.color, color: '#fff' }}>
                        {ct.icon}
                      </div>
                      <div className="min-w-0 w-full pr-6 sm:pr-6">
                        <p className="text-xs sm:text-sm font-semibold" style={{ color: FF.tealDark }}>{ct.title}</p>
                        <p className="text-[10px] sm:text-[11px] leading-tight mt-0.5 line-clamp-2 sm:line-clamp-none" style={{ color: FF.textMuted }}>{ct.description}</p>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <p className="text-[9px] sm:text-[10px] font-bold" style={{ color: FF.purple }}>
                            {ct.id === 'caseStudy'
                              ? 'Pick a project, date & location →'
                              : ct.id === 'story'
                              ? `${getReportsForType(ct.id).length} ${t.chRecords}`
                              : 'Pick a date range →'}
                          </p>
                          {promptMap['ch_' + ct.id] && (
                            <StatusBadge bg="#EDE8F9" fg={FF.purple} label="Custom" shape="pill" size="xs" />
                          )}
                        </div>
                      </div>
                    </button>
                    {isAdmin && (
                      <button
                        onClick={e => openEditor(ct, e)}
                        title="Edit AI instruction"
                        className="absolute top-2 right-2 opacity-0 group-hover/card:opacity-100 transition p-1.5 rounded-lg bg-white/90 hover:bg-white shadow-sm border border-gray-100"
                      >
                        <Pencil className="w-3 h-3 text-gray-500" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Social Media */}
          {effectivePerm('_social').includes(effectiveRole) && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Megaphone className="w-3.5 h-3.5" style={{ color: FF.textFaint }} />
                <h3 className="text-[11px] font-bold uppercase tracking-widest" style={{ color: FF.textFaint }}>{t.chSectionSocial}</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {SOCIAL_PLATFORMS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { onOpenSocial(socialScope, socialScopeName, filteredReports, p.id); onClose() }}
                    className="flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3.5 rounded-xl border text-left transition hover:shadow-md active:scale-[0.98]"
                    style={{ background: '#FFFFFF', borderColor: FF.border }}
                  >
                    <span className="text-xl sm:text-2xl">{p.emoji}</span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold truncate" style={{ color: FF.tealDark }}>{p.label}</p>
                      <p className="text-[9px] sm:text-[10px] font-bold mt-0.5" style={{ color: p.color }}>
                        {t.chGeneratePost}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="h-2" />
        </div>
        )}
      </div>
    ),
    editingId ? undefined : onClose,
  )
}

export function ContentHubTab(props: Omit<Props, 'mode' | 'onClose'>) {
  return <ContentHubModal {...props} mode="tab" />
}
