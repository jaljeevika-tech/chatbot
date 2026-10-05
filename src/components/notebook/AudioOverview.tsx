import { apiFetch } from '../../utils/apiFetch'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic2, Loader2, Volume2, Sparkles, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import { useSegmentPlayer } from './useSegmentPlayer'
import { PlayerControls } from './PlayerControls'
import type { NotebookSource, AudioLine, AudioOverviewOutputData } from '../../types/notebook'
import { getMedia, putMedia, mediaSig, legacyMediaSig, encodeAudio, decodeAudio, type CachedAudio } from '../../utils/notebookMediaCache'
import { mapPool } from '../../utils/mapPool'
import { ScriptEditor } from './ScriptEditor'
import { planEditedChunks, type EditableLine } from './scriptEdits'
import { MALE_VOICES, FEMALE_VOICES, validVoice, synthesizeDialogue, hostNames as getHostNames, type Voice } from './voices'

/** Voice requests in flight at once — enough to be quick, few enough not to trip quotas. */
const TTS_CONCURRENCY = 4

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

// ── Languages ──────────────────────────────────────────────────────────────
const INDIAN_LANGUAGES = [
  { code: 'en-IN', label: 'English (India)',  native: 'Indian English' },
  { code: 'hi-IN', label: 'Hindi',            native: 'हिन्दी'         },
  { code: 'bn-IN', label: 'Bengali',          native: 'বাংলা'          },
  { code: 'gu-IN', label: 'Gujarati',         native: 'ગુજરાતી'        },
  { code: 'kn-IN', label: 'Kannada',          native: 'ಕನ್ನಡ'          },
  { code: 'ml-IN', label: 'Malayalam',        native: 'മലയാളം'         },
  { code: 'mr-IN', label: 'Marathi',          native: 'मराठी'          },
  { code: 'ta-IN', label: 'Tamil',            native: 'தமிழ்'          },
  { code: 'te-IN', label: 'Telugu',           native: 'తెలుగు'         },
]

// Host names come from the selected voices (voices.ts hostNames) — change a
// voice and that host's name changes too, in the chosen language's script.
// The script itself is always parsed via ALEX:/JORDAN: markers.

// ── Helpers ────────────────────────────────────────────────────────────────
// A line may carry a "[tone]" cue ("ALEX: [warmly] ..."); it is split off and sent
// to TTS as a style instruction rather than read aloud.
const TONE_TAG_RE = /^\[([^\]\n]{1,30})\]\s*/u
function splitTone(text: string): { text: string; tone?: string } {
  const m = text.match(TONE_TAG_RE)
  if (!m) return { text }
  return { text: text.slice(m[0].length).trim(), tone: m[1].trim().toLowerCase() }
}

function parseScript(raw: string): AudioLine[] {
  const lines: AudioLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('ALEX:'))        lines.push({ host: 'ALEX',   ...splitTone(trimmed.slice(5).trim()) })
    else if (trimmed.startsWith('JORDAN:')) lines.push({ host: 'JORDAN', ...splitTone(trimmed.slice(7).trim()) })
  }
  return lines
}

// Each chunk is one multi-speaker TTS call so turn-taking sounds natural; every
// line keeps its own speaker tag so the voices can't swap (see voices.ts).
const TTS_CHUNK_CHARS = 1200
function buildChunks(parsed: AudioLine[]): { from: number; to: number }[] {
  const chunks: { from: number; to: number }[] = []
  let start = 0, chars = 0
  for (let i = 0; i < parsed.length; i++) {
    chars += parsed[i].text.length
    if (chars >= TTS_CHUNK_CHARS || i === parsed.length - 1) {
      chunks.push({ from: start, to: i })
      start = i + 1; chars = 0
    }
  }
  return chunks
}

