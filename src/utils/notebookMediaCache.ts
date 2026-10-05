// IndexedDB cache for notebook media too large for notebook_outputs (narration audio,
// segment images), so a reopened notebook skips re-paying for TTS/image generation.
// Entries carry a `sig` of their inputs so stale ones are ignored; all calls are best-effort.

const DB_NAME = 'ff_notebook_media'
const STORE   = 'media'

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onsuccess = () => resolve(req.result)
      req.onerror   = () => { dbPromise = null; reject(req.error) }
    })
  }
  return dbPromise
}

export async function getMedia<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror   = () => resolve(null)
    })
  } catch { return null }
}

export async function putMedia(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => resolve()
    })
  } catch { /* cache is best-effort */ }
}

/** Drop every cached entry for a deleted notebook (keys are `${notebookId}:…`). */
export async function deleteNotebookMedia(notebookId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(IDBKeyRange.bound(`${notebookId}:`, `${notebookId}:${String.fromCharCode(0xffff)}`))
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => resolve()
    })
  } catch { /* best-effort */ }
}

const hashString = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${(h >>> 0).toString(36)}`
}
/** The signature caches were written with before mediaSig became key-order
 *  independent — still accepted on restore so existing caches stay usable. */
export function legacyMediaSig(value: unknown): string { return hashString(JSON.stringify(value)) }

/** Short stable hash of whatever the media was generated from. */
export function mediaSig(value: unknown): string {
  // Key-order independent: JSONB (notebook_outputs) returns object keys in its
  // own order, so the saved script must hash the same as the one generated.
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
    : v
  const s = JSON.stringify(canon(value))
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${(h >>> 0).toString(36)}`
}

// Audio ↔ storable PCM

export interface CachedAudio {
  sig: string
  sampleRate: number
  /** Mono 16-bit PCM per segment; null where synthesis failed. */
  segments: (ArrayBuffer | null)[]
  /** Podcast only: transcript lines per segment, since user edits break the default chunking. */
  ranges?: { from: number; to: number }[]
}

export function encodeAudio(sig: string, buffers: (AudioBuffer | null)[]): CachedAudio {
  const first = buffers.find(Boolean)
  return {
    sig,
    sampleRate: first?.sampleRate ?? 24000,
    segments: buffers.map(b => {
      if (!b) return null
      const ch  = b.getChannelData(0)
      const pcm = new Int16Array(ch.length)
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      return pcm.buffer
    }),
  }
}

export function decodeAudio(cached: CachedAudio, ctx: BaseAudioContext): (AudioBuffer | null)[] {
  return cached.segments.map(seg => {
    if (!seg) return null
    const pcm = new Int16Array(seg)
    const floats = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768
    const buf = ctx.createBuffer(1, Math.max(1, floats.length), cached.sampleRate)
    buf.copyToChannel(floats, 0)
    return buf
  })
}
