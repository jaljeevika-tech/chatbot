// Frame renderer for Video Overview. Every frame is a pure function of timeline
// time, so the live preview and the offline MP4 exporter always draw the same picture.
// Layout is in logical units (640×360 / 360×640); `scale` maps it to real pixels.

import type { AudioLine, VideoSlide } from '../../types/notebook'
import type { SegmentCues } from './videoSync'
import { flatShots } from './videoShots'
import { EN_STRINGS, fmt, type VideoStrings, type VideoFonts } from './videoStrings'

// ── Theme (set per frame from FrameState — brand colour, language fonts) ─────
let SANS = '"IBM Plex Sans","Segoe UI",system-ui,sans-serif'
let SERIF = '"Newsreader",Georgia,serif'
let LATIN = true
const C = {
  title: 'rgba(246,248,251,0.97)',
  body:  'rgba(226,232,240,0.9)',
  dim:   'rgba(203,213,225,0.62)',
  faint: 'rgba(203,213,225,0.38)',
  panel: '#0B1220',
  strip: '#070B14',
  accent: '#A78BFA',
}

/** Seconds the opening title card holds before the first segment's panel. */
export const INTRO_SECONDS = 3.4
/** Recap ("The message" + chapters) — plays AFTER the last word. */
export const OUTRO_SECONDS = 4.2
const CREDITS_SECONDS = 5.4
/** Silent tail after the narration: recap, then credits. The live player
 *  appends this much silence so the preview shows it too. */
export const EXPORT_TAIL_SECONDS = OUTRO_SECONDS + CREDITS_SECONDS
const CHAPTER_SECONDS = 2.2
/** The chapter card is fully up by now — the picture cut happens behind it. */
const CHAPTER_IN_SECONDS = 0.4
/** Dissolve into a new card's first picture / between pictures under one card. */
const XFADE_SEG_SECONDS = 0.6
const XFADE_SHOT_SECONDS = 0.3
/** Intro → split transition (picture glides from full-bleed into its slot). */
const SETTLE_SECONDS = 0.7

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3)
const easeInOut = (v: number) => { const x = clamp01(v); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function withAlpha(hex: string, a: number) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`
}

/** A brand colour lifted enough to read on the dark frame. */
export function accentForDark(hex: string | undefined): string {
  const m = (hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return '#A78BFA'
  let [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  const L = Math.max(l, 0.7), S = Math.min(Math.max(s, 0.45), 0.8)
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S, p = 2 * L - q
  const hue = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  ;[r, g, b] = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
  return '#' + [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface Timeline {
  lineStart: number[]
  lineDur: number[]
  segStart: number[]
  segEnd: number[]
  /** When each picture is on screen — global shot order (videoShots.flatShots). */
  shotStart: number[]
  shotEnd: number[]
  /** The card each shot sits under. */
  shotSeg: number[]
  /** Narration length in seconds. */
  total: number
  hasIntro: boolean
  hasOutro: boolean
}

/** `durations[i]` = seconds of line i's audio (0 where synthesis failed).
 *  `sentenceAt(line, s)` = seconds into line `line` where its sentence `s`
 *  starts — where that shot's cut lands (sentence 0 always cuts at the line). */
export function buildTimeline(durations: number[], slides: VideoSlide[], sentenceAt?: (line: number, sentence: number) => number): Timeline {
  const lineStart: number[] = []
  let acc = 0
  for (const d of durations) { lineStart.push(acc); acc += d }
  const segStart = slides.map(s => lineStart[s.fromLine] ?? 0)
  const segEnd = slides.map(s => (lineStart[s.toLine] ?? 0) + (durations[s.toLine] ?? 0))
  const shots = flatShots(slides)
  const shotStart: number[] = []
  shots.forEach((sh, k) => {
    const first = k === 0 || shots[k - 1].seg !== sh.seg
    const inLine = !first && sh.sentence > 0 && sentenceAt ? Math.max(0, Math.min(sentenceAt(sh.line, sh.sentence), durations[sh.line] ?? 0)) : 0
    const at = first ? segStart[sh.seg] : (lineStart[sh.line] ?? segStart[sh.seg]) + inLine
    // Inside its card, never before the shot ahead of it.
    shotStart.push(Math.max(k ? shotStart[k - 1] : 0, Math.min(Math.max(at, segStart[sh.seg]), segEnd[sh.seg])))
  })
  const shotEnd = shots.map((sh, k) => (shots[k + 1]?.seg === sh.seg ? shotStart[k + 1] : segEnd[sh.seg]))
  return {
    lineStart, lineDur: durations, segStart, segEnd,
    shotStart, shotEnd, shotSeg: shots.map(sh => sh.seg),
    total: acc, hasIntro: acc > 10, hasOutro: acc > 16 && slides.length > 1,
  }
}

export function locate(tl: Timeline, t: number) {
  let lineIdx = -1
  for (let i = 0; i < tl.lineStart.length; i++) {
    if (tl.lineDur[i] > 0 && tl.lineStart[i] <= t) lineIdx = i
  }
  let segIdx = tl.segStart.length ? 0 : -1
  for (let i = 0; i < tl.segStart.length; i++) if (tl.segStart[i] <= t) segIdx = i
  // The picture: the last shot of THIS card that has started (its first shot otherwise).
  let shotIdx = -1
  for (let k = 0; k < tl.shotStart.length; k++) {
    if (tl.shotSeg[k] !== segIdx) continue
    if (shotIdx < 0 || tl.shotStart[k] <= t) shotIdx = k
  }
  return {
    lineIdx,
    lineT: lineIdx >= 0 ? t - tl.lineStart[lineIdx] : 0,
    segIdx,
    segT: segIdx >= 0 ? t - tl.segStart[segIdx] : 0,
    segDur: segIdx >= 0 ? Math.max(0.1, tl.segEnd[segIdx] - tl.segStart[segIdx]) : 0,
    shotIdx,
    shotT: shotIdx >= 0 ? t - tl.shotStart[shotIdx] : 0,
  }
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Greedy word-wrap into at most maxLines lines (last one ellipsized). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i]
    if (ctx.measureText(test).width > maxW && line) {
      if (out.length === maxLines - 1) {
        let l = line
        while (l && ctx.measureText(`${l}…`).width > maxW) l = l.slice(0, -1)
        out.push(`${l.trimEnd()}…`)
        return out
      }
      out.push(line); line = words[i]
    } else line = test
  }
  if (line) out.push(line)
  return out
}

/** Letter-spacing for small caps-style tags — Latin only (it breaks Indic shaping). */
function spacing(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${LATIN ? px : 0}px`
}
const tag = (s: string) => (LATIN ? s.toUpperCase() : s)
/** Line height for a font size — Indic scripts need more room above/below. */
const lh = (size: number) => size * (LATIN ? 1.28 : 1.5)

export function drawableSize(el: CanvasImageSource | null): { w: number; h: number } | null {
  if (!el) return null
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth > 0 ? { w: el.videoWidth, h: el.videoHeight } : null
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0 ? { w: el.naturalWidth, h: el.naturalHeight } : null
  return null
}

/** Parse "1,250" / "45%" / "₹2.3 Cr" / "3x" into an animatable number. */
function parseStat(value: string) {
  const m = value.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/)
  if (!m) return null
  const raw = m[2]
  const num = Number(raw.replace(/,/g, ''))
  if (!Number.isFinite(num)) return null
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
  const indian = /\d,\d\d,\d{3}/.test(raw)
  const grouped = raw.includes(',')
  return {
    prefix: m[1], suffix: m[3], num,
    format: (v: number) => grouped
      ? v.toLocaleString(indian ? 'en-IN' : 'en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : v.toFixed(decimals),
  }
}

// ── Layout ──────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }

/** Instagram Reels safe zones for the 9:16 cut: Reels overlays its UI on the top,
 *  bottom and right-hand button column, so text stays out of those bands. */
const REELS_SAFE = { top: 72, bottom: 116, right: 44 }

function splitLayout(W: number, H: number) {
  if (H > W) {
    const capH = 92, picH = Math.round(H * 0.36)
    const stripY = H - REELS_SAFE.bottom - capH
    return {
      pic:   { x: 0, y: 0, w: W, h: picH },
      // Text rects stop short of the right-hand Reels button column.
      panel: { x: 0, y: picH, w: W - (REELS_SAFE.right - 20), h: stripY - picH },
      strip: { x: 8, y: stripY, w: W - 8 - REELS_SAFE.right, h: capH },
      // Strip colour runs full-width and down through the bottom safe band.
      stripBg: { x: 0, y: stripY, w: W, h: H - stripY },
      logoTop: REELS_SAFE.top,
    }
  }
  const capH = 58, panelW = Math.round(W * 0.4)
  const strip = { x: 0, y: H - capH, w: W, h: capH }
  return { pic: { x: panelW, y: 0, w: W - panelW, h: H - capH }, panel: { x: 0, y: 0, w: panelW, h: H - capH }, strip, stripBg: strip, logoTop: 0 }
}
/** 16:9 with no cards to show: picture across the frame above the captions. */
function pictureOnlyLayout(W: number, H: number): ReturnType<typeof splitLayout> {
  const base = splitLayout(W, H)
  return { ...base, pic: { x: 0, y: 0, w: W, h: base.strip.y }, panel: { x: 0, y: 0, w: 0, h: base.strip.y } }
}
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) })

// ── Captions (paged, never truncated, timed to the real audio) ──────────────

interface CaptionLayout { words: string[]; est: number[]; pages: [number, number][][]; widths: number[] }
const captionCache = new Map<string, CaptionLayout>()
/** Text widths measured before a webfont loaded are wrong — drop cached layouts. */
export function resetTextLayoutCache() { captionCache.clear() }
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', resetTextLayoutCache)
}

function layoutCaption(ctx: CanvasRenderingContext2D, text: string, dur: number, maxW: number, maxLines: number, key: string): CaptionLayout {
  const hit = captionCache.get(key)
  if (hit) return hit
  const words = text.split(/\s+/).filter(Boolean)
  const weights = words.map(w => w.length + 2)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  const est = weights.map(wt => { const at = 0.08 + (acc / total) * Math.max(0.1, dur - 0.15); acc += wt; return at })
  const space = ctx.measureText(' ').width
  const widths = words.map(w => ctx.measureText(w).width)
  const lines: [number, number][] = []
  let from = 0, lw = 0
  for (let i = 0; i < words.length; i++) {
    const add = (i > from ? space : 0) + widths[i]
    if (lw + add > maxW && i > from) { lines.push([from, i - 1]); from = i; lw = widths[i] }
    else lw += add
  }
  if (words.length) lines.push([from, words.length - 1])
  const pages: [number, number][][] = []
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines))
  const layout = { words, est, pages, widths }
  if (captionCache.size > 400) captionCache.clear()
  captionCache.set(key, layout)
  return layout
}

