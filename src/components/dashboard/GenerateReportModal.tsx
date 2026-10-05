import { apiFetch } from '../../utils/apiFetch'
import { slimReportsForApi } from '../../utils/slimReport'
import { gatherContentHubReferenceData } from '../../utils/contentHubData'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import React, { useState, useRef, useEffect } from 'react'
import {
  X, FileText, Copy, CheckCheck, AlertCircle, Loader2,
  ExternalLink, Download, Printer, FileType, Bookmark, BookmarkCheck,
} from 'lucide-react'
import type { DailyReport, ActiveFilters } from '../../types/report'
import { getDriveThumbnailUrl } from '../../utils/driveImage'
import { exportToDocx } from '../../utils/docxExport'
import { useLanguage } from '../../context/LanguageContext'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { FF } from '../../theme/colors'

export interface ReportSubject {
  id?: string
  name: string
  phone?: string
}

interface Props {
  reports: DailyReport[]
  userName: string
  filters: ActiveFilters
  // Optional in page mode.
  onClose?: () => void
  // 'modal' (default) renders a fixed overlay; 'page' renders inline in the tab body.
  mode?: 'modal' | 'page'
  title?: string
  customInstruction?: string
  // When subjects[] is set, the identity header is shown and the request carries
  // { subjects, kind } so the server prompt emits a Subjects block.
  subjects?: ReportSubject[]
  kind?: 'self' | 'for_other' | 'team'
  // Contributors to pick from when subjects are empty; unset skips the picker.
  availableContributors?: ReportSubject[]
  // Open directly into the subject-picker step.
  pendingSubjectPick?: boolean
  // Output language chosen in the Content Hub picker; defaults to 'English'.
  initialLanguage?: string
}

type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

// ── Markdown renderer ─────────────────────────────────────────
const TABLE_LINE_RE = /^\|.+\|$/
const TABLE_SEP_RE  = /^\|[\s:|-]+\|$/
const splitTableRow = (l: string): string[] => l.trim().slice(1, -1).split('|').map(c => c.trim())
// Non-anchored: the model sometimes adds a bullet or trailing punctuation to the
// image line, and an anchored match would render the raw "![alt](url)" text.
const IMAGE_LINE_RE = /!\[([^\]]*)\]\((\S+?)\)/

