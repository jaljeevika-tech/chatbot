// lib/glific.js — Glific webhook signature verification

import crypto from 'crypto'

// ── Signature verification ────────────────────────────────────────────────────
// Glific sends X-Glific-Signature: sha256=<hmac> on every webhook call
export function verifyGlificSignature(payload, signature, secret) {
  if (!secret || !signature) return false
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex')
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}