function drawCaptions(ctx: CanvasRenderingContext2D, strip: Rect, s: FrameState) {
  if (!s.text || s.lineIdx < 0) return
  const portrait = strip.h > 80
  const size = portrait ? 12.5 : 12 // kept small — the subtitles support the picture, not compete with it
  ctx.font = `500 ${size}px ${SANS}`
  const maxW = strip.w * (portrait ? 0.88 : 0.84)
  const maxLines = portrait ? 3 : 2
  const L = layoutCaption(ctx, s.text, s.lineDur, maxW, maxLines, `${s.lineIdx}|${strip.w}|${SANS}|${s.text}`)
  if (!L.words.length) return
  const times = s.wordTimes && s.wordTimes.length === L.words.length ? s.wordTimes : L.est
  let cur = 0
  for (let i = 0; i < times.length; i++) if (times[i] <= s.lineT) cur = i
  const page = L.pages.find(p => cur >= p[0][0] && cur <= p[p.length - 1][1]) ?? L.pages[0]
  const lineH = lh(size) + 2
  const space = ctx.measureText(' ').width
  const lineWidth = ([a, b]: [number, number]) => { let w = 0; for (let i = a; i <= b; i++) w += L.widths[i] + (i > a ? space : 0); return w }
  const top = strip.y + (strip.h - 4 - page.length * lineH) / 2

  ctx.save()
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  page.forEach((ln, li) => {
    let x = strip.x + strip.w / 2 - lineWidth(ln) / 2
    const y = top + lineH * li + lineH / 2
    for (let i = ln[0]; i <= ln[1]; i++) {
      // Broadcast-style progressive caption: spoken words bright, the rest dimmed.
      const spokenIn = easeOut((s.lineT - times[i] + 0.05) / 0.16)
      ctx.globalAlpha = i < cur ? 1 : i === cur ? 0.55 + 0.45 * spokenIn : 0.5
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText(L.words[i], x, y)
      x += L.widths[i] + space
    }
  })
  ctx.restore()
}

// ── Key-point panel (beside the picture) ────────────────────────────────────

interface PanelItem { kind: 'super' | 'kicker' | 'title' | 'bullet' | 'stat' | 'statLabel' | 'quote' | 'attrib' | 'source'; lines: string[]; size: number; font: string; color: string; gap: number; at: number; num?: string; words?: number[] }

/** Build the panel's text block at a given type scale; returns items + total height. */
function buildPanel(ctx: CanvasRenderingContext2D, slide: VideoSlide, s: FrameState, w: number, k: number, lead: number): { items: PanelItem[]; height: number } {
  const items: PanelItem[] = []
  const add = (it: PanelItem) => items.push(it)
  const cues = s.cues
  const mk = (font: string, size: number) => { ctx.font = `${font} ${size}px ${font.includes('italic') ? SERIF : SANS}`; return ctx.font }

  // Tags are wrapped with the same letter-spacing they're drawn with, or the
  // measured width is short and the line overflows the panel.
  const superText = [slide.location, slide.date].filter(Boolean).join('  ·  ')
  if (superText) { const f = mk('700', 9.5 * k); spacing(ctx, 1.4); add({ kind: 'super', lines: wrapLines(ctx, tag(superText), w, 2), size: 9.5 * k, font: f, color: C.accent, gap: 6 * k, at: 0.15 }); spacing(ctx, 0) }
  const kicker = slide.visual === 'stat' ? s.str.kickerStat : slide.visual === 'quote' ? s.str.kickerQuote : s.str.kickerList
  { const f = mk('600', 9 * k); spacing(ctx, 1.4); add({ kind: 'kicker', lines: wrapLines(ctx, tag(kicker), w, 1), size: 9 * k, font: f, color: C.dim, gap: 10 * k, at: 0.1 }); spacing(ctx, 0) }
  { const f = mk('700', 19 * k); add({ kind: 'title', lines: wrapLines(ctx, slide.title, w, 3), size: 19 * k, font: f, color: C.title, gap: 14 * k, at: 0.2 }) }

  // Card-time window in which an item can still fully appear before the
  // segment ends (the intro/chapter lead eats into short segments).
  const visible = Math.max(0.8, s.segDur - lead - 0.8)
  const cue = (t: number | undefined, fallback: number) => (t != null && Number.isFinite(t) ? Math.max(0.45, t - lead) : fallback)
  if (slide.visual === 'stat' && slide.stat) {
    const f = mk('700', 40 * k)
    add({ kind: 'stat', lines: [slide.stat.value], size: 40 * k, font: f, color: '#FFFFFF', gap: 10 * k, at: cue(cues?.stat, 0.6), num: slide.stat.value })
    const f2 = mk('400', 13 * k)
    add({ kind: 'statLabel', lines: wrapLines(ctx, slide.stat.label, w, 3), size: 13 * k, font: f2, color: C.body, gap: 12 * k, at: cue(cues?.stat, 0.6) + 0.35 })
  } else if (slide.visual === 'quote' && slide.quote) {
    const f = mk('italic 400', 16 * k)
    const lines = wrapLines(ctx, `“${slide.quote}”`, w, 7)
    const nWords = lines.join(' ').split(/\s+/).length
    const words = cues?.quote && cues.quote.length >= nWords - 1
      ? Array.from({ length: nWords }, (_, j) => cue(cues.quote![Math.min(j, cues.quote!.length - 1)], 0.5))
      : Array.from({ length: nWords }, (_, j) => 0.5 + (j / Math.max(1, nWords)) * Math.max(0, Math.min(visible - 0.5, 5)))
    add({ kind: 'quote', lines, size: 16 * k, font: f, color: C.title, gap: 10 * k, at: words[0] ?? 0.5, words })
    if (slide.quoteAttribution) { const f2 = mk('600', 10.5 * k); add({ kind: 'attrib', lines: wrapLines(ctx, `— ${slide.quoteAttribution}`, w, 2), size: 10.5 * k, font: f2, color: C.accent, gap: 12 * k, at: (words[words.length - 1] ?? 1) + 0.3 }) }
  } else {
    const bullets = (slide.bullets || []).slice(0, 4)
    const span = Math.max(0, Math.min(visible - 0.6, 7))
    bullets.forEach((b, i) => {
      const f = mk('400', 13 * k)
      const fallback = 0.6 + (bullets.length > 1 ? (i * span) / bullets.length : 0)
      add({ kind: 'bullet', lines: wrapLines(ctx, b, w - 22 * k, 3), size: 13 * k, font: f, color: C.body, gap: 9 * k, at: cue(cues?.bullets[i], fallback) })
    })
  }
  if (slide.source) { const f = mk('600', 8 * k); spacing(ctx, 0.6); add({ kind: 'source', lines: wrapLines(ctx, tag(`${s.str.sourcePrefix} · ${slide.source}`), w, 2), size: 8 * k, font: f, color: C.faint, gap: 0, at: 0.4 }); spacing(ctx, 0) }

  // Enforce reading order: nothing appears before the item above it — and
  // nothing so late it would never be seen before the segment ends.
  for (let i = 1; i < items.length; i++) if (items[i].kind !== 'source') items[i].at = Math.max(items[i].at, items[i - 1].at + (items[i].kind === 'bullet' ? 0.35 : 0))
  for (const it of items) {
    if (it.kind === 'source') continue
    it.at = Math.min(it.at, visible)
    if (it.words) it.words = it.words.map(t => Math.min(t, visible))
  }
  const height = items.reduce((a, it) => a + it.lines.length * lh(it.size) + it.gap, 0)
  return { items, height }
}

function drawPanel(ctx: CanvasRenderingContext2D, panel: Rect, slide: VideoSlide, s: FrameState, cardT: number, alpha: number, lead: number) {
  if (alpha <= 0.01) return
  const portrait = panel.w > panel.h
  const pad = portrait ? 20 : 22
  const w = panel.w - pad * 2
  const avail = panel.h - pad * 2
  // Fit: step the type scale down until the block fits the panel.
  let block = buildPanel(ctx, slide, s, w, 1, lead)
  for (const k of [0.92, 0.85, 0.78, 0.72]) {
    if (block.height <= avail) break
    block = buildPanel(ctx, slide, s, w, k, lead)
  }
  const sourceItem = block.items.find(it => it.kind === 'source')
  const body = block.items.filter(it => it !== sourceItem)
  const bodyH = body.reduce((a, it) => a + it.lines.length * lh(it.size) + it.gap, 0)
  let y = panel.y + pad + Math.max(0, (avail - (sourceItem ? lh(sourceItem.size) * sourceItem.lines.length + 10 : 0) - bodyH) * (portrait ? 0 : 0.42))

  ctx.save()
  ctx.beginPath(); ctx.rect(panel.x, panel.y, panel.w, panel.h); ctx.clip()
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  const x0 = panel.x + pad
  for (const it of body) {
    const a = easeOut((cardT - it.at) / 0.45) * alpha
    const slideIn = (1 - easeOut((cardT - it.at) / 0.5)) * 8
    ctx.font = it.font
    ctx.fillStyle = it.color
    spacing(ctx, it.kind === 'super' || it.kind === 'kicker' ? 1.4 : 0)
    if (it.kind === 'stat' && it.num) {
      const parsed = parseStat(it.num)
      const p = easeInOut((cardT - it.at) / 1.3)
      ctx.globalAlpha = a
      const shown = parsed ? `${parsed.prefix}${parsed.format(parsed.num * p)}${parsed.suffix}` : it.num
      y += lh(it.size) * 0.85
      ctx.fillText(shown, x0 + slideIn, y)
      // accent rule that fills with the count
      ctx.fillStyle = withAlpha('#FFFFFF', 0.14); rrect(ctx, x0, y + 8, w * 0.7, 3, 1.5); ctx.fill()
      ctx.fillStyle = C.accent; rrect(ctx, x0, y + 8, w * 0.7 * p, 3, 1.5); ctx.fill()
      y += lh(it.size) * 0.15 + 8 + it.gap
      continue
    }
    if (it.kind === 'bullet') {
      ctx.globalAlpha = a
      ctx.fillStyle = C.accent
      rrect(ctx, x0 + slideIn, y + lh(it.size) * 0.42, 9, 2.5, 1.25); ctx.fill()
      ctx.fillStyle = it.color
      it.lines.forEach(l => { y += lh(it.size); ctx.fillText(l, x0 + 20 + slideIn, y - lh(it.size) * 0.25) })
      y += it.gap
      continue
    }
    if (it.kind === 'quote' && it.words) {
      let wi = 0
      const space = ctx.measureText(' ').width
      const blockIn = easeOut((cardT - 0.35) / 0.45) // appears with the title, then words brighten as they're read
      it.lines.forEach(l => {
        y += lh(it.size)
        let wx = x0
        for (const word of l.split(' ')) {
          const wa = alpha * blockIn * (0.25 + 0.75 * easeOut((cardT - (it.words![wi] ?? 0)) / 0.3))
          ctx.globalAlpha = wa
          ctx.fillText(word, wx, y - lh(it.size) * 0.25)
          wx += ctx.measureText(word).width + space
          wi++
        }
      })
      y += it.gap
      continue
    }
    ctx.globalAlpha = a
    it.lines.forEach(l => { y += lh(it.size); ctx.fillText(l, x0 + slideIn, y - lh(it.size) * 0.25) })
    if (it.kind === 'title') {
      // short accent rule under the statement
      const rw = 28 * easeOut((cardT - it.at - 0.2) / 0.5)
      ctx.fillStyle = C.accent; rrect(ctx, x0, y + 4, rw, 2.5, 1.25); ctx.fill()
      y += 6
    }
    y += it.gap
  }
  if (sourceItem) {
    ctx.globalAlpha = easeOut((cardT - sourceItem.at) / 0.5) * alpha
    ctx.font = sourceItem.font; ctx.fillStyle = sourceItem.color; spacing(ctx, 0.6)
    const sy = panel.y + panel.h - pad + 4 - (sourceItem.lines.length - 1) * lh(sourceItem.size)
    sourceItem.lines.forEach((l, i) => ctx.fillText(l, x0, sy + i * lh(sourceItem.size)))
  }
  spacing(ctx, 0)
  ctx.restore()
}

