import { useState, useRef, useEffect, useMemo, useCallback } from 'react'

// Narration buffers are stitched into one WAV and played through an <audio> element,
// since AudioBufferSourceNodes can't pause or seek. Segment boundaries are kept for highlighting.

function buildWav(buffers: (AudioBuffer | null)[]): { url: string; starts: number[]; duration: number } | null {
  const present = buffers.filter((b): b is AudioBuffer => !!b)
  if (present.length === 0) return null
  const rate  = present[0].sampleRate
  const total = present.reduce((n, b) => n + b.length, 0)

  const out  = new ArrayBuffer(44 + total * 2)
  const view = new DataView(out)
  const str  = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, total * 2, true)

  // starts[i] = second segment i begins; failed (null) segments get zero length.
  const starts: number[] = []
  let off = 44, samples = 0
  for (const b of buffers) {
    starts.push(samples / rate)
    if (!b) continue
    const ch = b.getChannelData(0)
    for (let i = 0; i < ch.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    samples += b.length
  }
  return { url: URL.createObjectURL(new Blob([out], { type: 'audio/wav' })), starts, duration: samples / rate }
}

function segmentAt(starts: number[], t: number): number {
  let idx = 0
  for (let i = 0; i < starts.length; i++) { if (starts[i] <= t) idx = i; else break }
  return idx
}

interface Options {
  /** Called whenever the active segment changes (-1 when stopped/ended). */
  onSegment?: (index: number) => void
  /** Route the element through a Web Audio graph (e.g. an AnalyserNode for a
   *  waveform). Called lazily on first play; must return the node to connect to. */
  connect?: () => { ctx: AudioContext; destination: AudioNode }
}

export interface SegmentPlayer {
  playing: boolean
  time: number
  duration: number
  segment: number
  segmentCount: number
  rate: number
  ready: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  stop: () => void
  seek: (t: number) => void
  skip: (delta: number) => void
  prevSegment: () => void
  nextSegment: () => void
  /** Jump to the start of segment i and start playing. */
  playSegment: (i: number) => void
  setRate: (r: number) => void
  /** Exact current position, read straight from the element — for per-frame
   *  renderers that can't wait for the (throttled) `time` state. */
  getTime: () => number
}

