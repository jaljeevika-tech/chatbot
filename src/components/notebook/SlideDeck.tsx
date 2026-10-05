import { useState, useRef, useEffect } from 'react'
import {
  Presentation, Loader2, Download, ChevronLeft, ChevronRight,
  PenLine, Pencil, X, Check, ChevronDown, ChevronUp, Sparkles,
} from 'lucide-react'
import type { NotebookSource, Slide, SlideDeckOutputData } from '../../types/notebook'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import { saveAs } from 'file-saver'
import { apiFetch } from '../../utils/apiFetch'

// One restrained brand palette, shared with VideoOverview.tsx's canvas.
const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF' }
const THEME = { ink: '#0E3A46', inkSoft: '#4B6169', accent: '#341272', accentSoft: '#F2F7F8', line: '#D9E6E8', surface: '#FFFFFF' }

/** Fetch a Drive field photo as a data: URI via /api/proxy-image. Must go through
 *  apiFetch: <img src> and pptxgenjs `path` can't attach the auth token and 401.
 *  Returns null on failure so a bad photo degrades to "no photo". */
async function fetchDrivePhotoAsDataUri(url: string): Promise<string | null> {
  try {
    const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    const driveUrl = m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w640-h360` : url
    const res = await apiFetch(`/api/proxy-image?url=${encodeURIComponent(driveUrl)}`)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload  = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// Repair common AI JSON mistakes: strip code fences, escape bare newlines inside strings
function cleanJSON(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim()
  let out = '', inStr = false, escaped = false
  for (const ch of s) {
    if (escaped)              { out += ch; escaped = false; continue }
    if (ch === '\\')          { out += ch; escaped = true;  continue }
    if (ch === '"')           { inStr = !inStr; out += ch;  continue }
    if (inStr && ch === '\n') { out += '\\n'; continue }
    if (inStr && ch === '\r') { out += '\\r'; continue }
    if (inStr && ch === '\t') { out += '\\t'; continue }
    out += ch
  }
  return out
}

// The prompts forbid emoji; strip any that slip through anyway.
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu

function stripEmoji(s: string): string {
  return s.replace(EMOJI_RE, '').replace(/ {2,}/g, ' ').trim()
}

function sanitizeSlide(s: Slide): Slide {
  return {
    title: stripEmoji(s.title),
    bullets: (s.bullets || []).map(stripEmoji),
    speakerNotes: stripEmoji(s.speakerNotes || ''),
    ...(s.matchedCaption ? { matchedCaption: s.matchedCaption } : {}),
  }
}

// Words too generic to count as a topical match between a slide and a photo caption.
const CAPTION_STOPWORDS = new Set([
  'that', 'this', 'from', 'have', 'with', 'were', 'been', 'they', 'their',
  'which', 'about', 'more', 'than', 'also', 'will', 'over', 'under', 'among',
  'project', 'training', 'programme', 'program', 'report', 'members', 'held',
])
function captionTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(w => !CAPTION_STOPWORDS.has(w)))
}

/** Index of the unused field photo whose caption best overlaps this slide's
 *  text, or -1 so the caller can generate a grounded photo instead. */
function pickRelevantPhoto(
  slideText: string,
  photos: { url: string; caption: string }[],
  used: Set<number>,
): number {
  const slideTokens = captionTokens(slideText)
  let bestIdx = -1, bestScore = 0
  photos.forEach((p, idx) => {
    if (used.has(idx) || !p.caption) return
    let score = 0
    for (const w of captionTokens(p.caption)) if (slideTokens.has(w)) score++
    if (score > bestScore) { bestScore = score; bestIdx = idx }
  })
  return bestScore > 0 ? bestIdx : -1
}

async function streamSSE(
  url: string,
  body: object,
  onChunk: (text: string) => void,
): Promise<string> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.body) throw new Error('No stream')

  // Non-SSE error response (e.g. 401, 500 JSON)
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    try { const j = JSON.parse(errBody); throw new Error(j.error || `HTTP ${res.status}`) }
    catch (e2) { if (e2 instanceof SyntaxError) throw new Error(`HTTP ${res.status}`) ; throw e2 }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let accum = '', buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const raw = trimmed.slice(6).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const chunk = JSON.parse(raw)
        if (chunk.error) throw new Error(chunk.error)   // always propagate SSE errors
        if (chunk.text) { accum += chunk.text; onChunk(accum) }
      } catch (e) {
        // Only swallow SSE frame JSON parse failures; rethrow everything else
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
  return accum
}

type DeckMode = 'detailed' | 'presenter'

interface Props {
  sources: NotebookSource[]
  /** Previously-generated deck, restored on notebook load so a refresh doesn't wipe it out. */
  initial?: SlideDeckOutputData
  onChange?: (data: SlideDeckOutputData) => void
  /** Reported up so OutputPanel can show a spinner and keep this tab mounted. */
  onBusyChange?: (busy: boolean) => void
}

export function SlideDeck({ sources, initial, onChange, onBusyChange }: Props) {
  const [slides, setSlides]         = useState<Slide[]>(initial?.slides ?? [])
  const [current, setCurrent]       = useState(0)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [progress, setProgress]     = useState(0)

  const [mode, setMode]                     = useState<DeckMode>(initial?.mode ?? 'detailed')
  const [showPrompt, setShowPrompt]         = useState(false)
  const [customPrompt, setCustomPrompt]     = useState('')

  const [revisingIdx, setRevisingIdx]       = useState<number | null>(null)
  const [reviseText, setReviseText]         = useState('')
  /** Manual edit of one slide (title, points one per line, speaker notes). */
  const [editDraft, setEditDraft]           = useState<{ idx: number; title: string; bullets: string; notes: string } | null>(null)
  const [revising, setRevising]             = useState(false)
  useEffect(() => { onBusyChange?.(loading || revising) }, [loading, revising, onBusyChange])

  // One photo per slide: real field photos where available, otherwise generated in the background.
  const [slideImages, setSlideImages]       = useState<(string | null)[]>(initial?.slideImages ?? [])

  const thumbsRef = useRef<HTMLDivElement>(null)

  // Bumped on every generate(). Background photo runs capture it and bail once
  // superseded, so a stale run can't overwrite the new deck's saved output.
  const generationRef = useRef(0)

  /** Fire-and-forget: photos pop in as they arrive and are persisted after each. */
  async function generateAllImages(newSlides: Slide[], deckMode: DeckMode, epoch: number) {
    setSlideImages(new Array(newSlides.length).fill(null))
    // Each photo uses the previous one as a reference so the deck looks consistent.
    let lastImage: { data: string; mimeType: string } | null = null
    for (let i = 0; i < newSlides.length; i++) {
      if (generationRef.current !== epoch) return // superseded by a newer generate()
      const s = newSlides[i]
      const prompt = [
        `Photorealistic documentary photograph illustrating: ${s.title}.`,
        `Subject matter: ${s.bullets.slice(0, 3).join('; ')}.`,
        'Context: NGO field development work, rural India.',
        'Style: natural light, candid documentary photojournalism, high detail, no text or logos in the image.',
      ].join(' ')
      try {
        const res = await apiFetch('/api/notebook/nanobanana', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, referenceImage: lastImage }),
        })
        if (res.ok && generationRef.current === epoch) {
          const data = await res.json()
          if (data.imageData && generationRef.current === epoch) {
            lastImage = { data: data.imageData, mimeType: data.mimeType || 'image/png' }
            setSlideImages(prev => {
              const next = [...prev]
              next[i] = `data:${data.mimeType || 'image/png'};base64,${data.imageData}`
              onChange?.({ slides: newSlides, slideImages: next, mode: deckMode })
              return next
            })
          }
        }
      } catch { /* individual failures are silently skipped — text stands on its own */ }
    }
  }

  /** Fire-and-forget: gives each slide the best-matching unused field photo, and
   *  falls back to a generated photo (referencing the last one used) otherwise. */
  async function useMixedPhotos(newSlides: Slide[], fieldPhotos: { url: string; caption: string }[], deckMode: DeckMode, epoch: number) {
    setSlideImages(new Array(newSlides.length).fill(null))
    const cache = new Map<string, string | null>()
    const usedPhotos = new Set<number>()
    let lastImage: { data: string; mimeType: string } | null = null

    for (let i = 0; i < newSlides.length; i++) {
      if (generationRef.current !== epoch) return // superseded by a newer generate()
      const s = newSlides[i]
      // Prefer the model's own matchedCaption over the keyword heuristic.
      const modelMatchIdx = s.matchedCaption
        ? fieldPhotos.findIndex((p, idx) => !usedPhotos.has(idx) && p.caption === s.matchedCaption)
        : -1
      const matchIdx = modelMatchIdx >= 0
        ? modelMatchIdx
        : pickRelevantPhoto(`${s.title} ${s.bullets.join(' ')}`, fieldPhotos, usedPhotos)

      if (matchIdx >= 0) {
        usedPhotos.add(matchIdx)
        const url = fieldPhotos[matchIdx].url
        let dataUri = cache.get(url)
        if (dataUri === undefined) {
          dataUri = await fetchDrivePhotoAsDataUri(url)
          cache.set(url, dataUri)
        }
        if (dataUri && generationRef.current === epoch) {
          const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
          if (match) lastImage = { mimeType: match[1], data: match[2] }
          const resolved = dataUri
          setSlideImages(prev => {
            const next = [...prev]
            next[i] = resolved
            onChange?.({ slides: newSlides, slideImages: next, mode: deckMode })
            return next
          })
          continue
        }
        // photo fetch failed — fall through to a generated photo instead
      }

      const prompt = [
        `Photorealistic documentary photograph illustrating: ${s.title}.`,
        `Subject matter: ${s.bullets.slice(0, 3).join('; ')}.`,
        'Context: NGO field development work, rural India.',
        'Style: natural light, candid documentary photojournalism, high detail, no text or logos in the image.',
      ].join(' ')
      try {
        const res = await apiFetch('/api/notebook/nanobanana', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, referenceImage: lastImage }),
        })
        if (res.ok && generationRef.current === epoch) {
          const data = await res.json()
          if (data.imageData && generationRef.current === epoch) {
            lastImage = { data: data.imageData, mimeType: data.mimeType || 'image/png' }
            setSlideImages(prev => {
              const next = [...prev]
              next[i] = `data:${data.mimeType || 'image/png'};base64,${data.imageData}`
              onChange?.({ slides: newSlides, slideImages: next, mode: deckMode })
              return next
            })
          }
        }
      } catch { /* individual failures are silently skipped — text stands on its own */ }
    }
  }

  // ── Generate full deck ──────────────────────────────────────────────────────
  async function generate() {
    if (sources.length === 0) return
    const epoch = ++generationRef.current
    setLoading(true); setError(null); setSlides([]); setSlideImages([]); setProgress(0); setCurrent(0)
    try {
      // Send field-photo captions so the model can say which slide each one fits.
      const fieldPhotos = sources.flatMap(s =>
        (s.imageUrls ?? []).map(url => ({ url, caption: s.imageCaptions?.[url] || '' }))
      )
      const fieldPhotoCaptions = [...new Set(fieldPhotos.map(p => p.caption).filter(Boolean))]
      const accum = await streamSSE(
        '/api/notebook/slide-deck',
        { sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })), mode, customPrompt, fieldPhotoCaptions },
        (raw) => setProgress(Math.min(88, (raw.length / 4000) * 100)),
      )
      if (generationRef.current !== epoch) return // a newer generate() started while this one streamed
      const jsonMatch = accum.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const parsed = (JSON.parse(cleanJSON(jsonMatch[0])) as Slide[]).map(sanitizeSlide)
        setSlides(parsed)
        onChange?.({ slides: parsed, slideImages: new Array(parsed.length).fill(null), mode })
        if (fieldPhotos.length > 0) {
          useMixedPhotos(parsed, fieldPhotos, mode, epoch) // don't await — photos stream in after the text
        } else {
          generateAllImages(parsed, mode, epoch) // don't await — photos stream in after the text
        }
      } else {
        setError('Could not parse slide JSON. Try generating again.')
      }
    } catch (e) {
      if (generationRef.current === epoch) setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      if (generationRef.current === epoch) setLoading(false)
    }
  }

  // ── Manually edit a single slide's text ─────────────────────────────────────
  function saveSlideEdit() {
    if (!editDraft || !editDraft.title.trim()) return
    const { idx } = editDraft
    const edited: Slide = {
      ...slides[idx],
      title: editDraft.title.trim(),
      bullets: editDraft.bullets.split('\n').map(b => b.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean),
      speakerNotes: editDraft.notes.trim(),
    }
    setSlides(prev => {
      const next = prev.map((s, i) => (i === idx ? edited : s))
      onChange?.({ slides: next, slideImages, mode })
      return next
    })
    setEditDraft(null)
  }

  // ── Revise a single slide ───────────────────────────────────────────────────
  async function reviseSlide(idx: number) {
    if (!reviseText.trim() || revising) return
    setRevising(true)
    try {
      const accum = await streamSSE(
        '/api/notebook/slide-revise',
        {
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 20_000) })),
          slide: slides[idx],
          instruction: reviseText.trim(),
          index: idx,
          total: slides.length,
        },
        () => {},
      )
      const objMatch = accum.match(/\{[\s\S]*\}/)
      if (objMatch) {
        const revised = sanitizeSlide(JSON.parse(cleanJSON(objMatch[0])) as Slide)
        setSlides(prev => {
          const next = prev.map((s, i) => i === idx ? revised : s)
          onChange?.({ slides: next, slideImages, mode })
          return next
        })
        setRevisingIdx(null)
        setReviseText('')
      } else {
        setError('Could not parse revised slide. Try again.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revision failed')
    } finally {
      setRevising(false)
    }
  }

  // ── Export DOCX ────────────────────────────────────────────────────────────
  async function exportDocx() {
    if (!slides.length) return
    setError(null)
    try {
      const children: any[] = []
      for (const [i, slide] of slides.entries()) {
        if (i > 0) children.push(new Paragraph({ pageBreakBefore: true }))
        children.push(new Paragraph({ text: `Slide ${i + 1}: ${slide.title}`, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }))
        for (const bullet of slide.bullets)
          children.push(new Paragraph({ children: [new TextRun(bullet)], bullet: { level: 0 }, spacing: { after: 120 } }))
        if (slide.speakerNotes) {
          children.push(new Paragraph({ spacing: { before: 200 } }))
          children.push(new Paragraph({ children: [new TextRun({ text: 'Speaker Notes: ', bold: true, italics: true }), new TextRun({ text: slide.speakerNotes, italics: true })], spacing: { after: 120 } }))
        }
      }
      saveAs(await Packer.toBlob(new Document({ sections: [{ children }] })), 'notebook_slides.docx')
    } catch (e) {
      setError(e instanceof Error ? `DOCX export failed: ${e.message}` : 'DOCX export failed')
    }
  }

  // ── Export PPTX ────────────────────────────────────────────────────────────
  async function exportPptx() {
    if (!slides.length) return
    setError(null)
    try {
    const { default: PptxGenJS } = await import('pptxgenjs')
    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_16x9'

    const ink    = THEME.ink.replace('#', '')
    const accent = THEME.accent.replace('#', '')

    // Slide geometry (16:9 = 13.33 x 7.5"). A reserved footer band keeps text on the canvas.
    const MARGIN = 0.55
    const FOOTER_Y = 7.0
    for (const [i, slide] of slides.entries()) {
      const sld = pptx.addSlide()
      sld.background = { color: 'FFFFFF' }
      const hasPhoto = Boolean(slideImages[i])
      const textX = hasPhoto ? 5.15 : MARGIN
      // Text column right edge sits at 13.33 - MARGIN.
      const colW = 13.33 - MARGIN - textX

      const barW = Number(((13.33 * (i + 1)) / slides.length).toFixed(2))
      sld.addShape('rect' as any, { x: 0, y: 0, w: barW, h: 0.08, fill: { color: accent }, line: { type: 'none' } })

      if (hasPhoto) {
        sld.addImage({ data: slideImages[i]!, x: MARGIN, y: 0.75, w: 4.2, h: 5.6, sizing: { type: 'cover', w: 4.2, h: 5.6 }, rounding: false })
      }

      sld.addText(`SLIDE ${i + 1} OF ${slides.length}`, {
        x: textX, y: 0.4, w: colW, h: 0.3,
        fontSize: 10, color: accent, bold: true, fontFace: 'Calibri', charSpacing: 2,
      })

      // Title shrinks to fit and is capped to its box so it never hits the bullets.
      sld.addText(slide.title, {
        x: textX, y: 0.78, w: colW, h: 1.15,
        fontSize: 28, bold: true, color: ink, fontFace: 'Calibri',
        valign: 'top', wrap: true, fit: 'shrink',
      })

      sld.addShape('rect' as any, { x: textX, y: 2.02, w: 0.7, h: 0.08, fill: { color: accent }, line: { type: 'none' } })

      // Bullets capped at 6, shrink-to-fit inside a box bounded above the footer.
      const bulletItems = slide.bullets.slice(0, 6).map(b => ({
        text: b,
        options: { bullet: { indent: 18 }, paraSpaceAfter: 10, breakLine: true },
      }))
      sld.addText(bulletItems as any, {
        x: textX, y: 2.35, w: colW, h: FOOTER_Y - 2.35 - 0.15,
        fontSize: mode === 'presenter' ? 18 : 15,
        color: '374151', fontFace: 'Calibri', valign: 'top',
        wrap: true, fit: 'shrink', lineSpacingMultiple: 1.05,
      })

      sld.addShape('line' as any, { x: MARGIN, y: FOOTER_Y, w: 13.33 - 2 * MARGIN, h: 0, line: { color: 'D9E6E8', width: 1 } })
      sld.addText('FieldFlow', {
        x: MARGIN, y: FOOTER_Y + 0.05, w: 6, h: 0.3,
        fontSize: 9, color: '9CA3AF', fontFace: 'Calibri',
      })

      if (slide.speakerNotes) sld.addNotes(slide.speakerNotes)
    }

    await pptx.writeFile({ fileName: 'notebook_slides.pptx' })
    } catch (e) {
      setError(e instanceof Error ? `PPTX export failed: ${e.message}` : 'PPTX export failed')
    }
  }

  function goTo(idx: number) {
    setCurrent(idx)
    setRevisingIdx(null)
    setReviseText('')
    setTimeout(() => {
      const el = thumbsRef.current?.children[idx] as HTMLElement | undefined
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }, 40)
  }

  const slide    = slides[current]
  const noSrc    = sources.length === 0
  const pct      = slides.length ? ((current + 1) / slides.length) * 100 : 0
  const photo    = slideImages[current] ?? null

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Controls ── */}
      <div className="px-4 pt-3 pb-3 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>

        <div className="flex gap-1 p-0.5 rounded-lg mb-2.5" style={{ background: '#F2F7F8' }}>
          {(['detailed', 'presenter'] as DeckMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="flex-1 py-1.5 rounded-md text-[11px] font-bold transition-all capitalize"
              style={{
                background: mode === m ? C.dark : 'transparent',
                color:      mode === m ? C.white : '#86A0A5',
              }}
            >
              {m === 'detailed' ? 'Detailed Deck' : 'Presenter Slides'}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowPrompt(v => !v)}
          className="w-full flex items-center gap-1.5 mb-2 text-[11px] font-semibold transition-all"
          style={{ color: showPrompt ? C.dark : '#86A0A5' }}
        >
          <Sparkles className="w-3 h-3" />
          Custom instructions
          {showPrompt ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
        </button>
        {showPrompt && (
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder="Emphasise certain themes, target a specific audience, or structure the deck around particular questions…"
            rows={3}
            className="w-full text-[11px] rounded-xl px-3 py-2 mb-2 resize-none outline-none"
            style={{ background: '#F2F7F8', color: '#374151', border: '1.5px solid #D9E6E8' }}
          />
        )}

        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={loading || noSrc}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all"
            style={{ background: noSrc || loading ? '#D9E6E8' : C.dark, color: noSrc || loading ? '#86A0A5' : C.white }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Presentation className="w-3.5 h-3.5" />}
            {loading ? 'Crafting slides…' : 'Generate Slides'}
          </button>
          {slides.length > 0 && (
            <>
              <button
                onClick={exportPptx}
                title="Export PowerPoint"
                className="px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1"
                style={{ background: C.lime, color: '#FFFFFF' }}
              >
                <Download className="w-3.5 h-3.5" />PPTX
              </button>
              <button
                onClick={exportDocx}
                title="Export Word"
                className="px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1"
                style={{ background: C.bg, color: C.dark, border: '1.5px solid #D9E6E8' }}
              >
                <Download className="w-3.5 h-3.5" />DOCX
              </button>
            </>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}

        {loading && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: '#D9E6E8' }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ background: C.lime, width: `${progress}%` }} />
            </div>
            <span className="text-[10px]" style={{ color: '#86A0A5' }}>AI writing…</span>
          </div>
        )}
      </div>

      {/* ── Slide viewer ── */}
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3 min-h-0">

        {slide ? (
          <>
            <div
              className="rounded-2xl relative overflow-hidden flex flex-col"
              style={{
                background: THEME.surface,
                border: `1.5px solid ${THEME.line}`,
                minHeight: 230,
                boxShadow: '0 8px 24px rgba(14,58,70,0.08)',
              }}
            >
              <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: THEME.line }}>
                <div className="h-full transition-all duration-500 ease-out" style={{ background: THEME.accent, width: `${pct}%` }} />
              </div>

              {revising && revisingIdx === current && (
                <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl" style={{ background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(4px)' }}>
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-7 h-7 animate-spin" style={{ color: THEME.accent }} />
                    <p className="text-xs font-semibold" style={{ color: THEME.ink }}>Revising slide…</p>
                  </div>
                </div>
              )}

              <div className="relative z-10 p-5 flex gap-4 flex-1">

                <div className="shrink-0 rounded-xl overflow-hidden" style={{ width: 128, background: THEME.accentSoft }}>
                  {photo ? (
                    <img src={photo} alt="" className="w-full h-full object-cover" style={{ minHeight: 160 }} />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center" style={{ minHeight: 160 }}>
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: THEME.accent }} />
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-3 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold tracking-widest uppercase px-2.5 py-0.5 rounded-full"
                      style={{ background: THEME.accentSoft, color: THEME.accent }}>
                      {current + 1} / {slides.length}
                    </span>
                    <button
                      onClick={() => { setEditDraft(editDraft?.idx === current ? null : { idx: current, title: slide.title, bullets: slide.bullets.join('\n'), notes: slide.speakerNotes || '' }); setRevisingIdx(null) }}
                      title="Edit this slide's text"
                      className="ml-auto w-6 h-6 rounded-lg flex items-center justify-center transition-all"
                      style={{ background: editDraft?.idx === current ? THEME.accent : THEME.accentSoft, color: editDraft?.idx === current ? '#FFFFFF' : THEME.accent }}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => { setRevisingIdx(revisingIdx === current ? null : current); setReviseText(''); setEditDraft(null) }}
                      title="Ask AI to revise this slide"
                      className="w-6 h-6 rounded-lg flex items-center justify-center transition-all"
                      style={{ background: revisingIdx === current ? THEME.accent : THEME.accentSoft, color: revisingIdx === current ? '#FFFFFF' : THEME.accent }}
                    >
                      <Sparkles className="w-3 h-3" />
                    </button>
                  </div>

                  {editDraft?.idx === current ? (
                    <div className="flex flex-col gap-2">
                      <label className="text-[9px] font-bold uppercase tracking-wide" style={{ color: THEME.inkSoft }}>Title</label>
                      <input
                        value={editDraft.title}
                        onChange={e => setEditDraft(d => d && { ...d, title: e.target.value })}
                        className="w-full text-[13px] font-bold rounded-lg px-2 py-1.5 outline-none"
                        style={{ color: THEME.ink, border: `1.5px solid ${THEME.line}` }}
                      />
                      <label className="text-[9px] font-bold uppercase tracking-wide" style={{ color: THEME.inkSoft }}>Points — one per line</label>
                      <textarea
                        value={editDraft.bullets}
                        onChange={e => setEditDraft(d => d && { ...d, bullets: e.target.value })}
                        rows={Math.min(8, Math.max(3, editDraft.bullets.split('\n').length + 1))}
                        className="w-full text-[11.5px] leading-snug rounded-lg px-2 py-1.5 resize-y outline-none"
                        style={{ color: THEME.ink, border: `1.5px solid ${THEME.line}` }}
                      />
                      <label className="text-[9px] font-bold uppercase tracking-wide" style={{ color: THEME.inkSoft }}>Speaker notes</label>
                      <textarea
                        value={editDraft.notes}
                        onChange={e => setEditDraft(d => d && { ...d, notes: e.target.value })}
                        rows={3}
                        className="w-full text-[11px] leading-snug rounded-lg px-2 py-1.5 resize-y outline-none"
                        style={{ color: THEME.ink, border: `1.5px solid ${THEME.line}` }}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={saveSlideEdit}
                          disabled={!editDraft.title.trim()}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold"
                          style={{ background: editDraft.title.trim() ? THEME.accent : THEME.line, color: editDraft.title.trim() ? '#FFFFFF' : THEME.inkSoft }}
                        >
                          <Check className="w-3 h-3" />Save
                        </button>
                        <button
                          onClick={() => setEditDraft(null)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold"
                          style={{ background: THEME.line, color: THEME.inkSoft }}
                        >
                          <X className="w-3 h-3" />Cancel
                        </button>
                      </div>
                    </div>
                  ) : (<>
                  <div>
                    <h2 className="text-[15px] font-black leading-snug tracking-tight" style={{ color: THEME.ink }}>{slide.title}</h2>
                    <div className="mt-2 h-[3px] rounded-full" style={{ background: THEME.accent, width: 36 }} />
                  </div>

                  {/* Capped to 6 to match the PPTX export */}
                  <ul className="space-y-2.5 mt-0.5">
                    {slide.bullets.slice(0, 6).map((b, i) => (
                      <li key={i} className="flex gap-2.5 text-[11.5px] leading-snug" style={{ color: THEME.inkSoft }}>
                        <span className="shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] font-black mt-[1px]"
                          style={{ background: THEME.accentSoft, color: THEME.accent }}>
                          {i + 1}
                        </span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  </>)}
                </div>
              </div>

              {revisingIdx === current && !revising && (
                <div className="relative z-10 px-4 pb-4">
                  <div className="rounded-xl overflow-hidden" style={{ background: THEME.accentSoft }}>
                    <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                      <Pencil className="w-3 h-3" style={{ color: THEME.accent }} />
                      <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: THEME.accent }}>Revise this slide</span>
                    </div>
                    <textarea
                      value={reviseText}
                      onChange={e => setReviseText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reviseSlide(current) }}
                      placeholder='e.g. "Add Q3 revenue figures", "Simplify to 3 bullets", "Make more visual"'
                      rows={2}
                      autoFocus
                      className="w-full text-[11px] px-3 py-2 resize-none outline-none bg-transparent"
                      style={{ color: THEME.ink, caretColor: THEME.accent }}
                    />
                    <div className="flex gap-2 px-3 pb-3">
                      <button
                        onClick={() => reviseSlide(current)}
                        disabled={!reviseText.trim()}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                        style={{ background: reviseText.trim() ? THEME.accent : THEME.line, color: reviseText.trim() ? '#FFFFFF' : THEME.inkSoft }}
                      >
                        <Check className="w-3 h-3" />Revise
                      </button>
                      <button
                        onClick={() => { setRevisingIdx(null); setReviseText('') }}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold"
                        style={{ background: THEME.line, color: THEME.inkSoft }}
                      >
                        <X className="w-3 h-3" />Cancel
                      </button>
                      <span className="ml-auto text-[9px] self-center" style={{ color: THEME.inkSoft }}>⌘↵ to submit</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

                  {/* Speaker notes */}
            {slide.speakerNotes && (
              <div
                className="rounded-xl px-4 pt-3 pb-4 relative overflow-hidden"
                style={{
                  background: '#FFFEF0',
                  border: '1.5px solid #E8E0C0',
                  backgroundImage: 'repeating-linear-gradient(transparent, transparent 23px, #E8E4CC 23px, #E8E4CC 24px)',
                  backgroundPosition: '0 32px',
                }}
              >
                <div className="absolute left-[38px] top-0 bottom-0 w-[1.5px]" style={{ background: 'rgba(220,60,60,0.18)' }} />
                <div className="flex items-center gap-1.5 mb-2 relative z-10">
                  <PenLine className="w-3 h-3" style={{ color: '#8B7355' }} />
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#8B7355' }}>Speaker Notes</span>
                </div>
                <p className="text-[11.5px] leading-[24px] relative z-10" style={{ color: '#3D3520', paddingLeft: 8 }}>
                  {slide.speakerNotes}
                </p>
              </div>
            )}

            {/* Navigation + thumbnail strip */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => goTo(Math.max(0, current - 1))}
                disabled={current === 0}
                className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all"
                style={{ background: current === 0 ? '#D9E6E8' : C.bg, color: current === 0 ? '#86A0A5' : C.dark }}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <div ref={thumbsRef} className="flex-1 flex gap-1.5 py-0.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {slides.map((_, i) => {
                  const active = i === current
                  return (
                    <button
                      key={i}
                      onClick={() => goTo(i)}
                      title={slides[i].title}
                      className="shrink-0 rounded-lg overflow-hidden transition-all flex items-center justify-center"
                      style={{
                        width: 38, height: 27,
                        background: active ? THEME.accent : THEME.accentSoft,
                        outline: active ? `2px solid ${THEME.accent}` : '2px solid transparent',
                        outlineOffset: 2,
                        transform: active ? 'scale(1.1)' : 'scale(1)',
                      }}
                    >
                      <span className="text-[9px] font-black" style={{ color: active ? '#FFFFFF' : THEME.accent }}>
                        {i + 1}
                      </span>
                    </button>
                  )
                })}
              </div>

              <button
                onClick={() => goTo(Math.min(slides.length - 1, current + 1))}
                disabled={current === slides.length - 1}
                className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all"
                style={{ background: current === slides.length - 1 ? '#D9E6E8' : C.bg, color: current === slides.length - 1 ? '#86A0A5' : C.dark }}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : loading ? (
          <div className="flex flex-col gap-3 flex-1">
            <div className="rounded-2xl flex-1 overflow-hidden" style={{ background: THEME.surface, border: `1.5px solid ${THEME.line}`, minHeight: 230 }}>
              <div className="p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-14 rounded-full animate-pulse" style={{ background: THEME.accentSoft }} />
                </div>
                <div className="h-5 w-3/4 rounded-full animate-pulse" style={{ background: THEME.line }} />
                <div className="h-[3px] w-9 rounded-full" style={{ background: THEME.accentSoft }} />
                <div className="space-y-2.5 mt-1">
                  {[78, 92, 68, 85].map((w, i) => (
                    <div key={i} className="flex gap-2.5 items-center">
                      <div className="w-[18px] h-[18px] rounded-full shrink-0 animate-pulse" style={{ background: THEME.accentSoft }} />
                      <div className="h-3 rounded-full animate-pulse" style={{ background: THEME.line, width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="text-center py-1">
              <p className="text-xs font-bold" style={{ color: C.dark }}>Crafting your slides…</p>
              <p className="text-[10px] mt-0.5" style={{ color: '#86A0A5' }}>AI is structuring content into a visual presentation</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center py-6">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: C.dark, boxShadow: '0 8px 24px rgba(14,58,70,0.25)' }}>
              <Presentation className="w-8 h-8" style={{ color: C.white }} />
            </div>
            <div>
              <p className="text-sm font-black" style={{ color: C.dark }}>AI Slide Deck</p>
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: '#86A0A5' }}>
                {noSrc ? 'Add sources first to get started' : 'Generate 10 visual slides from your sources'}
              </p>
            </div>
            {!noSrc && (
              <button onClick={generate} className="px-4 py-2 rounded-xl text-xs font-bold" style={{ background: C.dark, color: C.white }}>
                Generate Slides
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