// ── Pictures ────────────────────────────────────────────────────────────────

/** Where a picture came from — shown on screen so an AI image is never
 *  mistaken for a real photograph. */
export interface Visual {
  el: CanvasImageSource
  kind: 'field' | 'ai' | 'ai-photo' | 'ai-motion'
  /** For field photos: the report's place / date. */
  label?: string
}

/** A tiny downscaled copy of a picture — drawn scaled up it is a soft blur
 *  (no ctx.filter, which not every browser's canvas supports). */
const blurCache = new WeakMap<object, HTMLCanvasElement>()
function blurredOf(el: CanvasImageSource, dim: { w: number; h: number }): HTMLCanvasElement {
  let c = blurCache.get(el as object)
  if (!c) {
    c = document.createElement('canvas')
    const k = 24 / Math.max(dim.w, dim.h)
    c.width = Math.max(2, Math.round(dim.w * k)); c.height = Math.max(2, Math.round(dim.h * k))
    c.getContext('2d')!.drawImage(el, 0, 0, c.width, c.height)
    blurCache.set(el as object, c)
  }
  return c
}

function drawPhoto(ctx: CanvasRenderingContext2D, r: Rect, el: CanvasImageSource, progress: number, seed: number, alpha: number, strength = 1) {
  const dim = drawableSize(el)
  if (!dim) return false
  ctx.save()
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip()
  ctx.globalAlpha = alpha
  if (el instanceof HTMLVideoElement) {
    const k = Math.max(r.w / dim.w, r.h / dim.h)
    ctx.drawImage(el, r.x + (r.w - dim.w * k) / 2, r.y + (r.h - dim.h * k) / 2, dim.w * k, dim.h * k)
  } else {
    // A picture far off the frame's shape would lose its subject to a hard crop,
    // so it eases from "fill" toward "fit" over a blurred copy of itself.
    const cover = Math.max(r.w / dim.w, r.h / dim.h), contain = Math.min(r.w / dim.w, r.h / dim.h)
    const mismatch = Math.max(dim.w / dim.h, r.w / r.h) / Math.min(dim.w / dim.h, r.w / r.h)
    const fit = clamp01((mismatch - 1.5) / 1.5) * 0.5
    const base = Math.pow(cover, 1 - fit) * Math.pow(contain, fit)
    if (fit > 0) {
      const b = blurredOf(el, dim), bk = Math.max(r.w / b.width, r.h / b.height) * 1.15
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(b, r.x + (r.w - b.width * bk) / 2, r.y + (r.h - b.height * bk) / 2, b.width * bk, b.height * bk)
      ctx.fillStyle = 'rgba(4,7,12,0.45)'; ctx.fillRect(r.x, r.y, r.w, r.h)
    }
    // Ken Burns over the shot, alternating push/pull — restrained by default;
    // Reels pass a higher `strength` for a livelier, handheld feel.
    const p = easeInOut(progress)
    const span = 0.07 * strength
    const zoom = seed % 2 === 0 ? 1.03 + p * span : 1.03 + span - p * span
    const dirs: [number, number][] = [[-1, -0.5], [1, -0.4], [-0.8, 0.5], [1, 0.4]]
    const [dx, dy] = dirs[seed % dirs.length]
    const k = base * zoom
    const pw = dim.w * k, ph = dim.h * k
    const drift = 0.025 * strength
    ctx.drawImage(el, r.x + (r.w - pw) / 2 + dx * r.w * drift * (p - 0.5), r.y + (r.h - ph) / 2 + dy * r.h * drift * (p - 0.5), pw, ph)
  }
  ctx.restore()
  return true
}

// ── Picture edit (shots) ────────────────────────────────────────────────────

/** A run of consecutive shots showing the same picture (a shot whose own
 *  picture is missing holds the previous one) — drawn as ONE continuous shot:
 *  one move, no dissolve inside it. */
interface Run { first: number; last: number; start: number; end: number; v: Visual }

function runAt(s: FrameState, k: number): Run | null {
  const v = k >= 0 ? s.visualFor(k) : null
  if (!v) return null
  const tl = s.tl
  let first = k, last = k
  while (first > 0 && tl.shotSeg[first - 1] === tl.shotSeg[k] && s.visualFor(first - 1)?.el === v.el) first--
  while (last + 1 < tl.shotStart.length && tl.shotSeg[last + 1] === tl.shotSeg[k] && s.visualFor(last + 1)?.el === v.el) last++
  return { first, last, start: tl.shotStart[first], end: tl.shotEnd[last], v }
}

interface Cut {
  cur: Run | null
  prev: Run | null
  /** Opacity of the incoming picture (1 = cut finished). */
  a: number
  /** Dissolve length used for this cut — Ken Burns runs a little past the shot by this much. */
  xf: number
}

/** Which picture(s) are on screen now and how far the cut between them has
 *  got. `xSeg` / `xShot` = dissolve into a new card / within a card. */
function currentCut(s: FrameState, xSeg: number, xShot: number, chapterCut: boolean): Cut {
  const cur = s.shotIdx >= 0 ? runAt(s, s.shotIdx) : null
  if (!cur) return { cur: null, prev: null, a: 1, xf: xShot }
  // The picture before this run that was actually on screen (skip zero-length shots).
  let pk = cur.first - 1
  while (pk >= 0 && s.tl.shotEnd[pk] - s.tl.shotStart[pk] <= 0.001) pk--
  const prev = pk >= 0 ? runAt(s, pk) : null
  if (!prev || prev.v.el === cur.v.el) return { cur, prev: null, a: 1, xf: xShot }
  const newCard = s.tl.shotSeg[pk] !== s.tl.shotSeg[cur.first]
  const since = s.t - cur.start
  // A chapter card hides the cut: the old picture holds until the card is fully up, then a straight cut.
  if (newCard && chapterCut) return { cur, prev: since < CHAPTER_IN_SECONDS ? prev : null, a: since < CHAPTER_IN_SECONDS ? 0 : 1, xf: xSeg }
  const xf = newCard ? xSeg : xShot
  const a = easeInOut(clamp01(since / xf))
  return { cur, prev: a < 1 ? prev : null, a, xf }
}

/** Ken Burns position (0..1) of a run at time t — continues through the dissolve out. */
const runProgress = (r: Run, t: number, xf: number) => clamp01((t - r.start) / Math.max(0.5, r.end - r.start + xf))

/** Draw the cut into `rect`; returns what was drawn (for the provenance labels). */
function drawCut(ctx: CanvasRenderingContext2D, rect: Rect, s: FrameState, cut: Cut, strength: number) {
  let prevDrawn = false, curDrawn = false
  if (cut.prev && cut.a < 1) prevDrawn = drawPhoto(ctx, rect, cut.prev.v.el, runProgress(cut.prev, s.t, cut.xf), cut.prev.first, 1, strength)
  if (cut.cur && cut.a > 0) curDrawn = drawPhoto(ctx, rect, cut.cur.v.el, runProgress(cut.cur, s.t, cut.xf), cut.cur.first, cut.a, strength)
  return { prevDrawn, curDrawn }
}

/** Provenance for what the cut put on screen: one label per visible picture,
 *  each at its picture's opacity — but two pictures carrying the very same
 *  label (two AI illustrations) share one, instead of flashing a doubled tag. */
function drawCutProvenance(ctx: CanvasRenderingContext2D, rect: Rect, s: FrameState, cut: Cut, drawn: { prevDrawn: boolean; curDrawn: boolean }, maxBottom: number, topLeft?: { x: number; y: number }) {
  const p = drawn.prevDrawn && cut.prev ? cut.prev.v : null
  const c = drawn.curDrawn && cut.cur ? cut.cur.v : null
  if (p && c && provenanceText(p, s) === provenanceText(c, s)) { drawProvenance(ctx, rect, c, s, 1, maxBottom, 0, topLeft); return }
  const both = !!p && !!c && cut.a > 0.02 && cut.a < 0.98
  if (p) drawProvenance(ctx, rect, p, s, c ? 1 - cut.a : 1, maxBottom, both && !topLeft ? (LATIN ? 20 : 23) : 0, topLeft)
  if (c) drawProvenance(ctx, rect, c, s, cut.a, maxBottom, both && topLeft ? (LATIN ? 20 : 23) : 0, topLeft)
}

function drawAmbient(ctx: CanvasRenderingContext2D, r: Rect, t: number) {
  ctx.save()
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip()
  ctx.fillStyle = '#0E1A2B'; ctx.fillRect(r.x, r.y, r.w, r.h)
  const blobs: [number, number, number, string][] = [
    [0.3 + Math.sin(t * 0.21) * 0.12, 0.35 + Math.cos(t * 0.17) * 0.1, 0.6, withAlpha(C.accent, 0.18)],
    [0.72 + Math.cos(t * 0.19) * 0.1, 0.65 + Math.sin(t * 0.23) * 0.1, 0.55, 'rgba(20,184,166,0.12)'],
  ]
  for (const [bx, by, br, col] of blobs) {
    const g = ctx.createRadialGradient(r.x + bx * r.w, r.y + by * r.h, 0, r.x + bx * r.w, r.y + by * r.h, br * Math.max(r.w, r.h))
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h)
  }
  ctx.restore()
}

/** Documentary grade + edge falloff on the picture region only. */
function drawGrade(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save()
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip()
  ctx.globalCompositeOperation = 'saturation'
  ctx.globalAlpha = 0.14; ctx.fillStyle = '#808080'; ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.globalCompositeOperation = 'soft-light'
  ctx.globalAlpha = 0.12; ctx.fillStyle = '#FFB070'; ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  const v = ctx.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.4, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.75)
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.32)')
  ctx.fillStyle = v; ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.restore()
}

function provenanceText(v: Visual, s: FrameState) {
  const base = v.kind === 'field' ? s.str.provField : v.kind === 'ai' ? s.str.provAi : v.kind === 'ai-photo' ? s.str.provAiPhoto : s.str.provAiMotion
  return tag(v.kind === 'field' && v.label ? `${base} · ${v.label}` : base)
}

