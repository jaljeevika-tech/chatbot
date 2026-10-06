// HR Management (/api/hr/*): attendance + leave, implemented in services/hr.
// Proxied to Cloud Run when HR_SERVICE_URL is set; otherwise, or when the breaker is
// open / the service errors, services/hr/router.js runs in-process. As with finance,
// writes only fall back if the service was never reached (a mid-flight failure → 502).

import { Router } from 'express'
import { CircuitBreaker } from '../lib/circuitBreaker.js'
import { getPool } from '../db/pool.js'
import { createHrRouter } from '../services/hr/router.js'
import { usePool } from '../services/hr/db.js'
import { runHrReminders } from '../services/hr/reminders.js'

usePool(getPool)

// HR reminders + 10 pm auto check-out (services/hr/reminders.js). Lives here, not on
// Cloud Run, because a scale-to-zero service has no timer. Production only, so
// local dev without a DB stays quiet; HR_REMINDERS=off disables it.
if (process.env.NODE_ENV === 'production' && process.env.HR_REMINDERS !== 'off') {
  let lastError = ''
  const tick = () => runHrReminders()
    .then(n => { lastError = ''; if (n) console.log(`[hr-reminders] sent ${n}`) })
    .catch(e => { if (e.message !== lastError) console.warn('[hr-reminders] failed:', (lastError = e.message)) })
  setTimeout(tick, 2 * 60_000).unref()
  setInterval(tick, 10 * 60_000).unref()
}

const router = Router()
const hrCB = new CircuitBreaker('hr-service')
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

async function proxyToHrService(req, res, next) {
  if (!req.user?.orgId) return res.status(403).json({ error: 'No organization associated with this account.' })
  const HR_URL = process.env.HR_SERVICE_URL
  if (!HR_URL || hrCB.isOpen) return next()
  const isRead = req.method === 'GET'

  try {
    await hrCB.call(async () => {
      const idToken = await getCloudRunIdToken(HR_URL)
      const upstreamRes = await fetch(`${HR_URL}${req.originalUrl}`, {
        method:  req.method,
        headers: {
          'Content-Type':     'application/json',
          'x-correlation-id': req.correlationId || '',
          'x-forwarded-by':   'fieldflow-monolith',
          // Server-verified identity from this request's Firebase token —
          // the service trusts these headers, so never forward client values.
          'x-org-id':         req.user.orgId,
          'x-firebase-uid':   req.user.uid,
          'x-user-role':      req.user.role || 'employee',
          'x-user-phone':     req.user.phone || '',
          ...(process.env.HR_INTERNAL_TOKEN ? { 'x-internal-token': process.env.HR_INTERNAL_TOKEN } : {}),
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body:   req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      // Infra-level failure on a read: count it and serve in-process instead.
      if (isRead && upstreamRes.status >= 502) throw new Error(`HR service responded ${upstreamRes.status}`)
      res.status(upstreamRes.status)
        .type(upstreamRes.headers.get('content-type') || 'application/json')
        .send(await upstreamRes.text())
    })
  } catch (e) {
    if (res.headersSent) return
    const code = e?.cause?.code || e?.code
    const circuitOpen = /is OPEN/.test(e?.message || '') // breaker refused — nothing was sent
    if (isRead || circuitOpen || NOT_REACHED.has(code)) {
      console.warn(`[hr-proxy] falling back to in-process: ${e.message}`)
      return next()
    }
    console.error(`[hr-proxy] write failed upstream: ${e.message}`)
    res.status(502).json({ error: 'The HR service did not respond. Refresh to check whether your change was saved before trying again.' })
  }
}

router.use('/hr', proxyToHrService, (req, _res, next) => {
  req.hrIdent = { orgId: req.user.orgId, uid: req.user.uid, role: req.user.role, phone: req.user.phone || '' }
  next()
})
router.use(createHrRouter())

export default router
