// Voice catalogue + TTS client for Audio and Video Overview (server side: lib/tts.js).
import { apiFetch } from '../../utils/apiFetch'
import type { AudioLine } from '../../types/notebook'

/** `host` is the name that voice speaks as, so a different voice gives the host a different
 *  name. Native-script spellings live in HOST_NAMES. */
export interface Voice { name: string; gender: 'M' | 'F'; style: string; host: string }

// Genders per Google's voice table (docs.cloud.google.com/text-to-speech/docs/chirp3-hd).
// The defaults (Charon, Kore) keep the names Arjun and Priya.
export const VOICES: Voice[] = [
  { name: 'Charon',       gender: 'M', style: 'Warm',        host: 'Arjun'   },
  { name: 'Fenrir',       gender: 'M', style: 'Energetic',   host: 'Vikram'  },
  { name: 'Puck',         gender: 'M', style: 'Upbeat',      host: 'Rahul'   },
  { name: 'Orus',         gender: 'M', style: 'Deep',        host: 'Suresh'  },
  { name: 'Iapetus',      gender: 'M', style: 'Clear',       host: 'Amit'    },
  { name: 'Rasalgethi',   gender: 'M', style: 'Informative', host: 'Rohan'   },
  { name: 'Schedar',      gender: 'M', style: 'Steady',      host: 'Manoj'   },
  { name: 'Algieba',      gender: 'M', style: 'Smooth',      host: 'Karan'   },
  { name: 'Kore',         gender: 'F', style: 'Firm',        host: 'Priya'   },
  { name: 'Aoede',        gender: 'F', style: 'Breezy',      host: 'Ananya'  },
  { name: 'Zephyr',       gender: 'F', style: 'Bright',      host: 'Neha'    },
  { name: 'Leda',         gender: 'F', style: 'Youthful',    host: 'Kavya'   },
  { name: 'Sulafat',      gender: 'F', style: 'Warm',        host: 'Sunita'  },
  { name: 'Despina',      gender: 'F', style: 'Soft',        host: 'Meera'   },
  { name: 'Gacrux',       gender: 'F', style: 'Mature',      host: 'Lakshmi' },
  { name: 'Vindemiatrix', gender: 'F', style: 'Gentle',      host: 'Pooja'   },
]

