import { apiFetch } from '../../utils/apiFetch'
import { useState, useRef, useEffect, useCallback, useMemo, useReducer } from 'react'
import { Video, Download, Loader2, Sparkles, ChevronDown, ChevronUp, Pencil, Type } from 'lucide-react'
import type { NotebookSource, AudioLine, VideoSlide, VideoShot, VideoOverviewOutputData } from '../../types/notebook'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import { useSegmentPlayer } from './useSegmentPlayer'
import { PlayerControls } from './PlayerControls'
import { getMedia, putMedia, mediaSig, legacyMediaSig, encodeAudio, decodeAudio, type CachedAudio } from '../../utils/notebookMediaCache'
import { renderVideoFrame, buildTimeline, locate, computeBars, lineText, accentForDark, resetTextLayoutCache, tailSeconds, type Timeline, type Visual, type VideoLayout } from './videoRender'
import { alignWords, segmentCues, type SegmentCues } from './videoSync'
import { stringsFor, fontsFor, ensureFonts, fmt } from './videoStrings'
import { useOrg } from '../../context/OrgContext'
import { getMusicLoop, mixNarration, musicGain, type MusicKind } from './musicBed'
import { mapPool } from '../../utils/mapPool'
import { ScriptEditor } from './ScriptEditor'
import { unchangedLine, remapSlidesAfterEdit, type EditableLine } from './scriptEdits'
import { numberedScript, planShots, flatShots, shotNarration, sentenceStarts, parseShotAt, type FlatShot } from './videoShots'
import { VideoCardEditor } from './VideoCardEditor'
import { VOICES, FEMALE_VOICES, validVoice, validNarratorVoice, voiceGender, synthesizeLine, speechStyle, hostNames as getHostNames, VIDEO_TONES, validVideoTone, type Voice } from './voices'

/** Voice requests in flight at once — enough to be quick, few enough not to trip quotas. */
const TTS_CONCURRENCY = 4
/** Picture requests in flight at once (after the first, which sets the style)
 *  — ~20/min, under the server's 60/min image bucket. */
const IMAGE_CONCURRENCY = 3
/** Generated picture shape per frame: 4:3 sits in the 16:9 split-screen slot
 *  with almost no crop; 9:16 fills a Reel. */
const IMAGE_RATIO: Record<'landscape' | 'portrait', string> = { landscape: '4:3', portrait: '9:16' }

// SlideDeck.tsx's ink/accent pair, lightened for contrast on a dark video canvas.
const C = { dark: '#0E3A46', lime: '#A78BFA', white: '#FFFFFF' }

/** Number of bars in the mini "someone is talking" waveform badge (see videoRender.ts). */
const WAVEFORM_BARS = 6
/** Canvas pixels per logical layout unit in the live preview (crisp on HiDPI). */
const PREVIEW_SCALE = 2
/** MP4 export presets — logical 640×360 layout scaled up, bitrate to match. */
const EXPORT_QUALITY = {
  '720p':  { scale: 2, bitrate: 5_000_000 },
  '1080p': { scale: 3, bitrate: 9_000_000 },
} as const
type ExportQuality = keyof typeof EXPORT_QUALITY

type Aspect = 'landscape' | 'portrait'
const ASPECT_DIMS: Record<Aspect, { W: number; H: number }> = {
  landscape: { W: 640, H: 360 }, // 16:9 — default, matches a normal video player
  portrait:  { W: 360, H: 640 }, // 9:16 — Instagram Reels (Reels-safe layout in videoRender.ts; also fine for WhatsApp Status)
}

/** Visual treatment for the per-shot generated pictures. Names match NotebookLM's
 *  own Video Overview styles so they mean the same thing there and here. */
const DESIGN_STYLES: Record<string, { label: string; prompt: string }> = {
  // Default. Real field photos lead; AI fills only the gaps, in a style that can't
  // pass for a photograph (org rule), and is labelled on screen (drawProvenance).
  documentary:    { label: 'Documentary (real photos + reportage sketches)', prompt: 'Reportage sketch illustration: loose charcoal and ink-wash drawing with a muted, earthy palette, visibly hand-drawn and non-photographic, like a field artist\'s sketchbook. Show the setting, landscape, water, tools and the activity itself; any people are small, faceless figures seen from a distance.' },
  // The image model often refuses photorealistic identifiable people, so the prompt
  // steers toward settings, hands and wide/back-turned framing instead of faces.
  photorealistic: { label: 'Photorealistic', prompt: 'Photorealistic documentary photograph, natural light, candid photojournalism style, high detail. Focus on the setting, landscape, activity, tools, hands and wide environmental context rather than close-up identifiable faces; people, if any, are seen from a distance, from behind, or partially out of frame.' },
  classic:        { label: 'Classic',        prompt: 'Clean flat editorial illustration: simple bold shapes, a restrained professional color palette, minimalist informational-graphic style.' },
  whiteboard:     { label: 'Whiteboard',     prompt: 'Whiteboard-sketch illustration: simple hand-drawn marker linework on a plain white background, informal dry-erase-doodle style, a few bold marker colors.' },
  watercolor:     { label: 'Watercolor',     prompt: 'Watercolor-painting illustration: soft blended paint washes, translucent overlapping colors, gentle organic edges, a light paper-texture background.' },
  retroPrint:     { label: 'Retro Print',    prompt: 'Retro screen-print poster illustration: a limited vintage color palette, visible halftone or risograph grain texture, a mid-century print-poster look.' },
  heritage:       { label: 'Heritage',       prompt: 'Heritage folk-art illustration: warm earthy tones, traditional decorative motifs and patterning, a handcrafted cultural-textile feel.' },
  paperCraft:     { label: 'Paper-craft',    prompt: 'Paper-craft collage illustration: layered cut-paper shapes with soft drop shadows, a tactile handmade paper-diorama look, warm muted tones.' },
  kawaii:         { label: 'Kawaii',         prompt: 'Kawaii-style illustration: cute rounded characters and objects, a soft pastel palette, big friendly simplified shapes, an adorable Japanese-pop aesthetic.' },
  anime:          { label: 'Anime',          prompt: 'Anime-style illustration: clean cel-shaded linework, expressive characters, a vibrant Japanese-animation color palette.' },
}
const DESIGN_STYLE_KEYS = Object.keys(DESIGN_STYLES)
/** Styles that put the REAL field photos on screen (all others are pure illustration). */
const REAL_PHOTO_STYLES = new Set(['documentary', 'photorealistic'])

/** One real field photo from a report source. `id` = its index in the photo
 *  catalogue sent to /video-slides, so the model can pick it per segment. */
interface FieldPhoto { id: number; url: string; img: HTMLImageElement; caption: string; place?: string; date?: string }
interface PhotoCatalogEntry { id: number; url: string; caption: string; place?: string; date?: string }
const MAX_FIELD_PHOTOS = 16
/** Matches the server's capSources limit, so the credits list only the sources the script used. */
const SCRIPT_MAX_SOURCES = 3

/** Report date in the narration language's own format (e.g. "14 जुल॰ 2026"). */
function formatShortDate(d: string | undefined, locale: string) {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return d
  try { return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) }
  catch { return d }
}
/** Provenance label for a real field photo: where + when it was taken. */
const photoLabel = (p: FieldPhoto, locale: string) => [p.place?.split(',')[0], formatShortDate(p.date, locale)].filter(Boolean).join(' · ')

const INDIAN_LANGUAGES = [
  { code: 'en-IN', label: 'English (India)', native: 'Indian English' },
  { code: 'hi-IN', label: 'Hindi',           native: 'हिन्दी'         },
  { code: 'bn-IN', label: 'Bengali',         native: 'বাংলা'          },
  { code: 'gu-IN', label: 'Gujarati',        native: 'ગુજરાતી'        },
  { code: 'kn-IN', label: 'Kannada',         native: 'ಕನ್ನಡ'          },
  { code: 'ml-IN', label: 'Malayalam',       native: 'മലയാളം'         },
  { code: 'mr-IN', label: 'Marathi',         native: 'मराठी'          },
  { code: 'ta-IN', label: 'Tamil',           native: 'தமிழ்'          },
  { code: 'te-IN', label: 'Telugu',          native: 'తెలుగు'         },
]

// Repair common AI JSON mistakes: strip code fences, escape bare newlines inside strings
// (same as the unexported helper in SlideDeck.tsx).
function cleanSlidesJSON(raw: string): string {
  const s = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim()
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

/** A truncated response has no closing "]", so recover every complete {...}
 *  object before the cutoff; normalizeSlideRanges stretches the last one to the end. */
function salvagePartialSlides(raw: string): VideoSlide[] {
  const start = raw.indexOf('[')
  if (start < 0) return []
  let depth = 0, inStr = false, escaped = false, objStart = -1
  const objs: string[] = []
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') { if (depth === 0) objStart = i; depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) { objs.push(raw.slice(objStart, i + 1)); objStart = -1 }
    }
  }
  const out: VideoSlide[] = []
  for (const o of objs) {
    try { out.push(JSON.parse(cleanSlidesJSON(o)) as VideoSlide) } catch { /* last object cut off mid-field — skip it */ }
  }
  return out
}

// The prompts already forbid emoji; this catches any that slip through.
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu

function stripEmoji(s: string): string {
  return s.replace(EMOJI_RE, '').replace(/ {2,}/g, ' ').trim()
}

// Photos are matched to segments by shared substantive words with the report
// caption; generic words are ignored so an overlap means something.
const PHOTO_STOPWORDS = new Set([
  'that', 'this', 'from', 'have', 'with', 'were', 'been', 'they', 'their', 'which',
  'about', 'more', 'than', 'also', 'will', 'over', 'under', 'among', 'project',
  'training', 'programme', 'program', 'report', 'members', 'held', 'village',
])
function photoTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(w => !PHOTO_STOPWORDS.has(w)))
}
/** Best-matching unused field photo for a segment's text, or -1 if none share a
 *  substantive word. `used` prevents the same photo repeating across segments. */
function pickRelevantFieldPhoto(segmentText: string, photos: FieldPhoto[], used: Set<number>): number {
  const segTokens = photoTokens(segmentText)
  let bestIdx = -1, bestScore = 0
  photos.forEach((p, idx) => {
    if (used.has(idx) || !p.caption) return
    let score = 0
    for (const w of photoTokens(p.caption)) if (segTokens.has(w)) score++
    if (score > bestScore) { bestScore = score; bestIdx = idx }
  })
  // One shared word ("farmers", "pond") isn't evidence the photo shows THIS
  // segment — require two, otherwise the segment gets a labelled illustration.
  return bestScore >= 2 ? bestIdx : -1
}

/** Shots whose model-picked real photo is accepted (each photo at most twice, never
 *  in consecutive shots). Shared with generateShotImages' skip so they can't disagree. */