function drawProvenance(ctx: CanvasRenderingContext2D, r: Rect, v: Visual, s: FrameState, alpha: number, maxBottom = Infinity, lift = 0, topLeft?: { x: number; y: number }) {
  if (alpha <= 0.02) return
  const text = provenanceText(v, s)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `600 8px ${SANS}`; spacing(ctx, 0.8)
  const t = wrapLines(ctx, text, r.w * 0.7, 1)[0] ?? ''
  const tw = ctx.measureText(t).width
  const h = LATIN ? 16 : 19
  // Default: bottom-right of the picture. Reels pass a fixed top-left spot
  // (below Instagram's header, clear of its right-hand buttons).
  const x = topLeft ? topLeft.x : r.x + r.w - 10 - tw - 14
  const y = topLeft ? topLeft.y + lift : Math.min(r.y + r.h, maxBottom) - 10 - h - lift
  ctx.fillStyle = v.kind === 'field' ? 'rgba(6,10,18,0.66)' : 'rgba(76,29,149,0.78)'
  rrect(ctx, x, y, tw + 14, h, h / 2); ctx.fill()
  ctx.fillStyle = v.kind === 'field' ? 'rgba(255,255,255,0.9)' : '#EDE9FE'
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(t, x + 7, y + h / 2 + 0.5)
  spacing(ctx, 0)
  ctx.restore()
}

/** Organisation logo "bug", top-right of the picture. */
function drawLogo(ctx: CanvasRenderingContext2D, r: Rect, logo: HTMLImageElement | null, alpha: number, topInset = 0) {
  const d = logo ? drawableSize(logo) : null
  if (!logo || !d || alpha <= 0.02) return
  const h = 18, w = Math.min(72, (d.w / d.h) * h)
  const hh = (d.h / d.w) * w
  ctx.save()
  ctx.globalAlpha = alpha * 0.9
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6
  ctx.drawImage(logo, r.x + r.w - 12 - w, r.y + 12 + topInset, w, hh) // below the Reels header in 9:16
  ctx.restore()
}

// ── Full-frame cards ────────────────────────────────────────────────────────

function drawIntro(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const k = 1 - clamp01((s.t - (INTRO_SECONDS - SETTLE_SECONDS)) / (SETTLE_SECONDS * 0.8))
  if (k <= 0) return
  const portrait = H > W
  ctx.save()
  ctx.globalAlpha = k
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, 'rgba(6,10,18,0.45)'); g.addColorStop(1, 'rgba(6,10,18,0.92)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  const x = portrait ? 28 : 44
  const maxW = portrait ? W - x - REELS_SAFE.right : W - x * 2
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'

  let y = portrait ? H * 0.42 : H * 0.44
  ctx.globalAlpha = k * easeOut(s.t / 0.5)
  ctx.font = `700 9.5px ${SANS}`; spacing(ctx, 2.2); ctx.fillStyle = C.accent
  ctx.fillText(wrapLines(ctx, tag(s.org ? `${s.org}  ·  ${s.str.documentary}` : s.str.documentary), maxW, 1)[0] ?? '', x, y - 40)
  spacing(ctx, 0)

  const e = easeOut(s.t / 0.9)
  ctx.globalAlpha = k * e
  ctx.font = `700 ${portrait ? 26 : 30}px ${SANS}`; ctx.fillStyle = C.title
  const lines = wrapLines(ctx, s.title, maxW, 2)
  const rise = (1 - e) * 14
  lines.forEach((l, i) => ctx.fillText(l, x, y + rise + i * lh(portrait ? 26 : 30) - 14))
  y += (lines.length - 1) * lh(portrait ? 26 : 30)

  const lw = 44 * easeOut((s.t - 0.4) / 0.7)
  ctx.fillStyle = C.accent; rrect(ctx, x, y + 2, lw, 3, 1.5); ctx.fill()

  if (s.headline) {
    ctx.globalAlpha = k * easeOut((s.t - 0.75) / 0.6)
    ctx.font = `italic 400 ${portrait ? 15 : 16}px ${SERIF}`; ctx.fillStyle = C.body
    wrapLines(ctx, s.headline, maxW * 0.9, 3).forEach((l, i) => ctx.fillText(l, x, y + 30 + i * lh(16)))
    y += 30 + (wrapLines(ctx, s.headline, maxW * 0.9, 3).length - 1) * lh(16)
  }
  if (s.dateline) {
    ctx.globalAlpha = k * easeOut((s.t - 1.0) / 0.6)
    ctx.font = `500 11px ${SANS}`; ctx.fillStyle = C.dim
    ctx.fillText(wrapLines(ctx, s.dateline, maxW, 1)[0] ?? '', x, y + (s.headline ? 24 : 30))
  }
  ctx.restore()
}

/** Segment 0's chapter is folded into the intro. */
function hasChapterCard(s: FrameState, segIdx: number) {
  return !!s.slides[segIdx]?.chapter && !(segIdx === 0 && s.tl.hasIntro)
}

/** Numbered by the chapter cards the viewer actually sees — the cold-open
 *  chapter folded into the title card doesn't make the first card "Chapter 2". */
function chapterNumber(s: FrameState, segIdx: number) {
  let n = 0
  for (let i = 0; i <= segIdx && i < s.slides.length; i++) if (hasChapterCard(s, i)) n++
  return n
}

