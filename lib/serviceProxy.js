// lib/serviceProxy.js — Strangler-Fig proxy from the monolith to a private Cloud Run
// service whose router the monolith can also run in-process (finance, dashboard).
//
// URL env unset or breaker open → next() (in-process). GETs fall back on any failure;
// writes fall back only when the service was never reached (connection refused / DNS).
// A write that fails mid-flight returns 502, because it may already have committed upstream.

import { CircuitBreaker } from './circuitBreaker.js'

const NOT_REACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'])

async function getCloudRunIdToken(audience) {
  try {
    const metaRes = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
    )
    if (metaRes.ok) return await metaRes.text()
  } catch { /* not on GCP — local dev */ }
  return null
}

/**
 * @param {object} o
 * @param {string} o.name      log / breaker name, e.g. 'finance'
 * @param {string} o.label     user-facing name in the 502 message, e.g. 'Finance'
 * @param {string} o.urlEnv    env var holding the service URL
 * @param {string} o.keyEnv    env var holding the shared x-internal-key
 * @param {(req) => object} o.identity  server-verified identity headers (x-org-id, …)
 */
export function serviceProxy({ name, label, urlEnv, keyEnv, identity }) {
  const cb = new CircuitBreaker(`${name}-service`)
  return async function proxy(req, res, next) {
    const SERVICE_URL = process.env[urlEnv]
    if (!SERVICE_URL || cb.isOpen) return next()
    const isRead = req.method === 'GET'
    try {
      await cb.call(async () => {
        const idToken = await getCloudRunIdToken(SERVICE_URL)
        // originalUrl keeps the query string, which req.path drops.
        const upstreamRes = await fetch(`${SERVICE_URL.replace(/\/$/, '')}${req.originalUrl}`, {
          method:  req.method,
          headers: {
            'Content-Type':     'application/json',
            'x-correlation-id': req.correlationId || '',
            'x-forwarded-by':   'fieldflow-monolith',
            'x-internal-key':   process.env[keyEnv] || '',
            ...identity(req),
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body:   isRead ? undefined : JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(isRead ? 20_000 : 45_000),
        })
        // Infra-level failure on a read: count it and serve locally instead.
        if (isRead && upstreamRes.status >= 502) throw new Error(`upstream ${upstreamRes.status}`)
        const data = await upstreamRes.json().catch(() => ({ error: `${label} service error ${upstreamRes.status}` }))
        res.status(upstreamRes.status).json(data)
      })
    } catch (e) {
      if (res.headersSent) return
      const code = e?.cause?.code || e?.code
      const circuitOpen = /is OPEN/.test(e?.message || '') // breaker refused — nothing was sent
      if (isRead || circuitOpen || NOT_REACHED.has(code)) {
        console.warn(`[${name}-proxy] falling back to local: ${e.message}`)
        return next()
      }
      console.error(`[${name}-proxy] write failed upstream: ${e.message}`)
      res.status(502).json({ error: `The ${label} service did not respond. Refresh to check whether your change was saved before trying again.` })
    }
  }
}
