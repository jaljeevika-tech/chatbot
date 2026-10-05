// services/finance/src/crypto.js — decrypt-only copy of lib/crypto.js, for
// reading wa_config.access_token. This service can't import the monolith's lib/,
// so key handling and the AES-256-GCM format must stay in sync with it.

import crypto from 'crypto'

const ALGO    = 'aes-256-gcm'
const TAG_LEN = 16

let _cachedKey = null
function _getKey() {
  if (_cachedKey) return _cachedKey
  const raw = (process.env.ENCRYPTION_KEY || '').trim()
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return (_cachedKey = Buffer.from(raw, 'hex'))
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return (_cachedKey = b)
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[fm-crypto] ENCRYPTION_KEY is missing or malformed in production')
  }
  // Same local/dev-only fallback as lib/crypto.js
  const seed = (process.env.FIREBASE_PROJECT_ID || 'fieldflow') + '::ff-rotation-2026'
  return (_cachedKey = crypto.createHash('sha256').update(seed).digest())
}

export function decryptSecret(stored) {
  if (stored == null || stored === '') return stored
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored
  try {
    const [, , ivB64, payloadB64] = stored.split(':')
    const iv      = Buffer.from(ivB64, 'base64')
    const payload = Buffer.from(payloadB64, 'base64')
    const dec     = crypto.createDecipheriv(ALGO, _getKey(), iv)
    dec.setAuthTag(payload.subarray(payload.length - TAG_LEN))
    return Buffer.concat([dec.update(payload.subarray(0, payload.length - TAG_LEN)), dec.final()]).toString('utf8')
  } catch (e) {
    console.warn('[fm-crypto] decrypt failed:', e.message)
    return ''
  }
}