export function useSegmentPlayer(buffers: (AudioBuffer | null)[], opts: Options = {}): SegmentPlayer {
  const [playing,  setPlaying]  = useState(false)
  const [time,     setTime]     = useState(0)
  const [segment,  setSegment]  = useState(-1)
  const [rate,     setRateState] = useState(1)

  const audioRef   = useRef<HTMLAudioElement | null>(null)
  const optsRef    = useRef(opts)
  const segRef     = useRef(-1)
  const rafRef     = useRef<number | null>(null)
  const connectedRef = useRef<AudioContext | null>(null)
  /** True after Stop/end until the next play or seek — keeps the async
   *  'seeked' from the rewind re-highlighting segment 0. */
  const stoppedRef = useRef(true)
  optsRef.current = opts

  const wav = useMemo(() => buildWav(buffers), [buffers])
  const wavRef = useRef(wav)
  wavRef.current = wav

  function el() {
    if (!audioRef.current) {
      audioRef.current = new Audio()
      audioRef.current.preload = 'auto'
    }
    return audioRef.current
  }

  const setSeg = useCallback((i: number) => {
    if (segRef.current === i) return
    segRef.current = i
    setSegment(i)
    optsRef.current.onSegment?.(i)
  }, [])

  const sync = useCallback(() => {
    const a = audioRef.current, w = wavRef.current
    if (!a || !w) return
    setTime(a.currentTime)
    if (!stoppedRef.current) setSeg(segmentAt(w.starts, a.currentTime))
  }, [setSeg])

  useEffect(() => {
    const a = el()
    a.pause()
    stoppedRef.current = true
    setPlaying(false); setTime(0); setSeg(-1)
    if (wav) { a.src = wav.url; a.playbackRate = rate } else { a.removeAttribute('src'); a.load() }
    return () => { if (wav) URL.revokeObjectURL(wav.url) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wav])

  useEffect(() => {
    const a = el()
    const onEnded = () => { stoppedRef.current = true; setPlaying(false); setTime(0); a.currentTime = 0; setSeg(-1) }
    const onPause = () => { setPlaying(false); sync() }
    const onPlay  = () => setPlaying(true)
    // rAF stops ticking in background tabs — these keep position/segment
    // correct regardless (coarser, but never stale).
    a.addEventListener('ended', onEnded)
    a.addEventListener('pause', onPause)
    a.addEventListener('play',  onPlay)
    a.addEventListener('timeupdate', sync)
    a.addEventListener('seeked', sync)
    return () => {
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('play',  onPlay)
      a.removeEventListener('timeupdate', sync)
      a.removeEventListener('seeked', sync)
      a.pause()
    }
  }, [setSeg, sync])

  // Per-frame position tracking while playing (timeupdate only fires ~4x/s,
  // too coarse for line-level highlighting).
  useEffect(() => {
    if (!playing) return
    const tick = () => { sync(); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, sync])

  const play = useCallback(() => {
    const a = el()
    if (!wavRef.current) return
    const c = optsRef.current.connect
    if (c) {
      const { ctx, destination } = c()
      // createMediaElementSource may only be called once per element per context.
      if (connectedRef.current !== ctx) {
        ctx.createMediaElementSource(a).connect(destination)
        connectedRef.current = ctx
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    }
    stoppedRef.current = false
    a.play().then(sync).catch(() => setPlaying(false))
  }, [sync])

  const pause  = useCallback(() => { audioRef.current?.pause() }, [])
  const toggle = useCallback(() => { const a = audioRef.current; if (a && !a.paused) a.pause(); else play() }, [play])

  const stop = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    a.pause()
    stoppedRef.current = true
    if (wavRef.current) a.currentTime = 0
    setTime(0); setSeg(-1)
  }, [setSeg])

  const seek = useCallback((t: number) => {
    const a = audioRef.current, w = wavRef.current
    if (!a || !w) return
    stoppedRef.current = false
    a.currentTime = Math.max(0, Math.min(w.duration - 0.01, t))
    sync()
  }, [sync])

  const skip = useCallback((delta: number) => { seek((audioRef.current?.currentTime ?? 0) + delta) }, [seek])

  const prevSegment = useCallback(() => {
    const a = audioRef.current, w = wavRef.current
    if (!a || !w) return
    const cur = segmentAt(w.starts, a.currentTime)
    // Like a music player: first press restarts the current segment, a quick
    // second press (within 2s of its start) goes to the previous one.
    if (a.currentTime - w.starts[cur] > 2) { seek(w.starts[cur]); return }
    // Previous non-empty segment (failed/null ones share their start time).
    let target = cur
    while (target > 0 && w.starts[target] >= w.starts[cur]) target--
    seek(w.starts[target])
  }, [seek])

  const nextSegment = useCallback(() => {
    const a = audioRef.current, w = wavRef.current
    if (!a || !w) return
    const cur = segmentAt(w.starts, a.currentTime)
    // Skip over zero-length (failed) segments.
    for (let i = cur + 1; i < w.starts.length; i++) {
      if (w.starts[i] > w.starts[cur]) { seek(w.starts[i]); return }
    }
  }, [seek])

  const playSegment = useCallback((i: number) => {
    const w = wavRef.current
    if (!w || i < 0 || i >= w.starts.length) return
    seek(w.starts[i])
    play()
  }, [seek, play])

  const setRate = useCallback((r: number) => {
    setRateState(r)
    if (audioRef.current) audioRef.current.playbackRate = r
  }, [])

  const getTime = useCallback(() => (stoppedRef.current ? 0 : audioRef.current?.currentTime ?? 0), [])

  return {
    getTime,
    playing, time, duration: wav?.duration ?? 0, segment, segmentCount: buffers.length, rate, ready: !!wav,
    play, pause, toggle, stop, seek, skip, prevSegment, nextSegment, playSegment, setRate,
  }
}