type Script = 'deva' | 'beng' | 'gujr' | 'knda' | 'mlym' | 'taml' | 'telu'
/** Which script each language writes names in (English stays Latin). */
const LANGUAGE_SCRIPT: Record<string, Script> = {
  'hi-IN': 'deva', 'mr-IN': 'deva', 'bn-IN': 'beng', 'gu-IN': 'gujr',
  'kn-IN': 'knda', 'ml-IN': 'mlym', 'ta-IN': 'taml', 'te-IN': 'telu',
}
/** Each host name per script; shown in the UI, spoken, and drawn on screen in the video. */
const HOST_NAMES: Record<string, Record<Script, string>> = {
  Arjun:   { deva: 'अर्जुन',  beng: 'অর্জুন',  gujr: 'અર્જુન',  knda: 'ಅರ್ಜುನ್', mlym: 'അർജുൻ',  taml: 'அர்ஜுன்', telu: 'అర్జున్' },
  Vikram:  { deva: 'विक्रम',  beng: 'বিক্রম',  gujr: 'વિક્રમ',  knda: 'ವಿಕ್ರಮ್', mlym: 'വിക്രം',  taml: 'விக்ரம்', telu: 'విక్రమ్' },
  Rahul:   { deva: 'राहुल',   beng: 'রাহুল',   gujr: 'રાહુલ',   knda: 'ರಾಹುಲ್',  mlym: 'രാഹുൽ',   taml: 'ராகுல்',  telu: 'రాహుల్' },
  Suresh:  { deva: 'सुरेश',   beng: 'সুরেশ',   gujr: 'સુરેશ',   knda: 'ಸುರೇಶ್',  mlym: 'സുരേഷ്',  taml: 'சுரேஷ்',  telu: 'సురేష్' },
  Amit:    { deva: 'अमित',    beng: 'অমিত',    gujr: 'અમિત',    knda: 'ಅಮಿತ್',   mlym: 'അമിത്',   taml: 'அமித்',   telu: 'అమిత్' },
  Rohan:   { deva: 'रोहन',    beng: 'রোহন',    gujr: 'રોહન',    knda: 'ರೋಹನ್',   mlym: 'രോഹൻ',    taml: 'ரோஹன்',   telu: 'రోహన్' },
  Manoj:   { deva: 'मनोज',    beng: 'মনোজ',    gujr: 'મનોજ',    knda: 'ಮನೋಜ್',   mlym: 'മനോജ്',   taml: 'மனோஜ்',   telu: 'మనోజ్' },
  Karan:   { deva: 'करण',     beng: 'করণ',     gujr: 'કરણ',     knda: 'ಕರಣ್',    mlym: 'കരൺ',     taml: 'கரண்',    telu: 'కరణ్' },
  Priya:   { deva: 'प्रिया',   beng: 'প্রিয়া',   gujr: 'પ્રિયા',   knda: 'ಪ್ರಿಯಾ',  mlym: 'പ്രിയ',   taml: 'பிரியா',  telu: 'ప్రియ' },
  Ananya:  { deva: 'अनन्या',  beng: 'অনন্যা',  gujr: 'અનન્યા',  knda: 'ಅನನ್ಯಾ',  mlym: 'അനന്യ',   taml: 'அனன்யா',  telu: 'అనన్య' },
  Neha:    { deva: 'नेहा',    beng: 'নেহা',    gujr: 'નેહા',    knda: 'ನೇಹಾ',    mlym: 'നേഹ',     taml: 'நேஹா',    telu: 'నేహా' },
  Kavya:   { deva: 'काव्या',   beng: 'কাব্যা',   gujr: 'કાવ્યા',   knda: 'ಕಾವ್ಯಾ',   mlym: 'കാവ്യ',   taml: 'காவ்யா',  telu: 'కావ్య' },
  Sunita:  { deva: 'सुनीता',   beng: 'সুনীতা',   gujr: 'સુનીતા',   knda: 'ಸುನೀತಾ',   mlym: 'സുനിത',   taml: 'சுனிதா',  telu: 'సునీత' },
  Meera:   { deva: 'मीरा',    beng: 'মীরা',    gujr: 'મીરા',    knda: 'ಮೀರಾ',    mlym: 'മീര',     taml: 'மீரா',    telu: 'మీరా' },
  Lakshmi: { deva: 'लक्ष्मी',  beng: 'লক্ষ্মী',  gujr: 'લક્ષ્મી',  knda: 'ಲಕ್ಷ್ಮಿ',  mlym: 'ലക്ഷ്മി', taml: 'லட்சுமி', telu: 'లక్ష్మి' },
  Pooja:   { deva: 'पूजा',    beng: 'পূজা',    gujr: 'પૂજા',    knda: 'ಪೂಜಾ',    mlym: 'പൂജ',     taml: 'பூஜா',    telu: 'పూజ' },
}

/** The host name for a voice, written in the given language's script. */
export function hostName(voice: string, languageCode: string): string {
  const latin = VOICES.find(v => v.name === voice)?.host ?? voice
  const script = LANGUAGE_SCRIPT[languageCode]
  return (script && HOST_NAMES[latin]?.[script]) || latin
}

/** Both hosts' names (ALEX = male voice, JORDAN = female voice) in the language's script. */
export function hostNames(maleVoice: string, femaleVoice: string, languageCode: string): { alex: string; jordan: string } {
  return { alex: hostName(maleVoice, languageCode), jordan: hostName(femaleVoice, languageCode) }
}
export const MALE_VOICES   = VOICES.filter(v => v.gender === 'M')
export const FEMALE_VOICES = VOICES.filter(v => v.gender === 'F')
export const DEFAULT_MALE_VOICE   = 'Charon'
export const DEFAULT_FEMALE_VOICE = 'Kore'

/** A saved voice that's no longer valid for that host (wrong gender / removed) falls back to the default. */
export function validVoice(v: string | undefined, gender: 'M' | 'F'): string {
  const list = gender === 'M' ? MALE_VOICES : FEMALE_VOICES
  return v && list.some(x => x.name === v) ? v : gender === 'M' ? DEFAULT_MALE_VOICE : DEFAULT_FEMALE_VOICE
}

/** Video narration is ONE voice — any voice in the catalogue, male or female. */
export function validNarratorVoice(v: string | undefined): string {
  return v && VOICES.some(x => x.name === v) ? v : DEFAULT_MALE_VOICE
}
export const voiceGender = (v: string): 'M' | 'F' => VOICES.find(x => x.name === v)?.gender ?? 'M'

/** Video Overview tones. Ids mirror VIDEO_TONES in routes/notebook.routes.js (which shapes the
 *  script); `voice` here shapes the TTS delivery. Every tone is a single narrator. */
