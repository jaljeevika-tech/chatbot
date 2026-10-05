import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ImageOff, MapPin, Tag, Calendar, User, Briefcase, ExternalLink, Search, Download, MessageCircle, FileSpreadsheet,
  Upload, Loader2, FileText, Music, Video as VideoIcon, File as FileIcon, Trash2, Sparkles,
} from 'lucide-react';
import type { DailyReport } from '../../types/report';
import { getDriveThumbnailUrl, getDriveDownloadUrl } from '../../utils/driveImage';
import { useLanguage } from '../../context/LanguageContext';
import { apiFetch } from '../../utils/apiFetch';
import { authedDownload } from '../../utils/authedDownload';
import { useOrg } from '../../context/OrgContext';
import { DEFAULT_REPORT_CATEGORIES } from './ReportCategoriesSettings';

interface Props {
  reports: DailyReport[];
  projectKey?: string;
}

type UploadedMediaType = 'image' | 'video' | 'audio' | 'pdf' | 'other'

interface UploadedMedia {
  id: string
  media_type: UploadedMediaType
  name: string
  file_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  created_at: string
  category: string | null
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

function formatBytes(n: number | null): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Fetches its own blob via the authenticated content endpoint, since a plain <img>/<video>
 * src can't carry the Bearer token. */
function UploadedMediaCard({ projectKey, item, onDeleted }: { projectKey: string; item: UploadedMedia; onDeleted: (id: string) => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [loadingBlob, setLoadingBlob] = useState(item.media_type === 'image')
  const [deleting, setDeleting] = useState(false)
  const contentUrl = `/api/projects/${encodeURIComponent(projectKey)}/media/${item.id}/content`

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    if (item.media_type === 'image') {
      setLoadingBlob(true)
      apiFetch(contentUrl)
        .then(r => r.ok ? r.blob() : Promise.reject(new Error('Failed to load')))
        .then(blob => {
          if (cancelled) return
          url = URL.createObjectURL(blob)
          setBlobUrl(url)
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoadingBlob(false) })
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [item.id])

  async function handleDownload() {
    try {
      await authedDownload(contentUrl, item.name)
    } catch (e: any) {
      alert('Download failed: ' + (e.message || 'unknown'))
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/media/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Delete failed (${res.status})`)
      }
      onDeleted(item.id)
    } catch (e: any) {
      alert('Delete failed: ' + (e.message || 'unknown'))
      setDeleting(false)
    }
  }

  return (
    <div className="bg-white rounded-3xl overflow-hidden border border-gray-100 shadow-sm flex flex-col group transition-all hover:shadow-md">
      <div className="relative aspect-[4/3] bg-gray-100 overflow-hidden flex items-center justify-center">
        {item.media_type === 'image' ? (
          loadingBlob ? <Loader2 className="w-6 h-6 text-gray-300 animate-spin" /> :
          blobUrl ? <img src={blobUrl} alt={item.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" /> :
          <ImageOff className="w-8 h-8 text-gray-300" />
        ) : item.media_type === 'video' ? (
          <VideoIcon className="w-10 h-10 text-gray-300" />
        ) : item.media_type === 'audio' ? (
          <Music className="w-10 h-10 text-gray-300" />
        ) : item.media_type === 'pdf' ? (
          <FileText className="w-10 h-10 text-gray-300" />
        ) : (
          <FileIcon className="w-10 h-10 text-gray-300" />
        )}
        <div className="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
          <button onClick={handleDownload} title="Download" className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-md transition-all">
            <Download className="w-4 h-4" />
          </button>
          <button onClick={handleDelete} disabled={deleting} title="Delete" className="p-2 bg-black/50 hover:bg-red-600/80 text-white rounded-full backdrop-blur-md transition-all">
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div className="p-4 space-y-1.5">
        <p className="text-xs font-bold text-gray-800 truncate" title={item.name}>{item.name}</p>
        <div className="flex items-center gap-2 text-[10.5px] text-gray-400">
          <span className="uppercase font-black tracking-wider">{item.media_type}</span>
          {item.size_bytes ? <span>· {formatBytes(item.size_bytes)}</span> : null}
          <span>· {new Date(item.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </div>
        {item.category && (
          <span className="inline-block text-[10.5px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#F5F3FF', color: '#7C3AED' }}>
            {item.category}
          </span>
        )}
      </div>
    </div>
  )
}

export function MediaLibraryTab({ reports, projectKey }: Props) {
  const { t } = useLanguage()
  const { org } = useOrg()
  const categories = org?.reportCategories?.length ? org.reportCategories : DEFAULT_REPORT_CATEGORIES
  const [search, setSearch] = useState('');
  const [uploadedMedia, setUploadedMedia] = useState<UploadedMedia[]>([])
  const [loadingUploaded, setLoadingUploaded] = useState(!!projectKey)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // A file is staged and AI-classified before the user confirms the upload.
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingDataUrl, setPendingDataUrl] = useState<string | null>(null)
  const [pendingCategory, setPendingCategory] = useState<string | null>(null)
  const [suggestedCategory, setSuggestedCategory] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  useEffect(() => {
    if (!projectKey) return
    setLoadingUploaded(true)
    const params = new URLSearchParams()
    if (categoryFilter) params.set('category', categoryFilter)
    apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/media?${params.toString()}`)
      .then(r => r.json())
      .then(d => setUploadedMedia(d.media || []))
      .finally(() => setLoadingUploaded(false))
  }, [projectKey, categoryFilter])

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !projectKey) return
    setUploadError(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`"${file.name}" is too large — max 25MB per file.`)
      return
    }
    setPendingFile(file)
    setPendingDataUrl(null)
    setPendingCategory(null)
    setSuggestedCategory(null)

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      setPendingDataUrl(dataUrl)
      setSuggesting(true)
      try {
        const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/media/suggest-category`, {
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
        }
      } catch {
        // Best-effort — user can still pick a category manually.
      } finally {
        setSuggesting(false)
      }
    }
    reader.onerror = () => setUploadError('Could not read file')
    reader.readAsDataURL(file)
  }

  function cancelPendingUpload() {
    setPendingFile(null)
    setPendingDataUrl(null)
    setPendingCategory(null)
    setSuggestedCategory(null)
  }

  async function confirmPendingUpload() {
    const file = pendingFile
    if (!file || !pendingDataUrl || !projectKey) return
    setUploading(true)
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, file_type: file.type, data: pendingDataUrl, category: pendingCategory }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Upload failed (${res.status})`)
      }
      const created: UploadedMedia = await res.json()
      setUploadedMedia(prev => [created, ...prev])
      cancelPendingUpload()
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const mediaItems = useMemo(() => {
    return reports
      .filter(r => r.attachmentUrl)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [reports]);

  const filteredMedia = useMemo(() => {
    if (!search.trim()) return mediaItems;
    const s = search.toLowerCase();
    return mediaItems.filter(r => 
      r.project.toLowerCase().includes(s) ||
      r.location.toLowerCase().includes(s) ||
      r.name.toLowerCase().includes(s) ||
      r.areaOfIntervention.toLowerCase().includes(s) ||
      r.description.toLowerCase().includes(s) ||
      (r.source ?? 'sheet').toLowerCase().includes(s)
    );
  }, [mediaItems, search]);

  return (
    <div className="space-y-6">
      {projectKey && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-black text-gray-800">Uploaded Media {uploadedMedia.length > 0 && `(${uploadedMedia.length})`}</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 text-gray-600 bg-white"
              >
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,video/*,audio/*,application/pdf"
                onChange={handleFilePicked}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-xl text-white transition-all disabled:opacity-70"
                style={{ background: '#341272' }}
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {uploading ? 'Uploading…' : 'Upload Media'}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">Video, audio, pictures, and PDFs — up to 25MB per file.</p>
          {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}

          {loadingUploaded ? (
            <div className="flex items-center justify-center py-10 text-gray-300"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : uploadedMedia.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-3xl border border-dashed border-gray-200">
              <Upload className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium text-sm">
                {categoryFilter ? `No media tagged "${categoryFilter}" yet.` : 'No media uploaded to this project yet.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
              {uploadedMedia.map(item => (
                <UploadedMediaCard
                  key={item.id}
                  projectKey={projectKey}
                  item={item}
                  onDeleted={id => setUploadedMedia(prev => prev.filter(m => m.id !== id))}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {mediaItems.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-gray-200">
          <ImageOff className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 font-medium">{t.mlNoMedia}</p>
          <p className="text-sm text-gray-400 mt-1">{t.mlAdjustFilters}</p>
        </div>
      ) : (
      <div className="space-y-4">
        {projectKey && <h3 className="text-sm font-black text-gray-800">From Field Reports</h3>}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder={t.mlSearchPlaceholder}
            className="w-full pl-11 pr-4 py-3 bg-white border border-gray-100 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20 shadow-sm transition-all"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {filteredMedia.length === 0 && (
          <div className="text-center py-16 bg-white rounded-3xl border border-dashed border-gray-200">
            <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No photos match "{search}"</p>
            <p className="text-sm text-gray-400 mt-1">Try a different keyword or clear the search.</p>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
        {filteredMedia.map((r) => {
          const thumb = getDriveThumbnailUrl(r.attachmentUrl!, 'w800');
          const downloadUrl = getDriveDownloadUrl(r.attachmentUrl!) || r.attachmentUrl!;
          const isWhatsapp = r.source === 'whatsapp';

          return (
            <div key={r.id} className="bg-white rounded-3xl overflow-hidden border border-gray-100 shadow-sm flex flex-col group transition-all hover:shadow-md">
              <div className="relative aspect-[4/3] bg-gray-100 overflow-hidden">
                <img
                  src={thumb || r.attachmentUrl!}
                  alt={r.description}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                  <a
                    href={downloadUrl}
                    download
                    title={t.mlDownload}
                    aria-label={t.mlDownload}
                    className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-md transition-all"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                  <a
                    href={r.attachmentUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-md transition-all"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>

              <div className="p-3 sm:p-4 space-y-2.5 sm:space-y-3">
                <div className="flex flex-wrap gap-2">
                  <span className="flex items-center gap-1 bg-green-50 text-green-700 text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border border-green-100">
                    <Briefcase className="w-3 h-3" />
                    {r.project}
                  </span>
                  <span className="flex items-center gap-1 bg-blue-50 text-blue-700 text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border border-blue-100">
                    <Tag className="w-3 h-3" />
                    {r.areaOfIntervention}
                  </span>
                  <span className={`flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${isWhatsapp ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                    {isWhatsapp ? <MessageCircle className="w-3 h-3" /> : <FileSpreadsheet className="w-3 h-3" />}
                    {isWhatsapp ? t.mlSourceWhatsapp : t.mlSourceSheet}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4">
                  <div className="flex items-start gap-2 min-w-0">
                    <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">{t.mlLocation}</p>
                      <p className="text-xs text-gray-700 font-bold truncate">{r.location}, {r.state}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 min-w-0">
                    <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">{t.mlDate}</p>
                      <p className="text-xs text-gray-700 font-bold">{new Date(r.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 min-w-0 col-span-2">
                    <User className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">{t.mlContributor}</p>
                      <p className="text-xs text-gray-700 font-bold">{r.name}</p>
                    </div>
                  </div>
                </div>

                {r.description && (
                  <div className="pt-2 border-t border-gray-50">
                    <p className="text-xs text-gray-500 italic line-clamp-2">"{r.description}"</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>
      )}

      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={cancelPendingUpload}>
          <div
            className="bg-white rounded-2xl w-full flex flex-col gap-4 p-6"
            style={{ maxWidth: 420 }}
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm font-bold text-gray-800 truncate">{pendingFile.name}</p>

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-gray-400">
                Category
                {suggesting && <Loader2 className="w-3 h-3 animate-spin" />}
                {!suggesting && suggestedCategory && pendingCategory === suggestedCategory && (
                  <span className="flex items-center gap-1 font-bold normal-case tracking-normal" style={{ color: '#7C3AED' }}>
                    <Sparkles className="w-3 h-3" /> AI suggested
                  </span>
                )}
              </div>
              <select
                value={pendingCategory ?? ''}
                onChange={e => setPendingCategory(e.target.value || null)}
                className="text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 text-gray-700"
              >
                <option value="">— none —</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={cancelPendingUpload}
                className="text-sm font-semibold px-4 py-2 rounded-lg border border-gray-200 text-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={confirmPendingUpload}
                disabled={!pendingDataUrl || uploading}
                className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-60"
                style={{ background: '#341272' }}
              >
                {uploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
