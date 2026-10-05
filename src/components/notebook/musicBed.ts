// Background music for Video Overview, synthesized offline (no audio files or licensing)
// into a seamless loop: 'story' is a gently moving I–V–vi–IV score, 'ambient' a plain pad.

export type MusicKind = 'story' | 'ambient'

const LOOP_SECONDS = 32 // 4 chords × 8s
// Cmaj9 → Am7 → Fmaj7 → G6 (warm, unresolved, loops cleanly back to C)
const CHORDS: number[][] = [
  [48, 55, 59, 62, 64],
  [45, 52, 55, 60, 64],
  [41, 48, 52, 57, 60],
  [43, 50, 55, 59, 64],
]
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

/** Gain applied to the bed when mixed under narration (ambient pad). */
export const MUSIC_GAIN = 0.07
/** The story score is meant to be heard, still well under the voice: the loop
 *  measures ≈ -36 dBFS RMS (sparse plucks), so 0.4 puts it near -44 dBFS RMS —
 *  about 24 dB under typical narration, peaks around -24 dBFS. */
export const STORY_MUSIC_GAIN = 0.4
export const musicGain = (kind: MusicKind) => (kind === 'story' ? STORY_MUSIC_GAIN : MUSIC_GAIN)

const loops = new Map<MusicKind, Promise<AudioBuffer>>()

/** One seamless loop at 48kHz per kind, cached for the session. */
export function getMusicLoop(kind: MusicKind = 'story'): Promise<AudioBuffer> {
  let p = loops.get(kind)
  if (!p) {
    p = (kind === 'story' ? renderStoryLoop() : renderLoop()).catch(e => { loops.delete(kind); throw e })
    loops.set(kind, p)
  }
  return p
}

/** Fold a render's overhang (the last notes' release) back onto its start so the loop is seamless. */
function foldLoop(full: AudioBuffer, loopSeconds: number): AudioBuffer {
  const loopLen = Math.ceil(loopSeconds * full.sampleRate)
  const out = new AudioBuffer({ numberOfChannels: 2, length: loopLen, sampleRate: full.sampleRate })
  for (let ch = 0; ch < 2; ch++) {
    const src = full.getChannelData(ch), dst = out.getChannelData(ch)
    dst.set(src.subarray(0, loopLen))
    for (let i = 0; i < full.length - loopLen && i < loopLen; i++) dst[i] += src[loopLen + i]
  }
  return out
}

async function renderStoryLoop(): Promise<AudioBuffer> {
  const rate = 48000, bpm = 92, beat = 60 / bpm, bar = beat * 4
  // C → G → Am → F, two bars each; voiced close and warm.
  const prog: number[][] = [[48, 55, 60, 64, 67], [43, 50, 55, 59, 62], [45, 52, 57, 60, 64], [41, 48, 53, 57, 60]]
  const barsPerChord = 2
  const loopSeconds = prog.length * barsPerChord * bar
  const ctx = new OfflineAudioContext(2, Math.ceil((loopSeconds + 4) * rate), rate)
  const master = ctx.createGain(); master.gain.value = 0.6
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 0.5
  lp.connect(master); master.connect(ctx.destination)

  const voice = (m: number, t0: number, dur: number, peak: number, type: OscillatorType, pan: number, attack = 0.004) => {
    const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = midiHz(m)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(peak, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    const p = ctx.createStereoPanner(); p.pan.value = pan
    osc.connect(g); g.connect(p); p.connect(lp)
    osc.start(t0); osc.stop(t0 + dur + 0.05)
  }
  // Soft noise for the off-beat shaker.
  const noise = ctx.createBuffer(1, Math.ceil(rate * 0.08), rate)
  { const d = noise.getChannelData(0); let seed = 7; for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1 } }
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000; hp.connect(master)

  const ARP = [0, 2, 1, 3, 2, 4, 3, 2] // eighth-note pattern through the chord tones
  prog.forEach((notes, ci) => {
    const c0 = ci * barsPerChord * bar
    // Pad: the chord held softly underneath.
    for (const m of notes.slice(0, 3)) voice(m, c0, barsPerChord * bar + 1.2, 0.022, 'triangle', m % 2 ? 0.25 : -0.25, 0.9)
    for (let b = 0; b < barsPerChord; b++) {
      const b0 = c0 + b * bar
      // Round bass on the downbeat.
      voice(notes[0] - 12, b0, bar * 0.95, 0.11, 'sine', 0, 0.01)
      // Plucked arpeggio an octave up (sine + a little triangle = soft piano/marimba).
      ARP.forEach((k, e) => {
        const t = b0 + e * (beat / 2)
        const m = notes[Math.min(k, notes.length - 1)] + 12
        voice(m, t, 0.9, 0.05, 'sine', e % 2 ? 0.3 : -0.3)
        voice(m, t, 0.35, 0.012, 'triangle', e % 2 ? 0.3 : -0.3)
      })
      // Soft pulse on beats 1 and 3 — a heartbeat, not a drum kit.
      for (const q of [0, 2]) {
        const t = b0 + q * beat
        const osc = ctx.createOscillator(); osc.type = 'sine'
        osc.frequency.setValueAtTime(72, t); osc.frequency.exponentialRampToValueAtTime(44, t + 0.18)
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32)
        osc.connect(g); g.connect(master); osc.start(t); osc.stop(t + 0.35)
      }
      // Off-beat shaker, barely there.
      for (let e = 1; e < 8; e += 2) {
        const t = b0 + e * (beat / 2)
        const src = ctx.createBufferSource(); src.buffer = noise
        const g = ctx.createGain(); g.gain.setValueAtTime(0.012, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
        src.connect(g); g.connect(hp); src.start(t); src.stop(t + 0.08)
      }
    }
  })
  return foldLoop(await ctx.startRendering(), loopSeconds)
}

