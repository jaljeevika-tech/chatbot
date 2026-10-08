// services/notebook/index.js — FieldFlow Notebook AI microservice (Cloud Run):
// sources → chat, study guide, slide deck, mind map, flashcards, guide (SSE).
// The route code is src/router.js, which the monolith also mounts in-process
// (routes/notebook.routes.js), so both always run the same logic.
//
// Auth: deployed private (the monolith sends a Cloud Run ID token) AND every request
// must carry x-internal-key = NOTEBOOK_INTERNAL_KEY (lib/internalCaller.js). The org comes from
// the monolith's x-org-id header, filled from the verified Firebase token. Org prompts,
// context and usage tracking read the DB through db/pool.js (DATABASE_URL).
//
// Build context is the REPO ROOT (it reuses lib/*.js):
//   docker build -f services/notebook/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/notebook .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/notebook
//   gcloud run deploy fieldflow-notebook --image asia-south1-docker.pkg.dev/<project>/fieldflow/notebook \
//     --region asia-south1 --no-allow-unauthenticated \
//     --set-secrets NOTEBOOK_INTERNAL_KEY=NOTEBOOK_INTERNAL_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,DATABASE_URL=DATABASE_URL:latest \
//     --set-env-vars NODE_ENV=production
//   and set NOTEBOOK_INTERNAL_KEY on the monolith (Secret Manager) before redeploying it.

import express from 'express'
import { correlationId } from '../../lib/correlationId.js'
import { requireInternalKey, isOrgId } from '../../lib/internalCaller.js'
import router from './src/router.js'

const app  = express()
const PORT = process.env.PORT || 8081

app.disable('x-powered-by')
app.use(express.json({ limit: '5mb' }))
app.use(correlationId)

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'notebook', version: '2.0.0' }))

app.use('/api', requireInternalKey('notebook', 'NOTEBOOK_INTERNAL_KEY'), (req, res, next) => {
  const orgId = String(req.headers['x-org-id'] || '')
  if (!isOrgId(orgId)) return res.status(401).json({ error: 'Authentication required' })
  req.user = { orgId }
  next()
})
app.use('/api', router)
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => console.log(`[notebook] listening on :${PORT}`))
