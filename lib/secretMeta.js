// lib/secretMeta.js — which organizations.metadata keys are secrets, and how to
// hide / encrypt them.

import { encryptSecret, decryptSecret } from './crypto.js'

export const SECRET_META_KEY_RE = /(secret|token|password|api_?key|private_?key)/i
export const SECRET_MASK = '••••••••'

/** Drops secret keys entirely — for org-facing responses (any role can GET /org/metadata). */
export function stripSecretMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata
  const out = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (SECRET_META_KEY_RE.test(k)) continue
    out[k] = v
  }
  return out
}

/** Replaces each secret with SECRET_MASK — for super admin responses. */
export function maskSecretMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata
  const out = {}
  for (const [k, v] of Object.entries(metadata)) {
    out[k] = SECRET_META_KEY_RE.test(k) ? (v ? SECRET_MASK : '') : v
  }
  return out
}

/** Returns a patch safe to `metadata || patch`: SECRET_MASK means "keep stored", real values are encrypted. */
export function prepareSecretPatch(patch) {
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (!SECRET_META_KEY_RE.test(k)) { out[k] = v; continue }
    if (v === SECRET_MASK) continue
    out[k] = typeof v === 'string' && v ? encryptSecret(v.trim()) : ''
  }
  return out
}

/** Deep redaction for audit diffs — any key that looks secret becomes '[redacted]'. */
export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_META_KEY_RE.test(k) && v ? '[redacted]' : redactDeep(v)
  }
  return out
}

/** Legacy plaintext values pass through decryptSecret unchanged. */
export function readMetaSecret(metadata, key) {
  return decryptSecret(metadata?.[key] || '')
}