export const VIDEO_TONES = [
  { id: 'storytelling', label: 'Human story',      hint: 'The Better India style — one place, one change, told warmly',
    voice: 'warm, sincere documentary storyteller — close and human, gentle flowing pace with natural pauses, real feeling without drama, never flat or robotic' },
  { id: 'energetic',    label: 'Upbeat explainer', hint: 'YourStory style — fast, curious, numbers-led',
    voice: 'upbeat, curious explainer narration — lively, confident pace with punch on the key numbers, warm and clear, never flat, robotic or shouty' },
  { id: 'documentary',  label: 'Documentary',      hint: 'Calm, grounded, unhurried',
    voice: 'calm, warm documentary narration — measured, unhurried pace, clear and human, never flat or robotic' },
  { id: 'news',         label: 'News report',      hint: 'Headline first, neutral',
    voice: 'crisp, authoritative TV news delivery — clear diction, steady brisk pace, neutral and confident, never sing-song or robotic' },
  { id: 'inspiring',    label: 'Inspiring',        hint: 'Uplifting, for supporters & donors',
    voice: 'uplifting, inspiring narration — warm, confident and hopeful, building energy towards the end, never over-the-top or robotic' },
] as const
export type VideoToneId = typeof VIDEO_TONES[number]['id']
export const DEFAULT_VIDEO_TONE: VideoToneId = 'storytelling'
export const validVideoTone = (t: string | undefined): VideoToneId =>
  (VIDEO_TONES.find(x => x.id === t)?.id ?? DEFAULT_VIDEO_TONE)

/** Delivery style for one turn, sent as Gemini's `style` metadata (never spoken). The
 *  script's [tone] cue leads; for video, `videoTone` picks the overall delivery. */
export function speechStyle(tone: string | undefined, languageLabel: string, kind: 'podcast' | 'narration', videoTone?: string): string {
  const accent = /english/i.test(languageLabel) ? 'a natural Indian English accent' : `natural, native ${languageLabel}`
  const base = kind === 'podcast'
    ? 'relaxed, genuine conversation between colleagues — natural rhythm, small pauses, real emotion, never flat or robotic'
    : VIDEO_TONES.find(x => x.id === validVideoTone(videoTone))!.voice
  return `${tone ? `${tone}; ` : ''}${base}; ${accent}`
}

/** Decode the server's base64 16-bit mono PCM ("audio/pcm;rate=N") into an AudioBuffer. */
export function pcmToAudioBuffer(base64: string, ctx: BaseAudioContext, mimeType = ''): AudioBuffer {
  const rate   = Number(/rate=(\d+)/.exec(mimeType)?.[1]) || 24_000
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length & ~1) // whole 16-bit samples only
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm    = new Int16Array(bytes.buffer)
  const floats = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768
  const buf = ctx.createBuffer(1, Math.max(1, floats.length), rate)
  buf.copyToChannel(floats, 0)
  return buf
}

interface TtsResponse { audioData?: string; mimeType?: string; error?: string }

async function postTts(path: string, body: unknown): Promise<Required<Pick<TtsResponse, 'audioData' | 'mimeType'>>> {
  // One retry: transient quota / network blips otherwise leave a silent gap.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await apiFetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data: TtsResponse = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (!res.ok || data.error || !data.audioData) throw new Error(data.error || `HTTP ${res.status}`)
      return { audioData: data.audioData, mimeType: data.mimeType || 'audio/pcm;rate=24000' }
    } catch (e) {
      if (attempt >= 1) throw e
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

/** Voice ONE line/turn in one voice (video narration: per-line for word sync). */
export async function synthesizeLine(ctx: BaseAudioContext, text: string, voice: string, style: string): Promise<AudioBuffer> {
  const d = await postTts('/api/notebook/tts', { text, voice, style })
  return pcmToAudioBuffer(d.audioData, ctx, d.mimeType)
}

/** Voice two-host dialogue in one call; per-line speaker tags keep ALEX male and JORDAN female. */
export async function synthesizeDialogue(
  ctx: BaseAudioContext, lines: AudioLine[], maleVoice: string, femaleVoice: string, languageLabel: string,
): Promise<AudioBuffer> {
  const d = await postTts('/api/notebook/tts-multi', {
    speakers: [{ speaker: 'Alex', voice: maleVoice }, { speaker: 'Jordan', voice: femaleVoice }],
    turns: lines.map(l => ({
      speaker: l.host === 'ALEX' ? 'Alex' : 'Jordan',
      text: l.text,
      style: speechStyle(l.tone, languageLabel, 'podcast'),
    })),
  })
  return pcmToAudioBuffer(d.audioData, ctx, d.mimeType)
}
