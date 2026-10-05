import { apiFetch } from '../../utils/apiFetch'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import { useOrg } from '../../context/OrgContext'
import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  X, Sparkles, Copy, CheckCheck, AlertCircle, Loader2,
  Instagram, Facebook, Twitter, Linkedin, Download, ChevronLeft, ChevronRight,
  FolderOpen, RefreshCw, Info, MapPin, Briefcase,
} from 'lucide-react'
import type { DailyReport } from '../../types/report'
import { getDriveThumbnailUrl, extractDriveFileId } from '../../utils/driveImage'
import { exportToDocx } from '../../utils/docxExport'
import { MultiSelect } from './MultiSelect'
import { REPORT_LANGUAGES } from '../../constants/reportLanguages'

interface DrivePhoto {
  id:    string
  thumb: string
  full:  string
  drive: string
  location: string
  date:  string
  project: string
  source: 'report' | 'drive'
  // Report-sourced photos only; '' for Drive photos.
  description: string
}

interface Props {
  reports:         DailyReport[]
  scope:           'project' | 'organization'
  scopeName:       string
  defaultPlatform?: Platform
  onClose:         () => void
}

type Platform      = 'instagram' | 'facebook' | 'twitter' | 'linkedin'
type Tone          = 'inspiring' | 'celebratory' | 'professional' | 'urgent'
type VariantStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

interface VariantState {
  text:   string
  status: VariantStatus
  error:  string
}

const VARIANTS_PER_PLATFORM = 2

const PLATFORMS: { key: Platform; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'instagram', label: 'Instagram', icon: <Instagram className="w-4 h-4" />, color: '#E1306C' },
  { key: 'facebook',  label: 'Facebook',  icon: <Facebook  className="w-4 h-4" />, color: '#1877F2' },
  { key: 'twitter',   label: 'X / Twitter', icon: <Twitter className="w-4 h-4" />, color: '#000000' },
  { key: 'linkedin',  label: 'LinkedIn',  icon: <Linkedin  className="w-4 h-4" />, color: '#0A66C2' },
]

// Only Instagram and X enforce a hard limit.
const CHAR_LIMITS: Partial<Record<Platform, number>> = {
  instagram: 2200,
  twitter:   280,
}

const TONES: { key: Tone; label: string; emoji: string }[] = [
  { key: 'inspiring',    label: 'Inspiring',    emoji: '✨' },
  { key: 'celebratory',  label: 'Celebratory',  emoji: '🎉' },
  { key: 'professional', label: 'Professional', emoji: '💼' },
  { key: 'urgent',       label: 'Urgent',       emoji: '🔥' },
]

function emptyVariant(): VariantState {
  return { text: '', status: 'idle', error: '' }
}

function emptyResults(): Record<Platform, VariantState[]> {
  return {
    instagram: Array.from({ length: VARIANTS_PER_PLATFORM }, emptyVariant),
    facebook:  Array.from({ length: VARIANTS_PER_PLATFORM }, emptyVariant),
    twitter:   Array.from({ length: VARIANTS_PER_PLATFORM }, emptyVariant),
    linkedin:  Array.from({ length: VARIANTS_PER_PLATFORM }, emptyVariant),
  }
}

// Aggregate per-platform status from its variants, for the platform switcher badges.
function summarizeStatus(variants: VariantState[]): VariantStatus {
  if (variants.some(v => v.status === 'error')) return 'error'
  if (variants.every(v => v.status === 'done')) return 'done'
  if (variants.some(v => v.status === 'loading' || v.status === 'streaming')) return 'loading'
  return 'idle'
}

