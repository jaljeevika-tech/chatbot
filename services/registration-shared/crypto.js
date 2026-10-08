// services/registration-shared/crypto.js — field-level PII encryption for
// the registration services' write paths (POST /api/register).
//
// Deliberately not lib/piiCrypto.js: that one falls back to a derived dev key
// when ENCRYPTION_KEY is missing outside NODE_ENV=production, and these public
// forms must never encrypt with a guessable key — here a missing key always throws.
// Same AES-256-GCM format (enc:v1:<iv>:<ciphertext+tag>) and same HMAC-derived
// blind-index scheme as lib/piiCrypto.js, so the two stay interoperable
// (ENCRYPTION_KEY must be the SAME value as the monolith's — both read it from
// GCP Secret Manager's ENCRYPTION_KEY secret).
//
// DPDP Phase 4: contact_no is both encrypted (contact_no_enc, randomized
// IV, safe at rest) AND hashed (contact_no_hash, deterministic HMAC) — the
// duplicate-registration check below needs an exact-match lookup, which a
// randomized-IV ciphertext can never support. current_income_inr and
// panchayat are encrypted with no matching hash column since nothing
// queries them for exact-match equality.

import crypto from 'crypto'

const ALGO   = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function _key() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  const b = Buffer.from(raw, 'base64')
  if (b.length === 32) return b
  throw new Error('[crypto] ENCRYPTION_KEY is missing or malformed — set a 32-byte key (64 hex chars or base64) via Secret Manager')
}

export function encryptPii(value) {
  if (value === null || value === undefined || value === '') return null
  const iv     = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, _key(), iv)
  const ct     = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`
}

export function decryptPii(stored) {
  if (stored == null || stored === '' || !String(stored).startsWith('enc:v1:')) return stored
  try {
    const [, , ivB64, payloadB64] = String(stored).split(':')
    const iv      = Buffer.from(ivB64, 'base64')
    const payload = Buffer.from(payloadB64, 'base64')
    const ct      = payload.subarray(0, payload.length - TAG_LEN)
    const tag     = payload.subarray(payload.length - TAG_LEN)
    const dec     = crypto.createDecipheriv(ALGO, _key(), iv)
    dec.setAuthTag(tag)
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8')
  } catch (e) {
    console.warn('[crypto] decrypt failed:', e.message)
    return ''
  }
}

function _hashKey() {
  const base = (process.env.ENCRYPTION_KEY || '').trim()
  if (!base) throw new Error('[crypto] ENCRYPTION_KEY is missing — cannot compute contact_no_hash')
  return crypto.createHmac('sha256', base).update('fieldflow:contact_no_hash:v1').digest()
}

export function hashContactNo(value) {
  if (!value) return null
  return crypto.createHmac('sha256', _hashKey()).update(String(value).trim()).digest('hex')
}
