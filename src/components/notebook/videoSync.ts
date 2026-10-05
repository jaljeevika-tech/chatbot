// Audio ↔ on-screen sync for Video Overview. TTS returns no word timestamps, so words are
// laid out on a "speech clock" measured from the waveform's voiced spans (handling pauses),
// and segmentCues() finds when each bullet/stat/quote is actually spoken.

import type { AudioLine, VideoSlide } from '../../types/notebook'

const FRAME_SEC = 0.02
const MIN_PAUSE = 0.12

/** Voiced [start, end] spans of a line's audio, in seconds. */
function voicedSpans(buf: AudioBuffer): [number, number][] {
  const data = buf.getChannelData(0)
  const hop = Math.max(1, Math.floor(buf.sampleRate * FRAME_SEC))
  const rms: number[] = []
  for (let i = 0; i < data.length; i += hop) {
    let s = 0
    const end = Math.min(data.length, i + hop)
    for (let j = i; j < end; j++) s += data[j] * data[j]
    rms.push(Math.sqrt(s / Math.max(1, end - i)))
  }
  if (!rms.length) return []
  const sorted = [...rms].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  const speech = sorted[Math.floor(sorted.length * 0.8)]
  if (speech <= 1e-5) return []
  const thr = floor + (speech - floor) * 0.18

  const spans: [number, number][] = []
  let start = -1
  rms.forEach((v, i) => {
    if (v >= thr && start < 0) start = i
    else if (v < thr && start >= 0) { spans.push([start * FRAME_SEC, i * FRAME_SEC]); start = -1 }
  })
  if (start >= 0) spans.push([start * FRAME_SEC, rms.length * FRAME_SEC])
  // Merge across pauses too short to be a real pause; drop clicks.
  const merged: [number, number][] = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp[0] - last[1] < MIN_PAUSE) last[1] = sp[1]
    else merged.push([sp[0], sp[1]])
  }
  return merged.filter(([a, b]) => b - a >= 0.06)
}

const alignCache = new WeakMap<AudioBuffer, { text: string; times: number[] }>()

/** Start time (seconds from line start) of each whitespace-separated word. */
export function alignWords(buf: AudioBuffer | null, text: string, fallbackDur: number): number[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  if (buf) {
    const hit = alignCache.get(buf)
    if (hit && hit.text === text) return hit.times
  }
  const spans = buf ? voicedSpans(buf) : []
  const use: [number, number][] = spans.length ? spans : [[0.05, Math.max(0.1, (buf?.duration ?? fallbackDur) - 0.1)]]
  const speechTotal = use.reduce((a, [s, e]) => a + (e - s), 0)
  const weights = words.map(w => w.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length + 1.5)
  const wTotal = weights.reduce((a, b) => a + b, 0)

  // Map a position on the speech clock back to real time.
  const toReal = (clock: number) => {
    let acc = 0
    for (const [s, e] of use) {
      const len = e - s
      if (clock <= acc + len) return s + (clock - acc)
      acc += len
    }
    return use[use.length - 1][1]
  }
  let acc = 0
  const times = weights.map(w => { const t = toReal((acc / wTotal) * speechTotal); acc += w; return t })
  if (buf) alignCache.set(buf, { text, times })
  return times
}

// Cues: when is each on-screen item spoken?

// Function words that occur everywhere — matching on them cues a bullet at the
// wrong moment. English plus the common postpositions/auxiliaries of Hindi,
// Marathi and Bengali (Dravidian languages glue these onto words instead).
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'their', 'into', 'over', 'than', 'but', 'not', 'our', 'they', 'them', 'who', 'what', 'when', 'where', 'which', 'one', 'all', 'per', 'out', 'more', 'most',
  'में', 'की', 'के', 'का', 'को', 'से', 'है', 'हैं', 'और', 'पर', 'भी', 'एक', 'यह', 'वह', 'था', 'थे', 'थी', 'थीं', 'नहीं', 'बहुत', 'लिए', 'साथ', 'तो', 'ही', 'कि', 'जो', 'इस', 'उस', 'अभी',
  'आणि', 'आहे', 'आहेत', 'होते', 'होती', 'मध्ये', 'च्या', 'ची', 'चा', 'चे', 'ला', 'ने', 'हे', 'ते', 'या', 'त्या', 'पण',
  'এবং', 'এই', 'সেই', 'একটি', 'হয়', 'ছিল', 'থেকে', 'জন্য', 'না', 'করে', 'আর',
])
// Keep \p{M}: Indic vowel signs and viramas are combining marks — stripping
// them mangles Hindi/Tamil/… words and drops most of them under the length filter.
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')
// Indic digit blocks (Devanagari, Bengali, Gujarati, Tamil, Telugu, Kannada, Malayalam) → ASCII.
const DIGIT_ZEROS = [0x966, 0x9e6, 0xae6, 0xbe6, 0xc66, 0xce6, 0xd66]
const asciiDigits = (w: string) => w.replace(/\p{Nd}/gu, d => {
  const c = d.charCodeAt(0)
  for (const z of DIGIT_ZEROS) if (c >= z && c <= z + 9) return String(c - z)
  return d
}).replace(/[^0-9]/g, '')
/** Digits of the FIRST number in a value like "1,250", "₹2.3 Cr", "1,200–1,500". */
const firstNumberDigits = (v: string) => asciiDigits((v.match(/[\p{Nd}][\p{Nd},.]*/u) ?? [''])[0])
const stem = (w: string) => norm(w).slice(0, 6)
const keyTokens = (text: string) => [...new Set(text.split(/\s+/).map(norm).filter(t => t.length >= 3 && !STOP.has(t)).map(t => t.slice(0, 6)))]