export function MarkdownBlock({ text }: { text: string }) {
  const lines = text.split('\n')
  const els: React.ReactNode[] = []

  const inline = (s: string): React.ReactNode =>
    s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((p, i) => {
      if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
      if (p.startsWith('*')  && p.endsWith('*'))  return <em key={i}>{p.slice(1, -1)}</em>
      return p
    })

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Table block: collect the whole contiguous `|...|` run into one table.
    if (TABLE_LINE_RE.test(trimmed)) {
      const rows: string[][] = []
      while (i < lines.length && TABLE_LINE_RE.test(lines[i].trim())) {
        if (!TABLE_SEP_RE.test(lines[i].trim())) rows.push(splitTableRow(lines[i]))
        i++
      }
      if (rows.length > 0) {
        const [header, ...body] = rows
        els.push(
          <div key={`table-${i}`} className="my-4 overflow-x-auto rounded-xl border" style={{ borderColor: FF.border }}>
            <table className="w-full text-[11px] sm:text-xs">
              <thead>
                <tr style={{ background: FF.purple }}>
                  {header.map((cell, ci) => (
                    <th key={ci} className="text-left font-bold px-2 py-1.5 sm:px-3 sm:py-2 text-white whitespace-nowrap">
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} style={{ background: ri % 2 === 0 ? '#FFFFFF' : FF.bg }}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1.5 sm:px-3 sm:py-2 text-gray-700 border-t align-top" style={{ borderColor: FF.borderFaint }}>
                        {inline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      continue
    }

    // Image line: ![alt](url)
    const imgMatch = trimmed.match(IMAGE_LINE_RE)
    if (imgMatch) {
      const alt = imgMatch[1]
      const url = imgMatch[2].replace(/[)\].,;]+$/, '')
      const thumb = getDriveThumbnailUrl(url, 'w800')
      if (thumb) {
        els.push(
          <div key={i} className="my-6 rounded-2xl overflow-hidden border border-gray-100 shadow-xl bg-gray-50 group">
            <div className="relative">
              <img src={thumb} alt={alt} className="w-full h-auto object-cover max-h-[500px]" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              {alt && (
                <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-full group-hover:translate-y-0 transition-transform bg-white/90 backdrop-blur-sm">
                  <p className="text-[10px] font-bold text-gray-900 uppercase tracking-widest">{alt}</p>
                </div>
              )}
            </div>
          </div>
        )
        i++
        continue
      }
    }

    if      (line.startsWith('## '))  els.push(<h2 key={i} className="text-base font-bold mt-8 mb-3 pb-1 flex items-center gap-2" style={{ color: FF.purple, borderBottom: `1px solid ${FF.borderFaint}` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: FF.purple }} />
      {line.slice(3)}
    </h2>)
    else if (line.startsWith('### ')) els.push(<h3 key={i} className="text-sm font-semibold mt-5 mb-2" style={{ color: FF.tealDark }}>{line.slice(4)}</h3>)
    else if (line.startsWith('# '))   els.push(<h1 key={i} className="text-xl font-black mt-4 mb-4 tracking-tight" style={{ color: FF.purpleHover }}>{line.slice(2)}</h1>)
    else if (line.startsWith('- ') || line.startsWith('* '))
                                       els.push(<li key={i} className="ml-5 list-disc text-gray-700 my-1 text-sm leading-relaxed">{inline(line.slice(2))}</li>)
    else if (/^\d+\.\s/.test(line))   els.push(<li key={i} className="ml-5 list-decimal text-gray-700 my-1 text-sm leading-relaxed">{inline(line.replace(/^\d+\.\s/, ''))}</li>)
    else if (line.trim() === '')      els.push(<div key={i} className="h-3" />)
    else                              els.push(<p key={i} className="text-sm text-gray-700 leading-relaxed my-1.5">{inline(line)}</p>)
    i++
  }

  return <>{els}</>
}

// ── Section divider ───────────────────────────────────────────
export function SectionDivider({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className="w-9 h-9 rounded-xl bg-green-600 flex items-center justify-center text-white shrink-0 shadow-sm">
        {icon}
      </div>
      <div>
        <p className="font-bold text-gray-900 text-sm">{title}</p>
        {sub && <p className="text-xs text-gray-400">{sub}</p>}
      </div>
      <div className="flex-1 h-px bg-gray-100" />
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Markdown → HTML (for print popup) ────────────────────────
// Each text segment goes through escInline before concatenation: the result is
// written via document.write() into a same-origin popup that can read the auth token, so
// model output (possibly prompt-injected) must never reach the DOM unescaped.
const HTML_THEME = { purple: '#341272', purpleDark: '#1D0752', teal: '#0E3A46', border: '#D9E6E8', stripe: '#F5F3FF', muted: '#5C7378' }

function markdownToHtml(mdRaw: string): string {
  const lines = mdRaw.split('\n')
  const out: string[] = []
  const escInline = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  const isTableLine = (l: string) => /^\|.+\|$/.test(l.trim())
  const isSepLine    = (l: string) => /^\|[\s:|-]+\|$/.test(l.trim())
  const splitRow     = (l: string) => l.trim().slice(1, -1).split('|').map(c => c.trim())

  let inList = false
  const closeListIfOpen = () => { if (inList) { out.push('</ul>'); inList = false } }

  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // Table block: collect the whole contiguous `|...|` run into one table.
    if (isTableLine(trimmed)) {
      closeListIfOpen()
      const rows: string[][] = []
      while (i < lines.length && isTableLine(lines[i].trim())) {
        if (!isSepLine(lines[i].trim())) rows.push(splitRow(lines[i]))
        i++
      }
      if (rows.length > 0) {
        const [header, ...body] = rows
        out.push(`<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:12px">`)
        out.push('<thead><tr>' + header.map(c =>
          `<th style="background:${HTML_THEME.purple};color:#fff;text-align:left;padding:8px 10px;border:1px solid ${HTML_THEME.border}">${escInline(c)}</th>`
        ).join('') + '</tr></thead>')
        out.push('<tbody>' + body.map((row, ri) =>
          `<tr style="background:${ri % 2 === 0 ? '#FFFFFF' : HTML_THEME.stripe}">` +
          row.map(c => `<td style="padding:8px 10px;border:1px solid ${HTML_THEME.border};vertical-align:top">${escInline(c)}</td>`).join('') +
          '</tr>'
        ).join('') + '</tbody></table>')
      }
      continue
    }

    // Inline field photo (non-anchored match). Hotlinked to Drive's thumbnail endpoint,
    // not /api/proxy-image: that route needs a Bearer token a plain <img> can't send.
    const imgMatch = trimmed.match(IMAGE_LINE_RE)
    if (imgMatch) {
      closeListIfOpen()
      const alt = imgMatch[1]
      const url = imgMatch[2].replace(/[)\].,;]+$/, '')
      const thumb = getDriveThumbnailUrl(url, 'w800')
      if (!thumb) { i++; continue }
      out.push(`<div style="margin:20px 0;text-align:center;break-inside:avoid">`)
      out.push(`<img src="${thumb}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:8px;border:1px solid ${HTML_THEME.border}" />`)
      if (alt) out.push(`<p style="font-size:11px;color:${HTML_THEME.muted};font-style:italic;margin-top:6px">${escInline(alt)}</p>`)
      out.push('</div>')
      i++
      continue
    }

    if (trimmed.startsWith('### ')) {
      closeListIfOpen()
      out.push(`<h3 style="font-size:14px;font-weight:700;margin:16px 0 6px;color:${HTML_THEME.teal}">${escInline(trimmed.slice(4))}</h3>`)
      i++; continue
    }
    if (trimmed.startsWith('## ')) {
      closeListIfOpen()
      out.push(`<h2 style="font-size:16px;font-weight:800;color:${HTML_THEME.purple};margin:24px 0 8px;border-bottom:2px solid ${HTML_THEME.border};padding-bottom:4px">${escInline(trimmed.slice(3))}</h2>`)
      i++; continue
    }
    if (trimmed.startsWith('# ')) {
      closeListIfOpen()
      out.push(`<h1 style="font-size:20px;font-weight:900;margin:0 0 16px;text-align:center;color:${HTML_THEME.purpleDark}">${escInline(trimmed.slice(2))}</h1>`)
      i++; continue
    }
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px">'); inList = true }
      out.push(`<li style="margin:4px 0">${escInline(trimmed.slice(2))}</li>`)
      i++; continue
    }
    closeListIfOpen()
    if (trimmed === '') { out.push('<div style="height:10px"></div>'); i++; continue }
    out.push(`<p style="margin:8px 0">${escInline(trimmed)}</p>`)
    i++
  }
  closeListIfOpen()
  return out.join('\n')
}