async function renderLoop(): Promise<AudioBuffer> {
  const rate = 48000
  // Render one extra chord's worth so the tail of the last chord can be folded
  // back onto the start — that's what makes the loop seamless.
  const ctx = new OfflineAudioContext(2, Math.ceil((LOOP_SECONDS + 8) * rate), rate)
  const master = ctx.createGain(); master.gain.value = 0.5
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.4
  lp.connect(master); master.connect(ctx.destination)

  const chordLen = LOOP_SECONDS / CHORDS.length
  CHORDS.forEach((notes, ci) => {
    const t0 = ci * chordLen
    notes.forEach((m, ni) => {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator()
        osc.type = ni === 0 ? 'sine' : 'triangle'
        osc.frequency.value = midiHz(m)
        osc.detune.value = detune
        const g = ctx.createGain()
        const peak = (ni === 0 ? 0.16 : 0.07) / 2
        g.gain.setValueAtTime(0, t0)
        g.gain.linearRampToValueAtTime(peak, t0 + 2.5)
        g.gain.setValueAtTime(peak, t0 + chordLen - 0.5)
        g.gain.linearRampToValueAtTime(0, t0 + chordLen + 3)
        const pan = ctx.createStereoPanner(); pan.pan.value = (ni % 2 ? 0.35 : -0.35) * (detune > 0 ? 1 : -1)
        osc.connect(g); g.connect(pan); pan.connect(lp)
        osc.start(t0); osc.stop(t0 + chordLen + 3.2)
      }
    })
  })

  // Fold the overhang (last chord's release) onto the loop start.
  return foldLoop(await ctx.startRendering(), LOOP_SECONDS)
}

/** Offline mix for the MP4: narration lines at their timeline offsets, the
 *  music bed (optional) faded in/out underneath, and `tail` seconds of hold. */
export async function mixNarration(
  lines: (AudioBuffer | null)[], starts: number[], total: number, tail: number, music: MusicKind | null,
): Promise<AudioBuffer> {
  const rate = 48000
  const len = Math.ceil((total + tail) * rate)
  const ctx = new OfflineAudioContext(2, Math.max(1, len), rate)
  lines.forEach((b, i) => {
    if (!b) return
    const src = ctx.createBufferSource(); src.buffer = b
    src.connect(ctx.destination); src.start(starts[i])
  })
  if (music) {
    const loop = await getMusicLoop(music)
    const gain = musicGain(music)
    const src = ctx.createBufferSource(); src.buffer = loop; src.loop = true
    const g = ctx.createGain()
    const end = total + tail
    g.gain.setValueAtTime(0, 0)
    g.gain.linearRampToValueAtTime(gain * 1.5, 1.2)               // a touch louder under the opening
    g.gain.linearRampToValueAtTime(gain, 3.5)
    g.gain.setValueAtTime(gain, Math.max(3.5, total - 1))
    g.gain.linearRampToValueAtTime(gain * 1.6, Math.max(3.6, total + 0.3)) // swell into the end card
    g.gain.linearRampToValueAtTime(0, end)
    src.connect(g); g.connect(ctx.destination); src.start(0); src.stop(end)
  }
  return ctx.startRendering()
}
