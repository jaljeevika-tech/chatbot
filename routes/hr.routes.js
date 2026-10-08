// HR Management (/api/hr/*): attendance + leave, implemented in services/hr.
// Proxied to Cloud Run when HR_SERVICE_URL is set; otherwise, or when the breaker is
// open / the service errors, services/hr/router.js runs in-process.
// Fallback rules: lib/serviceProxy.js.

import { Router } from 'express'
import { serviceProxy } from '../lib/serviceProxy.js'
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

const proxyToHrService = serviceProxy({
  name: 'hr', label: 'HR', urlEnv: 'HR_SERVICE_URL', keyEnv: 'HR_INTERNAL_TOKEN', keyHeader: 'x-internal-token',
  // Server-verified identity from this request's Firebase token —
  // the service trusts these headers, so never forward client values.
  identity: req => ({
    'x-org-id':       req.user.orgId,
    'x-firebase-uid': req.user.uid,
    'x-user-role':    req.user.role || 'employee',
    'x-user-phone':   req.user.phone || '',
  }),
})

router.use('/hr', (req, res, next) => req.user?.orgId ? next() : res.status(403).json({ error: 'No organization associated with this account.' }))
router.use('/hr', proxyToHrService, (req, _res, next) => {
  req.hrIdent = { orgId: req.user.orgId, uid: req.user.uid, role: req.user.role, phone: req.user.phone || '' }
  next()
})
router.use(createHrRouter())

export default router