function acceptedPhotoPicks(shots: FlatShot[], loadedUrls: Set<string>): Map<number, string> {
  const picks = new Map<number, string>()
  const uses = new Map<string, number>()
  shots.forEach((sh, k) => {
    const u = sh.photoUrl
    if (u && loadedUrls.has(u) && (uses.get(u) ?? 0) < 2 && picks.get(k - 1) !== u) { picks.set(k, u); uses.set(u, (uses.get(u) ?? 0) + 1) }
  })
  return picks
}

/** Each shot gets the model's photo pick, else a keyword match, else null (an
 *  unrelated real photo would misrepresent it, so it gets a labelled illustration). */
function buildFieldPhotoAssignment(
  shots: FlatShot[], slides: VideoSlide[], lines: AudioLine[], photos: FieldPhoto[],
): Map<number, FieldPhoto | null> {
  const map = new Map<number, FieldPhoto | null>()
  const byUrl = new Map(photos.map((p, i) => [p.url, i]))
  const used = new Set<number>()
  for (const [k, url] of acceptedPhotoPicks(shots, new Set(byUrl.keys()))) {
    const i = byUrl.get(url)!
    map.set(k, photos[i]); used.add(i)
  }
  shots.forEach((sh, k) => {
    if (map.has(k)) return
    const s = slides[sh.seg]
    // A shot matches on its own moment (scene + the sentences it covers). A
    // card saved before shots existed is one shot, so its card text counts too.
    const cardText = s && !s.shots?.length ? `${s.title} ${(s.bullets || []).join(' ')} ${s.stat?.label || ''} ${s.quote || ''}` : ''
    const text = `${sh.scene ?? ''} ${cardText} ${s?.location ?? ''} ${shotNarration(shots, k, slides, lines)}`
    const pIdx = pickRelevantFieldPhoto(text, photos, used)
    if (pIdx >= 0) { used.add(pIdx); map.set(k, photos[pIdx]) }
    else map.set(k, null)
  })
  return map
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Period covered by the cards' dates, earliest to latest (never a range of ranges).
 *  Non-English month names fall back to the first date's start and the last's end. */
function periodOf(dates: string[]): string {
  const uniq = [...new Set(dates.map(d => d.trim()).filter(Boolean))]
  if (uniq.length <= 1) return uniq[0] ?? ''
  const points: { y: number; m: number }[] = []
  const readable = uniq.every(d => {
    const years = [...d.matchAll(/(?:19|20)\d{2}/g)].map(m => ({ y: Number(m[0]), at: m.index ?? 0 }))
    const months = [...d.toLowerCase().matchAll(/(?:^|[^a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/g)].map(m => ({ m: MONTHS.indexOf(m[1]), at: m.index ?? 0 }))
    if (!years.length || !months.length) return false
    // Each month belongs to the first year written after it ("Jul 2025 – Mar 2026").
    for (const mo of months) points.push({ y: (years.find(y => y.at > mo.at) ?? years[years.length - 1]).y, m: mo.m })
    return true
  })
  if (readable && points.length) {
    const key = (p: { y: number; m: number }) => p.y * 12 + p.m
    const a = points.reduce((x, p) => (key(p) < key(x) ? p : x)), b = points.reduce((x, p) => (key(p) > key(x) ? p : x))
    if (key(a) === key(b)) return `${MONTH_LABEL[a.m]} ${a.y}`
    return a.y === b.y ? `${MONTH_LABEL[a.m]} – ${MONTH_LABEL[b.m]} ${b.y}` : `${MONTH_LABEL[a.m]} ${a.y} – ${MONTH_LABEL[b.m]} ${b.y}`
  }
  const RANGE = /\s*[–—]\s*|\s+-\s+/
  return `${uniq[0].split(RANGE)[0]} – ${uniq[uniq.length - 1].split(RANGE).pop()}`
}

/** Beneficiary-profile sources are named after the person — never put that on screen. */
function creditName(name: string, beneficiaryLabel = 'Beneficiary profile'): string {
  return /^\s*beneficiary\s*:/i.test(name) ? beneficiaryLabel : name
}

/** One planned picture: {at: "5.1", scene, photo} from the model, or a saved {line, sentence, …}. */
function sanitizeShot(raw: unknown): VideoShot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const at = parseShotAt(o.at ?? o)
  if (!at) return null
  const scene = typeof o.scene === 'string' ? stripEmoji(o.scene).slice(0, 300) || undefined : undefined
  return {
    ...at, scene,
    photo: Number.isInteger(o.photo) && (o.photo as number) >= 0 ? (o.photo as number) : undefined,
    photoUrl: typeof o.photoUrl === 'string' && o.photoUrl ? o.photoUrl : undefined,
  }
}

/** Coerce one model-produced segment into a safe VideoSlide, or null if it's
 *  unusable. Never throws — one bad field must not drop the whole video. */
function sanitizeVideoSlide(raw: unknown): VideoSlide | null {
  try {
    const s = (raw ?? {}) as Record<string, unknown>
    // The script reached the model with "[n]"/"[n.s]" markers — never let one onto the screen.
    const str = (x: unknown) => stripEmoji(String(x ?? '').replace(/\[\d+(?:\.\d+)?\]\s*/g, ''))
    const opt = (x: unknown) => (x == null || x === '' ? undefined : str(x) || undefined)
    const fromLine = Math.trunc(Number(s.fromLine))
    if (!Number.isFinite(fromLine) || fromLine < 0) return null
    const toRaw = Math.trunc(Number(s.toLine ?? s.fromLine))
    const toLine = Number.isFinite(toRaw) ? Math.max(fromLine, toRaw) : fromLine
    const st = s.stat as Record<string, unknown> | undefined
    const stat = st && typeof st === 'object' && str(st.value) ? { value: str(st.value), label: str(st.label) } : undefined
    const quote = opt(s.quote)
    let visual: VideoSlide['visual'] = s.visual === 'stat' || s.visual === 'quote' ? s.visual : 'list'
    if (visual === 'stat' && !stat) visual = 'list'
    if (visual === 'quote' && !quote) visual = 'list'
    const source = opt(s.source)
    return {
      fromLine, toLine, visual,
      title: str(s.title),
      bullets: Array.isArray(s.bullets) ? s.bullets.filter(b => b != null).map(str).filter(Boolean) : undefined,
      stat, quote,
      quoteAttribution: opt(s.quoteAttribution),
      chapter: opt(s.chapter),
      location: opt(s.location),
      date: opt(s.date),
      source: source ? creditName(source) : undefined,
      photo: Number.isInteger(s.photo) && (s.photo as number) >= 0 ? (s.photo as number) : undefined,
      photoUrl: typeof s.photoUrl === 'string' && s.photoUrl ? s.photoUrl : undefined,
      scene: opt(s.scene)?.slice(0, 300),
      headline: opt(s.headline),
      shots: Array.isArray(s.shots) ? s.shots.map(sanitizeShot).filter((x): x is VideoShot => !!x) : undefined,
    }
  } catch {
    return null
  }
}
const sanitizeSlides = (arr: unknown[]): VideoSlide[] => arr.map(sanitizeVideoSlide).filter((x): x is VideoSlide => !!x)

/** LLMs get line ranges slightly wrong (gaps, overlaps), which puts the wrong
 *  picture under the narration; force-tile so each line maps to exactly one segment. */
function normalizeSlideRanges(slides: VideoSlide[], lineCount: number): VideoSlide[] {
  if (slides.length === 0 || lineCount <= 0) return slides
  const sorted = [...slides].sort((a, b) => a.fromLine - b.fromLine)
  const out: VideoSlide[] = []
  let next = 0
  for (const s of sorted) {
    const toLine = Math.min(s.toLine, lineCount - 1)
    if (toLine < next) continue // fully swallowed by the previous segment — drop it
    out.push({ ...s, fromLine: next, toLine })
    next = toLine + 1
    if (next > lineCount - 1) break
  }
  if (out.length === 0) return slides
  if (next <= lineCount - 1) out[out.length - 1] = { ...out[out.length - 1], toLine: lineCount - 1 }
  return out
}

// Optional "[tone]" cue after the speaker ("ALEX: [warmly] ..."): kept out of the
// subtitles and passed to TTS as a style instruction instead of being read aloud.
const TONE_TAG_RE = /^\[([^\]\n]{1,30})\]\s*/u
function splitTone(text: string): { text: string; tone?: string } {
  const m = text.match(TONE_TAG_RE)
  if (!m) return { text }
  return { text: text.slice(m[0].length).trim(), tone: m[1].trim().toLowerCase() }
}

/** A new video script has ONE narrator: every line is voiced as ALEX, even if the
 *  model slips in another speaker. (Saved two-voice scripts restore as saved.) */
function parseScript(raw: string): AudioLine[] {
  const lines: AudioLine[] = []
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(?:ALEX|JORDAN|NARRATOR)\s*:\s*(.*)$/i)
    if (m && m[1].trim()) lines.push({ host: 'ALEX', ...splitTone(m[1].trim()) })
  }
  return lines
}

/** "Female · Warm" — the narrator has no on-screen or spoken name, so the voice is chosen by sound. */
const voiceLabel = (v: Voice) => `${v.gender === 'F' ? 'Female' : 'Male'} · ${v.style}`

function VoiceSelect({ label, value, options, disabled, onChange, format = v => `${v.host} · ${v.style}` }: {
  label: string; value: string; options: Voice[]
  disabled: boolean; onChange: (v: string) => void
  format?: (v: Voice) => string
}) {
  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
      <span className="text-[9px] font-semibold uppercase tracking-wide truncate" style={{ color: '#9CA3AF' }}>
        {label}
      </span>
      <select
        value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        className="w-full rounded-lg px-2 py-1.5 text-[11px] font-medium border outline-none appearance-none cursor-pointer"
        style={{ background: C.white, color: C.dark, borderColor: '#E5E7EB' }}
      >
        {options.map(v => <option key={v.name} value={v.name}>{format(v)}</option>)}
      </select>
    </div>
  )
}

interface Props {
  sources: NotebookSource[]
  /** Saved script/slides restored on load; audio isn't persisted, so it's re-voiced from the script. */
  initial?: VideoOverviewOutputData
  onChange?: (data: VideoOverviewOutputData) => void
  /** IndexedDB key prefix (the notebook id) for this device's cached narration
   *  audio + segment images. Omitted for the ephemeral document Ask AI panel. */
  cacheKey?: string
  onBusyChange?: (busy: boolean) => void
  /** Notebook name — used for the opening title card and the MP4 filename. */
  title?: string
}

type StoredImage = { data: string; mimeType: string }
/** Pictures cache. v1 keeps every image in this record; v2 keeps only the count
 *  and each image under `${key}:${i}`, so saving one doesn't rewrite the rest. */
