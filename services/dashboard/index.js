// services/dashboard/index.js — FieldFlow Dashboard Microservice (Cloud Run)
// Bounded Context: Dashboards — read models over the org's projects, beneficiary
// registries, MIS tables and impact framework, plus super-admin custom dashboards
// (owns custom_dashboards, db/migrations/085). The route code is src/router.js,
// which the monolith also mounts in-process (routes/dashboard.routes.js).
//
// Auth: same as services/finance — deployed private (the monolith sends a Cloud Run
// ID token) AND every request must carry x-internal-key = DASHBOARD_INTERNAL_KEY;
// on Cloud Run a missing key fails closed. Identity comes from the monolith's
// x-org-id / x-user-uid / x-user-role headers (filled from the verified Firebase token).
//
// Env:
//   DASHBOARD_INTERNAL_KEY                shared secret with the monolith
//   DASHBOARD_DATABASE_URL | DATABASE_URL connection string
//   ENCRYPTION_KEY                        decrypts PII columns (lib/piiCrypto.js)
//
// Build context is the REPO ROOT (it reuses lib/*.js), so:
//   docker build -f services/dashboard/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/dashboard .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/dashboard
//   gcloud run deploy fieldflow-dashboard --image asia-south1-docker.pkg.dev/<project>/fieldflow/dashboard \
//     --region asia-south1 --no-allow-unauthenticated \
//     --set-secrets DASHBOARD_INTERNAL_KEY=DASHBOARD_INTERNAL_KEY:latest,DASHBOARD_DATABASE_URL=DATABASE_URL:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest \
//     --set-env-vars NODE_ENV=production
//   then grant the App Engine service account roles/run.invoker and set
//   DASHBOARD_SERVICE_URL (+ DASHBOARD_INTERNAL_KEY) on the monolith.

import express from 'express'
import pg from 'pg'
import { randomUUID, timingSafeEqual } from 'crypto'
import { createDashboardRouter } from './src/router.js'

const app  = express()
const PORT = process.env.PORT || 8084

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'dashboard', version: '1.0.0' }))

const INTERNAL_KEY = process.env.DASHBOARD_INTERNAL_KEY || ''
if (!INTERNAL_KEY && process.env.K_SERVICE) {
  console.error('[dashboard] DASHBOARD_INTERNAL_KEY is not set — refusing all API requests')
}
function keyMatches(given) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(INTERNAL_KEY)
  return a.length === b.length && timingSafeEqual(a, b)
}
app.use('/api', (req, res, next) => {
  if (INTERNAL_KEY ? !keyMatches(req.headers['x-internal-key']) : !!process.env.K_SERVICE) {
    return res.status(401).json({ error: 'Unauthorized caller' })
  }
  const orgId = String(req.headers['x-org-id'] || '')
  const uid   = String(req.headers['x-user-uid'] || '')
  if (!/^[0-9a-fA-F-]{36}$/.test(orgId) || !uid) return res.status(401).json({ error: 'Authentication required' })
  req.user = { orgId, uid, role: String(req.headers['x-user-role'] || 'employee'), name: String(req.headers['x-user-name'] || '') }
  next()
})

let _pool = null
function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: process.env.DASHBOARD_DATABASE_URL || process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
    _pool.on('error', err => console.error('[dashboard-db] Pool error:', err.message))
  }
  return _pool
}

app.use('/api', createDashboardRouter({ getPool }))
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => console.log(`[dashboard] listening on :${PORT}`))