function drawChapterCard(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const k = easeOut(s.segT / 0.4) * (1 - clamp01((s.segT - (CHAPTER_SECONDS - 0.45)) / 0.45))
  if (k <= 0.01) return
  const slide = s.slides[s.segIdx]
  ctx.save()
  ctx.globalAlpha = k
  ctx.fillStyle = 'rgba(5,8,14,0.86)'; ctx.fillRect(0, 0, W, H)
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 10px ${SANS}`; spacing(ctx, 2.6); ctx.fillStyle = C.accent
  ctx.fillText(tag(fmt(s.str.chapter, { n: chapterNumber(s, s.segIdx) })), W / 2, H / 2 - 24)
  spacing(ctx, 0)
  const rise = (1 - easeOut(s.segT / 0.7)) * 10
  const size = H > W ? 25 : 29
  ctx.font = `600 ${size}px ${SERIF}`; ctx.fillStyle = C.title
  wrapLines(ctx, slide.chapter!, W * (H > W ? 0.7 : 0.8), 2).forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + 14 + rise + i * lh(size)))
  ctx.restore()
}

function drawOutro(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const ot = s.t - s.total
  if (ot < 0 || ot > OUTRO_SECONDS + 0.8 || !s.slides.length) return
  const portrait = H > W
  const k = easeOut(ot / 0.7)
  ctx.save()
  ctx.globalAlpha = k
  ctx.fillStyle = '#060A12'; ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  const x = portrait ? 28 : 56
  const maxW = portrait ? W - x - REELS_SAFE.right : W - x * 2
  let y = portrait ? REELS_SAFE.top + 40 : H * 0.2

  if (s.headline) {
    ctx.font = `700 9.5px ${SANS}`; spacing(ctx, 2.2); ctx.fillStyle = C.accent
    ctx.fillText(tag(s.str.message), x, y); spacing(ctx, 0)
    y += 12
    ctx.globalAlpha = k * easeOut((ot - 0.2) / 0.6)
    const size = portrait ? 19 : 21
    ctx.font = `italic 400 ${size}px ${SERIF}`; ctx.fillStyle = C.title
    for (const l of wrapLines(ctx, s.headline, maxW, 3)) { y += lh(size); ctx.fillText(l, x, y) }
    y += 26
  }
  const rows = recapRows(s.slides, portrait ? 5 : 4)
  ctx.globalAlpha = k
  ctx.font = `700 9.5px ${SANS}`; spacing(ctx, 2.2); ctx.fillStyle = C.accent
  ctx.fillText(tag(s.str.recap), x, y); spacing(ctx, 0)
  y += 6
  const size = portrait ? 14 : 15
  rows.forEach((row, i) => {
    const b = easeOut((ot - 0.9 - i * 0.22) / 0.45)
    ctx.globalAlpha = k * b
    y += lh(size) + 4
    const x0 = x + (1 - b) * 10
    ctx.font = `700 10.5px ${SANS}`; ctx.fillStyle = C.accent
    ctx.fillText(String(i + 1).padStart(2, '0'), x0, y)
    let tx = x0 + 26
    if (row.value) {
      // A figure leads its row in the accent colour: "412  women running fish ponds…"
      ctx.font = `700 ${size}px ${SANS}`; ctx.fillStyle = C.accent
      ctx.fillText(row.value, tx, y)
      tx += ctx.measureText(row.value).width + size * 0.45
    }
    ctx.font = `600 ${size}px ${SANS}`; ctx.fillStyle = C.title
    ctx.fillText(wrapLines(ctx, row.text, maxW - (tx - x), 1)[0] ?? '', tx, y)
  })
  ctx.restore()
}

/** `n` items spread evenly across `arr` (all of it when it's short enough). */
function spread<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr
  return Array.from({ length: n }, (_, j) => arr[Math.floor(((j + 0.5) * arr.length) / n)])
}

/** The recap lists what the records SHOW — the film's figures (value + what
 *  it counts) first, topped up with card titles (each a stated point), in the
 *  order they played. Chapter names ("The work") are headings, not findings. */
function recapRows(slides: VideoSlide[], max: number): { value?: string; text: string }[] {
  const all = slides.map((_, i) => i)
  const stats = all.filter(i => slides[i].visual === 'stat' && slides[i].stat?.value)
  const picks = [...spread(stats, max)]
  picks.push(...spread(all.filter(i => !stats.includes(i) && slides[i].title), max - picks.length))
  return picks.sort((a, b) => a - b).map(i => {
    const sl = slides[i]
    return sl.visual === 'stat' && sl.stat ? { value: sl.stat.value, text: sl.stat.label || sl.title } : { text: sl.title }
  })
}

function drawCredits(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const ct = s.t - s.total - (s.tl.hasOutro ? OUTRO_SECONDS : 0)
  if (ct < 0) return
  ctx.save()
  ctx.globalAlpha = easeOut(ct / 0.6)
  ctx.fillStyle = '#05080E'; ctx.fillRect(0, 0, W, H)
  const portrait = H > W
  const maxW = W * (portrait ? 0.72 : 0.7)
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  const blocks: { head: string; lines: string[] }[] = []
  if (s.org) blocks.push({ head: s.str.producedBy, lines: [s.org] })
  blocks.push({ head: s.str.sources, lines: s.credits.length ? s.credits : ['—'] })
  blocks.push({ head: s.str.productionNotes, lines: [
    s.str.noteVoices,
    fmt(s.str.notePhotos, { field: s.str.provField }),
    fmt(s.str.noteAi, { ai: s.str.provAi }),
  ] })
  const size = portrait ? 11.5 : 12
  const heights = blocks.map(b => 20 + b.lines.reduce((a, l) => { ctx.font = `400 ${size}px ${SANS}`; return a + wrapLines(ctx, l, maxW, 2).length * lh(size) + 2 }, 0) + 16)
  // Portrait: centre within the Reels-safe band (below the header, above the caption bar).
  const top = portrait ? REELS_SAFE.top : 34
  const safeH = portrait ? H - REELS_SAFE.top - REELS_SAFE.bottom : H
  let y = Math.max(top, (portrait ? top : 0) + (safeH - heights.reduce((a, b) => a + b, 0)) / 2)
  blocks.forEach((b, bi) => {
    ctx.globalAlpha = easeOut((ct - 0.3 - bi * 0.6) / 0.6)
    ctx.font = `700 9.5px ${SANS}`; spacing(ctx, 2.2); ctx.fillStyle = C.accent
    ctx.fillText(tag(b.head), W / 2, y); spacing(ctx, 0)
    y += 20
    ctx.font = `400 ${size}px ${SANS}`; ctx.fillStyle = C.body
    for (const line of b.lines.slice(0, 5)) {
      for (const l of wrapLines(ctx, line, maxW, 2)) { ctx.fillText(l, W / 2, y); y += lh(size) }
      y += 2
    }
    y += 16
  })
  ctx.restore()
}

// Film grain — very light, in DEVICE pixels, deterministic per timeline time.
let grainTile: HTMLCanvasElement | null = null
const grainPattern = new WeakMap<CanvasRenderingContext2D, CanvasPattern>()
function drawGrain(ctx: CanvasRenderingContext2D, t: number) {
  if (!grainTile) {
    grainTile = document.createElement('canvas'); grainTile.width = grainTile.height = 128
    const g = grainTile.getContext('2d')!
    const img = g.createImageData(128, 128)
    let seed = 1337
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647
      const v = seed % 256
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
  }
  let pat = grainPattern.get(ctx)
  if (!pat) { pat = ctx.createPattern(grainTile, 'repeat')!; grainPattern.set(ctx, pat) }
  const f = Math.floor(t * 24)
  pat.setTransform(new DOMMatrix().translate((f * 53) % 128, (f * 97) % 128))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.04
  ctx.fillStyle = pat
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
}

// ── Reels (9:16) — creator-style layout ─────────────────────────────────────
// No title/chapter/recap cards, but provenance labels and source/AI credits stay (org honesty rules).

/** Silent tail after the narration in a Reel: just the short credits card. */
const REEL_TAIL_SECONDS = 4
/** Reels cut fast: a quick dissolve into a new card, a near-straight cut between its pictures. */
const REEL_XFADE_SEG_SECONDS = 0.25
const REEL_XFADE_SHOT_SECONDS = 0.12

/** Seconds of silent tail after the narration for this aspect and layout. */
export function tailSeconds(portrait: boolean, layout: VideoLayout = 'briefing') {
  if (layout === 'story') return STORY_TAIL_SECONDS
  return portrait ? REEL_TAIL_SECONDS : EXPORT_TAIL_SECONDS
}

/** Creator-style text: each line on its own rounded highlight box. Returns the next y. */
function drawBoxedLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, size: number, font: string, fg: string, bg: string, alpha: number, rise: number): number {
  if (alpha <= 0.01) return y + lines.length * (lh(size) + 6)
  ctx.save()
  ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  const padX = size * 0.45, boxH = lh(size) + 2
  for (const l of lines) {
    const w = ctx.measureText(l).width
    ctx.globalAlpha = alpha
    ctx.fillStyle = bg; rrect(ctx, x, y + rise, w + padX * 2, boxH, size * 0.28); ctx.fill()
    ctx.fillStyle = fg; ctx.fillText(l, x + padX, y + rise + boxH / 2 + 0.5)
    y += boxH + 4
  }
  ctx.restore()
  return y + 2
}

/** The segment's key point as on-screen text over the picture (upper safe area). */
function drawReelText(ctx: CanvasRenderingContext2D, W: number, slide: VideoSlide, s: FrameState, cardT: number, alpha: number) {
  if (alpha <= 0.01) return
  const x = 18
  const maxW = W - x - REELS_SAFE.right - 8
  let y = REELS_SAFE.top + 44 // below the provenance label
  // The cold open is the Reel's first frame (and its cover in the feed): its
  // place, title and number are on screen from frame one — not a "0" counting up.
  const hook = slide === s.slides[0]
  const pop = (at: number) => (hook && at <= 0
    ? { a: alpha, rise: 0 }
    : { a: easeOut((cardT - at) / 0.25) * alpha, rise: (1 - easeOut((cardT - at) / 0.3)) * 6 })
  const cue = (t: number | undefined, fallback: number) => (t != null && Number.isFinite(t) ? Math.max(0.3, t) : fallback)
  const visible = Math.max(0.6, s.segDur - 0.6)

  const superText = [slide.location, slide.date].filter(Boolean).join('  ·  ')
  if (superText) {
    const { a } = pop(hook ? 0 : 0.05)
    ctx.save(); ctx.globalAlpha = a
    ctx.font = `700 9px ${SANS}`; spacing(ctx, 1.2); ctx.fillStyle = '#FFFFFF'
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText(wrapLines(ctx, tag(superText), maxW, 1)[0] ?? '', x + 2, y)
    spacing(ctx, 0); ctx.restore()
    y += 10
  }

  if (slide.visual === 'stat' && slide.stat) {
    const at = hook ? 0 : Math.min(cue(s.cues?.stat, 0.35), visible)
    const { a, rise } = pop(at)
    const parsed = parseStat(slide.stat.value)
    const p = hook ? 1 : easeInOut((cardT - at) / 1.0)
    const shown = parsed ? `${parsed.prefix}${parsed.format(parsed.num * p)}${parsed.suffix}` : slide.stat.value
    ctx.save(); ctx.globalAlpha = a
    ctx.font = `800 46px ${SANS}`; ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 10
    y += lh(46) * 0.9
    ctx.fillText(wrapLines(ctx, shown, maxW, 1)[0] ?? shown, x, y + rise)
    ctx.restore()
    y += 10
    ctx.font = `700 14px ${SANS}`
    const lp = pop(hook ? 0 : at + 0.25)
    y = drawBoxedLines(ctx, wrapLines(ctx, slide.stat.label, maxW - 14, 3), x, y, 14, ctx.font, '#0B0F17', withAlpha(C.accent, 0.95), lp.a, lp.rise)
  } else if (slide.visual === 'quote' && slide.quote) {
    const at = hook ? 0 : Math.min(cue(s.cues?.quote?.[0], 0.35), visible)
    ctx.font = `italic 600 15px ${SERIF}`
    const { a, rise } = pop(at)
    y = drawBoxedLines(ctx, wrapLines(ctx, `“${slide.quote}”`, maxW - 14, 5), x, y, 15, ctx.font, '#FFFFFF', 'rgba(8,10,16,0.72)', a, rise)
    if (slide.quoteAttribution) {
      ctx.font = `600 10px ${SANS}`
      y = drawBoxedLines(ctx, wrapLines(ctx, `— ${slide.quoteAttribution}`, maxW - 12, 2), x, y, 10, ctx.font, '#0B0F17', withAlpha(C.accent, 0.95), pop(at + 0.4).a, pop(at + 0.4).rise)
    }
  } else {
    ctx.font = `800 20px ${SANS}`
    const t = pop(hook ? 0 : 0.1)
    y = drawBoxedLines(ctx, wrapLines(ctx, slide.title, maxW - 18, 3), x, y, 20, ctx.font, '#0B0F17', 'rgba(255,255,255,0.96)', t.a, t.rise)
    const bullets = (slide.bullets || []).slice(0, 3)
    const span = Math.max(0, Math.min(visible - 0.6, 6))
    bullets.forEach((b, i) => {
      const at = Math.min(cue(s.cues?.bullets[i], 0.5 + (bullets.length > 1 ? (i * span) / bullets.length : 0)), visible)
      ctx.font = `600 12.5px ${SANS}`
      const bp = pop(at)
      y = drawBoxedLines(ctx, wrapLines(ctx, b, maxW - 12, 2), x, y, 12.5, ctx.font, '#FFFFFF', 'rgba(8,10,16,0.7)', bp.a, bp.rise)
    })
  }

  if (slide.source) {
    ctx.save(); ctx.globalAlpha = easeOut((cardT - 0.5) / 0.4) * alpha * 0.85
    ctx.font = `600 7.5px ${SANS}`; spacing(ctx, 0.5); ctx.fillStyle = '#FFFFFF'
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText(wrapLines(ctx, tag(`${s.str.sourcePrefix} · ${slide.source}`), maxW, 1)[0] ?? '', x + 2, y + 8)
    spacing(ctx, 0); ctx.restore()
  }
}

/** Small creator-style captions, lower-middle, current word highlighted. */
function drawReelCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  if (!s.text || s.lineIdx < 0) return
  const size = 12.5
  ctx.font = `700 ${size}px ${SANS}`
  const left = 20, right = W - REELS_SAFE.right
  const maxW = right - left
  const L = layoutCaption(ctx, s.text, s.lineDur, maxW, 2, `reel|${s.lineIdx}|${maxW}|${SANS}|${s.text}`)
  if (!L.words.length) return
  const times = s.wordTimes && s.wordTimes.length === L.words.length ? s.wordTimes : L.est
  let cur = 0
  for (let i = 0; i < times.length; i++) if (times[i] <= s.lineT) cur = i
  const page = L.pages.find(p => cur >= p[0][0] && cur <= p[p.length - 1][1]) ?? L.pages[0]
  const lineH = lh(size) + 2
  const space = ctx.measureText(' ').width
  const lineWidth = ([a, b]: [number, number]) => { let w = 0; for (let i = a; i <= b; i++) w += L.widths[i] + (i > a ? space : 0); return w }
  const bottom = H - REELS_SAFE.bottom - 22
  const top = bottom - page.length * lineH
  ctx.save()
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1
  page.forEach((ln, li) => {
    let x = (left + right) / 2 - lineWidth(ln) / 2
    const y = top + lineH * li + lineH / 2
    for (let i = ln[0]; i <= ln[1]; i++) {
      ctx.globalAlpha = i <= cur ? 1 : 0.7
      ctx.fillStyle = i === cur ? '#FFE15A' : '#FFFFFF'
      ctx.fillText(L.words[i], x, y)
      x += L.widths[i] + space
    }
  })
  ctx.restore()
}

function renderReelFrame(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const full: Rect = { x: 0, y: 0, w: W, h: H }
  const inTail = s.t >= s.total

  // Full-screen picture, a new one on every shot, quick cuts, livelier motion.
  let prevIdx = s.segIdx - 1
  while (prevIdx >= 0 && s.tl.segEnd[prevIdx] - s.tl.segStart[prevIdx] <= 0.001) prevIdx--
  const cut = currentCut(s, REEL_XFADE_SEG_SECONDS, REEL_XFADE_SHOT_SECONDS, false)
  const drawn = drawCut(ctx, full, s, cut, 1.7)
  if (drawn.prevDrawn || drawn.curDrawn) drawGrade(ctx, full)
  else drawAmbient(ctx, full, s.t)

  // Legibility scrims behind the on-screen text (top) and captions (bottom).
  const tg = ctx.createLinearGradient(0, 0, 0, H * 0.45)
  tg.addColorStop(0, 'rgba(0,0,0,0.55)'); tg.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H * 0.45)
  const bg = ctx.createLinearGradient(0, H * 0.55, 0, H)
  bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, 'rgba(0,0,0,0.72)')
  ctx.fillStyle = bg; ctx.fillRect(0, H * 0.55, W, H * 0.45)

  // Key point text — the incoming card pops in as the old one snaps out.
  const slide = s.segIdx >= 0 ? s.slides[s.segIdx] : null
  if (slide && !inTail) drawReelText(ctx, W, slide, s, s.segT, prevIdx >= 0 ? clamp01((s.segT - 0.12) / 0.15) : 1)
  if (prevIdx >= 0 && !inTail && s.segT < 0.15) {
    const prevSlide = s.slides[prevIdx]
    if (prevSlide) drawReelText(ctx, W, prevSlide, { ...s, cues: null, segDur: 99 }, 99, 1 - s.segT / 0.15)
  }
  if (!inTail) drawLogo(ctx, full, s.logo, 1, REELS_SAFE.top)

  // Provenance on every picture — top-left, just under Instagram's header.
  drawCutProvenance(ctx, full, s, cut, drawn, Infinity, { x: 18, y: REELS_SAFE.top + 2 })

  if (!inTail) drawReelCaptions(ctx, W, H, s)

  // Short credits only (sources + AI notes) — no recap card.
  drawCredits(ctx, W, H, { ...s, tl: { ...s.tl, hasOutro: false } })
  drawGrain(ctx, s.t)
  if (s.t > s.total) {
    ctx.fillStyle = `rgba(0,0,0,${clamp01((s.t - s.total - (REEL_TAIL_SECONDS - 0.6)) / 0.6)})`
    ctx.fillRect(0, 0, W, H)
  }
}

// ── Story layout (default, 16:9 and 9:16) ───────────────────────────────────
// Full-screen picture with the narration as the main graphic: two-line captions cut
// phrase by phrase, plus a data badge, place tag and quote moment when those are spoken.

/** End card after the narration: logo, sources and the AI disclosure. */
const STORY_TAIL_SECONDS = 5
const STORY_XFADE_SEG_SECONDS = 0.5
const STORY_XFADE_SHOT_SECONDS = 0.28

let DISPLAY = '"Poppins","IBM Plex Sans","Segoe UI",system-ui,sans-serif'

interface Beat { from: number; to: number; lines: string[] }
const beatCache = new Map<string, Beat[]>()
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => beatCache.clear())
}

// A caption line shouldn't END on a little English function word ("…ponds of
// / the…"), nor START on a Hindi/Marathi/Bengali postposition that belongs to
// the word before it ("सुपौल / में").
const NO_END = new Set(['a', 'an', 'the', 'no', 'not', 'never', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'had', 'has', 'have', 'their', 'its', 'our', 'this', 'that', 'these', 'those'])
const NO_START = new Set(['में', 'की', 'के', 'का', 'को', 'से', 'ने', 'पर', 'है', 'हैं', 'था', 'थे', 'थी', 'च्या', 'ची', 'चा', 'चे', 'ला', 'त', 'আর', 'এর', '—', '–', '-'])
// …and reads best breaking just BEFORE a conjunction ("…the first ponds / and rebuilt…").
const BREAK_BEFORE = new Set(['and', 'but', 'or', 'when', 'where', 'while', 'which', 'who', 'because', 'so', 'then', 'after', 'before', 'until', 'since', 'और', 'लेकिन', 'जब', 'जहाँ', 'क्योंकि', 'तो', 'आणि', 'पण', 'जेव्हा'])
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}—–-]/gu, '')
/** "412", "2.4", "₹18.6", "60%" — never split a number from the word it counts. */
const NUMERIC = /^[₹$]?\p{Nd}[\p{Nd},.]*%?$/u

/** Cut one narration line into caption beats: a clause per beat on two balanced
 *  lines of at most `maxW`, with no stray one- or two-word beats. Uses the current ctx.font. */
export function storyBeats(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxWords: number, key: string): Beat[] {
  const hit = beatCache.get(key)
  if (hit) return hit
  const words = text.split(/\s+/).filter(Boolean)
  const wCache = new Map<number, number>()
  const width = (a: number, b: number) => {
    const k = a * 4096 + b
    let w = wCache.get(k)
    if (w == null) { w = ctx.measureText(words.slice(a, b).join(' ')).width; wCache.set(k, w) }
    return w
  }
  const PUNCT = /[,.;:!?…।—–]["'”’)]*$/u
  const END = /[.!?…।]["'”’)]*$/u
  /** Penalty (or, negative, a bonus) for breaking a line or beat before word k. */
  const breakCost = (k: number) =>
    (NO_END.has(bare(words[k - 1] ?? '')) ? 0.3 : 0) + (NO_START.has(bare(words[k] ?? '')) ? 0.4 : 0)
    + (NUMERIC.test((words[k - 1] ?? '').replace(/[,;:]$/, '')) && !PUNCT.test(words[k - 1] ?? '') ? 0.4 : 0)
    - (PUNCT.test(words[k - 1] ?? '') ? 0.15 : 0) - (BREAK_BEFORE.has(bare(words[k] ?? '')) ? 0.22 : 0)
  const splitTwo = (a: number, b: number): number => {
    let best = -1, score = Infinity
    for (let k = a + 1; k < b; k++) {
      const w1 = width(a, k), w2 = width(k, b)
      if (w1 > maxW || w2 > maxW) continue
      // Balanced, the top line a touch longer ("Rainfall is supposed / to grow crops."),
      // and no one-word orphan line ("There were setbacks / too.").
      const orphan = (k - a === 1 || b - k === 1) && b - a >= 4 ? 0.3 * maxW : 0
      const sc = Math.max(w1, w2) + (w1 < w2 ? (w2 - w1) * 0.35 : 0) + breakCost(k) * maxW + orphan
      if (sc < score) { score = sc; best = k }
    }
    return best
  }
  const fits = (a: number, b: number) => b - a <= maxWords && (width(a, b) <= maxW || splitTwo(a, b) > 0)
  const beats: [number, number][] = []
  /** A phrase too long for one beat: balanced chunks, each breaking where it reads best. */
  const pushChunked = (a: number, b: number) => {
    if (fits(a, b)) { beats.push([a, b]); return }
    const n = Math.max(2, Math.ceil((b - a) / maxWords), Math.ceil(width(a, b) / (maxW * 1.75)))
    let start = a
    for (let c = 1; c < n; c++) {
      const target = (width(start, b) / (n - c + 1))
      let best = start + 1, score = Infinity
      for (let k = start + 1; k <= b - (n - c); k++) {
        if (!fits(start, k)) break
        const sc = Math.abs(width(start, k) - target) * 0.7 + breakCost(k) * maxW
        if (sc < score) { score = sc; best = k }
      }
      beats.push([start, best]); start = best
    }
    beats.push([start, b])
  }
  // Phrases end after punctuation.
  let s0 = 0
  words.forEach((w, k) => {
    if (!PUNCT.test(w) && k < words.length - 1) return
    const a = s0, b = k + 1
    s0 = b
    const last = beats[beats.length - 1]
    if (last) {
      const lastEnds = END.test(words[last[1] - 1]), tiny = last[1] - last[0] <= 2
      // Keep growing the beat within a sentence (or absorb a tiny one) while it fits.
      if ((!lastEnds || tiny) && fits(last[0], b)) { last[1] = b; return }
      if (tiny && !lastEnds) { beats.pop(); pushChunked(last[0], b); return }
    }
    pushChunked(a, b)
  })
  // A tiny last beat folds back into the one before it when that still fits.
  if (beats.length > 1) {
    const z = beats[beats.length - 1], y = beats[beats.length - 2]
    if (z[1] - z[0] <= 2 && fits(y[0], z[1])) { y[1] = z[1]; beats.pop() }
  }
  const out = beats.map(([a, b]): Beat => {
    // Two lines for a real phrase; a short one ("That is an output.") stays on one.
    const k = b - a >= 6 || width(a, b) > maxW * 0.72 ? splitTwo(a, b) : -1
    return { from: a, to: b, lines: k > 0 ? [words.slice(a, k).join(' '), words.slice(k, b).join(' ')] : [words.slice(a, b).join(' ')] }
  })
  if (beatCache.size > 600) beatCache.clear()
  beatCache.set(key, out)
  return out
}

/** Word start times for a line when no measured alignment is available. */
function estTimes(words: string[], dur: number): number[] {
  const weights = words.map(w => w.length + 2)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  return weights.map(wt => { const at = 0.08 + (acc / total) * Math.max(0.1, dur - 0.15); acc += wt; return at })
}

function drawStoryCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState, portrait: boolean) {
  if (s.lineIdx < 0 || !s.text) return
  const hook = s.lineIdx === 0
  const size = hook ? (portrait ? 31 : 31) : (portrait ? 24 : 21)
  ctx.save()
  ctx.font = `${hook ? 700 : 600} ${size}px ${DISPLAY}`
  const left = portrait ? 24 : 34
  const maxW = portrait ? W - left - REELS_SAFE.right : hook ? W * 0.78 : W * 0.56
  const beats = storyBeats(ctx, s.text, maxW, portrait ? 9 : 10, `${hook ? 'h' : 'n'}|${portrait ? 'p' : 'l'}|${W}|${DISPLAY}|${s.text}`)
  if (!beats.length) { ctx.restore(); return }
  const nWords = beats[beats.length - 1].to
  const times = s.wordTimes && s.wordTimes.length === nWords ? s.wordTimes : estTimes(s.text.split(/\s+/).filter(Boolean), s.lineDur)
  const startOf = (b: Beat) => (b.from === 0 ? 0 : Math.max(0, (times[b.from] ?? 0) - 0.06))
  let bi = 0
  for (let k = 0; k < beats.length; k++) if (startOf(beats[k]) <= s.lineT) bi = k
  const beat = beats[bi], start = startOf(beat)
  const center = portrait || hook
  const x = center ? (portrait ? (left + W - REELS_SAFE.right) / 2 : W / 2) : left
  const lineH = lh(size) * 0.96
  const block = beat.lines.length * lineH
  const yLast = hook ? (portrait ? H * 0.45 : H * 0.5) + block / 2 - lineH * 0.3 : portrait ? H - REELS_SAFE.bottom - 26 : H - 30
  ctx.textAlign = center ? 'center' : 'left'; ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 1
  beat.lines.forEach((l, k) => {
    const a = easeOut((s.lineT - start - k * 0.06) / 0.18)
    ctx.globalAlpha = a
    ctx.fillStyle = beat.lines.length > 1 && k === beat.lines.length - 1 ? C.accent : '#FFFFFF'
    ctx.fillText(l, x, yLast - (beat.lines.length - 1 - k) * lineH + (1 - a) * 6)
  })
  ctx.restore()
}

/** A small map-pin glyph (for the place tag). */
function drawPin(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, hole: string) {
  ctx.fillStyle = fill
  ctx.beginPath(); ctx.arc(cx, cy - r * 0.35, r, Math.PI * 0.85, Math.PI * 2.15); ctx.lineTo(cx, cy + r * 1.25); ctx.closePath(); ctx.fill()
  ctx.fillStyle = hole; ctx.beginPath(); ctx.arc(cx, cy - r * 0.35, r * 0.42, 0, Math.PI * 2); ctx.fill()
}

/** The place/date tag when a card opens (only when it differs from the previous card's). */
function drawPlaceTag(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState, slide: VideoSlide, portrait: boolean) {
  const text = [slide.location, slide.date].filter(Boolean).join('  ·  ')
  if (!text) return
  const prev = s.segIdx > 0 ? s.slides[s.segIdx - 1] : null
  if (prev && [prev.location, prev.date].filter(Boolean).join('  ·  ') === text) return
  const a = easeOut((s.segT - 0.25) / 0.3) * (1 - clamp01((s.segT - 3.6) / 0.4))
  if (a <= 0.01) return
  ctx.save()
  ctx.globalAlpha = a
  ctx.font = `700 9.5px ${DISPLAY}`; spacing(ctx, 1)
  const maxW = portrait ? W - 24 - REELS_SAFE.right - 30 : W * 0.5
  const t = wrapLines(ctx, tag(text), maxW, 1)[0] ?? ''
  const h = LATIN ? 20 : 23, w = ctx.measureText(t).width + 30
  const x = portrait ? 18 : 34
  // Landscape: just above the captions (where the eye already is); Reels: under the header.
  const y = portrait ? REELS_SAFE.top + 30 : H - 30 - lh(21) * 2 - h - 6
  const rise = (1 - easeOut((s.segT - 0.25) / 0.35)) * 5
  ctx.fillStyle = withAlpha(C.accent, 0.95); rrect(ctx, x, y + rise, w, h, h / 2); ctx.fill()
  drawPin(ctx, x + 11, y + rise + h / 2, 3.6, '#0B0F17', withAlpha(C.accent, 0.95))
  ctx.fillStyle = '#0B0F17'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(t, x + 20, y + rise + h / 2 + 0.5)
  spacing(ctx, 0)
  ctx.restore()
}

/** The number as a badge when it's spoken ("17 villages"), counting up. */
function drawStatBadge(ctx: CanvasRenderingContext2D, W: number, s: FrameState, slide: VideoSlide, portrait: boolean) {
  if (!slide.stat) return
  // When the number is spoken — but on the opening card not before the hook
  // line (big, mid-frame) has finished, so the two never overlap.
  const hookEnd = s.segIdx === 0 ? (s.tl.lineDur[0] ?? 0) - (s.tl.segStart[0] ?? 0) : 0
  const at = Math.max(0.3, hookEnd, s.cues?.stat != null && Number.isFinite(s.cues.stat) ? s.cues.stat : 0.8)
  const until = Math.min(at + 4.4, Math.max(at + 1.5, s.segDur - 0.3))
  const a = easeOut((s.segT - at) / 0.3) * (1 - clamp01((s.segT - until) / 0.35))
  if (a <= 0.01) return
  const parsed = parseStat(slide.stat.value)
  const p = easeInOut((s.segT - at) / 0.9)
  const shown = parsed ? `${parsed.prefix}${parsed.format(parsed.num * p)}${parsed.suffix}` : slide.stat.value
  const nSize = portrait ? 38 : 34, lSize = portrait ? 13 : 12, pad = 13
  ctx.save()
  ctx.globalAlpha = a
  ctx.font = `700 ${nSize}px ${DISPLAY}`
  const final = parsed ? `${parsed.prefix}${parsed.format(parsed.num)}${parsed.suffix}` : slide.stat.value
  const numW = Math.min(ctx.measureText(final).width, portrait ? 280 : 300)
  ctx.font = `500 ${lSize}px ${DISPLAY}`
  const labelLines = slide.stat.label ? wrapLines(ctx, slide.stat.label, Math.max(numW, portrait ? 230 : 210), 2) : []
  const labelW = labelLines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0)
  const bw = Math.max(numW, labelW) + pad * 2
  const bh = pad * 1.6 + lh(nSize) * 0.78 + labelLines.length * lh(lSize)
  const x = portrait ? (24 + W - REELS_SAFE.right) / 2 - bw / 2 : 34
  const y = portrait ? REELS_SAFE.top + 70 : 64
  const rise = (1 - a) * 8
  ctx.fillStyle = 'rgba(8,12,22,0.84)'; rrect(ctx, x, y + rise, bw, bh, 10); ctx.fill()
  ctx.strokeStyle = withAlpha(C.accent, 0.95); ctx.lineWidth = 1.5; rrect(ctx, x + 0.75, y + rise + 0.75, bw - 1.5, bh - 1.5, 9.5); ctx.stroke()
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 ${nSize}px ${DISPLAY}`; ctx.fillStyle = '#FFFFFF'
  ctx.fillText(wrapLines(ctx, shown, numW + 4, 1)[0] ?? shown, x + pad, y + rise + pad * 0.7 + lh(nSize) * 0.72)
  ctx.font = `500 ${lSize}px ${DISPLAY}`; ctx.fillStyle = 'rgba(255,255,255,0.88)'
  labelLines.forEach((l, k) => ctx.fillText(l, x + pad, y + rise + pad * 0.7 + lh(nSize) * 0.78 + (k + 0.8) * lh(lSize)))
  ctx.restore()
}

