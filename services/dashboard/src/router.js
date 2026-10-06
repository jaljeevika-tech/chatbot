// services/dashboard/src/router.js — every dashboard read model in one router.
// Mounted by the Cloud Run service (identity from forwarded headers) and by the
// monolith in-process (routes/dashboard.routes.js); both set req.user.
//
// GET  /org-dashboard/overview
// GET  /beneficiary-registration-dashboard, POST …/geocode-locations
// GET  /projects/:projectKey/mis-dashboard, /projects/:projectKey/indicators/:id/drilldown
// GET  /projects/:projectKey/mis-tabs-dashboard
// GET  /impact/framework
// /custom-dashboards/*, /hr-dashboard, /builtin-dashboards/:key, /superadmin/org/:id/custom-dashboards/*  — see custom.js

import { Router } from 'express'
import { usePool } from './pool.js'
import orgDashboard from './org-dashboard.js'
import beneficiaryDashboard from './beneficiary-dashboard.js'
import misDashboard from './mis-dashboard.js'
import misTabsDashboard from './mis-tabs-dashboard.js'
import impactFramework from './impact-framework.js'
import customDashboards from './custom.js'

// Paths this router owns — the monolith proxies exactly these.
export const DASHBOARD_PATHS = [
  '/org-dashboard',
  '/beneficiary-registration-dashboard',
  '/projects/:projectKey/mis-dashboard',
  '/projects/:projectKey/mis-tabs-dashboard',
  '/projects/:projectKey/indicators/:id/drilldown',
  '/impact/framework',
  '/custom-dashboards',
  '/hr-dashboard',
  '/builtin-dashboards',
  '/superadmin/org/:id/custom-dashboards',
]

export function createDashboardRouter({ getPool }) {
  usePool(getPool)
  const router = Router()
  router.use(orgDashboard, beneficiaryDashboard, misDashboard, misTabsDashboard, impactFramework, customDashboards)
  return router
}
