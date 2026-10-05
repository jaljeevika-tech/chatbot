// Finance Management (/api/finance-mgmt/*). The routes live in
// services/finance/src/router.js: proxied to the Cloud Run service when
// FINANCE_SERVICE_URL is set, run in-process when unset or the breaker is open.
//
// Fallback is only automatic when it can't double-apply a change: GETs fall
// back on any failure; writes fall back only when the service was never
// reached (connection refused / DNS). A write that times out mid-flight
// returns 502 instead, because it may already have committed upstream.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { CircuitBreaker } from '../lib/circuitBreaker.js'
import { createFinanceRouter } from '../services/finance/src/router.js'

const router = Router()
const financeCB = new CircuitBreaker('finance-service')

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

// Caller's phone for the users-row fallback when firebase_uid isn't linked: from
// the phone-OTP token, else parsed from the server-minted uid
// (sheet_<orgSlug>_<phone>, or older sheet_<phone>; see auth.routes.js).
function callerPhone(user) {
  if (user?.phone) return user.phone
  const m = /^sheet_(?:.*_)?(\d{10,13})$/.exec(user?.uid || '')
  return m ? m[1] : null
}

// Identity for both paths — always the server-verified Firebase claims,
// never anything the client sent.
router.use('/finance-mgmt', (req, _res, next) => {
  req.fm = {
    orgId: req.user?.orgId || null,
    uid:   req.user?.uid || null,
    role:  req.user?.role || 'employee',
    phone: callerPhone(req.user),
  }
  next()
})

async function proxyToFinanceService(req, res, next) {
  const SERVICE_URL = process.env.FINANCE_SERVICE_URL
  if (!SERVICE_URL || financeCB.isOpen) return next()
  const isRead = req.method === 'GET'

  try {
    await financeCB.call(async () => {
      const idToken = await getCloudRunIdToken(SERVICE_URL)
      // originalUrl keeps the query string (?scope=…), which req.path drops.
      const upstreamRes = await fetch(`${SERVICE_URL.replace(/\/$/, '')}${req.originalUrl}`, {
        method:  req.method,
        headers: {
          'Content-Type':     'application/json',
          'x-correlation-id': req.correlationId || '',
          'x-forwarded-by':   'fieldflow-monolith',
          'x-internal-key':   process.env.FINANCE_INTERNAL_KEY || '',
          'x-org-id':         req.fm.orgId || '',
          'x-user-uid':       req.fm.uid || '',
          'x-user-role':      req.fm.role || '',
          'x-user-phone':     req.fm.phone || '',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body:   isRead ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(isRead ? 20_000 : 45_000),
      })
      // Infra-level failure on a read: count it and serve locally instead.
      if (isRead && upstreamRes.status >= 502) throw new Error(`upstream ${upstreamRes.status}`)
      const data = await upstreamRes.json().catch(() => ({ error: `Finance service error ${upstreamRes.status}` }))
      res.status(upstreamRes.status).json(data)
    })
  } catch (e) {
    if (res.headersSent) return
    const code = e?.cause?.code || e?.code
    const circuitOpen = /is OPEN/.test(e?.message || '') // breaker refused — nothing was sent
    if (isRead || circuitOpen || NOT_REACHED.has(code)) {
      console.warn(`[finance-proxy] falling back to local: ${e.message}`)
      return next()
    }
    console.error(`[finance-proxy] write failed upstream: ${e.message}`)
    res.status(502).json({ error: 'The Finance service did not respond. Refresh to check whether your change was saved before trying again.' })
  }
}

router.use('/finance-mgmt', proxyToFinanceService)
router.use(createFinanceRouter({ getPool }))

export default router
