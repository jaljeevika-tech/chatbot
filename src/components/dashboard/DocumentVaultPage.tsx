// Document Vault: per-project files in legal/financial/progress/knowledge tabs
// (see routes/documents.routes.js for upload, content and AI text routes).

import { useEffect, useRef, useState } from 'react'
import { Loader2, FileText, FileSpreadsheet, Presentation, File as FileIcon, Download, Eye, Sparkles, X, Trash2, Plus } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { FF, ffStatusColors } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'
import { SectionCard } from '../ui/SectionCard'
import { StatusBadge } from '../ui/StatusBadge'
import { DocumentAskAiPanel } from './DocumentAskAiPanel'
import { useOrg } from '../../context/OrgContext'
import { DEFAULT_REPORT_CATEGORIES } from './ReportCategoriesSettings'

// The four real storage buckets a document is uploaded into (vault_tab in the DB).
type UploadTabKey = 'legal' | 'financial' | 'progress' | 'knowledge'
const UPLOAD_TABS: { key: UploadTabKey; label: string }[] = [
  { key: 'legal', label: 'Legal' },
  { key: 'financial', label: 'Financial' },
  { key: 'progress', label: 'Progress' },
  { key: 'knowledge', label: 'Knowledge' },
]

// 'reports' is a virtual tab: documents from any bucket with a report_category set.
type VaultTabKey = UploadTabKey | 'reports'
const VAULT_TABS: { key: VaultTabKey; label: string }[] = [
  ...UPLOAD_TABS,
  { key: 'reports', label: 'Reports' },
]

interface VaultDoc {
  id: string; name: string; file_type: string; status: string; created_at: string; uploaded_by: string | null
  vault_tab: UploadTabKey; report_category: string | null; tags: string[]
}

interface Props {
  projectKey: string
}

function splitExt(filename: string): [string, string] {
  const idx = filename.lastIndexOf('.')
  if (idx <= 0) return [filename, '']
  return [filename.slice(0, idx), filename.slice(idx)]
}

function isPdf(d: VaultDoc) {
  return d.file_type === 'application/pdf' || d.name.toLowerCase().endsWith('.pdf')
}

