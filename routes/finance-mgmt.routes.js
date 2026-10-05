// Finance Management (/api/finance-mgmt/*). The routes live in
// services/finance/src/router.js: proxied to the Cloud Run service when
// FINANCE_SERVICE_URL is set, run in-process when unset or the breaker is open.
// Fallback rules: lib/serviceProxy.js.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { serviceProxy } from '../lib/serviceProxy.js'
import { createFinanceRouter } from '../services/finance/src/router.js'

const router = Router()

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

const proxyToFinanceService = serviceProxy({
  name: 'finance', label: 'Finance', urlEnv: 'FINANCE_SERVICE_URL', keyEnv: 'FINANCE_INTERNAL_KEY',
  identity: req => ({
    'x-org-id':     req.fm.orgId || '',
    'x-user-uid':   req.fm.uid || '',
    'x-user-role':  req.fm.role || '',
    'x-user-phone': req.fm.phone || '',
  }),
})

router.use('/finance-mgmt', proxyToFinanceService)
router.use(createFinanceRouter({ getPool }))

export default router
