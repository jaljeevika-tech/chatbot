// services/report-writer/index.js — FieldFlow Report Writer microservice (Cloud Run):
// voice profiles, glossary and feedback in the RW_SHEET_ID Google Sheet, plus AI drafting (SSE).
// The route code is src/router.js, which the monolith also mounts in-process
// (routes/report-writer.routes.js), so both always run the same logic.
//
// Auth: deployed private (the monolith sends a Cloud Run ID token) AND every request
// must carry x-internal-key = RW_INTERNAL_KEY (lib/internalCaller.js). The org comes from
// the monolith's x-org-id header, filled from the verified Firebase token. Org prompts,
// context and usage tracking read the DB through db/pool.js (DATABASE_URL).
//
// Build context is the REPO ROOT (it reuses lib/*.js):
//   docker build -f services/report-writer/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/report-writer .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/report-writer
//   gcloud run deploy fieldflow-report-writer --image asia-south1-docker.pkg.dev/<project>/fieldflow/report-writer \
//     --region asia-south1 --no-allow-unauthenticated \
//     --set-secrets RW_INTERNAL_KEY=RW_INTERNAL_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,DATABASE_URL=DATABASE_URL:latest,GOOGLE_SERVICE_ACCOUNT_JSON=GOOGLE_SERVICE_ACCOUNT_JSON:latest \
//     --set-env-vars NODE_ENV=production,RW_SHEET_ID=<sheet id>
//   and set RW_INTERNAL_KEY on the monolith (Secret Manager) before redeploying it.

import express from 'express'
import { correlationId } from '../../lib/correlationId.js'
import { requireInternalKey, isOrgId } from '../../lib/internalCaller.js'
import router from './src/router.js'

const app  = express()
const PORT = process.env.PORT || 8082

app.disable('x-powered-by')
app.use(express.json({ limit: '5mb' }))
app.use(correlationId)

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'report-writer', version: '2.0.0' }))

app.use('/api', requireInternalKey('report-writer', 'RW_INTERNAL_KEY'), (req, res, next) => {
  const orgId = String(req.headers['x-org-id'] || '')
  if (!isOrgId(orgId)) return res.status(401).json({ error: 'Authentication required' })
  req.user = { orgId }
  next()
})
app.use('/api', router)
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => console.log(`[report-writer] listening on :${PORT}`))