function FileTypeIcon({ d }: { d: VaultDoc }) {
  const name = d.name.toLowerCase()
  const style = { width: 16, height: 16, color: FF.textFaint }
  if (isPdf(d) || name.endsWith('.doc') || name.endsWith('.docx')) return <FileText style={style} />
  if (name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.csv')) return <FileSpreadsheet style={style} />
  if (name.endsWith('.ppt') || name.endsWith('.pptx')) return <Presentation style={style} />
  return <FileIcon style={style} />
}

export function DocumentVaultPage({ projectKey }: Props) {
  const { org } = useOrg()
  const reportCategories = org?.reportCategories?.length ? org.reportCategories : DEFAULT_REPORT_CATEGORIES
  const [activeTab, setActiveTab] = useState<VaultTabKey>('legal')
  const [docs, setDocs] = useState<VaultDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ name: string; url: string } | null>(null)
  const [askAiDoc, setAskAiDoc] = useState<VaultDoc | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingDataUrl, setPendingDataUrl] = useState<string | null>(null)
  const [pendingBaseName, setPendingBaseName] = useState('')
  const [pendingCategory, setPendingCategory] = useState<UploadTabKey>('legal')
  const [suggestedCategory, setSuggestedCategory] = useState<UploadTabKey | null>(null)
  const [reportCategoryFilter, setReportCategoryFilter] = useState('')
  const [pendingReportCategory, setPendingReportCategory] = useState<string | null>(null)
  const [suggestedReportCategory, setSuggestedReportCategory] = useState<string | null>(null)
  const [pendingTags, setPendingTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [aiSuggestedTags, setAiSuggestedTags] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  function load() {
    setLoading(true)
    const params = new URLSearchParams({ tab: activeTab })
    if (activeTab === 'reports' && reportCategoryFilter) params.set('category', reportCategoryFilter)
    apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents?${params.toString()}`)
      .then(r => r.json())
      .then(d => setDocs(d.documents || []))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [projectKey, activeTab, reportCategoryFilter])

  // Revoke the preview blob URL when the modal closes or the component unmounts.
  useEffect(() => () => { if (pdfPreview) URL.revokeObjectURL(pdfPreview.url) }, [pdfPreview])

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const [base] = splitExt(file.name)
    setPendingFile(file)
    setPendingBaseName(base)
    setPendingCategory(activeTab === 'reports' ? 'legal' : activeTab)
    setSuggestedCategory(null)
    setPendingReportCategory(null)
    setSuggestedReportCategory(null)
    setPendingTags([])
    setAiSuggestedTags(false)
    setTagDraft('')
    setPendingDataUrl(null)

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      setPendingDataUrl(dataUrl)

      setSuggesting(true)
      try {
        const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents/suggest-category`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, file_type: file.type, data: dataUrl }),
        })
        if (res.ok) {
          const body = await res.json()
          if (body.category && body.confidence >= 0.5) {
            setSuggestedCategory(body.category)
            setPendingCategory(body.category)
          }
          if (body.reportCategory) {
            setSuggestedReportCategory(body.reportCategory)
            setPendingReportCategory(body.reportCategory)
          }
          if (Array.isArray(body.tags) && body.tags.length) {
            setPendingTags(body.tags)
            setAiSuggestedTags(true)
          }
        }
      } catch {
        // Best-effort — user can still pick a category/tags manually.
      } finally {
        setSuggesting(false)
      }
    }
    reader.readAsDataURL(file)
  }

  function addTag() {
    const t = tagDraft.trim().toLowerCase()
    if (!t || pendingTags.includes(t)) return
    setPendingTags(prev => [...prev, t])
    setTagDraft('')
  }

  function removeTag(t: string) {
    setPendingTags(prev => prev.filter(x => x !== t))
    setAiSuggestedTags(false)
  }

  function cancelPendingUpload() {
    setPendingFile(null)
    setPendingDataUrl(null)
    setPendingBaseName('')
    setSuggestedCategory(null)
    setPendingReportCategory(null)
    setSuggestedReportCategory(null)
    setPendingTags([])
    setAiSuggestedTags(false)
    setTagDraft('')
  }

  async function confirmPendingUpload() {
    const file = pendingFile
    if (!file || !pendingDataUrl) return
    const [, ext] = splitExt(file.name)
    const finalName = (pendingBaseName.trim() || splitExt(file.name)[0]) + ext
    const category = pendingCategory
    setUploading(true)
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: finalName, file_type: file.type, data: pendingDataUrl, vault_tab: category,
          report_category: pendingReportCategory, tags: pendingTags,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Upload failed (${res.status})`)
      }
      setPendingFile(null)
      setPendingDataUrl(null)
      setPendingBaseName('')
      setSuggestedCategory(null)
      setPendingReportCategory(null)
      setSuggestedReportCategory(null)
      setPendingTags([])
      setAiSuggestedTags(false)
      // Reports is a virtual view: stay put and reload rather than jump to the file's vault_tab.
      if (activeTab === 'reports') load()
      else if (category !== activeTab) setActiveTab(category)
      else load()
    } catch (err: any) {
      alert('Upload failed: ' + (err.message || 'unknown error'))
    } finally {
      setUploading(false)
    }
  }

  async function handleDownload(d: VaultDoc) {
    setDownloadingId(d.id)
    try {
      await authedDownload(`/api/projects/${encodeURIComponent(projectKey)}/documents/${d.id}/content`, d.name)
    } catch (e: any) {
      alert('Download failed: ' + (e.message || 'unknown'))
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleView(d: VaultDoc) {
    setDownloadingId(d.id)
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents/${d.id}/content`)
      if (!res.ok) throw new Error('Failed to load document')
      const blob = await res.blob()
      // isPdf() trusts client-declared type/name; only real PDFs may render in the
      // same-origin frame, or stored markup would execute in the app's origin.
      if (blob.type !== 'application/pdf') throw new Error('this file can’t be previewed — use Download instead')
      setPdfPreview({ name: d.name, url: URL.createObjectURL(blob) })
    } catch (e: any) {
      alert('Preview failed: ' + (e.message || 'unknown'))
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleDelete(d: VaultDoc) {
    if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return
    setDeletingId(d.id)
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents/${d.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Delete failed (${res.status})`)
      }
      setDocs(prev => prev.filter(x => x.id !== d.id))
    } catch (e: any) {
      alert('Delete failed: ' + (e.message || 'unknown'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <TabPill tabs={VAULT_TABS} active={activeTab} onChange={setActiveTab} />
        {activeTab === 'reports' && (
          <select
            value={reportCategoryFilter}
            onChange={e => setReportCategoryFilter(e.target.value)}
            style={{ font: "500 12.5px 'IBM Plex Sans',sans-serif", padding: '8px 10px', borderRadius: 8, border: `1px solid ${FF.border}`, color: FF.tealDark, background: '#FFFFFF' }}
          >
            <option value="">All categories</option>
            {reportCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <input ref={fileInput} type="file" onChange={onFilePicked} style={{ display: 'none' }} />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          style={{ display: 'flex', alignItems: 'center', gap: 6, font: "500 13px 'IBM Plex Sans',sans-serif", padding: '9px 16px', borderRadius: 8, border: 'none', background: FF.purple, color: '#F4FBFC', cursor: uploading ? 'default' : 'pointer', opacity: uploading ? 0.7 : 1 }}
        >
          {uploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {uploading ? 'Uploading…' : 'Upload Document'}
        </button>
      </div>

      <SectionCard noPadding>
        {loading ? (
          <div className="flex items-center justify-center py-10" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : docs.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: FF.textFaint, textAlign: 'center' }}>
            {activeTab === 'reports'
              ? (reportCategoryFilter ? `No documents tagged "${reportCategoryFilter}" yet.` : 'No documents have a report category yet.')
              : 'No documents in this tab yet.'}
          </div>
        ) : (
          <>
            {/* md+: grid table; below md the rows render as cards instead */}
            <div className="hidden md:block">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 130px 100px 120px 130px', gap: 12, padding: '12px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
                <div>Document</div><div>Uploaded</div><div>Uploaded by</div><div>Status</div><div /><div />
              </div>
              {docs.map(d => {
                const indexed = d.status === 'indexed'
                const c = ffStatusColors(indexed ? 'green' : 'amber')
                const busy = downloadingId === d.id
                return (
                  <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 130px 100px 120px 130px', gap: 12, alignItems: 'center', padding: '14px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13.5 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <FileTypeIcon d={d} />
                        <span style={{ color: FF.tealDark, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                      </div>
                      {(activeTab === 'reports' || d.report_category || d.tags?.length > 0) && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 24 }}>
                          {activeTab === 'reports' && (
                            <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: FF.borderFaint, color: FF.textMuted, textTransform: 'capitalize' }}>
                              {d.vault_tab}
                            </span>
                          )}
                          {d.report_category && (
                            <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#F5F3FF', color: FF.purple }}>
                              {d.report_category}
                            </span>
                          )}
                          {(d.tags || []).map(t => (
                            <span key={t} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: FF.borderFaint, color: FF.textFaint }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ color: FF.textMuted }}>{new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                    <div style={{ color: FF.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.uploaded_by || '—'}</div>
                    <div><StatusBadge bg={c.bg} fg={c.fg} label={indexed ? 'AI-ready' : 'View only'} /></div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {isPdf(d) && (
                        <button onClick={() => handleView(d)} disabled={busy} title="View" style={{ padding: 6, borderRadius: 6, border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer' }}>
                          <Eye className="w-3.5 h-3.5" style={{ color: FF.textMuted }} />
                        </button>
                      )}
                      <button onClick={() => handleDownload(d)} disabled={busy} title="Download" style={{ padding: 6, borderRadius: 6, border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer' }}>
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: FF.textMuted }} /> : <Download className="w-3.5 h-3.5" style={{ color: FF.textMuted }} />}
                      </button>
                      <button onClick={() => handleDelete(d)} disabled={deletingId === d.id} title="Delete" style={{ padding: 6, borderRadius: 6, border: 'none', background: 'transparent', cursor: deletingId === d.id ? 'default' : 'pointer' }}>
                        {deletingId === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: FF.red }} /> : <Trash2 className="w-3.5 h-3.5" style={{ color: FF.red }} />}
                      </button>
                    </div>
                    <div>
                      {indexed && (
                        <button
                          onClick={() => setAskAiDoc(d)}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, padding: '5px 10px', borderRadius: 999, border: `1px solid ${FF.border}`, background: '#FFFFFF', color: FF.purple, cursor: 'pointer' }}
                        >
                          <Sparkles className="w-3 h-3" /> Ask AI
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {docs.map(d => {
                const indexed = d.status === 'indexed'
                const c = ffStatusColors(indexed ? 'green' : 'amber')
                const busy = downloadingId === d.id
                return (
                  <div key={d.id} className="p-4">
                    <div className="flex items-center gap-2 min-w-0 mb-1.5">
                      <FileTypeIcon d={d} />
                      <span className="truncate" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{d.name}</span>
                    </div>
                    {(activeTab === 'reports' || d.report_category || d.tags?.length > 0) && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {activeTab === 'reports' && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: FF.borderFaint, color: FF.textMuted, textTransform: 'capitalize' }}>
                            {d.vault_tab}
                          </span>
                        )}
                        {d.report_category && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#F5F3FF', color: FF.purple }}>
                            {d.report_category}
                          </span>
                        )}
                        {(d.tags || []).map(t => (
                          <span key={t} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: FF.borderFaint, color: FF.textFaint }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2.5" style={{ fontSize: 12, color: FF.textMuted }}>
                      <div>Uploaded: {new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                      <div className="truncate">By: {d.uploaded_by || '—'}</div>
                      <div><StatusBadge bg={c.bg} fg={c.fg} label={indexed ? 'AI-ready' : 'View only'} /></div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {isPdf(d) && (
                        <button onClick={() => handleView(d)} disabled={busy} title="View" style={{ padding: 7, borderRadius: 6, border: `1px solid ${FF.border}`, background: '#FFFFFF', cursor: busy ? 'default' : 'pointer' }}>
                          <Eye className="w-3.5 h-3.5" style={{ color: FF.textMuted }} />
                        </button>
                      )}
                      <button onClick={() => handleDownload(d)} disabled={busy} title="Download" style={{ padding: 7, borderRadius: 6, border: `1px solid ${FF.border}`, background: '#FFFFFF', cursor: busy ? 'default' : 'pointer' }}>
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: FF.textMuted }} /> : <Download className="w-3.5 h-3.5" style={{ color: FF.textMuted }} />}
                      </button>
                      <button onClick={() => handleDelete(d)} disabled={deletingId === d.id} title="Delete" style={{ padding: 7, borderRadius: 6, border: `1px solid ${FF.border}`, background: '#FFFFFF', cursor: deletingId === d.id ? 'default' : 'pointer' }}>
                        {deletingId === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: FF.red }} /> : <Trash2 className="w-3.5 h-3.5" style={{ color: FF.red }} />}
                      </button>
                      {indexed && (
                        <button
                          onClick={() => setAskAiDoc(d)}
                          className="ml-auto"
                          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, padding: '6px 10px', borderRadius: 999, border: `1px solid ${FF.border}`, background: '#FFFFFF', color: FF.purple, cursor: 'pointer' }}
                        >
                          <Sparkles className="w-3 h-3" /> Ask AI
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </SectionCard>

      {pdfPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-6" onClick={() => setPdfPreview(null)}>
          <div className="bg-white rounded-2xl w-full max-w-4xl h-full max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: FF.border }}>
              <p className="text-sm font-semibold truncate" style={{ color: FF.tealDark }}>{pdfPreview.name}</p>
              <button onClick={() => setPdfPreview(null)} className="p-1.5 rounded-lg hover:bg-black/5 transition shrink-0">
                <X className="w-4 h-4" style={{ color: FF.textMuted }} />
              </button>
            </div>
            <iframe src={pdfPreview.url} title={pdfPreview.name} className="flex-1 w-full" />
          </div>
        </div>
      )}

      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-6" onClick={cancelPendingUpload}>
          <div
            className="rounded-t-2xl sm:rounded-2xl"
            style={{ background: '#FFFFFF', width: '100%', maxWidth: 420, maxHeight: '92vh', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}
            onClick={e => e.stopPropagation()}
          >
            <p style={{ font: "600 15px 'IBM Plex Sans',sans-serif", color: FF.tealDark }}>Name this document</p>
            <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${FF.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <input
                autoFocus
                value={pendingBaseName}
                onChange={e => setPendingBaseName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmPendingUpload(); if (e.key === 'Escape') cancelPendingUpload() }}
                style={{ flex: 1, minWidth: 0, padding: '9px 12px', border: 'none', outline: 'none', font: "500 13.5px 'IBM Plex Sans',sans-serif", color: FF.tealDark }}
              />
              <span style={{ padding: '9px 12px 9px 0', font: "500 13.5px 'IBM Plex Sans',sans-serif", color: FF.textFaint }}>
                {splitExt(pendingFile.name)[1]}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint }}>
                Category
                {suggesting && <Loader2 className="w-3 h-3 animate-spin" />}
                {!suggesting && suggestedCategory && pendingCategory === suggestedCategory && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: FF.purple, textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                    <Sparkles className="w-3 h-3" /> AI suggested
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {UPLOAD_TABS.map(t => {
                  const selected = pendingCategory === t.key
                  return (
                    <button
                      key={t.key}
                      onClick={() => setPendingCategory(t.key)}
                      style={{
                        font: "500 12.5px 'IBM Plex Sans',sans-serif",
                        padding: '7px 14px',
                        borderRadius: 999,
                        border: `1px solid ${selected ? FF.purple : FF.border}`,
                        background: selected ? FF.purple : '#FFFFFF',
                        color: selected ? '#F4FBFC' : FF.textMuted,
                        cursor: 'pointer',
                      }}
                    >
                      {t.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint }}>
                Report Category
                {suggesting && <Loader2 className="w-3 h-3 animate-spin" />}
                {!suggesting && suggestedReportCategory && pendingReportCategory === suggestedReportCategory && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: FF.purple, textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                    <Sparkles className="w-3 h-3" /> AI suggested
                  </span>
                )}
              </div>
              <select
                value={pendingReportCategory ?? ''}
                onChange={e => setPendingReportCategory(e.target.value || null)}
                style={{ font: "500 12.5px 'IBM Plex Sans',sans-serif", padding: '8px 10px', borderRadius: 8, border: `1px solid ${FF.border}`, color: FF.tealDark, background: '#FFFFFF' }}
              >
                <option value="">— none —</option>
                {reportCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint }}>
                Tags
                {suggesting && <Loader2 className="w-3 h-3 animate-spin" />}
                {!suggesting && aiSuggestedTags && pendingTags.length > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: FF.purple, textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                    <Sparkles className="w-3 h-3" /> AI suggested
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {pendingTags.map(t => (
                  <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '5px 6px 5px 10px', borderRadius: 999, background: FF.borderFaint, color: FF.textMuted }}>
                    {t}
                    <button onClick={() => removeTag(t)} style={{ padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}>
                      <X className="w-3 h-3" style={{ color: FF.textFaint }} />
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={tagDraft}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                  placeholder="Add a tag…"
                  style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: `1px solid ${FF.border}`, outline: 'none', font: "500 12.5px 'IBM Plex Sans',sans-serif", color: FF.tealDark }}
                />
                <button
                  onClick={addTag}
                  disabled={!tagDraft.trim()}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, font: "500 12.5px 'IBM Plex Sans',sans-serif", padding: '8px 12px', borderRadius: 8, border: `1px solid ${FF.border}`, background: '#FFFFFF', color: FF.textMuted, cursor: tagDraft.trim() ? 'pointer' : 'default', opacity: tagDraft.trim() ? 1 : 0.6 }}
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={cancelPendingUpload}
                style={{ font: "500 13px 'IBM Plex Sans',sans-serif", padding: '9px 16px', borderRadius: 8, border: `1px solid ${FF.border}`, background: '#FFFFFF', color: FF.textMuted, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmPendingUpload}
                disabled={!pendingBaseName.trim() || !pendingDataUrl || uploading}
                style={{ display: 'flex', alignItems: 'center', gap: 6, font: "500 13px 'IBM Plex Sans',sans-serif", padding: '9px 16px', borderRadius: 8, border: 'none', background: FF.purple, color: '#F4FBFC', cursor: (pendingBaseName.trim() && pendingDataUrl && !uploading) ? 'pointer' : 'default', opacity: (pendingBaseName.trim() && pendingDataUrl && !uploading) ? 1 : 0.6 }}
              >
                {uploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {askAiDoc && (
        <DocumentAskAiPanel
          projectKey={projectKey}
          documentId={askAiDoc.id}
          documentName={askAiDoc.name}
          onClose={() => setAskAiDoc(null)}
        />
      )}
    </div>
  )
}
