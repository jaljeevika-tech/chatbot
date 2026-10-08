// lib/internalCaller.js — caller check for the private Cloud Run services the monolith
// proxies to (lib/serviceProxy.js). Every /api request must carry the shared key;
// on Cloud Run (K_SERVICE set) a missing key fails closed, since anyone past IAM
// could otherwise claim any org.

import { timingSafeEqual } from 'crypto'

export function requireInternalKey(service, keyEnv) {
  const key = process.env[keyEnv] || ''
  if (!key && process.env.K_SERVICE) console.error(`[${service}] ${keyEnv} is not set — refusing all API requests`)
  const matches = given => {
    const a = Buffer.from(String(given || ''))
    const b = Buffer.from(key)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  return (req, res, next) =>
    (key ? matches(req.headers['x-internal-key']) : !process.env.K_SERVICE)
      ? next()
      : res.status(401).json({ error: 'Unauthorized caller' })
}

export const isOrgId = v => /^[0-9a-fA-F-]{36}$/.test(v)
