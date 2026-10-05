// Pure helpers for post-generation script editing (Podcast + Video). Kept out
// of the components so the reuse/remap rules can be tested on their own.
import type { AudioLine, VideoSlide, VideoShot } from '../../types/notebook'

export interface EditableLine extends AudioLine {
  /** Index of this line in the script before editing (absent = newly added). */
  origIdx?: number
}

/** True when an edited line is identical to the original line it came from — its audio can be reused. */
export function unchangedLine(orig: AudioLine[], l: EditableLine): boolean {
  if (l.origIdx == null) return false
  const o = orig[l.origIdx]
  return !!o && o.text === l.text && o.host === l.host
}

type Range = { from: number; to: number }

/** Podcast: reuse every old chunk whose lines all survive unchanged and in order; group
 *  the rest into new chunks of up to `maxChars`. `reuse[i]` is the kept buffer, or null. */
export function planEditedChunks<B>(edited: EditableLine[], oldLines: AudioLine[], oldRanges: Range[], oldBuffers: (B | null)[], maxChars: number): { chunks: Range[]; reuse: (B | null)[] } {
  const starts = new Map<number, number>() // new line index → reusable old chunk
  oldRanges.forEach((r, k) => {
    if (!oldBuffers[k]) return
    const j = edited.findIndex(l => l.origIdx === r.from)
    if (j < 0) return
    for (let m = 0; m <= r.to - r.from; m++) {
      const l = edited[j + m]
      if (!l || l.origIdx !== r.from + m || !unchangedLine(oldLines, l)) return
    }
    starts.set(j, k)
  })
  const chunks: Range[] = [], reuse: (B | null)[] = []
  let dirtyFrom = -1, chars = 0
  const flush = (to: number) => { if (dirtyFrom >= 0 && to >= dirtyFrom) { chunks.push({ from: dirtyFrom, to }); reuse.push(null) } dirtyFrom = -1; chars = 0 }
  for (let i = 0; i < edited.length;) {
    const k = starts.get(i)
    if (k != null) {
      flush(i - 1)
      const len = oldRanges[k].to - oldRanges[k].from + 1
      chunks.push({ from: i, to: i + len - 1 }); reuse.push(oldBuffers[k])
      i += len
      continue
    }
    if (dirtyFrom < 0) dirtyFrom = i
    chars += edited[i].text.length
    if (chars >= maxChars) flush(i)
    i++
  }
  flush(edited.length - 1)
  return { chunks, reuse }
}

/** Video: kept lines stay on their card, new lines join the previous line's card, and
 *  emptied cards are dropped; shots follow their lines. `keep[n]` / `keepShots[m]` give
 *  the old card / flat shot index so the caller can carry pictures across. */
export function remapSlidesAfterEdit(slides: VideoSlide[], edited: EditableLine[]): { slides: VideoSlide[]; keep: number[]; keepShots: number[] } {
  const shotCount = (s: VideoSlide) => s.shots?.length || 1
  if (!slides.length || !edited.length) {
    return { slides, keep: slides.map((_, k) => k), keepShots: Array.from({ length: slides.reduce((n, s) => n + shotCount(s), 0) }, (_, m) => m) }
  }
  const ownerOfOld = (o: number) => slides.findIndex(s => o >= s.fromLine && o <= s.toLine)
  const owner: number[] = []
  let last = 0
  edited.forEach((l, j) => {
    let k = l.origIdx != null ? ownerOfOld(l.origIdx) : -1
    if (k < 0) k = last
    owner[j] = Math.max(k, last) // never step backwards — keeps ranges contiguous
    last = owner[j]
  })
  const keep = slides.map((_, k) => k).filter(k => owner.includes(k))
  const firstShot: number[] = []
  slides.reduce((n, s, k) => { firstShot[k] = n; return n + shotCount(s) }, 0)
  const keepShots: number[] = []
  const out = keep.map(k => {
    const s = slides[k]
    const fromLine = owner.indexOf(k), toLine = owner.lastIndexOf(k)
    if (!s.shots?.length) { keepShots.push(firstShot[k]); return { ...s, fromLine, toLine } }
    const shots: VideoShot[] = []
    s.shots.forEach((sh, i) => {
      const j = edited.findIndex(l => l.origIdx === sh.line)
      if (j < 0 || owner[j] !== k) return // its line was deleted
      // A card still opens on a picture: the first kept shot starts the card.
      const at = shots.length === 0 ? { line: fromLine, sentence: 0 } : { line: j, sentence: sh.sentence }
      const prev = shots[shots.length - 1]
      if (prev && (at.line < prev.line || (at.line === prev.line && at.sentence <= prev.sentence))) return
      shots.push({ ...sh, ...at })
      keepShots.push(firstShot[k] + i)
    })
    if (!shots.length) { shots.push({ ...s.shots[0], line: fromLine, sentence: 0 }); keepShots.push(firstShot[k]) }
    return { ...s, fromLine, toLine, shots }
  })
  return { slides: out, keep, keepShots }
}