/** When a verified quote is read: the picture dims and the words come up as
 *  they're spoken. Returns whether it is on screen (captions step aside). */
function drawQuoteMoment(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState, slide: VideoSlide, portrait: boolean): boolean {
  if (!slide.quote) return false
  const spoken = s.cues?.quote && s.cues.quote.length ? s.cues.quote : null
  // Read aloud: full moment over the reading. Not read: a pull quote beside the captions.
  const start = spoken ? spoken[0] : 0.8
  const end = spoken ? spoken[spoken.length - 1] + 0.6 : start + 4.6
  const a = easeOut((s.segT - start + 0.2) / 0.3) * (1 - clamp01((s.segT - end) / 0.4))
  if (a <= 0.01) return false
  ctx.save()
  if (spoken) { ctx.globalAlpha = a * 0.5; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H) }
  const size = spoken ? (portrait ? 22 : 21) : (portrait ? 15 : 14)
  const maxW = spoken ? (portrait ? W - 24 - REELS_SAFE.right : W * 0.7) : (portrait ? W - 24 - REELS_SAFE.right : W * 0.46)
  ctx.font = `italic 500 ${size}px ${SERIF}`
  // A quote lifted from mid-sentence ("…saying: the pond is ours now.") still opens with a capital on screen.
  const quoteText = slide.quote.charAt(0).toLocaleUpperCase() + slide.quote.slice(1)
  const lines = wrapLines(ctx, `“${quoteText}”`, maxW, spoken ? 5 : 4)
  const cx = portrait ? (24 + W - REELS_SAFE.right) / 2 : spoken ? W / 2 : 34
  ctx.textAlign = spoken || portrait ? 'center' : 'left'; ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 8
  let y = spoken ? H * 0.5 - (lines.length * lh(size)) / 2 + lh(size) * 0.8 : portrait ? REELS_SAFE.top + 86 : 78
  let wi = 0
  for (const l of lines) {
    // Spoken quotes brighten word by word as they're read.
    if (spoken) {
      const ws = l.split(' ')
      const lineW = ctx.measureText(l).width, space = ctx.measureText(' ').width
      let wx = ctx.textAlign === 'center' ? cx - lineW / 2 : cx
      ctx.textAlign = 'left'
      for (const w of ws) {
        const t = spoken[Math.min(wi, spoken.length - 1)] ?? start
        ctx.globalAlpha = a * (0.35 + 0.65 * easeOut((s.segT - t + 0.05) / 0.25))
        ctx.fillStyle = '#FFFFFF'; ctx.fillText(w, wx, y)
        wx += ctx.measureText(w).width + space; wi++
      }
      ctx.textAlign = 'center'
    } else {
      ctx.globalAlpha = a; ctx.fillStyle = '#FFFFFF'; ctx.fillText(l, cx, y)
    }
    y += lh(size)
  }
  if (slide.quoteAttribution) {
    ctx.globalAlpha = a
    ctx.font = `600 ${spoken ? 10.5 : 9.5}px ${DISPLAY}`; spacing(ctx, 0.6); ctx.fillStyle = C.accent
    ctx.fillText(wrapLines(ctx, tag(`— ${slide.quoteAttribution}`), maxW, 1)[0] ?? '', cx, y + 4)
    spacing(ctx, 0)
  }
  ctx.restore()
  return !!spoken
}