// ── VoiceSelect sub-component ──────────────────────────────────────────────
function VoiceSelect({
  label, value, options, disabled, onChange,
}: {
  label: string; value: string; options: Voice[]; disabled: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
      <span className="text-[9px] font-semibold uppercase tracking-wide truncate" style={{ color: '#86A0A5' }}>
        {label}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg px-2 py-1.5 text-[11px] font-medium border outline-none appearance-none cursor-pointer"
        style={{ background: C.white, color: C.dark, borderColor: '#D9E6E8' }}
      >
        {options.map(v => (
          <option key={v.name} value={v.name}>{v.host} · {v.style}</option>
        ))}
      </select>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
interface Props {
  sources: NotebookSource[]
  /** Previously-saved script + voice settings (notebook_outputs 'audio_overview'). */
  initial?: AudioOverviewOutputData
  onChange?: (data: AudioOverviewOutputData) => void
  /** IndexedDB key prefix for the synthesized audio (the notebook id). Omitted
   *  for the ephemeral document Ask AI panel — nothing is cached then. */
  cacheKey?: string
  onBusyChange?: (busy: boolean) => void
}

/** What a cached conversation was voiced from — a mismatch means stale audio. */
function audioSig(lines: AudioLine[], languageCode: string, alexVoice: string, jordanVoice: string) {
  return mediaSig({ lines, languageCode, alexVoice, jordanVoice })
}

export function AudioOverview({ sources, initial, onChange, cacheKey, onBusyChange }: Props) {
  const [language,    setLanguage]    = useState(() => INDIAN_LANGUAGES.find(l => l.code === initial?.languageCode) ?? INDIAN_LANGUAGES[0])
  const [alexVoice,   setAlexVoice]   = useState(() => validVoice(initial?.alexVoice, 'M'))
  const [jordanVoice, setJordanVoice] = useState(() => validVoice(initial?.jordanVoice, 'F'))
  const [script,      setScript]      = useState('')
  const [lines,       setLines]       = useState<AudioLine[]>(initial?.lines ?? [])
  const [editing,     setEditing]     = useState(false)
  /** Language + voices the current chunk audio was made with — reused audio after
   *  an edit is only valid if these haven't changed since. */
  const voicedWithRef = useRef('')
  // One buffer per multi-speaker chunk; each chunk's line range drives transcript highlighting.
  const [chunkBuffers, setChunkBuffers] = useState<(AudioBuffer | null)[]>([])
  const [chunkRanges,  setChunkRanges]  = useState<{ from: number; to: number }[]>(() => buildChunks(initial?.lines ?? []))
  const [generating,  setGenerating]  = useState(false)
  const [synthesizing, setSynthesizing] = useState(false)
  const [synthProgress, setSynthProgress] = useState({ done: 0, total: 0 })
  const [error,       setError]       = useState<string | null>(null)
  const [showPrompt,   setShowPrompt]   = useState(false)
  const [customPrompt, setCustomPrompt] = useState(initial?.customPrompt ?? '')
  const [restoring,    setRestoring]    = useState(() => !!cacheKey && !!initial?.lines?.length)

  const audioCtxRef   = useRef<AudioContext | null>(null)
  const isMountedRef  = useRef(true)
  const generationRef = useRef(0)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      audioCtxRef.current?.close()
    }
  }, [])

  function getAudioCtx() {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext()
    }
    return audioCtxRef.current
  }

  const player = useSegmentPlayer(chunkBuffers)
  const audioCacheKey = cacheKey ? `${cacheKey}:audio_overview` : null

  // Restore this device's cached audio for the saved script, if it still matches.
  useEffect(() => {
    if (!audioCacheKey || !initial?.lines?.length) return
    const epoch = generationRef.current
    getMedia<CachedAudio>(audioCacheKey).then(cached => {
      if (!isMountedRef.current || generationRef.current !== epoch) return
      const sig = audioSig(initial.lines, initial.languageCode, initial.alexVoice, initial.jordanVoice)
      const legacy = legacyMediaSig({ lines: initial.lines, languageCode: initial.languageCode, alexVoice: initial.alexVoice, jordanVoice: initial.jordanVoice })
      if (cached && (cached.sig === sig || cached.sig === legacy)) {
        setChunkBuffers(decodeAudio(cached, getAudioCtx()))
        if (cached.ranges?.length) setChunkRanges(cached.ranges) // chunks of an edited script
        voicedWithRef.current = `${initial.languageCode}|${initial.alexVoice}|${initial.jordanVoice}`
      }
    }).finally(() => { if (isMountedRef.current) setRestoring(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const busy = generating || synthesizing
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const hostNames = getHostNames(alexVoice, jordanVoice, language.code)

  async function generateScript() {
    if (sources.length === 0) return
    const epoch = ++generationRef.current
    setGenerating(true)
    setError(null)
    setScript('')
    setLines([])
    setChunkBuffers([])
    setChunkRanges([])
    player.stop()

    try {
      const res = await apiFetch('/api/notebook/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 30_000) })),
          languageCode:  language.code,
          languageLabel: language.label,
          host1Name: hostNames.alex,
          host2Name: hostNames.jordan,
          customPrompt,
        }),
      })
      if (!res.body) throw new Error('No stream')
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        try { const j = JSON.parse(errBody); throw new Error(j.error || `HTTP ${res.status}`) }
        catch (e2) { if (e2 instanceof SyntaxError) throw new Error(`HTTP ${res.status}`); throw e2 }
      }
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   accum   = ''
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const rawLines = buffer.split('\n')
        buffer = rawLines.pop() ?? ''
        for (const ln of rawLines) {
          const trimmed = ln.trim()
          if (!trimmed.startsWith('data: ')) continue
          const raw = trimmed.slice(6).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            const chunk = JSON.parse(raw)
            if (chunk.error) { setError(chunk.error); return }
            if (chunk.text)  { accum += chunk.text; setScript(accum) }
          } catch { /* skip */ }
        }
      }

      const parsed = parseScript(accum)
      setLines(parsed)
      if (parsed.length > 0) {
        // Auto-save the script as soon as it exists, so it survives even if
        // voice synthesis is interrupted.
        if (generationRef.current === epoch) onChange?.({ lines: parsed, languageCode: language.code, alexVoice, jordanVoice, customPrompt })
        await synthesizeConversation(parsed, epoch)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  /** Synthesize the dialogue as conversational chunks (Gemini 3.8 TTS, each
   *  line speaker-tagged so voices never swap). Epoch-guarded so a Regenerate
   *  mid-synthesis can't stomp the new run's buffers. */
  const synthesizeConversation = useCallback(async (
    parsed: AudioLine[], epoch = generationRef.current,
    /** After a user edit: the chunk plan + audio reused from untouched chunks (null = voice it). */
    plan?: { chunks: { from: number; to: number }[]; reuse: (AudioBuffer | null)[] },
  ) => {
    const live = () => isMountedRef.current && generationRef.current === epoch
    const chunks = plan?.chunks ?? buildChunks(parsed)
    const buffers: (AudioBuffer | null)[] = plan ? [...plan.reuse] : new Array<AudioBuffer | null>(chunks.length).fill(null)
    const todo = chunks.map((ch, ci) => ({ ch, ci })).filter(({ ci }) => !buffers[ci])
    setSynthesizing(true)
    setSynthProgress({ done: 0, total: todo.length })

    const ctx = getAudioCtx()
    let done = 0
    let lastErr = ''

    await mapPool(todo, TTS_CONCURRENCY, async ({ ch, ci }) => {
      if (!live()) return
      try {
        buffers[ci] = await synthesizeDialogue(ctx, parsed.slice(ch.from, ch.to + 1), alexVoice, jordanVoice, language.label)
      } catch (e) {
        lastErr = e instanceof Error ? e.message : 'synthesis failed'
        console.warn(`TTS failed for chunk ${ci}:`, e)
      }
      done++
      if (live()) setSynthProgress({ done, total: todo.length })
    })

    if (live()) {
      // Cache before clearing `synthesizing` — a background notebook is
      // unmounted as soon as it stops being busy. Ranges are stored too: an
      // edited script's chunks don't follow buildChunks().
      if (audioCacheKey && buffers.some(Boolean)) {
        await putMedia(audioCacheKey, { ...encodeAudio(audioSig(parsed, language.code, alexVoice, jordanVoice), buffers), ranges: chunks })
      }
      if (!live()) return
      voicedWithRef.current = `${language.code}|${alexVoice}|${jordanVoice}`
      setChunkBuffers(buffers)
      setChunkRanges(chunks)
      setSynthesizing(false)
      if (buffers.every(b => !b)) setError(lastErr ? `Voice synthesis failed: ${lastErr}` : 'Voice synthesis failed')
    }
  }, [language, alexVoice, jordanVoice, audioCacheKey])

  /** Apply the user's script edits: save the new script, then re-voice only the
   *  changed parts — untouched chunks keep their audio (unless the language or
   *  voices changed since they were made, in which case everything is re-voiced). */
  async function saveEdits(edited: EditableLine[]) {
    setEditing(false)
    const epoch = ++generationRef.current
    setError(null)
    player.stop()
    const next: AudioLine[] = edited.map(({ origIdx: _o, ...l }) => l)
    const sameVoices = voicedWithRef.current === `${language.code}|${alexVoice}|${jordanVoice}`
    const plan = planEditedChunks(edited, lines, chunkRanges, sameVoices ? chunkBuffers : [], TTS_CHUNK_CHARS)
    setLines(next)
    onChange?.({ lines: next, languageCode: language.code, alexVoice, jordanVoice, customPrompt })
    await synthesizeConversation(next, epoch, plan)
  }

  /** Saved script, but no audio on this device (other device / cache cleared)
   *  or the voices were changed since — voice it again without rewriting it. */
  async function resynthesize() {
    const epoch = ++generationRef.current
    setError(null)
    player.stop()
    onChange?.({ lines, languageCode: language.code, alexVoice, jordanVoice, customPrompt })
    await synthesizeConversation(lines, epoch)
  }

  const noSources   = sources.length === 0
  const isLoading   = generating || synthesizing || restoring
  const readyToPlay = chunkBuffers.some(Boolean) && lines.length > 0 && !synthesizing

  // Which transcript lines belong to the chunk currently playing (for highlight).
  const currentChunk = player.segment
  const activeRange = currentChunk >= 0 ? chunkRanges[currentChunk] : undefined

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-3">

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#86A0A5' }}>
          Podcast Language
        </label>
        <select
          value={language.code}
          onChange={e => setLanguage(INDIAN_LANGUAGES.find(l => l.code === e.target.value)!)}
          disabled={isLoading}
          className="w-full rounded-xl px-3 py-2 text-xs font-medium border outline-none appearance-none cursor-pointer"
          style={{ background: C.white, color: C.dark, borderColor: '#D9E6E8' }}
        >
          {INDIAN_LANGUAGES.map(l => (
            <option key={l.code} value={l.code}>{l.label} — {l.native}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#86A0A5' }}>
          Host Voices
        </span>
        <div className="flex gap-2">
          <VoiceSelect
            label={`Host 1 · ${hostNames.alex}`}
            value={alexVoice}
            options={MALE_VOICES}
            disabled={isLoading}
            onChange={setAlexVoice}
          />
          <VoiceSelect
            label={`Host 2 · ${hostNames.jordan}`}
            value={jordanVoice}
            options={FEMALE_VOICES}
            disabled={isLoading}
            onChange={setJordanVoice}
          />
        </div>
      </div>

      <button
        onClick={() => setShowPrompt(v => !v)}
        className="w-full flex items-center gap-1.5 text-[11px] font-semibold transition-all"
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
          placeholder="Focus on a specific theme, target a particular audience, or set the tone…"
          rows={3}
          disabled={isLoading}
          className="w-full text-[11px] rounded-xl px-3 py-2 resize-none outline-none"
          style={{ background: C.bg, color: '#374151', border: '1.5px solid #D9E6E8' }}
        />
      )}

      <SubscriptionGate featureName="AI Audio Overview">
      <button
        onClick={generateScript}
        disabled={isLoading || noSources}
        className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all"
        style={{
          background: noSources || isLoading ? '#D9E6E8' : C.dark,
          color:      noSources || isLoading ? '#86A0A5' : C.white,
        }}
      >
        {generating   ? <><Loader2 className="w-4 h-4 animate-spin" />Writing script…</>
         : synthesizing ? <><Loader2 className="w-4 h-4 animate-spin" />Synthesizing voices… {synthProgress.done}/{synthProgress.total}</>
         : restoring    ? <><Loader2 className="w-4 h-4 animate-spin" />Loading saved podcast…</>
         : <><Mic2 className="w-4 h-4" />{lines.length > 0 ? 'Regenerate Podcast' : 'Generate Podcast'}</>}
      </button>
      </SubscriptionGate>

      {/* Saved script without audio on this device — voice it again (TTS only). */}
      {lines.length > 0 && !chunkBuffers.some(Boolean) && !isLoading && (
        <button
          onClick={resynthesize}
          className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all"
          style={{ background: C.white, color: C.dark, border: '1.5px solid #D9E6E8' }}
        >
          <Volume2 className="w-3.5 h-3.5" />Synthesize Audio for Saved Script
        </button>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {readyToPlay && (
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: C.dark }}>
          <div className="min-w-0">
            <p className="text-xs font-bold text-white flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.85)' }} />
              Audio Overview
            </p>
            <p className="text-[11px] text-white/50">
              {currentChunk >= 0
                ? `${player.playing ? 'Playing' : 'Paused'} · part ${currentChunk + 1} / ${chunkBuffers.length}`
                : `${lines.length} lines · ${language.native} · ${hostNames.alex} & ${hostNames.jordan}`}
            </p>
          </div>
          <PlayerControls player={player} accent={C.white} accentInk="#000" segmentLabel="part" />
        </div>
      )}

      {/* Script editor (after generation) — replaces the transcript while open */}
      {editing && lines.length > 0 && (
        <ScriptEditor lines={lines} hostNames={hostNames} onSave={saveEdits} onCancel={() => setEditing(false)} />
      )}

      {!editing && (script || lines.length > 0) && (
        <div className="flex-1 overflow-auto space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#86A0A5' }}>
              Transcript
            </p>
            {lines.length > 0 && !isLoading && (
              <button
                onClick={() => { player.stop(); setEditing(true) }}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold"
                style={{ background: C.white, color: C.dark, border: '1.5px solid #D9E6E8' }}
              >
                <Pencil className="w-3 h-3" />Edit script
              </button>
            )}
          </div>
          {lines.length > 0
            ? lines.map((line, i) => {
                const displayName = line.host === 'ALEX' ? hostNames.alex : hostNames.jordan
                const active = !!activeRange && i >= activeRange.from && i <= activeRange.to
                const chunkIdx = chunkRanges.findIndex(r => i >= r.from && i <= r.to)
                const seekable = readyToPlay && chunkIdx >= 0
                return (
                  <div
                    key={i}
                    onClick={seekable ? () => player.playSegment(chunkIdx) : undefined}
                    title={seekable ? 'Play from here' : undefined}
                    className={`p-3 rounded-xl text-xs leading-relaxed transition-all ${seekable ? 'cursor-pointer hover:brightness-95' : ''}`}
                    style={{
                      background: active ? C.lime + '33' : C.white,
                      borderLeft: active ? `3px solid ${C.lime}` : '3px solid transparent',
                    }}
                  >
                    <span
                      className="font-black text-[10px] mr-2"
                      style={{ color: line.host === 'ALEX' ? C.dark : C.sidebar }}
                    >
                      {displayName}
                    </span>
                    {line.text}
                  </div>
                )
              })
            : (
              <pre className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: '#374151' }}>
                {script}
              </pre>
            )}
        </div>
      )}

      {!script && lines.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center">
          <Mic2 className="w-8 h-8" style={{ color: C.lime }} />
          <p className="text-xs font-semibold" style={{ color: C.dark }}>Two-host podcast overview</p>
          <p className="text-[11px]" style={{ color: '#86A0A5' }}>
            {hostNames.alex} & {hostNames.jordan} discuss key insights<br />using Gemini AI voices
          </p>
        </div>
      )}
    </div>
  )
}
