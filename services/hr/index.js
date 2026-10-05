// FieldFlow HR microservice (attendance + leave); owns the hr_* tables (078) via
// the hr_service role. Only the monolith calls it, forwarding the verified caller as
// x-org-id / x-firebase-uid / x-user-role / x-user-phone; deploy private, with
// HR_INTERNAL_TOKEN set on both sides. The same routes run in-process via
// routes/hr.routes.js when HR_SERVICE_URL is unset or this service is down.
//
// Local:  DB_HOST=… DB_PASSWORD=… node index.js        (port 8086)
// Deploy: gcloud run deploy fieldflow-hr --source . --region asia-south1 \
//           --no-allow-unauthenticated --add-cloudsql-instances <instance> \
//           --set-env-vars HR_DB_USER=hr_service --set-secrets HR_DB_PASSWORD=HR_DB_PASSWORD:latest

import express from 'express'
import { randomUUID, timingSafeEqual } from 'crypto'
import { createHrRouter } from './router.js'
import { UUID_RE } from './context.js'

const app  = express()
const PORT = process.env.PORT || 8086
const INTERNAL_TOKEN = process.env.HR_INTERNAL_TOKEN || ''
if (!INTERNAL_TOKEN && process.env.K_SERVICE) {
  console.error('[hr] HR_INTERNAL_TOKEN is not set — refusing all API requests')
}
function tokenMatches(given) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(INTERNAL_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'hr', version: '1.0.0' }))

app.use('/api/hr', (req, res, next) => {
  // Fail closed on Cloud Run: without the token anyone past IAM could claim any org/role.
  if (INTERNAL_TOKEN ? !tokenMatches(req.headers['x-internal-token']) : !!process.env.K_SERVICE) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const orgId = String(req.headers['x-org-id'] || '')
  const uid   = String(req.headers['x-firebase-uid'] || '')
  if (!UUID_RE.test(orgId) || !uid) return res.status(401).json({ error: 'Missing caller identity' })
  req.hrIdent = {
    orgId,
    uid,
    role:  String(req.headers['x-user-role'] || 'employee'),
    phone: String(req.headers['x-user-phone'] || ''),
  }
  next()
})

app.use('/api', createHrRouter())

app.listen(PORT, () => console.log(`[hr] listening on ${PORT}`))