interface CachedImages { sig: string; style?: string; images?: (StoredImage | null)[]; v?: 2; count?: number }
interface CachedShotImage { sig: string; image: StoredImage | null }
const videoAudioSig  = (lines: AudioLine[], languageCode: string, alexVoice: string, jordanVoice: string) =>
  mediaSig({ lines, languageCode, alexVoice, jordanVoice })
const videoImagesSig = (slides: VideoSlide[], designStyle: string) => mediaSig({
  designStyle,
  // Cards without shots hash the same as before shots existed, so their cached pictures still restore.
  slides: slides.map(x => {
    const card = [x.fromLine, x.toLine, x.title ?? '', x.visual ?? '', x.scene ?? '', x.location ?? '', x.photoUrl ?? '', x.stat?.label ?? '', x.quote ?? '', (x.bullets || []).join('|')]
    return x.shots?.length ? [...card, x.shots.map(sh => [sh.line, sh.sentence, sh.scene ?? '', sh.photoUrl ?? ''])] : card
  }),
})
const asStored = (img: HTMLImageElement | null | undefined): StoredImage | null => {
  const m = img?.src.match(/^data:([^;]+);base64,(.+)$/)
  return m ? { mimeType: m[1], data: m[2] } : null
}

export function VideoOverview({ sources, initial, onChange, cacheKey, onBusyChange, title }: Props) {
  const [language,      setLanguage]      = useState(() => INDIAN_LANGUAGES.find(l => l.code === initial?.languageCode) ?? INDIAN_LANGUAGES[0])
  // Load the language's script fonts so the canvas can draw it (Noto for Indic).
  useEffect(() => { ensureFonts(language.code).then(resetTextLayoutCache) }, [language.code])
  const languageRef = useRef(language.code)
  languageRef.current = language.code
  // ONE narrator voice (any voice, male or female). jordanVoice only voices the
  // second-host lines of videos scripted before the single-narrator format.
  const [alexVoice,     setAlexVoice]     = useState(() => validNarratorVoice(initial?.alexVoice))
  const [jordanVoice,   setJordanVoice]   = useState(() => validVoice(initial?.jordanVoice, 'F'))
  const [lines,         setLines]         = useState<AudioLine[]>(initial?.lines ?? [])
  const [audioBuffers,  setAudioBuffers]  = useState<(AudioBuffer | null)[]>([])
  const [showPrompt,    setShowPrompt]    = useState(false)
  const [customPrompt,  setCustomPrompt]  = useState('')
  const [generating,    setGenerating]    = useState(false)
  const [synthesizing,  setSynthesizing]  = useState(false)
  const [synthProgress, setSynthProgress] = useState({ done: 0, total: 0 })
  const [error,         setError]         = useState<string | null>(null)
  const [exporting,     setExporting]     = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  // Shown on screen so image failures (key, quota, safety refusal…) are diagnosable without DevTools.
  const [imgStatus, setImgStatus] = useState<{ done: number; failed: number; total: number; lastError: string }>({ done: 0, failed: 0, total: 0, lastError: '' })
  // Veo animation (image-to-video on a few key segments). Off by default — only
  // runs on an explicit click because each 8s clip costs real money.
  const [veoCount,   setVeoCount]   = useState(3)
  const [veoBusy,    setVeoBusy]    = useState(false)
  const [veoStatus,  setVeoStatus]  = useState<{ done: number; failed: number; total: number; lastError: string }>({ done: 0, failed: 0, total: 0, lastError: '' })
  // A reopened Reel comes back as a Reel — its script length and pictures were made for 9:16.
  const [aspect,        setAspect]        = useState<Aspect>(() => (initial?.aspect === 'portrait' ? 'portrait' : 'landscape'))
  /** The on-screen cards + picture plan didn't come back — offered as a retry. */
  const [slidesFailed,  setSlidesFailed]  = useState(false)
  const [videoTone,     setVideoTone]     = useState(() => validVideoTone(initial?.videoTone))
  /** Post-generation editing: the narration script, or the on-screen card text. */
  const [editMode,      setEditMode]      = useState<null | 'script' | 'cards'>(null)
  /** Language|voices|tone the current line audio was made with — reused audio
   *  after a narration edit is only valid while these are unchanged. */
  const voicedWithRef = useRef('')
  // A documentary has a score — on by default, sits ~24 dB under the voices.
  const [music,         setMusic]         = useState<MusicKind | 'off'>('story')
  /** Story (full-screen, The Better India style) or Briefing (key points beside the picture). */
  const [layout,        setLayout]        = useState<VideoLayout>(() => (initial?.layout === 'briefing' ? 'briefing' : 'story'))
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [quality,       setQuality]       = useState<ExportQuality>('720p')
  const [designStyle,   setDesignStyle]   = useState(() =>
    (initial?.designStyle && DESIGN_STYLES[initial.designStyle]) ? initial.designStyle : 'documentary'
  )
  const { W, H } = ASPECT_DIMS[aspect]

  // Brand + language for the frame: the org's own name/colour/logo, and the
  // narration language's labels and fonts.
  const { org } = useOrg()
  const brandRef = useRef<{ org: string; accent: string; logo: HTMLImageElement | null }>({ org: '', accent: '#A78BFA', logo: null })
  brandRef.current.org = org?.branding?.org_name || ''
  brandRef.current.accent = accentForDark(org?.branding?.theme?.accent || org?.branding?.theme?.primary)
  const logoUrl = org?.branding?.logo_url || ''
  useEffect(() => {
    brandRef.current.logo = null
    if (!logoUrl) return
    let cancelled = false, objectUrl = ''
    const use = (src: string, cors: boolean) => {
      const img = new Image()
      if (cors) img.crossOrigin = 'anonymous' // never draw a CORS-tainted logo — it would break the MP4 export
      img.onload = () => { if (!cancelled) brandRef.current.logo = img }
      img.src = src
    }
    apiFetch(`/api/proxy-image?url=${encodeURIComponent(logoUrl)}`)
      .then(r => (r.ok ? r.blob() : null))
      .then(b => { if (cancelled) return; if (b) { objectUrl = URL.createObjectURL(b); use(objectUrl, false) } else use(logoUrl, true) })
      .catch(() => { if (!cancelled) use(logoUrl, true) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [logoUrl])

  const canvasRef        = useRef<HTMLCanvasElement>(null)
  const audioCtxRef      = useRef<AudioContext | null>(null)
  const analyserRef      = useRef<AnalyserNode | null>(null)
  const animFrameRef     = useRef<number | null>(null)
  const linesRef         = useRef<AudioLine[]>([])
  const audioBuffersRef  = useRef<(AudioBuffer | null)[]>([])
  const isPlayingRef     = useRef(false)
  const isMountedRef     = useRef(true)
  /** Bumped on every generateScript(); async work checks its captured epoch before
   *  writing so a stale run's late images can't land in the new run's arrays. */
  const generationRef    = useRef(0)
  /** Visual segments synced to dialogue line ranges. */
  const slidesRef        = useRef<VideoSlide[]>([])
  /** Generated picture per shot, in flatShots order (several per card). */
  const shotImagesRef    = useRef<(HTMLImageElement | null)[]>([])
  /** Real field photos; the report caption is kept for matching photos to segments. */
  const fieldPhotosRef   = useRef<FieldPhoto[]>([])
  /** Style the current AI images were made in; their provenance label follows this, not the dropdown. */
  const slideImageStyleRef = useRef('documentary')
  /** Shots whose AI image was skipped because a real photo covered them. */
  const skippedForPhotoRef = useRef<Set<number>>(new Set())
  /** Memoized shot→field-photo assignment, rebuilt when slides or photos change identity. */
  const fieldPhotoByShotRef = useRef<Map<number, FieldPhoto | null>>(new Map())
  const photoAssignKeyRef   = useRef<{ slides: unknown; photos: unknown } | null>(null)
  /** Veo clips per shot index; override the still in the render loop. Not persisted
   *  (large, and Veo source URIs expire after 2 days). */
  const veoClipsRef        = useRef<Map<number, HTMLVideoElement>>(new Map())
  /** Read by the animation loop's closure to decide whether real photos may appear. */
  const designStyleRef   = useRef(designStyle)
  const exportingRef     = useRef(false)

  /** Stop and detach every Veo <video> so the (multi-MB, looping) decoded clips
   *  don't keep running/holding memory after a Regenerate or unmount. */
  function releaseVeoClips() {
    veoClipsRef.current.forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load() } catch { /* noop */ } })
    veoClipsRef.current = new Map()
  }

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      releaseVeoClips()
      audioCtxRef.current?.close()
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [])
  useEffect(() => { linesRef.current = lines }, [lines])
  useEffect(() => { designStyleRef.current = designStyle }, [designStyle])
  useEffect(() => { audioBuffersRef.current = audioBuffers }, [audioBuffers])
  // `initial` is stable for this instance, so hydrate once on mount.
  useEffect(() => {
    if (initial?.videoSlides?.length) {
      // Older saves stored the photo as a catalogue position; map it to the
      // photo's URL now so later source-list changes can't point it elsewhere.
      const restored = sanitizeSlides(initial.videoSlides).map(x =>
        x.photoUrl || x.photo == null ? x : { ...x, photoUrl: photoCatalog[x.photo]?.url, photo: undefined })
      slidesRef.current = normalizeSlideRanges(restored, initial?.lines?.length ?? 0)
      slideImageStyleRef.current = initial.designStyle ?? 'documentary'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore this device's cached narration + segment images for the saved
  // script, so reopening a notebook doesn't re-pay for TTS / image generation.
  const audioCacheKey = cacheKey ? `${cacheKey}:video_overview:audio`  : null
  const imageCacheKey = cacheKey ? `${cacheKey}:video_overview:images` : null
  const [restoring, setRestoring] = useState(() => !!cacheKey && !!initial?.lines?.length)
  // Pictures live in refs (the render loop reads them every frame); bump this
  // when one arrives so UI that depends on them re-evaluates.
  const [, bumpVisuals] = useReducer((n: number) => n + 1, 0)
  const [photosLoading, setPhotosLoading] = useState(false)
  useEffect(() => {
    if (!audioCacheKey || !imageCacheKey || !initial?.lines?.length) return
    const epoch = generationRef.current
    const live  = () => isMountedRef.current && generationRef.current === epoch
    const restoredSlides = slidesRef.current
    Promise.all([
      getMedia<CachedAudio>(audioCacheKey).then(cached => {
        if (!live()) return
        const legacy = legacyMediaSig({ lines: initial.lines, languageCode: initial.languageCode, alexVoice: initial.alexVoice, jordanVoice: initial.jordanVoice })
        if (cached && (cached.sig === videoAudioSig(initial.lines, initial.languageCode, initial.alexVoice, initial.jordanVoice) || cached.sig === legacy)) {
          const bufs = decodeAudio(cached, getAudioCtx())
          setAudioBuffers(bufs); audioBuffersRef.current = bufs
          voicedWithRef.current = `${initial.languageCode}|${initial.alexVoice}|${initial.jordanVoice}|${validVideoTone(initial.videoTone)}`
        }
      }),
      getMedia<CachedImages>(imageCacheKey).then(async cached => {
        if (!live() || !restoredSlides.length || !cached) return
        const style = cached.style ?? initial.designStyle ?? 'documentary'
        if (cached.sig !== videoImagesSig(restoredSlides, style)) return
        const count = flatShots(restoredSlides).length
        const stored: (StoredImage | null)[] = cached.v === 2
          ? await Promise.all(Array.from({ length: Math.min(count, cached.count ?? 0) }, (_, i) =>
              getMedia<CachedShotImage>(`${imageCacheKey}:${i}`).then(e => (e && e.sig === cached.sig ? e.image : null))))
          : (cached.images ?? []) // v1: one picture per card = one shot per card
        if (!live()) return
        shotImagesRef.current = new Array(count).fill(null)
        slideImageStyleRef.current = style // provenance follows the style they were made in
        return Promise.all(stored.slice(0, count).map((im, i) => !im ? null : new Promise<void>(resolve => {
          const img = new Image()
          img.onload = () => { if (live()) { shotImagesRef.current[i] = img; bumpVisuals() } resolve() }
          img.onerror = () => resolve()
          img.src = `data:${im.mimeType};base64,${im.data}`
        })))
      }),
    ]).finally(() => { if (isMountedRef.current) setRestoring(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Real field photos from report sources ────────────────────────────────
  // Catalogue order defines each photo's id, which /video-slides uses to pick photos.
  const photoCatalog = useMemo<PhotoCatalogEntry[]>(() => sources.slice(0, SCRIPT_MAX_SOURCES).flatMap(s =>
    (s.imageUrls ?? []).map(url => ({ url, caption: s.imageCaptions?.[url] || '', place: s.imageMeta?.[url]?.place, date: s.imageMeta?.[url]?.date }))
  ).slice(0, MAX_FIELD_PHOTOS).map((p, id) => ({ id, ...p })), [sources])

  // Drive thumbnails send no CORS headers, so load them via our proxy as same-origin
  // blob: URLs; otherwise the canvas is tainted and MP4 export fails.
  useEffect(() => {
    fieldPhotosRef.current = []
    fieldPhotoByShotRef.current = new Map(); photoAssignKeyRef.current = null
    let cancelled = false
    const objectUrls: string[] = []
    function toDriveThumbnail(url: string): string {
      const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
      if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w640-h360`
      return url
    }
    const rawPairs = photoCatalog
    if (rawPairs.length === 0) { setPhotosLoading(false); return }
    setPhotosLoading(true)
    // Fixed-length slots keep id↔photo alignment regardless of load order.
    const slots: (FieldPhoto | null)[] = new Array(rawPairs.length).fill(null)
    let loaded = 0
    const commit = () => { fieldPhotosRef.current = slots.filter((p): p is FieldPhoto => !!p); bumpVisuals() }
    rawPairs.forEach((pair, idx) => {
      apiFetch(`/api/proxy-image?url=${encodeURIComponent(toDriveThumbnail(pair.url))}`)
        .then(res => res.ok ? res.blob() : null)
        .then(blob => {
          if (blob && !cancelled) {
            const objectUrl = URL.createObjectURL(blob)
            objectUrls.push(objectUrl)
            const img = new Image()
            img.onload = () => { if (!cancelled) { slots[idx] = { id: pair.id, url: pair.url, img, caption: pair.caption, place: pair.place, date: pair.date }; commit() } }
            img.src = objectUrl
          }
        })
        .catch(() => { /* one bad photo just isn't included */ })
        .finally(() => { loaded++; if (loaded === rawPairs.length) { commit(); if (!cancelled) setPhotosLoading(false) } })
    })
    return () => { cancelled = true; objectUrls.forEach(u => URL.revokeObjectURL(u)) }
  }, [photoCatalog])

  // ── Timeline (shared by the live preview and the MP4 export) ─────────────
  // Recomputed only when the audio buffers or the segment list change.
  const timelineCacheRef = useRef<{ bufs: unknown; slides: unknown; lines: unknown; tl: Timeline } | null>(null)
  function getTimeline(): Timeline {
    const bufs = audioBuffersRef.current, slides = slidesRef.current, lines = linesRef.current
    const c = timelineCacheRef.current
    if (c && c.bufs === bufs && c.slides === slides && c.lines === lines) return c.tl
    const tl = buildTimeline(lines.map((_, i) => bufs[i]?.duration ?? 0), slides, sentenceAt)
    timelineCacheRef.current = { bufs, slides, lines, tl }
    return tl
  }
  /** Seconds into line `line` where its sentence `s` is spoken — a shot's cut
   *  point, a beat ahead of the first word the way an editor cuts. */
  function sentenceAt(line: number, s: number): number {
    const starts = sentenceStarts(linesRef.current[line]?.text ?? '')
    const word = starts[Math.min(s, starts.length - 1)] ?? 0
    if (word <= 0) return 0
    const times = wordTimesFor(line)
    return Math.max(0, (times[word] ?? 0) - 0.1)
  }

  /** Every shot (picture) in playback order — memoized on the slides array. */
  const shotsMemoRef = useRef<{ slides: unknown; shots: FlatShot[] }>({ slides: null, shots: [] })
  function shotList(): FlatShot[] {
    const slides = slidesRef.current, m = shotsMemoRef.current
    if (m.slides !== slides) { m.slides = slides; m.shots = flatShots(slides) }
    return m.shots
  }

  /** Current shot→real-photo assignment (rebuilt when slides/photos change). */
  function photoAssignment(): Map<number, FieldPhoto | null> {
    const slides = slidesRef.current, photos = fieldPhotosRef.current, key = photoAssignKeyRef.current
    if (!key || key.slides !== slides || key.photos !== photos) {
      fieldPhotoByShotRef.current = slides.length && photos.length ? buildFieldPhotoAssignment(shotList(), slides, linesRef.current, photos) : new Map()
      photoAssignKeyRef.current = { slides, photos }
    }
    return fieldPhotoByShotRef.current
  }

  /** A shot's own picture with provenance: a matching real photo (real-photo styles),
   *  else its AI image. Null while missing. */
  function ownVisual(k: number, style: string): Visual | null {
    const fp = photoAssignment().get(k) ?? null
    if (fp && REAL_PHOTO_STYLES.has(style)) return { el: fp.img, kind: 'field', label: photoLabel(fp, languageRef.current) }
    const ai = shotImagesRef.current[k]
    if (ai) return { el: ai, kind: slideImageStyleRef.current === 'photorealistic' ? 'ai-photo' : 'ai' }
    // An illustrated style picked after generation skipped this shot for a real photo:
    // show that photo. Other gaps stay empty so "Generate missing visuals" offers them.
    return fp && skippedForPhotoRef.current.has(k) ? { el: fp.img, kind: 'field', label: photoLabel(fp, languageRef.current) } : null
  }

  /** Shot k's own picture, or while it's missing, the nearest picture of the same card. */
  function visualFor(k: number, style: string, veo?: HTMLVideoElement | null): Visual | null {
    if (veo) return { el: veo, kind: 'ai-motion' }
    if (k < 0) {
      const p = REAL_PHOTO_STYLES.has(style) ? fieldPhotosRef.current[0] : undefined
      return p ? { el: p.img, kind: 'field', label: photoLabel(p, languageRef.current) } : null
    }
    const own = ownVisual(k, style)
    if (own) return own
    const shots = shotList(), seg = shots[k]?.seg
    for (let j = k - 1; j >= 0 && shots[j].seg === seg; j--) { const v = ownVisual(j, style); if (v) return v }
    for (let j = k + 1; j < shots.length && shots[j].seg === seg; j++) { const v = ownVisual(j, style); if (v) return v }
    return null
  }

  /** "Place · period" under the opening title, from the segments' own supers. */
  function dateline(): string {
    const slides = slidesRef.current
    const places = [...new Set(slides.map(x => x.location).filter(Boolean) as string[])]
    const place = places.length > 2 ? `${places[0]} ${fmt(stringsFor(language.code).morePlaces, { n: places.length - 1 })}` : places.join(' & ')
    return [place, periodOf(slides.map(x => x.date ?? ''))].filter(Boolean).join('  ·  ')
  }
  /** Measured word start times for line i (speech-clock alignment on its audio). */
  function wordTimesFor(i: number): number[] {
    const buf = audioBuffersRef.current[i] ?? null
    return alignWords(buf, linesRef.current[i]?.text ?? '', buf?.duration ?? 0)
  }
  /** When each on-screen item of segment i is spoken — cached per timeline. */
  const cuesCacheRef = useRef<{ tl: Timeline | null; slides: unknown; map: Map<number, SegmentCues> }>({ tl: null, slides: null, map: new Map() })
  function cuesFor(tl: Timeline, i: number): SegmentCues | null {
    const slides = slidesRef.current
    if (i < 0 || !slides[i]) return null
    const c = cuesCacheRef.current
    if (c.tl !== tl || c.slides !== slides) { c.tl = tl; c.slides = slides; c.map = new Map() }
    let cues = c.map.get(i)
    if (!cues) { cues = segmentCues(slides[i], linesRef.current, tl.lineStart, tl.segStart[i] ?? 0, wordTimesFor); c.map.set(i, cues) }
    return cues
  }
  const creditsRef = useRef<string[]>([])
  creditsRef.current = sources.slice(0, SCRIPT_MAX_SOURCES).map(x => creditName(x.name, stringsFor(language.code).beneficiaryProfile))

  const getTimeRef = useRef<() => number>(() => 0)
  const titleRef   = useRef('')

  // ── Live preview loop ─────────────────────────────────────────────────────
  // Draws the frame for the player's CURRENT timeline position, so pausing
  // freezes the picture and seeking jumps straight to the right frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    if (!ctx) return
    const hosts      = getHostNames(alexVoice, jordanVoice, language.code)
    const langNative = language.native

    function frame() {
      animFrameRef.current = requestAnimationFrame(frame)
      // Exporting (give the encoder the CPU) or panel hidden — nothing to paint.
      if (exportingRef.current || !canvas!.offsetParent) return

      const ls = linesRef.current, slides = slidesRef.current, tl = getTimeline()
      const playing = isPlayingRef.current
      const t = getTimeRef.current()
      const loc = locate(tl, t)
      const lineDur = loc.lineIdx >= 0 ? tl.lineDur[loc.lineIdx] : 0
      const speaking = loc.lineIdx >= 0 && loc.lineT < lineDur

      let bars: number[] = new Array(WAVEFORM_BARS).fill(0)
      const analyser = analyserRef.current
      if (analyser && playing && speaking) {
        const freq = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>
        analyser.getByteFrequencyData(freq)
        const chunk = Math.max(1, Math.floor(freq.length / WAVEFORM_BARS))
        bars = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
          let sum = 0
          for (let j = i * chunk; j < Math.min(freq.length, (i + 1) * chunk); j++) sum += freq[j]
          return sum / chunk / 255
        })
      }

      // Keep the active shot's Veo clip in step with the timeline (also
      // while paused, so a seek shows the right frame); others stay paused.
      veoClipsRef.current.forEach((v, k) => {
        if (k === loc.shotIdx) {
          if (v.duration > 0 && Math.abs(v.currentTime - (loc.shotT % v.duration)) > 0.4) {
            try { v.currentTime = loc.shotT % v.duration } catch { /* not seekable yet */ }
          }
          if (v.playbackRate !== rateRef.current) v.playbackRate = rateRef.current
          if (playing && v.paused) v.play().catch(() => {})
          else if (!playing && !v.paused) v.pause()
        } else if (!v.paused) v.pause()
      })

      renderVideoFrame(ctx, W, H, {
        t, total: tl.total, tl,
        lineIdx: loc.lineIdx, lineT: loc.lineT, lineDur,
        text: speaking ? lineText(ls, loc.lineIdx) : '',
        speakHost: speaking ? ls[loc.lineIdx]?.host ?? null : null,
        bars, noLines: ls.length === 0,
        slides, segIdx: loc.segIdx, segT: loc.segT, segDur: loc.segDur, shotIdx: loc.shotIdx,
        visualFor: i => visualFor(i, designStyleRef.current, i === loc.shotIdx ? veoClipsRef.current.get(i) : null),
        wordTimes: speaking ? wordTimesFor(loc.lineIdx) : null,
        cues: cuesFor(tl, loc.segIdx),
        hosts, langNative, title: titleRef.current, headline: slides[0]?.headline ?? '', dateline: dateline(), credits: creditsRef.current,
        str: stringsFor(language.code), fonts: fontsFor(language.code), ...brandRef.current,
        isPlaying: playing, scale: PREVIEW_SCALE, layout: layoutRef.current,
      })
    }

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = requestAnimationFrame(frame)
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, W, H, alexVoice, jordanVoice]) // voices → on-screen host names

  // ── Playback ──────────────────────────────────────────────────────────────
  // One segment per dialogue line, routed through the analyser for the waveform.
  const playerBuffers = useMemo(() => {
    if (!audioBuffers.some(Boolean)) return audioBuffers
    const rate = audioBuffers.find(Boolean)!.sampleRate
    return [...audioBuffers, new AudioBuffer({ numberOfChannels: 1, length: Math.ceil(tailSeconds(aspect === 'portrait', layout) * rate), sampleRate: rate })]
  }, [audioBuffers, aspect, layout]) // the silent tail holds the end card (length per format/layout)
  const player = useSegmentPlayer(playerBuffers, {
    connect: () => { const ctx = getAudioCtx(); return { ctx, destination: analyserRef.current! } },
  })
  const playing = player.playing
  isPlayingRef.current = playing
  getTimeRef.current = player.getTime
  const rateRef = useRef(1)
  rateRef.current = player.rate
  titleRef.current = (title && title !== 'Untitled notebook' ? title : slidesRef.current[0]?.title) || 'Video Overview'

  // Preview music is a loop, so it only follows play/pause, not the narration position.
  const musicNodeRef = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null)
  useEffect(() => {
    const stopMusic = () => {
      const m = musicNodeRef.current, ctx = audioCtxRef.current
      musicNodeRef.current = null
      if (!m || !ctx || ctx.state === 'closed') return
      try { m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); m.src.stop(ctx.currentTime + 0.6) } catch { /* already stopped */ }
    }
    if (!playing || music === 'off') { stopMusic(); return }
    let cancelled = false
    getMusicLoop(music).then(loop => {
      if (cancelled || musicNodeRef.current) return
      const ctx = getAudioCtx()
      const src = ctx.createBufferSource(); src.buffer = loop; src.loop = true
      const gain = ctx.createGain(); gain.gain.value = 0
      gain.gain.setTargetAtTime(musicGain(music), ctx.currentTime, 0.4)
      src.connect(gain); gain.connect(ctx.destination); src.start()
      musicNodeRef.current = { src, gain }
    }).catch(() => { /* no music is fine */ })
    // Switching kind (or pausing) fades the current loop out.
    return () => { cancelled = true; stopMusic() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, music])

  // ── Audio helpers ─────────────────────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx     = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512; analyser.connect(ctx.destination)
      audioCtxRef.current = ctx; analyserRef.current = analyser
    }
    return audioCtxRef.current
  }

  /** Store pictures under `sig`: one record per shot (cache v2) plus a small index. */
  async function storeShotImages(sig: string, style: string, images: (StoredImage | null)[], only?: number[]) {
    if (!imageCacheKey) return
    for (const i of only ?? images.map((_, j) => j)) {
      if (images[i]) await putMedia(`${imageCacheKey}:${i}`, { sig, image: images[i] } as CachedShotImage)
    }
    await putMedia(imageCacheKey, { sig, style, v: 2, count: images.length } as CachedImages)
  }

  /** Fire-and-forget: one picture per shot from its scene and narration; shotImagesRef
   *  fills in as they arrive. The first anchors the style, the rest follow in a pool. */
  async function generateShotImages(videoSlides: VideoSlide[], dialogueLines: AudioLine[], styleKey: string, epoch: number, onlyMissing = false) {
    const shots = flatShots(videoSlides)
    const live = () => isMountedRef.current && generationRef.current === epoch
    const ratio = IMAGE_RATIO[aspect]
    // onlyMissing: keep the pictures already made in this style; generate the rest.
    const keep = onlyMissing && slideImageStyleRef.current === styleKey ? shotImagesRef.current.slice(0, shots.length) : []
    shotImagesRef.current = shots.map((_, i) => keep[i] ?? null)
    slideImageStyleRef.current = styleKey
    const coveredByPhoto = REAL_PHOTO_STYLES.has(styleKey)
      ? acceptedPhotoPicks(shots, new Set(fieldPhotosRef.current.map(p => p.url)))
      : new Map<number, string>()
    if (!onlyMissing) skippedForPhotoRef.current = new Set(coveredByPhoto.keys())
    else coveredByPhoto.forEach((_, i) => skippedForPhotoRef.current.add(i))
    // Shots covered by an accepted real photo need no AI image.
    const todo = shots.map((_, i) => i).filter(i => !coveredByPhoto.has(i) && !keep[i])
    if (isMountedRef.current) setImgStatus({ done: 0, failed: 0, total: todo.length, lastError: '' })
    const style = DESIGN_STYLES[styleKey] ?? DESIGN_STYLES.documentary
    const sig = videoImagesSig(videoSlides, styleKey)
    const stored = shots.map((_, i) => asStored(keep[i]))
    // Kept pictures may only exist in an older single-record cache — store them per shot now.
    if (stored.some(Boolean) && live()) await storeShotImages(sig, styleKey, stored)
    let styleRef: StoredImage | null = stored.find(Boolean) ?? null

    const fail = (i: number, msg: string) => {
      console.warn(`[nanobanana] shot ${i} (${styleKey}) failed: ${msg}`)
      if (live()) setImgStatus(p => ({ ...p, failed: p.failed + 1, lastError: msg }))
    }
    const makeOne = async (i: number) => {
      if (!live()) return
      const sh = shots[i], s = videoSlides[sh.seg]
      const narration = shotNarration(shots, i, videoSlides, dialogueLines).slice(0, 300)
      const topic = s.visual === 'stat' ? s.stat?.label : s.visual === 'quote' ? s.quote : (s.bullets || []).join('; ')
      const prompt = [
        style.prompt,
        sh.scene ? `Show exactly this scene: ${sh.scene}` : `Show the real setting and activity the narration describes at this moment${topic || s.title ? ` (the point being made: ${topic || s.title})` : ''}.`,
        narration ? `It must match what the narration says at this moment: "${narration}"` : '',
        s.location ? `Place: ${s.location}.` : '',
        'Context: NGO field work on water, wetlands, fisheries and farming livelihoods in rural India.',
        'No text, captions, numbers, logos or identifiable faces in the image.',
      ].filter(Boolean).join(' ')
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await apiFetch('/api/notebook/nanobanana', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, referenceImage: styleRef, referenceMode: 'style', aspectRatio: ratio }),
          })
        } catch (e) { fail(i, e instanceof Error ? e.message : 'request failed'); return }
        // Rate-limited: wait and try again rather than leave a hole in the edit.
        if (res.status === 429 && attempt < 2) {
          await new Promise(r => setTimeout(r, 8000 * (attempt + 1)))
          if (!live()) return
          continue
        }
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.imageData) { fail(i, data?.error || `HTTP ${res.status} (no image in response)`); return }
        const image: StoredImage = { data: data.imageData, mimeType: data.mimeType || 'image/png' }
        if (!styleRef) styleRef = image
        stored[i] = image
        // Cache before counting it done: a background notebook is unmounted
        // as soon as it stops being busy.
        if (generationRef.current === epoch) await storeShotImages(sig, styleKey, stored, [i])
        const ok = await new Promise<boolean>(resolve => {
          const img = new Image()
          img.onload = () => { if (live()) { shotImagesRef.current[i] = img; bumpVisuals() } resolve(true) }
          img.onerror = () => resolve(false)
          img.src = `data:${image.mimeType};base64,${image.data}`
        })
        if (!ok) { fail(i, 'picture could not be decoded'); return }
        if (live()) setImgStatus(p => ({ ...p, done: p.done + 1 }))
        return
      }
    }
    // The first picture sets the look; the rest follow it, a few at a time.
    if (!styleRef && todo.length) await makeOne(todo.shift()!)
    await mapPool(todo, IMAGE_CONCURRENCY, i => makeOne(i))
  }

  /** Animate a few key shots' stills with Veo (explicit click only; each 8s clip costs money).
   *  Start the op, poll every 10s, load the MP4 as a muted loop. Epoch-guarded. */
  async function animateWithVeo() {
    const slides = slidesRef.current, shots = shotList()
    if (veoBusy || shots.length === 0) return
    const epoch = generationRef.current

    // Prefer card openers, stat/quote cards first, among shots with their own AI still.
    const withStill = shots
      .map((sh, idx) => ({ sh, idx }))
      .filter(({ idx }) => !!shotImagesRef.current[idx] && !veoClipsRef.current.has(idx) && !photoAssignment().get(idx))
    const score = ({ sh, idx }: { sh: FlatShot; idx: number }) => {
      const s = slides[sh.seg], opener = idx === 0 || shots[idx - 1].seg !== sh.seg
      return (opener ? 3 : 0) + (s?.visual === 'stat' ? 2 : s?.visual === 'quote' ? 1 : 0)
    }
    const ranked = [...withStill].sort((a, b) => score(b) - score(a) || a.idx - b.idx)
    const chosen = ranked.slice(0, Math.max(1, Math.min(veoCount, ranked.length)))
    if (chosen.length === 0) { setVeoStatus({ done: 0, failed: 0, total: 0, lastError: 'No generated stills to animate yet — generate the video first.' }); return }

    setVeoBusy(true)
    setVeoStatus({ done: 0, failed: 0, total: chosen.length, lastError: '' })
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

    try {
      for (const { sh, idx } of chosen) {
        if (generationRef.current !== epoch || !isMountedRef.current) return
        const still = shotImagesRef.current[idx]
        const m = still?.src.match(/^data:([^;]+);base64,(.+)$/)
        if (!m) { setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: still not available as data` })); continue }
        const narration = shotNarration(shots, idx, slides, linesRef.current).slice(0, 200)
        const prompt = `Gentle, natural, cinematic motion bringing this scene to life; keep the subject and composition consistent. Context: ${sh.scene || slides[sh.seg]?.title || ''}. ${narration}`.slice(0, 480)
        try {
          const startRes = await apiFetch('/api/notebook/veo-start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageData: m[2], mimeType: m[1], prompt, aspectRatio: aspect === 'portrait' ? '9:16' : '16:9' }),
          })
          const startData = await startRes.json().catch(() => null)
          if (!startRes.ok || !startData?.operationName) {
            setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: ${startData?.error || `HTTP ${startRes.status}`}` }))
            continue
          }
          // Poll up to ~6 min (36 × 10s).
          let clipData: { videoData?: string; mimeType?: string; error?: string } | null = null
          for (let attempt = 0; attempt < 36; attempt++) {
            if (generationRef.current !== epoch || !isMountedRef.current) return
            await sleep(10_000)
            const pollRes = await apiFetch('/api/notebook/veo-poll', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ operationName: startData.operationName }),
            })
            const poll = await pollRes.json().catch(() => null)
            if (!pollRes.ok) { clipData = { error: poll?.error || `HTTP ${pollRes.status}` }; break }
            if (poll?.done) { clipData = poll; break }
          }
          if (!clipData) { setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: timed out` })); continue }
          if (clipData.error || !clipData.videoData) {
            setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: ${clipData.error || 'no video returned'}` }))
            continue
          }
          if (generationRef.current !== epoch || !isMountedRef.current) return
          const video = document.createElement('video')
          video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'auto'
          video.src = `data:${clipData.mimeType || 'video/mp4'};base64,${clipData.videoData}`
          const decoded = await new Promise<boolean>((resolve) => {
            video.onloadeddata = () => resolve(true)
            video.onerror = () => resolve(false)
          })
          if (!decoded) { setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: clip could not be decoded` })); continue }
          veoClipsRef.current.set(idx, video)
          setVeoStatus(p => ({ ...p, done: p.done + 1 }))
        } catch (e) {
          setVeoStatus(p => ({ ...p, failed: p.failed + 1, lastError: `Shot ${idx + 1}: ${e instanceof Error ? e.message : 'request failed'}` }))
        }
      }
    } finally {
      if (isMountedRef.current) setVeoBusy(false)
    }
  }

  /** Fetch the on-screen cards and their shot plan. On failure slidesRef stays empty
   *  (pictures without a text panel) and `slidesFailed` offers a retry. */
  async function fetchVideoSlides(dialogueLines: AudioLine[], epoch: number) {
    const lineCount = dialogueLines.length
    const format = aspect === 'portrait' ? 'reel' : 'landscape'
    const failed = () => { if (isMountedRef.current && generationRef.current === epoch) setSlidesFailed(true) }
    if (isMountedRef.current) setSlidesFailed(false)
    try {
      const res = await apiFetch('/api/notebook/video-slides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 20_000) })),
          // Numbered lines so fromLine/toLine match the voiced lines; [n.s] marks where pictures cut.
          scriptText: numberedScript(dialogueLines), lineCount,
          // All on-screen text (titles, key points, labels) in the narration language.
          languageCode: language.code, languageLabel: language.label,
          // So the on-screen cards follow the same instructions as the narration.
          customPrompt,
          // Pictures change faster in a Reel.
          videoFormat: format,
          // The model picks a photo per shot only where its caption fits what's said.
          photos: REAL_PHOTO_STYLES.has(designStyle)
            ? photoCatalog.map(p => ({ id: p.id, caption: p.caption, place: p.place, date: p.date }))
            : [],
        }),
      })
      if (!res.body || !res.ok) { failed(); return }
      const reader = res.body.getReader(), decoder = new TextDecoder()
      let accum = '', buf = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const rawLines = buf.split('\n'); buf = rawLines.pop() ?? ''
        for (const ln of rawLines) {
          const tr = ln.trim(); if (!tr.startsWith('data: ')) continue
          const raw = tr.slice(6).trim(); if (!raw || raw === '[DONE]') continue
          try { const ch = JSON.parse(raw); if (ch.text) accum += ch.text } catch { /**/ }
        }
      }
      const jsonMatch = accum.match(/\[[\s\S]*\]/)
      let parsedJson: unknown[] = []
      try { parsedJson = jsonMatch ? (JSON.parse(cleanSlidesJSON(jsonMatch[0])) as unknown[]) : [] } catch { parsedJson = [] }
      // The model picks photos by catalogue id; persist the photo's URL instead
      // so a later change to the source list can't re-point it.
      const byId = <T extends { photo?: number; photoUrl?: string }>(x: T): T => (x.photo == null ? x : { ...x, photoUrl: photoCatalog[x.photo]?.url, photo: undefined })
      const rawSlides = (parsedJson.length ? sanitizeSlides(parsedJson) : sanitizeSlides(salvagePartialSlides(accum))) // truncated mid-array — recover what we can
        .map(x => ({ ...byId(x), shots: x.shots?.map(byId) }))
      if (generationRef.current !== epoch) return
      if (rawSlides.length === 0) { failed(); return }
      const planned = planShots(normalizeSlideRanges(rawSlides, lineCount), dialogueLines, format)
      slidesRef.current = planned
      generateShotImages(planned, dialogueLines, designStyle, epoch) // don't await — pictures stream in after the script
    } catch (e) {
      console.warn('video-slides fetch failed:', e)
      failed()
    }
  }

  async function generateScript() {
    if (sources.length === 0) return
    const epoch = ++generationRef.current
    setGenerating(true); setError(null)
    setLines([]); setAudioBuffers([])
    linesRef.current = []; audioBuffersRef.current = []
    slidesRef.current = []; shotImagesRef.current = []
    fieldPhotoByShotRef.current = new Map(); photoAssignKeyRef.current = null
    setSlidesFailed(false)
    releaseVeoClips()
    setVeoStatus({ done: 0, failed: 0, total: 0, lastError: '' })
    player.stop()
    try {
      const res = await apiFetch('/api/notebook/audio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 30_000) })),
          languageCode: language.code, languageLabel: language.label,
          customPrompt,
          mediaType: 'video',
          // One narrator; its voice's gender keeps any gendered grammar consistent.
          narratorGender: voiceGender(alexVoice),
          // 9:16 is for Instagram Reels → tight 45-75s script; 16:9 → ~2.5 min.
          videoFormat: aspect === 'portrait' ? 'reel' : 'landscape',
          videoTone,
        }),
      })
      if (!res.body) throw new Error('No stream')
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        try { const j = JSON.parse(errBody); throw new Error(j.error || `HTTP ${res.status}`) }
        catch (e2) { if (e2 instanceof SyntaxError) throw new Error(`HTTP ${res.status}`); throw e2 }
      }
      const reader = res.body.getReader(), decoder = new TextDecoder()
      let accum = '', buf = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const rawLines = buf.split('\n'); buf = rawLines.pop() ?? ''
        for (const ln of rawLines) {
          const tr = ln.trim(); if (!tr.startsWith('data: ')) continue
          const raw = tr.slice(6).trim(); if (!raw || raw === '[DONE]') continue
          try { const ch = JSON.parse(raw); if (ch.error) { setError(ch.error); return }; if (ch.text) accum += ch.text } catch { /**/ }
        }
      }
      const parsed = parseScript(accum)
      setLines(parsed); linesRef.current = parsed
      if (parsed.length > 0) {
        // Auto-save the script right away so it survives an interrupted synthesis.
        if (generationRef.current === epoch) onChange?.({ lines: parsed, videoSlides: [], languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
        // Independent calls, so run them concurrently.
        await Promise.all([synthesizeAll(parsed, epoch), fetchVideoSlides(parsed, epoch)])
        if (generationRef.current === epoch) onChange?.({ lines: parsed, videoSlides: slidesRef.current, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally { setGenerating(false) }
  }

  const synthesizeAll = useCallback(async (
    parsed: AudioLine[], epoch = generationRef.current,
    /** After a user edit: audio reused for unchanged lines (null/undefined = voice it). */
    reuse?: (AudioBuffer | null | undefined)[],
  ) => {
    // A newer Regenerate must not be overwritten by this run's late results.
    const live = () => isMountedRef.current && generationRef.current === epoch
    const results: (AudioBuffer | null)[] = parsed.map((_, i) => reuse?.[i] ?? null)
    const todo = parsed.map((line, i) => ({ line, i })).filter(({ i }) => !results[i])
    setSynthesizing(true); setSynthProgress({ done: 0, total: todo.length })
    const ctx = getAudioCtx()
    let done = 0
    // Per-line buffers for word-level subtitle sync; pooled because firing every
    // line at once trips the rate limit and leaves silent gaps.
    await mapPool(todo, TTS_CONCURRENCY, async ({ line, i }) => {
      if (!live()) return
      try {
        const voice = line.host === 'ALEX' ? alexVoice : jordanVoice
        results[i] = await synthesizeLine(ctx, line.text, voice, speechStyle(line.tone, language.label, 'narration', videoTone))
      } catch (e) { console.warn(`TTS line ${i}:`, e) }
      done++; if (live()) setSynthProgress({ done, total: todo.length })
    })
    if (live() && audioCacheKey && results.some(Boolean)) {
      await putMedia(audioCacheKey, encodeAudio(videoAudioSig(parsed, language.code, alexVoice, jordanVoice), results))
    }
    if (live()) {
      voicedWithRef.current = `${language.code}|${alexVoice}|${jordanVoice}|${videoTone}`
      setAudioBuffers(results); audioBuffersRef.current = results; setSynthesizing(false)
    }
  }, [language, alexVoice, jordanVoice, audioCacheKey, videoTone])

  /** Re-store the shot pictures under the CURRENT slides' signature, so an
   *  edit (which changes the signature) doesn't orphan them on the next reload. */
  async function recacheImages() {
    if (!imageCacheKey) return
    const style = slideImageStyleRef.current
    const images = shotList().map((_, i) => asStored(shotImagesRef.current[i]))
    if (images.some(Boolean)) await storeShotImages(videoImagesSig(slidesRef.current, style), style, images)
  }

  /** Save narration edits: cards follow their lines, and only new/changed lines are
   *  re-voiced (all of them if language, voices or tone changed since). */
  async function saveScriptEdits(edited: EditableLine[]) {
    setEditMode(null)
    player.stop()
    setError(null)
    const epoch = generationRef.current
    const oldLines = linesRef.current, oldBufs = audioBuffersRef.current
    const sameVoices = voicedWithRef.current === `${language.code}|${alexVoice}|${jordanVoice}|${videoTone}`
    const reuse = edited.map(l => (sameVoices && unchangedLine(oldLines, l) ? oldBufs[l.origIdx!] ?? null : null))
    const next: AudioLine[] = edited.map(({ origIdx: _o, ...l }) => l)

    // Cards follow their lines, and each picture follows its sentence.
    const { slides, keepShots } = remapSlidesAfterEdit(slidesRef.current, edited)
    slidesRef.current = slides
    shotImagesRef.current = keepShots.map(k => shotImagesRef.current[k] ?? null)
    const oldClips = veoClipsRef.current
    veoClipsRef.current = new Map(keepShots.flatMap((k, n) => (oldClips.has(k) ? [[n, oldClips.get(k)!] as [number, HTMLVideoElement]] : [])))
    skippedForPhotoRef.current = new Set(keepShots.flatMap((k, n) => (skippedForPhotoRef.current.has(k) ? [n] : [])))
    fieldPhotoByShotRef.current = new Map(); photoAssignKeyRef.current = null

    setLines(next); linesRef.current = next
    onChange?.({ lines: next, videoSlides: slides, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
    await recacheImages()
    bumpVisuals()
    await synthesizeAll(next, epoch, reuse)
  }

  /** On-screen card text edited by the user — text only, nothing to regenerate. */
  async function saveCardEdits(slides: VideoSlide[]) {
    setEditMode(null)
    slidesRef.current = slides
    onChange?.({ lines: linesRef.current, videoSlides: slides, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
    await recacheImages()
    bumpVisuals()
  }

  /** MP4 export via WebCodecs (mediabunny), faster than real time: frames come from the
   *  same renderVideoFrame() as the preview; audio is one offline mix. */
  async function exportVideoMp4() {
    const bufs = audioBuffersRef.current, ls = linesRef.current
    if (!bufs.length || !ls.length) return
    setExporting(true); exportingRef.current = true; setExportProgress(0); setError(null)
    try {
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality } = await import('mediabunny')
      const tl = getTimeline()
      if (tl.total <= 0) { setError('No synthesized audio to export yet'); return }

      const preset = EXPORT_QUALITY[quality]
      await ensureFonts(language.code) // never bake fallback glyphs into the MP4
      resetTextLayoutCache()
      const offCanvas = document.createElement('canvas')
      offCanvas.width = W * preset.scale; offCanvas.height = H * preset.scale
      const offCtx = offCanvas.getContext('2d')
      if (!offCtx) throw new Error('Could not create an offscreen canvas')

      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
      const fps = 30
      const videoSource = new CanvasSource(offCanvas, { codec: 'avc', quality: new Quality({ bitrate: preset.bitrate }) })
      output.addVideoTrack(videoSource, { frameRate: fps })
      const audioSource = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: 160_000 }) })
      output.addAudioTrack(audioSource)
      await output.start()

      // One 48kHz stereo mix (48k also sidesteps browsers whose AAC encoder
      // rejects our 24kHz TTS rate). Failed lines are simply silent.
      await audioSource.add(await mixNarration(bufs, tl.lineStart, tl.total, tailSeconds(aspect === 'portrait', layout), music === 'off' ? null : music))

      const hosts = getHostNames(alexVoice, jordanVoice, language.code)
      const slides = slidesRef.current
      const exportDateline = dateline()

      const totalFrames = Math.ceil((tl.total + tailSeconds(aspect === 'portrait', layout)) * fps)
      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps
        const loc = locate(tl, t)
        const lineDur = loc.lineIdx >= 0 ? tl.lineDur[loc.lineIdx] : 0
        const speaking = loc.lineIdx >= 0 && loc.lineT < lineDur
        const buf = loc.lineIdx >= 0 ? bufs[loc.lineIdx] : null
        const bars = speaking && buf ? computeBars(buf, loc.lineT, WAVEFORM_BARS) : new Array(WAVEFORM_BARS).fill(0)

        // Veo clip for the active shot: seek to the shot-local time and
        // wait for the frame (the one slow part); falls back to the still.
        let clip: HTMLVideoElement | null = null
        const veoClip = loc.shotIdx >= 0 ? veoClipsRef.current.get(loc.shotIdx) : undefined
        if (veoClip && veoClip.readyState >= 2 && veoClip.duration > 0) {
          const target = loc.shotT % veoClip.duration
          if (Math.abs(veoClip.currentTime - target) > 0.02) {
            const seeked = await new Promise<boolean>((resolve) => {
              let done = false
              const ok = () => { if (!done) { done = true; veoClip.removeEventListener('seeked', ok); resolve(true) } }
              veoClip.addEventListener('seeked', ok)
              veoClip.currentTime = target
              setTimeout(() => { if (!done) { done = true; veoClip.removeEventListener('seeked', ok); resolve(false) } }, 3000)
            })
            if (seeked) clip = veoClip
          } else clip = veoClip
        }

        renderVideoFrame(offCtx, W, H, {
          t, total: tl.total, tl,
          lineIdx: loc.lineIdx, lineT: loc.lineT, lineDur,
          text: speaking ? lineText(ls, loc.lineIdx) : '',
          speakHost: speaking ? ls[loc.lineIdx]?.host ?? null : null,
          bars, noLines: false,
          slides, segIdx: loc.segIdx, segT: loc.segT, segDur: loc.segDur, shotIdx: loc.shotIdx,
          visualFor: i => visualFor(i, designStyle, i === loc.shotIdx ? clip : null),
          wordTimes: speaking ? wordTimesFor(loc.lineIdx) : null,
          cues: cuesFor(tl, loc.segIdx),
          hosts, langNative: language.native, title: titleRef.current, headline: slides[0]?.headline ?? '', dateline: exportDateline, credits: creditsRef.current,
          str: stringsFor(language.code), fonts: fontsFor(language.code), ...brandRef.current,
          isPlaying: true, scale: preset.scale, layout,
        })

        await videoSource.add(t, 1 / fps) // respects encoder backpressure
        if (f % 15 === 0) {
          setExportProgress(Math.round((f / totalFrames) * 100))
          await new Promise(r => setTimeout(r, 0)) // keep the tab responsive
        }
      }

      await output.finalize()
      const buffer = output.target.buffer
      if (!buffer) throw new Error('Export produced no output')
      const blob = new Blob([buffer], { type: 'video/mp4' })
      const slug = titleRef.current.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video-overview'
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${slug}-${language.code}-${quality}.mp4` })
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch (e) {
      setError(e instanceof Error ? `Export failed: ${e.message}` : 'Export failed')
    } finally {
      exportingRef.current = false
      if (isMountedRef.current) setExporting(false)
    }
  }

  const imagesPending = imgStatus.total > 0 && imgStatus.done + imgStatus.failed < imgStatus.total
  /** Shots with no picture of their own yet (each holds its card's nearest one meanwhile). */
  const missingPictures = slidesRef.current.length ? shotList().filter((_, k) => !ownVisual(k, designStyle)).length : 0
  const busy = generating || synthesizing || veoBusy || exporting || imagesPending
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const noSources   = sources.length === 0
  const isLoading   = generating || synthesizing || restoring
  const readyToPlay = audioBuffers.length > 0 && lines.length > 0 && !isLoading

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-3">

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Format</label>
        <div className="flex gap-2">
          <button
            onClick={() => setAspect('landscape')}
            disabled={isLoading || exporting}
            className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-all"
            style={{ background: aspect === 'landscape' ? C.dark : C.white, color: aspect === 'landscape' ? C.white : C.dark, border: '1.5px solid #E5E7EB' }}
          >
            16:9 Landscape
          </button>
          <button
            onClick={() => setAspect('portrait')}
            disabled={isLoading || exporting}
            className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-all"
            style={{ background: aspect === 'portrait' ? C.dark : C.white, color: aspect === 'portrait' ? C.white : C.dark, border: '1.5px solid #E5E7EB' }}
          >
            9:16 Reels
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Language</label>
        <select value={language.code}
          onChange={e => setLanguage(INDIAN_LANGUAGES.find(l => l.code === e.target.value)!)}
          disabled={isLoading || exporting}
          className="w-full rounded-xl px-3 py-2 text-xs font-medium border outline-none appearance-none cursor-pointer"
          style={{ background: C.white, color: C.dark, borderColor: '#E5E7EB' }}
        >
          {INDIAN_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label} — {l.native}</option>)}
        </select>
      </div>

      {/* Story: full-screen pictures with captions. Briefing: key points beside the picture. */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Layout</label>
        <div className="flex gap-2">
          {([['story', 'Story · full screen'], ['briefing', 'Briefing · key points']] as const).map(([id, label]) => (
            <button key={id}
              onClick={() => { setLayout(id); if (lines.length) onChange?.({ lines, videoSlides: slidesRef.current, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout: id }) }}
              disabled={exporting}
              className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-all"
              style={{ background: layout === id ? C.dark : C.white, color: layout === id ? C.white : C.dark, border: '1.5px solid #E5E7EB' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* One narrator; an older two-voice script keeps its second voice. */}
      <div className="flex gap-2">
        <VoiceSelect label="Narrator voice" value={alexVoice} options={[...VOICES]} format={voiceLabel} disabled={isLoading||exporting} onChange={setAlexVoice} />
        {lines.some(l => l.host === 'JORDAN') && (
          <VoiceSelect label="Second voice (older script)" value={jordanVoice} options={FEMALE_VOICES} format={voiceLabel} disabled={isLoading||exporting} onChange={setJordanVoice} />
        )}
      </div>

      {/* Tone shapes both the script (server VIDEO_TONES) and the voice delivery */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Tone</label>
        <select value={videoTone}
          onChange={e => setVideoTone(validVideoTone(e.target.value))}
          disabled={isLoading || exporting}
          className="w-full rounded-xl px-3 py-2 text-xs font-medium border outline-none appearance-none cursor-pointer"
          style={{ background: C.white, color: C.dark, borderColor: '#E5E7EB' }}
        >
          {VIDEO_TONES.map(t => <option key={t.id} value={t.id}>{t.label} — {t.hint}</option>)}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Visual Style</label>
        <select value={designStyle}
          onChange={e => setDesignStyle(e.target.value)}
          disabled={isLoading || exporting}
          className="w-full rounded-xl px-3 py-2 text-xs font-medium border outline-none appearance-none cursor-pointer"
          style={{ background: C.white, color: C.dark, borderColor: '#E5E7EB' }}
        >
          {DESIGN_STYLE_KEYS.map(key => <option key={key} value={key}>{DESIGN_STYLES[key].label}</option>)}
        </select>
      </div>

      <button
        onClick={() => setShowPrompt(v => !v)}
        className="w-full flex items-center gap-1.5 text-[11px] font-semibold transition-all"
        style={{ color: showPrompt ? C.dark : '#9CA3AF' }}
      >
        <Sparkles className="w-3 h-3" />
        Custom instructions
        {showPrompt ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
      </button>
      {showPrompt && (
        <textarea
          value={customPrompt}
          onChange={e => setCustomPrompt(e.target.value)}
          placeholder="Focus on a specific theme, target a particular audience, or set the tone…"
          rows={3}
          disabled={isLoading || exporting}
          className="w-full text-[11px] rounded-xl px-3 py-2 resize-none outline-none"
          style={{ background: '#F9FAFB', color: '#374151', border: '1.5px solid #E5E7EB' }}
        />
      )}

      <SubscriptionGate featureName="AI Video Overview">
      <button onClick={generateScript} disabled={isLoading || noSources || exporting}
        className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all"
        style={{ background: noSources||isLoading||exporting ? '#E5E7EB' : C.dark, color: noSources||isLoading||exporting ? '#9CA3AF' : C.white }}
      >
        {generating    ? <><Loader2 className="w-4 h-4 animate-spin" />Writing script…</>
         : synthesizing ? <><Loader2 className="w-4 h-4 animate-spin" />Synthesizing {synthProgress.done}/{synthProgress.total}…</>
         : <><Video className="w-4 h-4" />{lines.length > 0 ? 'Regenerate Video Overview' : 'Generate Video Overview'}</>}
      </button>
      </SubscriptionGate>

      {/* Restored script without cached audio: re-voice it (and regenerate pictures) under a fresh epoch. */}
      {lines.length > 0 && audioBuffers.length === 0 && !isLoading && (
        <button
          onClick={() => {
            const epoch = ++generationRef.current
            synthesizeAll(lines, epoch)
            // Skip images already restored from this device's cache.
            if (slidesRef.current.length > 0 && !shotImagesRef.current.some(Boolean)) generateShotImages(slidesRef.current, lines, designStyle, epoch)
            onChange?.({ lines, videoSlides: slidesRef.current, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
          }}
          disabled={exporting}
          className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all"
          style={{ background: C.white, color: C.dark, border: '1.5px solid #E5E7EB' }}
        >
          <Video className="w-3.5 h-3.5" />Synthesize Audio &amp; Visuals for Restored Script
        </button>
      )}

      {/* Retry just the cards + picture plan step. */}
      {slidesFailed && lines.length > 0 && !generating && !exporting && (
        <button
          onClick={async () => {
            const epoch = generationRef.current
            await fetchVideoSlides(linesRef.current, epoch)
            if (generationRef.current === epoch && slidesRef.current.length) {
              bumpVisuals()
              onChange?.({ lines: linesRef.current, videoSlides: slidesRef.current, languageCode: language.code, alexVoice, jordanVoice, designStyle, videoTone, aspect, layout })
            }
          }}
          className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all"
          style={{ background: '#FEF2F2', color: '#B91C1C', border: '1.5px solid #FECACA' }}
        >
          <Sparkles className="w-3.5 h-3.5" />On-screen cards didn't come through — retry
        </button>
      )}

      {lines.length > 0 && audioBuffers.length > 0 && !isLoading && !imagesPending && !veoBusy && !exporting
        && !restoring && !photosLoading && missingPictures > 0 && (
        <button
          onClick={() => generateShotImages(slidesRef.current, lines, designStyle, generationRef.current, true)}
          className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all"
          style={{ background: C.white, color: C.dark, border: '1.5px solid #E5E7EB' }}
        >
          <Sparkles className="w-3.5 h-3.5" />Generate {missingPictures} missing picture{missingPictures > 1 ? 's' : ''}
        </button>
      )}

      {/* Veo is explicit opt-in: it costs ~$1 per clip. */}
      {lines.length > 0 && !isLoading && (
        <div className="rounded-xl p-2.5 flex flex-col gap-1.5" style={{ background: '#F5F3FF', border: '1.5px solid #E5E7EB' }}>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>Animate key shots (Veo)</label>
            <select value={veoCount} onChange={e => setVeoCount(Number(e.target.value))} disabled={veoBusy || exporting}
              className="ml-auto rounded-lg px-2 py-1 text-[11px] font-medium border outline-none"
              style={{ background: C.white, color: C.dark, borderColor: '#E5E7EB' }}>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} clip{n > 1 ? 's' : ''}</option>)}
            </select>
          </div>
          <button onClick={animateWithVeo} disabled={veoBusy || exporting}
            className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all"
            style={{ background: veoBusy || exporting ? '#E5E7EB' : C.lime, color: veoBusy || exporting ? '#9CA3AF' : '#000' }}
          >
            {veoBusy
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Animating {veoStatus.done}/{veoStatus.total}… (~1 min each)</>
              : <><Sparkles className="w-3.5 h-3.5" />Animate {veoCount} key shot{veoCount > 1 ? 's' : ''} with Veo</>}
          </button>
          <p className="text-[10px]" style={{ color: '#9CA3AF' }}>
            Real AI motion on the key shots (~8s each). Costs roughly ${(veoCount * 1.2).toFixed(2)} per run.
          </p>
          {veoStatus.total > 0 && (
            <p className="text-[10px]" style={{ color: veoStatus.failed > 0 ? '#DC2626' : '#6D28D9' }}>
              Clips: {veoStatus.done}/{veoStatus.total} ready{veoStatus.failed > 0 && `, ${veoStatus.failed} failed`}
              {veoStatus.lastError && <span className="block mt-0.5 break-words">Last error: {veoStatus.lastError}</span>}
            </p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {imgStatus.total > 0 && (
        <p className="text-[11px]" style={{ color: imgStatus.failed > 0 ? '#DC2626' : '#9CA3AF' }}>
          Pictures: {imgStatus.done}/{imgStatus.total} generated
          {imgStatus.failed > 0 && `, ${imgStatus.failed} failed`}
          {imgStatus.lastError && <span className="block mt-0.5 break-words">Last error: {imgStatus.lastError}</span>}
        </p>
      )}

      <div className="rounded-2xl overflow-hidden shrink-0" style={{ background: '#040D10' }}>
        <canvas ref={canvasRef} width={W * PREVIEW_SCALE} height={H * PREVIEW_SCALE} className="w-full h-auto block" />
        <div className="flex flex-col gap-1.5 px-3 py-2" style={{ background: 'rgba(4,13,16,0.97)' }}>
          <PlayerControls player={player} accent={C.lime} accentInk="#000" disabled={!readyToPlay || exporting} segmentLabel="line" />
          <div className="flex items-center gap-2">
          <p className="flex-1 text-[11px] truncate" style={{ color: 'rgba(255,255,255,0.38)' }}>
            {exporting   ? `● Exporting MP4… ${exportProgress}%`
             : readyToPlay ? (player.segment >= lines.length ? `${playing ? 'Playing' : 'Paused'} · credits` : player.segment >= 0 ? `${playing ? 'Playing' : 'Paused'} · line ${player.segment + 1} / ${lines.length}` : `${lines.length} lines`)
             : 'Generate to preview'}
          </p>
          {readyToPlay && (
            <button
              onClick={() => setMusic(m => (m === 'story' ? 'ambient' : m === 'ambient' ? 'off' : 'story'))} disabled={exporting}
              title="Music under the narration (preview and MP4): story score → ambient pad → off"
              className="px-2 py-1 rounded-md text-[10px] font-semibold transition-all"
              style={{ background: music !== 'off' ? 'rgba(167,139,250,0.22)' : 'rgba(255,255,255,0.06)', color: music !== 'off' ? '#C4B5FD' : 'rgba(255,255,255,0.45)' }}
            >
              ♪ {music === 'story' ? 'Story score' : music === 'ambient' ? 'Ambient' : 'Music off'}
            </button>
          )}
          {readyToPlay && !playing && (
            <select value={quality} onChange={e => setQuality(e.target.value as ExportQuality)} disabled={exporting}
              title="Export resolution" aria-label="Export resolution"
              className="rounded-md px-1.5 py-1 text-[10px] font-semibold outline-none cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', border: 'none' }}
            >
              {(Object.keys(EXPORT_QUALITY) as ExportQuality[]).map(q => <option key={q} value={q} style={{ color: '#000' }}>{q}</option>)}
            </select>
          )}
          {readyToPlay && !playing && (
            <button onClick={exportVideoMp4} disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
              style={{ background: exporting ? 'rgba(255,255,255,0.04)' : 'rgba(167,139,250,0.14)', color: exporting ? '#6B7280' : '#A78BFA' }}
            >
              {exporting ? <><Loader2 className="w-3 h-3 animate-spin" />Exporting…</> : <><Download className="w-3 h-3" />Download MP4</>}
            </button>
          )}
          </div>
        </div>
      </div>

      {lines.length > 0 && !isLoading && !exporting && editMode === null && (
        <div className="flex gap-2">
          <button
            onClick={() => { player.stop(); setEditMode('script') }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold"
            style={{ background: C.white, color: C.dark, border: '1.5px solid #E5E7EB' }}
          >
            <Pencil className="w-3.5 h-3.5" />Edit narration
          </button>
          {slidesRef.current.length > 0 && (
            <button
              onClick={() => { player.stop(); setEditMode('cards') }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold"
              style={{ background: C.white, color: C.dark, border: '1.5px solid #E5E7EB' }}
            >
              <Type className="w-3.5 h-3.5" />Edit on-screen text
            </button>
          )}
        </div>
      )}
      {editMode === 'script' && (
        <ScriptEditor lines={lines} hostNames={getHostNames(alexVoice, jordanVoice, language.code)} noun="voice"
          singleVoice={!lines.some(l => l.host === 'JORDAN')}
          onSave={saveScriptEdits} onCancel={() => setEditMode(null)} />
      )}
      {editMode === 'cards' && (
        <VideoCardEditor slides={slidesRef.current} onSave={saveCardEdits} onCancel={() => setEditMode(null)} />
      )}
    </div>
  )
}
