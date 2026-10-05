// Gemini text-to-speech for Notebook podcasts and video narration.
// Primary: Gemini 3.8 Flash TTS (Interactions API). Each segment carries its own
// speaker + style as speech_metadata, so voices can't swap between hosts and style
// cues are never read aloud; language is auto-detected.
// Fallback: Gemini 2.5 Pro TTS per segment, PCM concatenated (still one voice per call).
// Output: headerless 16-bit mono PCM (base64) + sample rate, for the client's pcmToAudioBuffer().
// Docs: https://ai.google.dev/gemini-api/docs/speech-generation

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts'
const LEGACY_TTS_MODEL = 'gemini-2.5-pro-preview-tts'
const DEFAULT_RATE = 24_000

/**
 * @typedef {{ text: string, speaker?: string, style?: string }} Segment
 * @param {string} apiKey
 * @param {{ segments: Segment[], voices: Record<string, string> | string, signal?: AbortSignal }} opts
 *   voices: a single voice name (single speaker) or { speakerName: voiceName } (conversation, max 2)
 * @returns {Promise<{ audioData: string, mimeType: string, model: string }>}
 */
export async function synthesizeSpeech(apiKey, { segments, voices, signal }) {
  const clean = (segments || []).filter(s => s && String(s.text || '').trim())
  if (!clean.length) throw new Error('No text to synthesize')

  let primaryErr
  try {
    const pcm = await synthesizeV38(apiKey, clean, voices, signal)
    return packPcm(pcm.bytes, pcm.rate, TTS_MODEL)
  } catch (e) {
    if (signal?.aborted) throw e
    primaryErr = e
    console.warn(`[tts] ${TTS_MODEL} failed, falling back to ${LEGACY_TTS_MODEL}: ${e.message}`)
  }

  try {
    const parts = []
    for (const seg of clean) {
      parts.push(await synthesizeLegacy(apiKey, seg.text, voiceFor(voices, seg.speaker), seg.style, signal))
    }
    return packPcm(Buffer.concat(parts), DEFAULT_RATE, LEGACY_TTS_MODEL)
  } catch (e) {
    throw new Error(`Voice synthesis failed (${TTS_MODEL}: ${primaryErr?.message}; ${LEGACY_TTS_MODEL}: ${e.message})`)
  }
}

function voiceFor(voices, speaker) {
  if (typeof voices === 'string') return voices
  return voices?.[speaker] || Object.values(voices || {})[0] || 'Charon'
}

function packPcm(bytes, rate, model) {
  return { audioData: bytes.toString('base64'), mimeType: `audio/pcm;rate=${rate}`, model }
}

// ── Gemini 3.8 TTS (Interactions API) ────────────────────────────────────────
async function synthesizeV38(apiKey, segments, voices, signal) {
  const multi = typeof voices !== 'string'
  const speechConfig = multi
    ? {
        mode: 'conversational',
        speakers: Object.entries(voices).slice(0, 2).map(([speaker, voice]) => ({ speaker, voice })),
      }
    : [{ voice: voices }]

  const res = await fetch(`${API_BASE}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [{
        type: 'user_input',
        content: segments.map(s => {
          const meta = {
            ...(multi && s.speaker ? { speaker: s.speaker } : {}),
            ...(s.style ? { style: s.style } : {}),
          }
          return {
            type: 'text',
            text: s.text,
            ...(Object.keys(meta).length ? { annotations: [{ type: 'speech_metadata', ...meta }] } : {}),
          }
        }),
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: speechConfig },
    }),
    signal: combineSignals(signal, 120_000),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`)

  const audio = (data?.steps || [])
    .filter(st => st?.type === 'model_output')
    .flatMap(st => st.content || [])
    .filter(c => c?.type === 'audio' && c.data)
    .pop()?.data || data?.output_audio?.data
  if (!audio) throw new Error('No audio in response')
  return wavToPcm(Buffer.from(audio, 'base64'))
}

/** 3.8 returns a RIFF/WAV file; strip the header so the client gets raw PCM.
 *  Walks the chunk list rather than assuming a 44-byte header. */
function wavToPcm(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { bytes: buf, rate: DEFAULT_RATE } // already headerless PCM
  }
  let rate = DEFAULT_RATE
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12)
    if (id === 'data') return { bytes: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)), rate }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV response had no data chunk')
}

// ── Legacy Gemini 2.5 TTS (generateContent) ──────────────────────────────────
async function synthesizeLegacy(apiKey, text, voice, style, signal) {
  // 2.5 has no style field — the cue rides in the text as a "Say …:" instruction.
  const synthText = style ? `Say in a ${style} way: ${text}` : text
  const res = await fetch(`${API_BASE}/models/${LEGACY_TTS_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: synthText }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: combineSignals(signal, 90_000),
  })
  const data = await res.json().catch(() => null)
  const audio = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data
  if (!audio) throw new Error(data?.error?.message || `No audio returned (HTTP ${res.status})`)
  return Buffer.from(audio, 'base64')
}

function combineSignals(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