// Starts generation on mount; the Content Hub picker already collected every input.
// Rendered inside <SubscriptionGate>, so it only fires for subscribed orgs.
function AutoGenerate({ onGenerate }: { onGenerate: () => void }) {
  useEffect(() => { onGenerate() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500">
      <Loader2 className="w-8 h-8 animate-spin text-green-600" />
      <p className="text-sm font-medium">Starting…</p>
    </div>
  )
}

export function GenerateReportModal({
  reports, userName, filters, onClose: _onCloseRaw,
  mode = 'modal',
  title, customInstruction,
  subjects: initialSubjects = [], kind: initialKind, availableContributors = [],
  pendingSubjectPick = false,
  initialLanguage,
}: Props) {
  const onClose = _onCloseRaw ?? (() => {})
  const { t } = useLanguage()
  const [status,           setStatus]           = useState<Status>('idle')
  const [subjects, setSubjects] = useState<ReportSubject[]>(initialSubjects)
  const [pickingSubjects, setPickingSubjects] = useState(pendingSubjectPick && initialSubjects.length === 0)
  const reportKind: 'self' | 'for_other' | 'team' =
    initialKind ?? (subjects.length > 1 ? 'team' : subjects.length === 1 ? 'for_other' : 'self')
  const [reportText,       setReportText]       = useState('')
  const [errorMsg,         setErrorMsg]         = useState('')
  const [copied,           setCopied]           = useState(false)
  const [copiedPlain,      setCopiedPlain]      = useState(false)
  const [downloading,      setDownloading]      = useState(false)
  const [saving,           setSaving]           = useState(false)
  const [saved,            setSaved]            = useState(false)
  const [lightbox,         setLightbox]         = useState<{ img: string; drive: string } | null>(null)
  // Language is chosen in the Content Hub picker and passed in as initialLanguage.
  const selectedLanguage = initialLanguage || 'English'

  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef  = useRef<AbortController | null>(null)

  function handleClose() { abortRef.current?.abort(); onClose() }

  useEscapeKey(handleClose)

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  useEffect(() => {
    if (status === 'streaming' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [reportText, status])

  async function generate() {
    setStatus('loading')
    setReportText('')
    setErrorMsg('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      // Slim + cap the payload to stay under the 5 MB body-parser limit (HTTP 413).
      const slimReports = slimReportsForApi(reports)

      // Attach structured project/beneficiary reference data so the AI grounds targets
      // and budgets in real records. Best-effort: failure never blocks generation.
      const scopeProjects = filters.project.length > 0
        ? filters.project
        : [...new Set(reports.map(r => r.project).filter(Boolean))]
      const supplementaryData = await gatherContentHubReferenceData(scopeProjects, filters)
        .catch(() => [])

      const res = await apiFetch('/api/get-ai-report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          reports: slimReports,
          userName,
          filters,
          instruction: customInstruction,
          audience: '',
          language: selectedLanguage,
          // Named employees this report is about; the server emits a Subjects block.
          subjects,
          kind: reportKind,
          supplementaryData,
        }),
        signal:  controller.signal,
      })

      if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`)

      setStatus('streaming')
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let finished  = false

      const processLines = (buf: string): string => {
        const lines     = buf.split('\n')
        const remaining = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { finished = true; return '' }
          try {
            const p = JSON.parse(raw) as { text?: string; error?: string }
            if (p.error) { setErrorMsg(p.error); setStatus('error'); finished = true; return '' }
            if (p.text)  setReportText(prev => prev + p.text)
          } catch { /* skip */ }
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
      setStatus('done')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setErrorMsg(e instanceof Error ? e.message : 'Unknown error')
      setStatus('error')
    }
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(reportText)
    } catch {
      // Fallback for restricted contexts (insecure origins, denied permission)
      const ta = document.createElement('textarea')
      ta.value = reportText
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

  async function copyPlainText() {
    const plain = reportText
      .replace(/!\[.*?\]\(.*?\)/g, '')          // images
      .replace(/\[(.+?)\]\(.*?\)/g, '$1')       // links → label only
      .replace(/^#{1,6}\s+/gm, '')              // headings
      .replace(/\*\*(.+?)\*\*/g, '$1')          // bold
      .replace(/\*(.+?)\*/g, '$1')              // italic
      .replace(/^[-*]\s+/gm, '• ')              // bullets
      .replace(/^\d+\.\s+/gm, (m) => m)         // numbered lists (keep)
      .replace(/\|/g, ' ')                       // table pipes
      .trim()
    try {
      await navigator.clipboard.writeText(plain)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = plain
      ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopiedPlain(true)
    setTimeout(() => setCopiedPlain(false), 2000)
  }

  async function saveReport() {
    if (!reportText || saving || saved) return
    setSaving(true)
    try {
      await apiFetch('/api/saved-reports', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          title:       title || 'Field Report',
          content:     reportText,
          reportCount: reports.length,
          filters,
          // Persisted so Saved Reports can show "Report on <subjects> · by <generator>" and filter by subject.
          subjects,
          kind: reportKind,
        }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      console.error('Failed to save report', e)
    } finally {
      setSaving(false)
    }
  }

  async function handleDownloadDoc() {
    if (!reportText || downloading) return
    setDownloading(true)
    try {
      const imageUrls = reports
        .filter(r => r.attachmentUrl)
        .slice(0, 5)
        .map(r => getDriveThumbnailUrl(r.attachmentUrl!, 'w800')!)

      // Filename: {ReportType}_{WorkerName}_{Project}_{Mon}_{Year}
      const reportType  = (title || 'FieldReport').replace(/\s+/g, '')
      const workerSlug  = userName.replace(/\s+/g, '')
      const projectSlug = (Array.isArray(filters.project) && filters.project.length > 0
        ? filters.project[0]
        : 'AllProjects').replace(/[\s/\\]/g, '_')
      const now      = new Date()
      const monthStr = now.toLocaleString('en-US', { month: 'short' })
      const yearStr  = now.getFullYear()
      const docTitle = `${reportType}_${workerSlug}_${projectSlug}_${monthStr}_${yearStr}`

      await exportToDocx(docTitle, reportText, imageUrls)
    } finally {
      setDownloading(false)
    }
  }

  function handlePrint() {
    const html = markdownToHtml(reportText)
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head>
      <title>${escapeHtml(title || 'Field Report')}</title>
      <style>
        body { font-family: Georgia, serif; max-width: 780px; margin: 0 auto; padding: 40px; color: #111; }
        h1 { text-align: center; }
        h2 { color: #341272; border-bottom: 2px solid #D9E6E8; padding-bottom: 4px; }
        li { margin: 4px 0; }
        table { break-inside: avoid; }
        tr { break-inside: avoid; }
        img { break-inside: avoid; }
        @media print { body { padding: 20px; } }
      </style>
    </head><body>${html}</body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 500)
  }

  const isActive = status === 'streaming' || status === 'done'

  // The card content is identical in both modes; only the outer layer and sizing differ.
  const innerCardClass = mode === 'page'
    ? 'bg-white w-full max-w-5xl mx-auto rounded-2xl flex flex-col border border-gray-100 shadow-sm'
    : 'bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl flex flex-col'
  const innerCardStyle: React.CSSProperties = mode === 'page'
    ? { height: 'calc(100vh - 180px)', minHeight: '500px' }
    : { height: '92vh' }

  // Plain function returning JSX, not a component: a component defined in the render
  // body gets a new type each render, remounting the subtree and breaking the SSE reader.
  const wrapWithOuter = (child: React.ReactNode): React.ReactNode => {
    if (mode === 'page') return child
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center"
        onClick={handleClose}
      >
        {child}
      </div>
    )
  }

  return (
    <>
      {wrapWithOuter(
        <div
          className={innerCardClass}
          style={innerCardStyle}
          onClick={e => e.stopPropagation()}
        >
          {/* ── Header ─────────────────────────────────────── */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 sm:px-5 py-3 sm:py-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-5 h-5 text-green-600 shrink-0" />
                <h2 className="font-semibold text-gray-900 truncate">{title || t.grAiFieldReport}</h2>
                {status === 'streaming' && (
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full animate-pulse shrink-0">
                    {t.grGenerating}
                  </span>
                )}
                {status === 'done' && (
                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full shrink-0">{t.grComplete}</span>
                )}
              </div>
              {/* Close button stays next to the title on mobile so it's reachable
                  without scrolling past the (potentially wrapped) action row. */}
              <button onClick={handleClose} className="sm:hidden p-1.5 rounded-lg hover:bg-gray-100 transition shrink-0">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              {reportText && status === 'done' && (
                <>
                  <button
                    onClick={saveReport}
                    disabled={saving || saved}
                    className="flex items-center gap-1.5 text-xs text-green-700 border border-green-200 rounded-lg px-2.5 py-1.5 hover:bg-green-50 transition font-bold disabled:opacity-60"
                    title="Save report to your account"
                  >
                    {saving
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : saved
                        ? <BookmarkCheck className="w-3.5 h-3.5 text-green-600" />
                        : <Bookmark className="w-3.5 h-3.5" />
                    }
                    {saved ? 'Saved!' : 'Save'}
                  </button>
                  <button
                    onClick={handleDownloadDoc}
                    disabled={downloading}
                    className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50 transition font-bold disabled:opacity-50"
                  >
                    {downloading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    {downloading ? t.grPreparing : t.grDoc}
                  </button>
                  <button
                    onClick={handlePrint}
                    className="flex items-center gap-1.5 text-xs text-purple-700 border border-purple-200 rounded-lg px-2.5 py-1.5 hover:bg-purple-50 transition font-bold"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    {t.grPdf}
                  </button>
                  <button
                    onClick={copyReport}
                    className="flex items-center gap-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition"
                  >
                    {copied ? <CheckCheck className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? t.grCopied : t.grCopy}
                  </button>
                  <button
                    onClick={copyPlainText}
                    className="flex items-center gap-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition"
                    title="Copy as plain text (no markdown)"
                  >
                    {copiedPlain ? <CheckCheck className="w-3.5 h-3.5 text-green-600" /> : <FileType className="w-3.5 h-3.5" />}
                    {copiedPlain ? 'Copied!' : 'Plain text'}
                  </button>
                </>
              )}
              <button onClick={handleClose} className="hidden sm:block p-1.5 rounded-lg hover:bg-gray-100 transition">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
          </div>

          {/* ── Scrollable body ────────────────────────────── */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">

            {/* Identity strip — shown for "for_other" / "team" reports. */}
            {status === 'idle' && reportKind !== 'self' && (subjects.length > 0 || pickingSubjects) && (
              <div className="mb-3 border border-purple-200 rounded-lg p-3 bg-purple-50/40 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wide text-purple-700 font-semibold">Report for</div>
                  {subjects.length > 0 ? (
                    <div className="text-sm font-semibold text-gray-900 truncate">
                      {subjects.slice(0, 3).map(s => s.name).join(', ')}
                      {subjects.length > 3 && (
                        <span className="text-gray-500 font-normal"> +{subjects.length - 3} more</span>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm font-medium text-purple-700">Select one or more contributors below</div>
                  )}
                  {!pickingSubjects && subjects.length > 0 && availableContributors.length > 0 && (
                    <button
                      onClick={() => setPickingSubjects(true)}
                      className="mt-0.5 text-[11px] text-purple-700 hover:underline"
                    >
                      Change subjects
                    </button>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Generated by</div>
                  <div className="text-sm font-semibold text-gray-900">{userName}</div>
                  <div className="text-[10px] text-gray-500">
                    {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              </div>
            )}

            {/* Subject-picker — shown when filter was empty and "Report for Other" was clicked. */}
            {status === 'idle' && pickingSubjects && (
              <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-white">
                <p className="text-xs font-semibold text-gray-700 mb-2">
                  Select the contributor(s) this report is about
                </p>
                <div className="max-h-48 overflow-y-auto border border-gray-100 rounded">
                  {availableContributors.length === 0 ? (
                    <p className="text-xs text-gray-400 p-2">No contributors available — go back and apply a filter.</p>
                  ) : (
                    availableContributors.map(c => {
                      const checked = subjects.some(s => (s.id && s.id === c.id) || s.name === c.name)
                      return (
                        <label
                          key={c.id || c.name}
                          className="flex items-center gap-2 px-2 py-1.5 hover:bg-purple-50 cursor-pointer text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSubjects(prev => checked
                                ? prev.filter(s => !((s.id && s.id === c.id) || s.name === c.name))
                                : [...prev, c])
                            }}
                          />
                          <span className="truncate font-medium text-gray-900">{c.name}</span>
                          {c.phone && <span className="text-gray-400 ml-auto">{c.phone}</span>}
                        </label>
                      )
                    })
                  )}
                </div>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    onClick={() => { setSubjects([]); setPickingSubjects(false) }}
                    className="text-xs text-gray-500 hover:underline px-2 py-1"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={subjects.length === 0}
                    onClick={() => setPickingSubjects(false)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-md bg-purple-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Continue ({subjects.length} selected)
                  </button>
                </div>
              </div>
            )}

            {/* Inputs were collected in the Content Hub picker, so generation starts on mount. */}
            {status === 'idle' && !pickingSubjects && (
              <SubscriptionGate featureName="AI Report Generation">
                <AutoGenerate onGenerate={generate} />
              </SubscriptionGate>
            )}

            {status === 'loading' && (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500">
                <Loader2 className="w-8 h-8 animate-spin text-green-600" />
                <p className="text-sm font-medium">{t.grAnalysing}</p>
                <p className="text-xs text-gray-400">{t.grWaiting}</p>
              </div>
            )}

            {/* STREAMING / DONE — all in one view */}
            {isActive && (
              <div>
                {/* ── 1. AI Generated Text ─────────────────── */}
                {reportText
                  ? <div className="text-sm">
                      <MarkdownBlock text={reportText} />
                      {status === 'streaming' && (
                        <span className="inline-block w-2 h-4 bg-green-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
                      )}
                    </div>
                  : <div className="flex items-center gap-2 text-gray-400 py-4">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm">{t.grWaitingResp}</span>
                    </div>
                }

                <div className="h-6" />
              </div>
            )}

            {status === 'error' && (
              <div className="h-full flex flex-col items-center justify-center gap-3">
                <div className="flex items-start gap-2 text-red-600 bg-red-50 rounded-xl p-4 max-w-sm w-full">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-sm">{t.grError}</p>
                    <p className="text-sm mt-1 whitespace-pre-wrap">{errorMsg}</p>
                  </div>
                </div>
                <button
                  onClick={generate}
                  className="text-sm text-green-600 border border-green-600 rounded-xl px-4 py-2 hover:bg-green-50 transition"
                >
                  {t.grTryAgain}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Lightbox ──────────────────────────────────────── */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          <img
            src={lightbox.img}
            alt="Full size field photo"
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onError={e => {
              // fall back to thumbnail URL if full-res fails
              const el = e.currentTarget
              if (!el.src.includes('thumbnail')) {
                el.src = lightbox.img.includes('lh3')
                  ? lightbox.img.replace('lh3.googleusercontent.com/d/', 'drive.google.com/thumbnail?sz=w1200&id=')
                  : lightbox.img
              }
            }}
          />

          <a
            href={lightbox.drive}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="absolute bottom-4 right-4 flex items-center gap-1.5 text-xs text-white bg-white/10 hover:bg-white/20 px-3 py-2 rounded-full transition backdrop-blur-sm"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {t.grOpenDrive}
          </a>
        </div>
      )}
    </>
  )
}

// Inline (page-mode) variant used by the dashboard's 'generate-report' tab.
export function GenerateReportPage(props: Omit<Props, 'mode'>) {
  return <GenerateReportModal {...props} mode="page" />
}