interface SpokenWord { s: string; d: string; t: number }

export interface SegmentCues {
  /** Segment-relative seconds at which each bullet is spoken (NaN = not found). */
  bullets: number[]
  /** When the stat's number/label is spoken. */
  stat: number
  /** Per-word reveal times for a quote that is read aloud, else null. */
  quote: number[] | null
}

function findPhrase(words: SpokenWord[], tokens: string[], from: number): number {
  if (!tokens.length) return -1
  const need = Math.max(1, Math.ceil(tokens.length * 0.34))
  let best = -1, bestScore = 0
  for (let i = from; i < words.length; i++) {
    const win = new Set(words.slice(i, i + 10).map(w => w.s))
    let score = 0
    for (const t of tokens) if (win.has(t)) score++
    // Earliest window that reaches the best score — the moment it starts being said.
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (bestScore < need) return -1
  // Slide forward to the first matched token inside that window.
  for (let i = best; i < Math.min(words.length, best + 10); i++) if (tokens.includes(words[i].s)) return i
  return best
}

export function segmentCues(
  slide: VideoSlide, lines: AudioLine[], lineStart: number[], segStart: number,
  wordTimesFor: (lineIdx: number) => number[],
): SegmentCues {
  const words: SpokenWord[] = []
  for (let l = slide.fromLine; l <= slide.toLine && l < lines.length; l++) {
    const ws = (lines[l]?.text ?? '').split(/\s+/).filter(Boolean)
    const times = wordTimesFor(l)
    ws.forEach((w, k) => words.push({ s: stem(w), d: asciiDigits(w), t: (lineStart[l] ?? 0) - segStart + (times[k] ?? 0) }))
  }
  const lead = 0.12 // land a few frames before the word, like an editor would

  // Bullets, in order.
  const bullets: number[] = []
  let from = 0
  for (const b of slide.bullets ?? []) {
    const i = findPhrase(words, keyTokens(b), from)
    if (i >= 0) { bullets.push(Math.max(0, words[i].t - lead)); from = i + 1 }
    else bullets.push(NaN)
  }

  // Stat: the number itself if it's written with digits in the script, else its label.
  let stat = NaN
  if (slide.stat) {
    // Compare full digit strings (the 6-char stem would truncate 7+ digit figures).
    const digits = firstNumberDigits(slide.stat.value)
    const di = digits.length >= 2 ? words.findIndex(w => w.d === digits) : -1
    const li = di >= 0 ? di : findPhrase(words, keyTokens(slide.stat.label), 0)
    if (li >= 0) stat = Math.max(0, words[li].t - lead)
  }

  // Quote read aloud: align its words to the narration run that matches it.
  let quote: number[] | null = null
  if (slide.quote) {
    const q = slide.quote.split(/\s+/).filter(Boolean).map(stem)
    const probe = q.slice(0, 5)
    let bestI = -1, bestHits = 0
    for (let i = 0; i < words.length; i++) {
      let hits = 0
      probe.forEach((p, j) => { if (words[i + j]?.s === p) hits++ })
      if (hits > bestHits) { bestHits = hits; bestI = i }
    }
    if (bestI >= 0 && bestHits >= Math.max(2, Math.ceil(probe.length * 0.6))) {
      quote = q.map((_, j) => Math.max(0, (words[Math.min(words.length - 1, bestI + j)]?.t ?? 0) - lead))
    }
  }
  return { bullets, stat, quote }
}
