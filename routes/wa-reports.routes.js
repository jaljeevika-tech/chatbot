// routes/wa-reports.routes.js — WA flow → daily_reports bridge
//
// POST /api/wa/reports/submit   (authed — org comes from req.user.orgId)
//
// The Reporting flow calls submitWaReport() in-process (lib/flowEngine.js); this
// route remains for older clients. Any `org_id` in the body is ignored — trusting it
// would allow cross-tenant writes.

import { Router } from 'express'
import { submitWaReport } from '../lib/waReportSubmit.js'

const router = Router()

router.post('/wa/reports/submit', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ success: false, error: 'Authentication required' })
  const { status, body } = await submitWaReport(req.user.orgId, req.body || {})
  res.status(status).json(body)
})

export default router