/** Branded end card: logo (or name), the sources and the AI disclosure. */
function drawStoryEnd(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const et = s.t - s.total
  if (et < 0) return
  const portrait = H > W
  ctx.save()
  ctx.globalAlpha = easeOut(et / 0.6)
  ctx.fillStyle = '#05080E'; ctx.fillRect(0, 0, W, H)
  const g = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.7)
  g.addColorStop(0, withAlpha(C.accent, 0.26)); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  const top = portrait ? REELS_SAFE.top : 0, bottom = portrait ? H - REELS_SAFE.bottom : H
  let y = top + (bottom - top) * 0.34
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  const d = s.logo ? drawableSize(s.logo) : null
  ctx.globalAlpha = easeOut((et - 0.2) / 0.6)
  if (s.logo && d) {
    const maxW = portrait ? 190 : 170, maxH = portrait ? 64 : 56
    const k = Math.min(maxW / d.w, maxH / d.h)
    ctx.drawImage(s.logo, W / 2 - (d.w * k) / 2, y - d.h * k, d.w * k, d.h * k)
  } else {
    ctx.font = `700 ${portrait ? 24 : 26}px ${DISPLAY}`; ctx.fillStyle = '#FFFFFF'
    ctx.fillText(wrapLines(ctx, s.org || s.title, W * 0.8, 1)[0] ?? '', W / 2, y)
  }
  ctx.fillStyle = C.accent; rrect(ctx, W / 2 - 20, y + 14, 40 * easeOut((et - 0.4) / 0.6), 3, 1.5); ctx.fill()
  // Credits — the sources and what was AI-made (org honesty rule), small and quiet.
  ctx.globalAlpha = easeOut((et - 0.9) / 0.6)
  const maxW = portrait ? W * 0.82 : W * 0.72
  let cy = bottom - (portrait ? 128 : 92)
  ctx.font = `700 8.5px ${DISPLAY}`; spacing(ctx, 1.6); ctx.fillStyle = withAlpha(C.accent, 0.95)
  ctx.fillText(tag(s.str.sources), W / 2, cy); spacing(ctx, 0)
  ctx.font = `400 ${portrait ? 10 : 10.5}px ${SANS}`; ctx.fillStyle = 'rgba(226,232,240,0.82)'
  for (const l of wrapLines(ctx, (s.credits.length ? s.credits : ['—']).join('  ·  '), maxW, 2)) { cy += lh(10.5); ctx.fillText(l, W / 2, cy) }
  cy += 8
  ctx.font = `400 ${portrait ? 9 : 9.5}px ${SANS}`; ctx.fillStyle = 'rgba(203,213,225,0.62)'
  for (const note of [s.str.noteVoices, fmt(s.str.notePhotos, { field: s.str.provField }), fmt(s.str.noteAi, { ai: s.str.provAi })]) {
    for (const l of wrapLines(ctx, note, maxW, 2)) { cy += lh(9.5); ctx.fillText(l, W / 2, cy) }
  }
  ctx.restore()
  // Fade to black at the very end.
  ctx.fillStyle = `rgba(0,0,0,${clamp01((et - (STORY_TAIL_SECONDS - 0.6)) / 0.6)})`
  ctx.fillRect(0, 0, W, H)
}