export function SocialPostModal({ reports, scope, scopeName, defaultPlatform, onClose }: Props) {
  const { org } = useOrg()
  const [tone,       setTone]       = useState<Tone>('inspiring')
  const [copied,     setCopied]     = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [carouselIdx, setCarouselIdx] = useState(0)
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set())
  const [selectedLanguage, setSelectedLanguage] = useState('English')

  // Every platform generates VARIANTS_PER_PLATFORM captions at once.
  const [hasGenerated,     setHasGenerated]     = useState(false)
  const [results,          setResults]          = useState(emptyResults())
  const [activePlatform,   setActivePlatform]   = useState<Platform>(defaultPlatform ?? 'instagram')
  const [activeVariantIdx, setActiveVariantIdx] = useState(0)

  // These filters scope both the photo grid and the AI data context (reportAggregate).
  const [previewPhotoId,  setPreviewPhotoId]  = useState<string | null>(null)
  const [dateFrom,        setDateFrom]        = useState('')
  const [dateTo,          setDateTo]          = useState('')
  const [filterProjects,  setFilterProjects]  = useState<string[]>([])
  const [filterLocations, setFilterLocations] = useState<string[]>([])

  const [drivePhotos,  setDrivePhotos]  = useState<DrivePhoto[]>([])
  const [driveLoading, setDriveLoading] = useState(false)
  const [driveError,   setDriveError]   = useState('')
  const [folderId,     setFolderId]     = useState('')
  const [showDriveBox, setShowDriveBox] = useState(false)

  // Every in-flight fetch registers here so closing the modal cancels all of them.
  const controllersRef = useRef<Set<AbortController>>(new Set())

  // Drawn from the full `reports` pool so the filter always offers every choice.
  const projectOptions = useMemo(
    () => [...new Set(reports.map(r => r.project).filter(Boolean))].sort(),
    [reports]
  )

  // Date + project filtered; the pool Location options are drawn from.
  const projectDateReports = useMemo(() => {
    return reports.filter(r => {
      if (filterProjects.length > 0 && !filterProjects.includes(r.project)) return false
      if (dateFrom || dateTo) {
        const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : ''
        if (!date) return false
        if (dateFrom && date < dateFrom) return false
        if (dateTo   && date > dateTo)   return false
      }
      return true
    })
  }, [reports, filterProjects, dateFrom, dateTo])

  const locationOptions = useMemo(
    () => [...new Set(projectDateReports.map(r => r.location).filter(Boolean))].sort(),
    [projectDateReports]
  )

  // Blank filters mean the whole scope, same as the report pickers.
  const scopedReports = useMemo(() => {
    if (filterLocations.length === 0) return projectDateReports
    return projectDateReports.filter(r => filterLocations.includes(r.location))
  }, [projectDateReports, filterLocations])

  const reportPhotos: DrivePhoto[] = useMemo(() => {
    return scopedReports
      .filter(r => r.attachmentUrl)
      .map(r => {
        const fileId = extractDriveFileId(r.attachmentUrl!)
        return {
          id:    r.id,
          thumb: getDriveThumbnailUrl(r.attachmentUrl!, 'w800')!,
          full:  fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : getDriveThumbnailUrl(r.attachmentUrl!, 'w1600')!,
          drive: r.attachmentUrl!,
          location: r.location,
          date:  r.timestamp,
          project: r.project,
          source: 'report' as const,
          description: r.description || '',
        }
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [scopedReports])

  // Drive photos (curated) first, then report photos
  const photos: DrivePhoto[] = useMemo(
    () => [...drivePhotos, ...reportPhotos],
    [drivePhotos, reportPhotos]
  )

  // Aggregated client-side: sending raw `reports` hit 413 for larger orgs, and the
  // backend only needs these aggregates plus a few highlight lines.
  const reportAggregate = useMemo(() => {
    const totalBenef = scopedReports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
    const states      = [...new Set(scopedReports.map(r => r.state).filter(Boolean))]
    const projects    = [...new Set(scopedReports.map(r => r.project).filter(Boolean))]
    const areas       = [...new Set(scopedReports.map(r => r.areaOfIntervention).filter(Boolean))]
    const withPhotos  = scopedReports.filter(r => r.attachmentUrl)
    const source      = withPhotos.length > 0 ? withPhotos : scopedReports
    const highlights  = source
      .slice(0, 8)
      .map((r, i) => `${i + 1}. ${r.location}, ${r.state} — ${String(r.description).slice(0, 200)}`)
      .join('\n')
    return { reportCount: scopedReports.length, totalBenef, states, projects, areas, highlights }
  }, [scopedReports])

  async function loadDriveFolder() {
    if (!folderId.trim()) { setDriveError('Enter a Google Drive folder ID first.'); return }
    setDriveLoading(true)
    setDriveError('')
    try {
      const res = await apiFetch('/api/drive-folder', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ folderId }),
      })
      const data = await res.json()
      if (data.error) {
        setDriveError(data.error)
        setDrivePhotos([])
      } else {
        const mapped: DrivePhoto[] = (data.files || []).map((f: any) => ({
          id:       `drive-${f.id}`,
          thumb:    f.thumb,
          full:     f.full,
          drive:    f.drive,
          location: f.name,
          date:     f.createdTime || '',
          project:  scopeName,
          source:   'drive' as const,
          description: '',
        }))
        setDrivePhotos(mapped)
        setSelectedImages(new Set(mapped.slice(0, 4).map(p => p.id)))
        setShowDriveBox(false)
      }
    } catch (e) {
      setDriveError(e instanceof Error ? e.message : 'Failed to load folder')
    } finally {
      setDriveLoading(false)
    }
  }

  useEffect(() => {
    if (drivePhotos.length === 0 && reportPhotos.length > 0) {
      setSelectedImages(new Set(reportPhotos.slice(0, 4).map(p => p.id)))
    }
  }, [reportPhotos, drivePhotos.length])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  function currentPhotoMeta() {
    return photos
      .filter(p => selectedImages.has(p.id))
      .map(p => ({
        location: p.location,
        date:     p.date,
        project:  p.project,
        source:   p.source,
        thumb:    p.thumb,   // backend fetches this as inline_data for Gemini vision
      }))
  }

  async function streamVariant(platformKey: Platform, variantIdx: number, selectedPhotoMeta: ReturnType<typeof currentPhotoMeta>) {
    const setVariant = (updater: (v: VariantState) => VariantState) => {
      setResults(prev => ({
        ...prev,
        [platformKey]: prev[platformKey].map((v, i) => i === variantIdx ? updater(v) : v),
      }))
    }

    const controller = new AbortController()
    controllersRef.current.add(controller)
    setVariant(() => ({ text: '', status: 'loading', error: '' }))

    try {
      const res = await apiFetch('/api/generate-social-post', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          ...reportAggregate,
          platform: platformKey,
          tone, scope, scopeName,
          language: selectedLanguage,
          selectedPhotos: selectedPhotoMeta,
          variantHint: VARIANTS_PER_PLATFORM > 1
            ? `Write variation ${variantIdx + 1} of ${VARIANTS_PER_PLATFORM} for this same post — use a different opening line and angle than a typical take so it reads as genuinely distinct, not a reworded duplicate.`
            : undefined,
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `Server error: ${res.status}`)
      }

      setVariant(v => ({ ...v, status: 'streaming' }))
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer   = ''
      let finished = false
      let sawError = false

      const processLines = (buf: string): string => {
        const lines     = buf.split('\n')
        const remaining = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { finished = true; return '' }
          try {
            const p = JSON.parse(raw) as { text?: string; error?: string }
            if (p.error) {
              setVariant(v => ({ ...v, status: 'error', error: p.error! }))
              sawError = true; finished = true; return ''
            }
            if (p.text) setVariant(v => ({ ...v, text: v.text + p.text }))
          } catch {}
        }
        return remaining
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) { if (buffer.trim()) processLines(buffer + '\n'); break }
        buffer += decoder.decode(value, { stream: true })
        buffer  = processLines(buffer)
        if (finished) break
      }
      if (!sawError) setVariant(v => ({ ...v, status: 'done' }))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setVariant(v => ({ ...v, status: 'error', error: e instanceof Error ? e.message : 'Unknown error' }))
    } finally {
      controllersRef.current.delete(controller)
    }
  }

  async function generateAll() {
    setHasGenerated(true)
    setResults(emptyResults())
    setActiveVariantIdx(0)
    const selectedPhotoMeta = currentPhotoMeta()
    await Promise.all(
      PLATFORMS.flatMap(p =>
        Array.from({ length: VARIANTS_PER_PLATFORM }, (_, variantIdx) => streamVariant(p.key, variantIdx, selectedPhotoMeta))
      )
    )
  }

  function regenerateVariant(platformKey: Platform, variantIdx: number) {
    streamVariant(platformKey, variantIdx, currentPhotoMeta())
  }

  function handleClose() {
    controllersRef.current.forEach(c => c.abort())
    onClose()
  }

  async function copyPost(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for restricted contexts (insecure origins, denied permission)
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function toggleImage(id: string) {
    setSelectedImages(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function downloadImage(url: string, filename: string) {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = filename
      link.click()
      URL.revokeObjectURL(link.href)
    } catch {
      window.open(url, '_blank')
    }
  }

  async function handleDownloadDoc(text: string) {
    if (!text || downloading) return
    setDownloading(true)
    try {
      const selectedPhotos = photos.filter(p => selectedImages.has(p.id))
      const imageUrls = selectedPhotos.map(p => p.thumb)
      await exportToDocx(`${scopeName} - ${activePlatformInfo.label} Post`, text, imageUrls, {
        orgName: org?.branding?.org_name || scopeName,
      })
    } finally {
      setDownloading(false)
    }
  }

  const selectedPhotos    = photos.filter(p => selectedImages.has(p.id))
  const currentPhoto      = selectedPhotos[carouselIdx] ?? selectedPhotos[0]
  const activePlatformInfo = PLATFORMS.find(p => p.key === activePlatform) ?? PLATFORMS[0]
  const activeVariants    = results[activePlatform]
  const activeVariant     = activeVariants[activeVariantIdx] ?? activeVariants[0]
  const charLimit         = CHAR_LIMITS[activePlatform]
  const overLimit         = charLimit != null && activeVariant.text.length > charLimit

  // Drive photos aren't tied to a report, so location still post-filters them
  // (a no-op for report photos, which are already scoped).
  const visiblePhotos = photos.filter(p =>
    filterLocations.length === 0 || filterLocations.includes(p.location)
  )
  const previewPhoto = photos.find(p => p.id === previewPhotoId) ?? null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center backdrop-blur-sm"
    >
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl flex flex-col"
        style={{ height: '94vh' }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-white shadow-sm">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-bold text-gray-900 text-sm leading-tight">Social Media Post</h2>
              <p className="text-[11px] text-gray-500">{scope === 'organization' ? 'Organization-wide' : scopeName}</p>
            </div>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">

          {!hasGenerated && (
            <>
              <div className="px-5 pt-4">
                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-2">Tone</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {TONES.map(t => {
                    const active = t.key === tone
                    return (
                      <button
                        key={t.key}
                        onClick={() => setTone(t.key)}
                        className={`flex flex-col items-center gap-0.5 py-2 rounded-xl border transition ${
                          active
                            ? 'bg-green-50 border-green-300 text-green-700'
                            : 'bg-gray-50 border-gray-100 text-gray-500 hover:bg-gray-100'
                        }`}
                      >
                        <span className="text-base">{t.emoji}</span>
                        <span className="text-[10px] font-semibold">{t.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Output language of the post, not the UI language */}
              <div className="px-5 mt-4">
                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-2">Language</p>
                <div className="flex flex-wrap gap-2">
                  {REPORT_LANGUAGES.map(lang => (
                    <button
                      key={lang}
                      onClick={() => setSelectedLanguage(lang)}
                      className="text-xs px-3 py-1.5 rounded-full border transition font-medium"
                      style={{
                        background:  selectedLanguage === lang ? '#16a34a' : '#F0FDF4',
                        color:       selectedLanguage === lang ? '#ffffff' : '#16a34a',
                        borderColor: selectedLanguage === lang ? '#16a34a' : '#BBF7D0',
                      }}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              </div>

              {/* Data scope: narrows both the photo picker and the AI context */}
              <div className="px-5 mt-4">
                <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-2">Data scope (optional)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    type="date"
                    value={dateFrom}
                    max={dateTo || undefined}
                    onChange={e => setDateFrom(e.target.value)}
                    className="flex-1 text-[11px] font-semibold border border-gray-200 rounded-lg px-2 py-1.5 bg-gray-50 text-gray-600"
                  />
                  <input
                    type="date"
                    value={dateTo}
                    min={dateFrom || undefined}
                    onChange={e => setDateTo(e.target.value)}
                    className="flex-1 text-[11px] font-semibold border border-gray-200 rounded-lg px-2 py-1.5 bg-gray-50 text-gray-600"
                  />
                </div>
                {(projectOptions.length > 1 || locationOptions.length > 1) && (
                  <div className="flex flex-wrap gap-2">
                    {projectOptions.length > 1 && (
                      <MultiSelect
                        label="Project"
                        placeholder="Project"
                        options={projectOptions}
                        selected={filterProjects}
                        onChange={sel => { setFilterProjects(sel); setFilterLocations([]) }}
                      />
                    )}
                    {locationOptions.length > 1 && (
                      <MultiSelect
                        label="Location"
                        placeholder="Location"
                        options={locationOptions}
                        selected={filterLocations}
                        onChange={setFilterLocations}
                      />
                    )}
                  </div>
                )}
                {(dateFrom || dateTo || filterProjects.length > 0 || filterLocations.length > 0) && (
                  <button
                    onClick={() => { setDateFrom(''); setDateTo(''); setFilterProjects([]); setFilterLocations([]) }}
                    className="mt-1.5 text-[11px] font-semibold text-gray-400 hover:text-gray-600"
                  >
                    Clear data scope filters
                  </button>
                )}
              </div>

              <div className="px-5 mt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
                    Media Source
                  </p>
                  <button
                    onClick={() => setShowDriveBox(v => !v)}
                    className="text-[10px] text-blue-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <FolderOpen className="w-3 h-3" />
                    {drivePhotos.length > 0 ? 'Change folder' : 'Add Drive folder'}
                  </button>
                </div>

                {showDriveBox && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-2">
                    <label className="block text-[10px] font-bold text-blue-700 mb-1">Google Drive Folder ID</label>
                    <input
                      type="text"
                      value={folderId}
                      onChange={e => setFolderId(e.target.value.trim())}
                      placeholder="e.g. 1uVU6JYHG6uhK1VJRYO1urm8-lU9cpiZD"
                      className="w-full text-xs bg-white border border-blue-200 rounded-lg px-2 py-1.5 mb-2 font-mono"
                    />
                    <button
                      onClick={loadDriveFolder}
                      disabled={driveLoading}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-1.5 rounded-lg disabled:opacity-50"
                    >
                      {driveLoading ? 'Loading…' : 'Load folder'}
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 text-[11px]">
                  {driveLoading && (
                    <span className="flex items-center gap-1 text-gray-500">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading from Drive…
                    </span>
                  )}
                  {!driveLoading && drivePhotos.length > 0 && (
                    <span className="flex items-center gap-1 text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                      <FolderOpen className="w-3 h-3" />
                      {drivePhotos.length} media files from Drive
                      <button
                        onClick={loadDriveFolder}
                        className="ml-1 hover:text-green-900"
                        title="Refresh"
                      >
                        <RefreshCw className="w-3 h-3" />
                      </button>
                    </span>
                  )}
                  {reportPhotos.length > 0 && (
                    <span className="text-gray-500">
                      + {reportPhotos.length} from reports
                    </span>
                  )}
                </div>

                {driveError && (
                  <div className="mt-2 bg-amber-50 border border-amber-200 text-amber-800 text-[11px] p-2 rounded-lg whitespace-pre-wrap leading-relaxed">
                    <div className="flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div>{driveError}</div>
                    </div>
                  </div>
                )}
              </div>

              {photos.length > 0 && (
                <div className="px-5 mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
                      Photos ({selectedImages.size}/{photos.length} selected)
                    </p>
                    <button
                      onClick={() => setSelectedImages(new Set(visiblePhotos.slice(0, 10).map(p => p.id)))}
                      className="text-[10px] text-green-600 font-semibold hover:underline"
                    >
                      Top 10
                    </button>
                  </div>


                  {visiblePhotos.length === 0 ? (
                    <p className="text-[11px] text-gray-400 py-3">No photos match this project/location combination.</p>
                  ) : (
                    <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                      {visiblePhotos.map(p => {
                        const isSelected = selectedImages.has(p.id)
                        return (
                          <div key={p.id} className="relative shrink-0 snap-start">
                            <button
                              onClick={() => toggleImage(p.id)}
                              className={`relative block w-16 h-16 rounded-lg overflow-hidden border-2 transition ${
                                isSelected ? 'border-green-500 ring-2 ring-green-200' : 'border-gray-200 opacity-60'
                              }`}
                            >
                              <img
                                src={p.thumb}
                                alt=""
                                className="w-full h-full object-cover"
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                              {p.source === 'drive' && (
                                <div className="absolute bottom-0.5 left-0.5 bg-blue-600 text-white text-[7px] font-bold px-1 py-px rounded">
                                  DRIVE
                                </div>
                              )}
                              {isSelected && (
                                <div className="absolute top-0.5 right-0.5 bg-green-500 rounded-full w-4 h-4 flex items-center justify-center">
                                  <CheckCheck className="w-2.5 h-2.5 text-white" />
                                </div>
                              )}
                            </button>
                            {/* Background story: report-sourced photos only */}
                            <button
                              onClick={e => { e.stopPropagation(); setPreviewPhotoId(prev => prev === p.id ? null : p.id) }}
                              className={`absolute -top-1 -left-1 rounded-full flex items-center justify-center shadow transition ${
                                previewPhotoId === p.id ? 'bg-purple-600 text-white' : 'bg-white text-gray-500 hover:text-purple-600'
                              }`}
                              style={{ width: 18, height: 18 }}
                              title="View background story"
                            >
                              <Info className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {previewPhoto && (
                    <div className="mt-1 bg-purple-50 border border-purple-100 rounded-xl p-3 text-xs">
                      <div className="flex items-center gap-3 text-purple-700 font-semibold mb-1.5 flex-wrap">
                        {previewPhoto.location && (
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{previewPhoto.location}</span>
                        )}
                        {previewPhoto.project && (
                          <span className="flex items-center gap-1"><Briefcase className="w-3 h-3" />{previewPhoto.project}</span>
                        )}
                        {previewPhoto.date && (
                          <span className="text-purple-400 font-normal">
                            {new Date(previewPhoto.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                      <p className="text-gray-600 leading-relaxed">
                        {previewPhoto.description || 'No background story available for this photo — it came from a Drive folder, not a field report.'}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="px-5 py-6">
                <SubscriptionGate featureName="AI Social Post">
                  <button
                    onClick={generateAll}
                    disabled={reports.length === 0 || (selectedImages.size === 0 && photos.length > 0)}
                    className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold py-3 rounded-xl shadow-lg hover:shadow-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Sparkles className="w-4 h-4" />
                    Generate All Platforms
                  </button>
                </SubscriptionGate>
                <p className="text-[10px] text-gray-400 text-center mt-2">
                  {reports.length === 0
                    ? 'No field reports available — adjust your filters first.'
                    : `Based on ${reports.length} reports · ${photos.length} photos available · ${VARIANTS_PER_PLATFORM} variations per platform`}
                </p>
              </div>
            </>
          )}

          {hasGenerated && (
            <div className="px-5 pt-4 pb-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                {PLATFORMS.map(p => {
                  const active = p.key === activePlatform
                  const pStatus = summarizeStatus(results[p.key])
                  return (
                    <button
                      key={p.key}
                      onClick={() => { setActivePlatform(p.key); setActiveVariantIdx(0) }}
                      className={`relative flex flex-col items-center justify-center gap-1 py-3 rounded-xl border-2 transition-all ${
                        active
                          ? 'border-transparent text-white shadow-md scale-[1.02]'
                          : 'border-gray-100 bg-gray-50 text-gray-500 hover:bg-gray-100'
                      }`}
                      style={active ? { background: p.color } : {}}
                    >
                      {p.icon}
                      <span className="text-[10px] font-bold">{p.label}</span>
                      {pStatus === 'loading' && (
                        <Loader2 className={`absolute top-1.5 right-1.5 w-3 h-3 animate-spin ${active ? 'text-white' : 'text-pink-400'}`} />
                      )}
                      {pStatus === 'error' && (
                        <AlertCircle className={`absolute top-1.5 right-1.5 w-3 h-3 ${active ? 'text-white' : 'text-red-400'}`} />
                      )}
                      {pStatus === 'done' && (
                        <CheckCheck className={`absolute top-1.5 right-1.5 w-3 h-3 ${active ? 'text-white' : 'text-green-500'}`} />
                      )}
                    </button>
                  )
                })}
              </div>

              {VARIANTS_PER_PLATFORM > 1 && (
                <div className="flex gap-2 mb-3">
                  {activeVariants.map((v, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveVariantIdx(i)}
                      className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border transition ${
                        i === activeVariantIdx
                          ? 'bg-purple-600 border-purple-600 text-white'
                          : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {(v.status === 'loading' || v.status === 'streaming') && <Loader2 className="w-3 h-3 animate-spin" />}
                      {v.status === 'error' && <AlertCircle className="w-3 h-3" />}
                      Variant {i + 1}
                    </button>
                  ))}
                </div>
              )}

              {(activeVariant.status === 'loading') && (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-gray-500">
                  <Loader2 className="w-7 h-7 animate-spin text-pink-500" />
                  <p className="text-sm font-medium">Crafting your {activePlatformInfo.label} post…</p>
                </div>
              )}

              {activeVariant.status === 'error' && (
                <div className="py-2">
                  <div className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-semibold">Generation failed</p>
                      <p className="text-xs mt-1 whitespace-pre-wrap">{activeVariant.error}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => regenerateVariant(activePlatform, activeVariantIdx)}
                    className="mt-3 w-full text-sm text-pink-600 border border-pink-300 rounded-xl py-2.5 hover:bg-pink-50 transition font-semibold"
                  >
                    Try Again
                  </button>
                </div>
              )}

              {(activeVariant.status === 'streaming' || activeVariant.status === 'done') && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400">Preview</p>
                      {activeVariant.status === 'done' && charLimit && (
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                            overLimit ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'
                          }`}
                          title={overLimit ? `Over ${activePlatformInfo.label}'s ${charLimit}-character limit — trim before posting` : undefined}
                        >
                          {activeVariant.text.length}/{charLimit}{overLimit ? ' — too long' : ''}
                        </span>
                      )}
                    </div>
                    {activeVariant.status === 'done' && (
                      <button
                        onClick={() => copyPost(activeVariant.text)}
                        className="flex items-center gap-1 text-[11px] text-gray-600 border border-gray-200 hover:bg-gray-50 px-2.5 py-1 rounded-lg transition"
                      >
                        {copied ? <CheckCheck className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                        {copied ? 'Copied!' : 'Copy text'}
                      </button>
                    )}
                  </div>

                  {/* Mock social card */}
                  <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">

                    <div className="flex items-center gap-2 p-3 border-b border-gray-100">
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0"
                        style={{ background: activePlatformInfo.color }}
                      >
                        {activePlatformInfo.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-gray-900 truncate">
                          {scope === 'organization' ? 'Our Organization' : scopeName}
                        </p>
                        <p className="text-[10px] text-gray-400">{activePlatformInfo.label} · just now</p>
                      </div>
                    </div>

                    {selectedPhotos.length > 0 && currentPhoto && (
                      <div className="relative bg-black" style={{ aspectRatio: activePlatform === 'instagram' ? '1' : '16/9' }}>
                        <img
                          src={currentPhoto.full}
                          alt="field photo"
                          className="w-full h-full object-cover"
                          onError={e => {
                            const el = e.currentTarget as HTMLImageElement
                            if (!el.src.includes('thumbnail')) {
                              el.src = currentPhoto.thumb
                            }
                          }}
                        />

                        {selectedPhotos.length > 1 && (
                          <>
                            <button
                              onClick={() => setCarouselIdx(i => (i - 1 + selectedPhotos.length) % selectedPhotos.length)}
                              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white p-1.5 rounded-full transition"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setCarouselIdx(i => (i + 1) % selectedPhotos.length)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white p-1.5 rounded-full transition"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>

                            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                              {selectedPhotos.map((_, i) => (
                                <span
                                  key={i}
                                  className={`w-1.5 h-1.5 rounded-full transition ${
                                    i === carouselIdx ? 'bg-white w-4' : 'bg-white/50'
                                  }`}
                                />
                              ))}
                            </div>

                            <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {carouselIdx + 1}/{selectedPhotos.length}
                            </div>
                          </>
                        )}

                        <button
                          onClick={() => downloadImage(currentPhoto.full, `field-photo-${currentPhoto.id}.jpg`)}
                          className="absolute bottom-2 right-2 bg-white/90 hover:bg-white text-gray-700 text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1 shadow"
                        >
                          <Download className="w-3 h-3" />
                          Save
                        </button>
                      </div>
                    )}

                    <div className="p-3">
                      <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                        {activeVariant.text}
                        {activeVariant.status === 'streaming' && (
                          <span className="inline-block w-1.5 h-3.5 bg-pink-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
                        )}
                      </p>
                    </div>
                  </div>

                  {activeVariant.status === 'done' && (
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <button
                        onClick={() => regenerateVariant(activePlatform, activeVariantIdx)}
                        className="flex items-center justify-center gap-1.5 text-xs font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 py-2.5 rounded-xl transition"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Regenerate
                      </button>
                      <button
                        onClick={() => handleDownloadDoc(activeVariant.text)}
                        disabled={downloading}
                        className="flex items-center justify-center gap-1.5 text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 py-2.5 rounded-xl transition border border-blue-200 disabled:opacity-50"
                      >
                        {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        {downloading ? '...' : 'DOC'}
                      </button>
                      <button
                        onClick={() => copyPost(activeVariant.text)}
                        className="flex items-center justify-center gap-1.5 text-xs font-bold text-white bg-gradient-to-r from-pink-500 to-purple-600 hover:opacity-90 py-2.5 rounded-xl transition"
                      >
                        {copied ? <CheckCheck className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={generateAll}
                className="w-full mt-4 text-xs font-bold text-gray-400 hover:text-gray-600 py-2 transition"
              >
                Start over — regenerate all platforms
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
