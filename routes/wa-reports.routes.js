// routes/wa-reports.routes.js — WA flow → daily_reports bridge
//
// POST /api/wa/reports/submit   (authed — org comes from req.user.orgId)
//
// The Reporting flow calls submitWaReport() in-process (lib/flowEngine.js); this
// route remains for older clients. Any `org_id` in the body is ignored — trusting it
// would allow cross-tenant writes.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { submitWaReport, MEDIA_MIME } from '../lib/waReportSubmit.js'

const router = Router()

router.post('/wa/reports/submit', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ success: false, error: 'Authentication required' })
  const { status, body } = await submitWaReport(req.user.orgId, req.body || {})
  res.status(status).json(body)
})

// GET /api/wa/media/:id   (public — the random id is the key; <img>/<video> can't send auth)
router.get('/wa/media/:id([0-9a-fA-F-]{36})', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT mime_type, data FROM wa_report_media WHERE id = $1', [req.params.id])
    if (!rows.length || !MEDIA_MIME.test(rows[0].mime_type)) return res.status(404).end()
    res.setHeader('Content-Type', rows[0].mime_type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(rows[0].data)
  } catch (e) {
    console.error('[wa-media GET]', e.message)
    res.status(500).end()
  }
})

export default router
