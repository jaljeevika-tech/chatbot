// AES-256-GCM helpers for at-rest secrets (e.g. wa_config.access_token).
// Key: ENCRYPTION_KEY (32 bytes, hex or base64); a derived fallback exists for dev only.
// Format `enc:v1:<base64(iv)>:<base64(ciphertext+authTag)>`; anything not starting
// with `enc:` is legacy plaintext, returned as-is and encrypted on next write.

import crypto from 'crypto'

const ALGO    = 'aes-256-gcm'
const IV_LEN  = 12   // standard GCM nonce length
const TAG_LEN = 16

function _key() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim()
  if (raw) {
    // Accept hex (64 chars) or base64
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return b
  }
  // In production a missing/malformed key must fail loudly rather than fall back
  // to a guessable key; the fallback below is for local dev only.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[crypto] ENCRYPTION_KEY is missing or malformed in production. ' +
      'Set a 32-byte key (64 hex chars or base64) via Secret Manager — ' +
      'see lib/secretManager.js. Refusing to fall back to a weak derived key.'
    )
  }
  // Fallback (local/dev only) — deterministic key derived from project id + static salt
  const seed = (process.env.FIREBASE_PROJECT_ID || 'fieldflow') + '::ff-rotation-2026'
  return crypto.createHash('sha256').update(seed).digest()
}

// Lazy: ESM imports evaluate before server.js awaits loadSecretsFromManager(), so a
// top-level key would lock in the fallback before ENCRYPTION_KEY is loaded.
let _cachedKey = null
function _getKey() {
  if (!_cachedKey) _cachedKey = _key()
  return _cachedKey
}

export function encryptSecret(plain) {
  if (plain == null || plain === '') return plain
  if (typeof plain === 'string' && plain.startsWith('enc:v1:')) return plain
  const iv     = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, _getKey(), iv)
  const ct     = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`
}

export function decryptSecret(stored) {
  if (stored == null || stored === '') return stored
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) {
    // Legacy plaintext value — return as-is so old rows still work
    return stored
  }
  try {
    const [, , ivB64, payloadB64] = stored.split(':')
    const iv      = Buffer.from(ivB64, 'base64')
    const payload = Buffer.from(payloadB64, 'base64')
    const ct      = payload.subarray(0, payload.length - TAG_LEN)
    const tag     = payload.subarray(payload.length - TAG_LEN)
    const dec     = crypto.createDecipheriv(ALGO, _getKey(), iv)
    dec.setAuthTag(tag)
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8')
  } catch (e) {
    console.warn('[crypto] decrypt failed:', e.message, '— returning empty string')
    return ''
  }
}
