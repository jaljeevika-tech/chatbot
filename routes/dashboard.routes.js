// Dashboards (org, beneficiary registration, MIS, MIS tabs, impact framework, custom).
// The routes live in services/dashboard/src/router.js: proxied to the Cloud Run
// service when DASHBOARD_SERVICE_URL is set, run in-process when unset or down.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { serviceProxy } from '../lib/serviceProxy.js'
import { auditPlatform } from '../lib/platformAudit.js'
import { createDashboardRouter, DASHBOARD_PATHS } from '../services/dashboard/src/router.js'

const router = Router()

// Super admin builder writes → platform audit log. The /superadmin guard in
// superadmin.routes.js (mounted earlier) has already rejected non-superadmins.
// Target org captured up front: req.params is rewritten by later layers before res.json.
const auditOpts = { orgId: req => req.saTargetOrg, targetId: (_req, body) => body?.id || null }
const audit = {
  POST:   auditPlatform('custom_dashboard.create', 'custom_dashboard', auditOpts),
  PUT:    auditPlatform('custom_dashboard.update', 'custom_dashboard', auditOpts),
  DELETE: auditPlatform('custom_dashboard.delete', 'custom_dashboard', auditOpts),
}
router.use('/superadmin/org/:id/custom-dashboards', (req, res, next) => {
  req.saTargetOrg = req.params.id
  return audit[req.method] && req.path !== '/preview' ? audit[req.method](req, res, next) : next()
})

router.use(DASHBOARD_PATHS, serviceProxy({
  name: 'dashboard', label: 'Dashboard', urlEnv: 'DASHBOARD_SERVICE_URL', keyEnv: 'DASHBOARD_INTERNAL_KEY',
  // Always the server-verified Firebase claims, never anything the client sent.
  identity: req => ({
    // A super admin may have no org of their own; the builder targets :id.
    'x-org-id':    req.user?.orgId || req.saTargetOrg || '',
    'x-user-uid':  req.user?.uid || '',
    'x-user-role': req.user?.role || '',
  }),
}))
router.use(createDashboardRouter({ getPool }))

export default router