function renderStoryFrame(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  const portrait = H > W
  const full: Rect = { x: 0, y: 0, w: W, h: H }
  const inTail = s.t >= s.total

  // Full-screen picture, a new one on every shot.
  const cut = currentCut(s, portrait ? REEL_XFADE_SEG_SECONDS : STORY_XFADE_SEG_SECONDS, portrait ? REEL_XFADE_SHOT_SECONDS : STORY_XFADE_SHOT_SECONDS, false)
  const drawn = drawCut(ctx, full, s, cut, portrait ? 1.5 : 1.2)
  if (drawn.prevDrawn || drawn.curDrawn) drawGrade(ctx, full)
  else drawAmbient(ctx, full, s.t)

  // Legibility scrims: under the captions, and a light one under the corner labels.
  const bottomStart = portrait ? H * 0.5 : H * 0.48
  const bg = ctx.createLinearGradient(0, bottomStart, 0, H)
  bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, 'rgba(0,0,0,0.66)')
  ctx.fillStyle = bg; ctx.fillRect(0, bottomStart, W, H - bottomStart)
  const tg = ctx.createLinearGradient(0, 0, 0, H * 0.22)
  tg.addColorStop(0, 'rgba(0,0,0,0.4)'); tg.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H * 0.22)
  if (s.lineIdx === 0 && !inTail) { // the hook sits mid-frame: a soft centre wash
    const hw = ctx.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, Math.max(W, H) * 0.55)
    hw.addColorStop(0, 'rgba(0,0,0,0.38)'); hw.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = hw; ctx.fillRect(0, 0, W, H)
  }

  const slide = s.segIdx >= 0 ? s.slides[s.segIdx] : null
  let quoteUp = false
  if (slide && !inTail) {
    if (slide.visual === 'quote') quoteUp = drawQuoteMoment(ctx, W, H, s, slide, portrait)
    if (slide.visual === 'stat') drawStatBadge(ctx, W, s, slide, portrait)
    if (!quoteUp) drawPlaceTag(ctx, W, H, s, slide, portrait)
  }
  if (!inTail && !quoteUp) drawStoryCaptions(ctx, W, H, s, portrait)

  // Provenance on every picture; logo bug top-right.
  drawCutProvenance(ctx, full, s, cut, drawn, Infinity, portrait ? { x: 18, y: REELS_SAFE.top + 2 } : { x: 16, y: 14 })
  if (!inTail) drawLogo(ctx, full, s.logo, 1, portrait ? REELS_SAFE.top : 0)

  drawStoryEnd(ctx, W, H, s)
  drawGrain(ctx, s.t)
}

// ── Frame ───────────────────────────────────────────────────────────────────

export interface FrameState {
  /** Timeline seconds. */
  t: number
  /** Narration length. */
  total: number
  tl: Timeline
  lineIdx: number
  lineT: number
  lineDur: number
  text: string
  speakHost: 'ALEX' | 'JORDAN' | null
  /** Measured start time of each caption word in the current line (videoSync.alignWords). */
  wordTimes: number[] | null
  /** When the current segment's bullets / stat / quote are spoken (videoSync.segmentCues). */
  cues: SegmentCues | null
  bars: number[]
  noLines: boolean
  slides: VideoSlide[]
  segIdx: number
  segT: number
  segDur: number
  /** Current picture — global shot index (Timeline.shotStart order), -1 if none. */
  shotIdx: number
  /** Picture for a shot index, with its provenance. */
  visualFor: (shotIdx: number) => Visual | null
  hosts: { alex: string; jordan: string }
  langNative: string
  title: string
  /** The film's one-sentence core message (first segment's headline). */
  headline: string
  /** "Place · period" line under the opening title. */
  dateline: string
  /** Source names for the closing credits. */
  credits: string[]
  /** On-screen labels in the narration language. */
  str: VideoStrings
  fonts: VideoFonts
  /** Brand: organisation name, accent colour (already lifted for dark), logo. */
  org: string
  accent: string
  logo: HTMLImageElement | null
  isPlaying: boolean
  /** Pixel scale over the logical layout size. */
  scale: number
  /** 'story' (default): full-screen pictures with narration captions, like
   *  The Better India / YourStory films. 'briefing': key points in a panel
   *  beside the picture (16:9) / creator-style boxed text (9:16). */
  layout: VideoLayout
}

export type VideoLayout = 'story' | 'briefing'

export function renderVideoFrame(ctx: CanvasRenderingContext2D, W: number, H: number, s: FrameState) {
  SANS = s.fonts.sans; SERIF = s.fonts.serif; DISPLAY = s.fonts.display; LATIN = s.fonts.latin
  C.accent = s.accent || '#A78BFA'
  ctx.setTransform(s.scale, 0, 0, s.scale, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  const full: Rect = { x: 0, y: 0, w: W, h: H }
  // No cards came back (the on-screen text step failed): the picture takes the
  // panel's place too, rather than an empty text column for the whole video.
  const split = s.slides.length ? splitLayout(W, H) : pictureOnlyLayout(W, H)

  ctx.fillStyle = C.panel; ctx.fillRect(0, 0, W, H)

  // Nothing to time yet (no audio, or every TTS call failed): a neutral title
  // frame rather than a picture without its label or captions.
  if (s.noLines || s.total <= 0) {
    drawAmbient(ctx, full, s.t)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = `700 22px ${SANS}`; ctx.fillStyle = C.title
    ctx.fillText(wrapLines(ctx, s.noLines ? s.str.idleTitle : s.title, W * 0.84, 1)[0] ?? '', W / 2, H / 2 - 12)
    if (s.noLines) {
      ctx.font = `400 13px ${SANS}`; ctx.fillStyle = C.dim
      ctx.fillText(s.str.idleSub, W / 2, H / 2 + 16)
    }
    return
  }

  if (s.layout === 'story') { renderStoryFrame(ctx, W, H, s); return }

  if (H > W) { renderReelFrame(ctx, W, H, s); return }

  // Intro: picture full-bleed, then glides into its split slot as the panel arrives.
  const settle = s.tl.hasIntro ? easeInOut((s.t - (INTRO_SECONDS - SETTLE_SECONDS)) / SETTLE_SECONDS) : 1
  const picRect = lerpRect(full, split.pic, settle)

  // ── Panel + strip backgrounds ──
  const pg = ctx.createLinearGradient(0, 0, 0, H)
  pg.addColorStop(0, '#0D1526'); pg.addColorStop(1, C.panel)
  ctx.fillStyle = pg; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = C.strip; ctx.fillRect(split.stripBg.x, split.stripBg.y, split.stripBg.w, split.stripBg.h)

  // ── Picture: the current shot, cut from the one before it ──
  let prevIdx = s.segIdx - 1
  while (prevIdx >= 0 && s.tl.segEnd[prevIdx] - s.tl.segStart[prevIdx] <= 0.001) prevIdx-- // skip zero-length segments
  const slide = s.segIdx >= 0 ? s.slides[s.segIdx] : null
  const chapter = !!slide && hasChapterCard(s, s.segIdx)
  const cut = currentCut(s, XFADE_SEG_SECONDS, XFADE_SHOT_SECONDS, chapter)
  const drawn = drawCut(ctx, picRect, s, cut, 1)
  if (drawn.prevDrawn || drawn.curDrawn) drawGrade(ctx, picRect)
  else drawAmbient(ctx, picRect, s.t)

  // Hairline accent between panel and picture.
  if (settle > 0 && split.panel.w > 0) {
    ctx.fillStyle = withAlpha(C.accent, 0.55 * settle)
    ctx.fillRect(split.pic.x - 1, 0, 2, split.pic.h * settle)
  }

  // ── Key-point panel ──
  // One exit only: the outgoing panel dissolves during the first 0.35s of the
  // next segment, and the incoming text waits for it so the two never overlap.
  const inTail = s.t >= s.total
  const handoff = prevIdx >= 0 && !chapter ? 0.3 : 0
  const lead = slide
    ? (s.segIdx === 0 && s.tl.hasIntro ? Math.max(0, INTRO_SECONDS - SETTLE_SECONDS * 0.5 - s.tl.segStart[0]) : 0) + (chapter ? CHAPTER_SECONDS - 0.3 : 0) + handoff
    : 0
  if (slide && !inTail) drawPanel(ctx, split.panel, slide, s, s.segT - lead, 1, lead)
  if (prevIdx >= 0 && !inTail && s.segT < 0.35) {
    const prevSlide = s.slides[prevIdx]
    if (prevSlide) drawPanel(ctx, split.panel, prevSlide, { ...s, cues: null, segDur: 99 }, 99, 1 - clamp01(s.segT / 0.35), 0)
  }
  if (!inTail) drawLogo(ctx, picRect, s.logo, s.tl.hasIntro ? clamp01((s.t - 1) / 0.6) : 1, split.logoTop)

  if (chapter && !inTail) drawChapterCard(ctx, W, H, s)
  if (s.tl.hasIntro && s.t < INTRO_SECONDS) drawIntro(ctx, W, H, s)

  // Drawn above the intro/chapter cards (which only dim the picture) so no picture
  // is ever on screen unlabelled; the opaque recap/credits cards cover both.
  drawCutProvenance(ctx, picRect, s, cut, drawn, split.strip.y)

  // ── Captions strip (from the first word, including under the intro) ──
  if (!inTail) drawCaptions(ctx, split.strip, s)

  // ── Progress + chapter ticks along the bottom edge ──
  if (s.total > 0 && !inTail) {
    const y = H - 2.5
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(0, y, W, 2.5)
    ctx.fillStyle = C.accent; ctx.fillRect(0, y, W * clamp01(s.t / s.total), 2.5)
    ctx.fillStyle = C.strip
    s.slides.forEach((sl, i) => { if (i > 0 && sl.chapter) ctx.fillRect((s.tl.segStart[i] / s.total) * W - 1, y, 2, 2.5) })
  }

  if (s.tl.hasOutro) drawOutro(ctx, W, H, s)
  drawCredits(ctx, W, H, s)
  drawGrain(ctx, s.t)

  // Fade to black at the very end of the credits.
  if (s.t > s.total) {
    ctx.fillStyle = `rgba(0,0,0,${clamp01((s.t - s.total - (EXPORT_TAIL_SECONDS - 0.7)) / 0.7)})`
    ctx.fillRect(0, 0, W, H)
  }
}

// ── Offline helpers for the exporter ────────────────────────────────────────

/** RMS levels around `timeInSec` — the exporter's stand-in for the live AnalyserNode. */
export function computeBars(buffer: AudioBuffer, timeInSec: number, numBars: number): number[] {
  const data = buffer.getChannelData(0)
  const span = Math.floor(buffer.sampleRate * 0.16)
  const center = Math.floor(timeInSec * buffer.sampleRate)
  const win = Math.max(1, Math.floor(span / numBars))
  const bars: number[] = []
  for (let b = 0; b < numBars; b++) {
    const start = Math.max(0, center - span / 2 + b * win)
    const end = Math.min(data.length, start + win)
    if (end <= start) { bars.push(0); continue }
    let sum = 0
    for (let i = start; i < end; i++) sum += data[i] * data[i]
    bars.push(Math.min(1, Math.sqrt(sum / (end - start)) * 4))
  }
  return bars
}

export function lineText(lines: AudioLine[], i: number) { return i >= 0 ? lines[i]?.text ?? '' : '' }

export { EN_STRINGS }
