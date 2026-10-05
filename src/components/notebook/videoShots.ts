// Shot planning for Video Overview: each card (VideoSlide) carries shots that cut to a
// new picture when the narration moves to a new subject. The script goes to /video-slides
// with sentence markers ([5.1] = line 5, sentence 1); these helpers normalise the model's
// shots and fall back to a sentence-based split. Pure functions, no React or canvas.

import type { AudioLine, VideoSlide, VideoShot } from '../../types/notebook'

export type VideoFormat = 'landscape' | 'reel'

/** Pacing per format: words of narration per picture the fallback split aims
 *  for (~2.6 spoken words/s → ~6 s landscape, ~4 s Reels), and the most
 *  pictures one video may ask the image generator for. */
export const SHOT_PACE: Record<VideoFormat, { targetWords: number; minWords: number; maxShots: number }> = {
  landscape: { targetWords: 16, minWords: 5, maxShots: 40 },
  reel:      { targetWords: 10, minWords: 4, maxShots: 22 },
}

// Sentence ends: Latin . ! ? … and the Devanagari/Bengali danda (। ॥), with
// any closing quote or bracket after them.
const SENTENCE_END = /[.!?…।॥]["'”’)\]]*$/u
// Words that end in a full stop without ending the sentence: an initial ("A."),
// or a common abbreviation.
const INITIAL = /^[A-Z]\.$/
const ABBREV = /^(?:dr|mr|mrs|ms|st|no|nos|rs|vs|approx|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e|govt|dept)\.$/i

/** Word index (whitespace-separated words, as alignWords counts them) at which
 *  each sentence of `text` starts. Always begins with 0 for non-empty text. */
export function sentenceStarts(text: string): number[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const starts = [0]
  for (let i = 0; i < words.length - 1; i++) {
    if (SENTENCE_END.test(words[i]) && !INITIAL.test(words[i]) && !ABBREV.test(words[i])) starts.push(i + 1)
  }
  return starts
}

/** The sentences of `text` (joined back with single spaces). */
export function sentencesOf(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const starts = sentenceStarts(text)
  return starts.map((s, k) => words.slice(s, starts[k + 1] ?? words.length).join(' '))
}

/** "[i] HOST: text" per line; a line with several sentences also gets a
 *  "[i.s]" marker before each sentence, so the model can say where a cut lands. */
export function numberedScript(lines: AudioLine[]): string {
  return lines.map((l, i) => {
    const ss = sentencesOf(l.text)
    const body = ss.length > 1 ? ss.map((s, k) => `[${i}.${k}] ${s}`).join(' ') : l.text
    return `[${i}] ${l.host}: ${body}`
  }).join('\n')
}

/** Accepts the model's "at" ("5.1", "5", 5) or a {line, sentence} object. */
export function parseShotAt(raw: unknown): { line: number; sentence: number } | null {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const line = Math.trunc(Number(o.line)), sentence = Math.trunc(Number(o.sentence ?? 0))
    return Number.isFinite(line) && line >= 0 ? { line, sentence: Number.isFinite(sentence) && sentence > 0 ? sentence : 0 } : null
  }
  const m = String(raw ?? '').trim().replace(/^\[|\]$/g, '').match(/^(\d+)(?:\s*[.:]\s*(\d+))?$/)
  if (!m) return null
  return { line: Number(m[1]), sentence: m[2] ? Number(m[2]) : 0 }
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Words of narration from shot position a (inclusive) to b (exclusive) — both [line, sentence]. */
function wordsBetween(lines: AudioLine[], a: [number, number], b: [number, number]): number {
  let n = 0
  for (let l = a[0]; l <= b[0] && l < lines.length; l++) {
    const ss = sentencesOf(lines[l]?.text ?? '')
    const from = l === a[0] ? a[1] : 0
    const to = l === b[0] ? b[1] : ss.length
    for (let k = from; k < Math.min(to, ss.length); k++) n += wordCount(ss[k])
  }
  return n
}

/** Sentence-based split of one card's lines into shots of about `targetWords`
 *  words each — used when the model planned no (usable) shots for a card. */
function autoShots(slide: VideoSlide, lines: AudioLine[], targetWords: number, minWords: number): VideoShot[] {
  const shots: VideoShot[] = [{ line: slide.fromLine, sentence: 0, scene: slide.scene, photoUrl: slide.photoUrl }]
  let acc = 0
  for (let l = slide.fromLine; l <= slide.toLine && l < lines.length; l++) {
    sentencesOf(lines[l]?.text ?? '').forEach((s, k) => {
      const w = wordCount(s)
      // Cut before this sentence when taking it would overshoot the target more than stopping short does.
      if (acc >= minWords && acc + w / 2 > targetWords && !(l === slide.fromLine && k === 0)) { shots.push({ line: l, sentence: k }); acc = 0 }
      acc += w
    })
  }
  // A short tail reads as a flicker — let the previous picture hold through it.
  if (shots.length > 1 && acc < minWords) shots.pop()
  return shots
}

/** Clean one card's shots: inside its line range, valid sentence indices,
 *  sorted, no duplicates, first shot at the card's first sentence, and no
 *  shot shorter than `minWords` (merged into the one before). */
function cleanShots(slide: VideoSlide, lines: AudioLine[], minWords: number): VideoShot[] {
  const valid = (slide.shots ?? []).flatMap(sh => {
    if (!Number.isInteger(sh.line) || sh.line < slide.fromLine || sh.line > slide.toLine || sh.line >= lines.length) return []
    const n = Math.max(1, sentenceStarts(lines[sh.line]?.text ?? '').length)
    return [{ ...sh, sentence: Math.max(0, Math.min(n - 1, Math.trunc(sh.sentence) || 0)) }]
  }).sort((a, b) => a.line - b.line || a.sentence - b.sentence)
  const out: VideoShot[] = []
  for (const sh of valid) {
    const last = out[out.length - 1]
    if (last && last.line === sh.line && last.sentence === sh.sentence) continue
    out.push(sh)
  }
  if (!out.length) return []
  // The card's first sentence always opens with a picture: pull the first shot back to it.
  out[0] = { ...out[0], line: slide.fromLine, sentence: 0 }
  // Too-short shots read as flicker — fold them into the previous shot.
  const end: [number, number] = [slide.toLine, Number.MAX_SAFE_INTEGER]
  for (let i = out.length - 1; i >= 1; i--) {
    const next = out[i + 1]
    if (wordsBetween(lines, [out[i].line, out[i].sentence], next ? [next.line, next.sentence] : end) < minWords) out.splice(i, 1)
  }
  return out
}

/** Give every card its shots: the model's plan where usable, otherwise a
 *  sentence-based split; then cap the total so one video never asks for more
 *  than `maxShots` pictures (the shortest shots merge first). */
export function planShots(slides: VideoSlide[], lines: AudioLine[], format: VideoFormat): VideoSlide[] {
  const pace = SHOT_PACE[format]
  const planned = slides.map(s => {
    const cleaned = cleanShots(s, lines, pace.minWords)
    // A card whose model plan has a single shot over many words gets split too.
    const words = wordsBetween(lines, [s.fromLine, 0], [s.toLine, Number.MAX_SAFE_INTEGER])
    const shots = cleaned.length > 1 || (cleaned.length === 1 && words <= pace.targetWords * 1.6)
      ? cleaned
      : autoShots({ ...s, scene: cleaned[0]?.scene ?? s.scene, photoUrl: cleaned[0]?.photoUrl ?? s.photoUrl }, lines, pace.targetWords, pace.minWords)
    return { ...s, shots }
  })
  let total = planned.reduce((n, s) => n + s.shots.length, 0)
  while (total > pace.maxShots) {
    // Merge the shortest non-first shot anywhere into its predecessor.
    let bestSi = -1, bestK = -1, bestWords = Infinity
    for (let si = 0; si < planned.length; si++) {
      const s = planned[si]
      for (let k = 1; k < s.shots.length; k++) {
        const sh = s.shots[k], next = s.shots[k + 1]
        const w = wordsBetween(lines, [sh.line, sh.sentence], next ? [next.line, next.sentence] : [s.toLine, Number.MAX_SAFE_INTEGER])
        if (w < bestWords) { bestWords = w; bestSi = si; bestK = k }
      }
    }
    if (bestSi < 0) break
    const si = bestSi, k = bestK
    planned[si] = { ...planned[si], shots: planned[si].shots.filter((_, j) => j !== k) }
    total--
  }
  return planned
}

/** A shot with the index of the card it belongs to (global shot order). */
export interface FlatShot extends VideoShot { seg: number }

/** Every shot in the video, in playback order. A card saved before shots
 *  existed counts as one shot (its old single picture). */
export function flatShots(slides: VideoSlide[]): FlatShot[] {
  return slides.flatMap((s, seg) => s.shots?.length
    ? s.shots.map(sh => ({ ...sh, seg }))
    : [{ seg, line: s.fromLine, sentence: 0, scene: s.scene, photoUrl: s.photoUrl }])
}

/** The narration a shot covers (its sentences up to the next shot). */
export function shotNarration(shots: FlatShot[], i: number, slides: VideoSlide[], lines: AudioLine[]): string {
  const sh = shots[i], next = shots[i + 1]
  const endLine = next && next.seg === sh.seg ? next.line : slides[sh.seg]?.toLine ?? sh.line
  const out: string[] = []
  for (let l = sh.line; l <= endLine && l < lines.length; l++) {
    const ss = sentencesOf(lines[l]?.text ?? '')
    const from = l === sh.line ? sh.sentence : 0
    const to = next && next.seg === sh.seg && l === next.line ? next.sentence : ss.length
    out.push(...ss.slice(from, to))
  }
  return out.join(' ')
}
