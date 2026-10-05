// Multi-project action plans. Every endpoint takes optional ?plan=<project_key>;
// without it, the org's most recently updated plan is used.
//
//   GET    /api/action-plans                       — list plans for this org
//   POST   /api/action-plans                       — create plan (body = parsed JSON)
//   GET    /api/action-plans/:id                   — fetch one plan
//   DELETE /api/action-plans/:id                   — archive/purge the PROJECT (Portfolio Overview card and all)
//   POST   /api/action-plans/:id/clear-plan        — reset just the uploaded Action Plan structure; project untouched
//   GET    /api/action-plans/template.xlsx         — download blank template
//
//   GET    /api/action-plan/progress?plan=key      — load saved cells for a plan
//   PUT    /api/action-plan/progress               — body must include project_key
//   GET    /api/action-plan/history?plan=key       — recent edits
//   GET    /api/action-plan/export.xlsx?plan=key   — export, same shape as the upload template
//
// Reads are open to any org member (the UI has a read-only mode that needs the real
// plan); writes require manager|admin|superadmin.
//
// Routes live in ./action-plan/, mounted below in their original registration order.

import { Router } from 'express'
import plansRoutes                  from './action-plan/plans.routes.js'
import portfolioDashboardsRoutes    from './action-plan/portfolio-dashboards.routes.js'
import annualProgressRoutes         from './action-plan/annual-progress.routes.js'
import insightsRoutes               from './action-plan/insights.routes.js'
import planTemplateRoutes           from './action-plan/plan-template.routes.js'
import progressRoutes               from './action-plan/progress.routes.js'
import exportRoutes                 from './action-plan/export.routes.js'

const router = Router()

router.use(plansRoutes)
router.use(portfolioDashboardsRoutes)
router.use(annualProgressRoutes)
router.use(insightsRoutes)
router.use(planTemplateRoutes)
router.use(progressRoutes)
router.use(exportRoutes)

export default router
