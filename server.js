// FieldFlow production server: middleware, route mounting and static serving.
// Business logic lives in routes/ and lib/.

import express from 'express'
import './lib/asyncErrors.js'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'

import { requireAuth } from './lib/auth.js'
import { subscriptionGuard } from './lib/subscriptionGuard.js'
import { correlationId } from './lib/correlationId.js'

import authRoutes        from './routes/auth.routes.js'
import leadsRoutes       from './routes/leads.routes.js'
import orgRoutes         from './routes/org.routes.js'
import superadminRoutes  from './routes/superadmin.routes.js'
import superadminIntegrationsRoutes from './routes/superadmin-integrations.routes.js'
import workerRoutes      from './routes/workers.routes.js'
import reportRoutes      from './routes/reports.routes.js'
import notebookRoutes    from './routes/notebook.routes.js'
import rwRoutes          from './routes/report-writer.routes.js'
import financeRoutes     from './routes/finance.routes.js'
import savedReportsRoutes from './routes/saved-reports.routes.js'
import whatsappRoutes     from './routes/whatsapp.routes.js'
import waPlatformRoutes   from './routes/wa-platform.routes.js'
import flowGeneratorRoutes from './routes/flow-generator.routes.js'
import quickReportRoutes   from './routes/quick-report.routes.js'
import waReportsRoutes     from './routes/wa-reports.routes.js'
import adminRoutes        from './routes/admin.routes.js'
import promptsRoutes      from './routes/prompts.routes.js'
import billingRoutes      from './routes/billing.routes.js'
import aiRoutes           from './routes/ai.routes.js'
import aiSettingsRoutes   from './routes/ai-settings.routes.js'
import actionPlanRoutes   from './routes/action-plan.routes.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import budgetUtilisationRoutes from './routes/budget-utilisation.routes.js'
import aiExtractRoutes    from './routes/ai-extract.routes.js'
import correctnessRoutes  from './routes/correctness.routes.js'
import performanceRoutes  from './routes/performance.routes.js'
import storyFinderRoutes  from './routes/story-finder.routes.js'
import documentsRoutes    from './routes/documents.routes.js'
import notebooksRoutes    from './routes/notebooks.routes.js'
import mediaRoutes        from './routes/media.routes.js'
import beneficiariesRoutes from './routes/beneficiaries.routes.js'
import beneficiaryMisRoutes from './routes/beneficiary-mis.routes.js'
import individualBeneficiariesRoutes from './routes/individual-beneficiaries.routes.js'
import microEntrepreneursRoutes from './routes/micro-entrepreneurs.routes.js'
import collectivesRoutes from './routes/collectives.routes.js'
import beneficiaryProfileRoutes from './routes/beneficiary-profile.routes.js'
import resourcesRoutes from './routes/resources.routes.js'
import trainingsRoutes from './routes/trainings.routes.js'
import incomeRoutes from './routes/income.routes.js'
import indirectBeneficiariesRoutes from './routes/indirect-beneficiaries.routes.js'
import inputDistributionsRoutes from './routes/input-distributions.routes.js'
import schemeAccessRoutes from './routes/scheme-access.routes.js'
import creditGrantAccessRoutes from './routes/credit-grant-access.routes.js'
import businessDevelopmentSupportRoutes from './routes/business-development-support.routes.js'
import complianceSupportRoutes from './routes/compliance-support.routes.js'
import campaignRoutes from './routes/campaign.routes.js'
import exposureVisitsRoutes from './routes/exposure-visits.routes.js'
import communityMeetingRoutes from './routes/community-meeting.routes.js'
import indicatorsRoutes   from './routes/indicators.routes.js'
import dataSourcesRoutes  from './routes/data-sources.routes.js'
import misEntriesRoutes   from './routes/mis-entries.routes.js'
import complianceRoutes   from './routes/compliance.routes.js'
import financeMgmtRoutes  from './routes/finance-mgmt.routes.js'
import lgdRoutes          from './routes/lgd.routes.js'
import consentRoutes      from './routes/consent.routes.js'
import dsrRoutes          from './routes/dsr.routes.js'
import beneficiaryErasureRoutes from './routes/beneficiary-erasure.routes.js'
import hrRoutes           from './routes/hr.routes.js'
import { initUsageTracking } from './lib/usageTracker.js'
import { initAiLayer }       from './lib/aiAgent.js'
import { startRetention }    from './lib/retention.js'
import { runDailyReconciliation } from './lib/dataCorrectness/reconciliation.js'
import { loadSecretsFromManager } from './lib/secretManager.js'

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT — fill missing secrets from GCP Secret Manager before Express is
//  configured; values already in process.env win. Non-fatal on error.
// ─────────────────────────────────────────────────────────────────────────────
await loadSecretsFromManager().catch(e =>
  console.warn('[boot] Secret Manager load failed (continuing with env):', e.message)
)

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 8080

// App Engine terminates TLS and forwards the client IP in X-Forwarded-For;
// without trust proxy express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1)

console.log('--- RE-STARTING FIELDFLOW MULTI-TENANT VERSION 5.0 (modular) ---')

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  // React SPA uses inline scripts/styles
  contentSecurityPolicy: false,
  // COEP blocks Firebase SDK token refresh (calls to gstatic/googleapis)
  crossOriginEmbedderPolicy: false,
  // Off so SSE fetch streams and Firebase cross-origin calls keep working
  crossOriginResourcePolicy: false,
  // Allow same-origin framing (dashboard embeds)
  frameguard: { action: 'sameorigin' },
}))

// ── Global middleware ─────────────────────────────────────────────────────────
// Tiered body limits: the smallest that works for each route category.
app.use((req, res, next) => {
  // Webhooks: 256kb (Meta payloads are tiny; bigger is almost certainly malicious).
  // notebook/upload and /api/projects/*: 40mb — 25MB raw media inflates ~4/3 as base64.
  // /api/finance-mgmt/files: bills & ledger statements, capped at 10MB raw by the route.
  // /api/finance-mgmt/budget/expenses/bulk: Excel/Tally expense upload, ≤5000 rows.
  const webhookRoutes = ['/api/wa/webhook', '/api/whatsapp/webhook']
  const fileRoutes = ['/api/notebook/upload', '/api/projects/', '/api/org/branding', '/api/ai-extract/', '/api/finance-mgmt/files',
    '/api/finance-mgmt/budget/expenses/bulk']
  const aiDataRoutes = [
    '/api/get-ai-report', '/api/generate-social-post', '/api/prewarm',
    '/api/analytics/worker', '/api/notebook/', '/api/notebooks/', '/api/rw/',
    '/api/analyze-toc-aggregate', '/api/analyze-report-impact',
    '/api/ai/ask', '/api/ai/seed-memories', '/api/ai/learning',
    '/api/story-finder',
  ]
  let limit = '512kb'
  if (webhookRoutes.some(p => req.path.startsWith(p))) limit = '256kb'
  else if (fileRoutes.some(p => req.path.startsWith(p)))   limit = '40mb'
  else if (aiDataRoutes.some(p => req.path.startsWith(p))) limit = '5mb'
  return express.json({
    limit,
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') },
  })(req, res, next)
})
app.use(correlationId)   // attaches req.correlationId + X-Correlation-ID response header

// ── Rate limiters for AI endpoints ────────────────────────────────────────────
// 30 req/min per IP on all expensive AI SSE routes
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' },
  skip: (req) => req.method === 'OPTIONS',
})
// TTS gets its own bucket: a podcast/video voices each turn separately (~40-60
// calls), which would starve the shared 30/min aiLimiter and drop lines/visuals.
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many voice requests — please wait a moment and try again.' },
  skip: (req) => req.method === 'OPTIONS',
})
// Video Overview draws a picture per narration beat (~20-40 per video), so
// images get their own bucket too.
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image requests — please wait a moment and try again.' },
  skip: (req) => req.method === 'OPTIONS',
})
// 10 req/min for lightweight prewarm
const prewarmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many prewarm requests.' },
})

app.use('/api/get-ai-report',        aiLimiter)
app.use('/api/story-finder',         aiLimiter)
app.use('/api/generate-social-post', aiLimiter)
app.use('/api/notebook/chat',        aiLimiter)
app.use('/api/notebook/audio',       aiLimiter)
app.use('/api/notebook/tts',         ttsLimiter)
app.use('/api/notebook/tts-multi',   ttsLimiter)
app.use('/api/notebook/study-guide', aiLimiter)
app.use('/api/notebook/slide-deck',  aiLimiter)
app.use('/api/notebook/video-slides',aiLimiter)
app.use('/api/notebook/slide-revise',aiLimiter)
app.use('/api/notebook/imagen',      aiLimiter)
app.use('/api/notebook/nanobanana',  imageLimiter)
app.use('/api/notebook/veo-start',   aiLimiter)
app.use('/api/notebook/veo-poll',    aiLimiter)
app.use('/api/notebook/mindmap',     aiLimiter)
app.use('/api/notebook/guide',       aiLimiter)
app.use('/api/notebook/flashcards-quiz', aiLimiter)
app.use('/api/rw',                   aiLimiter)
app.use('/api/analytics/worker',     aiLimiter)
app.use('/api/analyze-report-impact',   aiLimiter)
app.use('/api/analyze-toc-aggregate',   aiLimiter)
app.use('/api/ai/ask',               aiLimiter)
app.use('/api/ai/seed-memories',    aiLimiter)
app.use('/api/ai-extract',           aiLimiter)
app.use('/api/prewarm',              prewarmLimiter)

// ── Auth guard on all /api/* except public endpoints ─────────────────────────
// Paths relative to /api; /whatsapp/health stays public for load-balancer pings.
const PUBLIC_API_PATHS = [
  '/send-otp',
  '/verify-otp',
  '/auth/sheet-login',
  '/auth/token-info',      // invite / reset links (rate-limited, token-gated)
  '/auth/set-password',
  '/auth/forgot-password', // always answers generically
  '/public/trial-request', // landing page lead form (rate-limited, honeypot)
  '/wa/webhook',
  '/whatsapp/health',
  '/whatsapp/webhook',
]

app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.some(p => req.path === p)) return next()
  return requireAuth(req, res, next)
})

// Plan + subscription enforcement (read-only after expiry/suspension, AI gating).
// After requireAuth; public paths have no req.user and pass through.
app.use('/api', subscriptionGuard)

// ── Route modules ─────────────────────────────────────────────────────────────
app.use('/api', leadsRoutes)      // POST /public/trial-request — landing page lead form
app.use('/api', authRoutes)       // POST /auth/sheet-login, POST /auth/login, POST /send-otp, POST /verify-otp
app.use('/api', orgRoutes)        // GET  /org/metadata, GET /subscription
app.use('/api', superadminRoutes) // GET/POST/PATCH /superadmin/*
app.use('/api', superadminIntegrationsRoutes) // /superadmin/org/:id/{integrations,email,whatsapp}, /superadmin/sheets/test, send-link
app.use('/api', workerRoutes)     // POST /add-user, PUT /update-user, DELETE /delete-user, POST /analytics/worker
app.use('/api', reportRoutes)     // POST /get-ai-report, POST /drive-folder, POST /generate-social-post, GET /proxy-image
app.use('/api', notebookRoutes)   // POST /notebook/* (Strangler Fig proxy to Cloud Run when NOTEBOOK_SERVICE_URL is set)
app.use('/api', rwRoutes)         // GET/POST /rw/*
app.use('/api', financeRoutes)    // GET /bq/finance, GET /bq/attendance
app.use('/api', savedReportsRoutes) // POST/GET/DELETE /saved-reports
app.use('/api', actionPlanRoutes)   // GET/PUT /action-plan/progress
app.use('/api', dashboardRoutes) // org / beneficiary / MIS / MIS-tabs / impact + custom dashboards (proxy to Cloud Run when DASHBOARD_SERVICE_URL is set)
app.use('/api', budgetUtilisationRoutes)   // GET/POST/PUT/DELETE /action-plans/:id/budget-utilisation
app.use('/api', aiExtractRoutes)   // POST /ai-extract/action-plan|budget-utilisation|annual-progress
app.use('/api', documentsRoutes)    // GET/POST/DELETE /projects/:projectKey/documents
app.use('/api', notebooksRoutes)    // GET/POST/PATCH/DELETE /notebooks — saved "Ask AI" notebook persistence
app.use('/api', mediaRoutes)         // GET/POST/DELETE /projects/:projectKey/media (uploaded video/audio/pictures/PDFs)
app.use('/api', beneficiariesRoutes) // GET/POST/PUT/DELETE /projects/:projectKey/beneficiaries
app.use('/api', beneficiaryMisRoutes) // GET/POST/DELETE /projects/:projectKey/beneficiary-mis
app.use('/api', individualBeneficiariesRoutes) // GET /individual-beneficiaries, GET/POST /individual-beneficiaries/registration-link(/rotate)
app.use('/api', microEntrepreneursRoutes) // GET /micro-entrepreneurs, GET/POST /micro-entrepreneurs/registration-link(/rotate)
app.use('/api', collectivesRoutes) // GET /collectives, GET/POST /collectives/registration-link(/rotate)
app.use('/api', beneficiaryProfileRoutes) // GET /beneficiary-profile/:uid — full record + all 7 MIS categories for one beneficiary
app.use('/api', resourcesRoutes) // GET /resources, GET/POST /resources/registration-link(/rotate)
app.use('/api', trainingsRoutes) // GET /trainings, POST /trainings/bulk-upload
app.use('/api', incomeRoutes) // GET /income, POST /income/bulk-upload
app.use('/api', indirectBeneficiariesRoutes) // GET /indirect-beneficiaries
app.use('/api', inputDistributionsRoutes) // GET /input-distributions, POST /input-distributions/bulk-upload
app.use('/api', schemeAccessRoutes) // GET /scheme-access, POST /scheme-access/bulk-upload
app.use('/api', creditGrantAccessRoutes) // GET /credit-grant-access, POST /credit-grant-access/bulk-upload
app.use('/api', businessDevelopmentSupportRoutes) // GET /business-development-support, POST /business-development-support/bulk-upload
app.use('/api', complianceSupportRoutes) // GET /compliance-support, POST /compliance-support/bulk-upload
app.use('/api', campaignRoutes) // GET /campaign, POST /campaign/bulk-upload
app.use('/api', exposureVisitsRoutes) // GET /exposure-visits, POST /exposure-visits/bulk-upload
app.use('/api', communityMeetingRoutes) // GET /community-meeting, POST /community-meeting/bulk-upload
app.use('/api', indicatorsRoutes)    // GET/POST/PUT /projects/:projectKey/indicators
app.use('/api', dataSourcesRoutes)   // GET/POST/PUT /projects/:projectKey/data-sources, /mis-templates
app.use('/api', misEntriesRoutes)    // GET/PUT /projects/:projectKey/mis-entries, workflow transitions, evidence
app.use('/api', lgdRoutes)           // GET /lgd/states, /lgd/districts, /lgd/blocks, /lgd/panchayats, /lgd/villages
app.use('/api', complianceRoutes)    // GET/POST/PUT/DELETE /compliance-items
app.use('/api', financeMgmtRoutes)   // /finance-mgmt/* — advances, settlements, ledger requests (proxy to Cloud Run when FINANCE_SERVICE_URL is set)
app.use('/api', whatsappRoutes)     // POST /whatsapp/webhook, GET /whatsapp/health
app.use('/api', waPlatformRoutes)   // GET|POST /wa/webhook (public) + authed flow/contact/broadcast routes
app.use('/api', flowGeneratorRoutes) // POST /wa/flows/generate — AI flow generator
app.use('/api', quickReportRoutes)   // POST /reports/quick-extract, /reports/quick-submit, GET /reports/daily
app.use('/api', waReportsRoutes)     // POST /wa/reports/submit — authed, own-org only (WA flows call lib/waReportSubmit.js in-process)
app.use('/api', adminRoutes)        // POST /admin/prompt-sheet/create, GET /admin/prompt-sheet
app.use('/api', promptsRoutes)     // GET/PUT/DELETE /prompts/:id (admin+)
app.use('/api', billingRoutes)     // GET /superadmin/billing/* (superadmin only)
app.use('/api', aiRoutes)          // POST /ai/ask (SSE), GET/POST/PUT/DELETE /ai/memories, POST /ai/feedback
app.use('/api', aiSettingsRoutes)  // GET/PUT /ai/settings, GET /ai/health, GET /ai/stats, /ai/learning/*, /ai/rule-versions
app.use('/api', correctnessRoutes)  // GET /correctness/flags, /reconciliation, /policy, POST /override, /reconcile-now
app.use('/api', performanceRoutes)  // /performance/reviews CRUD + draft/finalise/acknowledge + action-items
app.use('/api', storyFinderRoutes)  // POST /story-finder — top5 + custom story discovery
app.use('/api', consentRoutes)      // POST /consent, GET /consent/:beneficiaryUid(/status) — DPDP consent capture
app.use('/api', dsrRoutes)          // POST/GET/PATCH /dsr, POST /dsr/:id/fulfill/{access,correction,erasure} — DPDP DSR workflow
app.use('/api', beneficiaryErasureRoutes) // POST /beneficiary-erasure/:uid/{anonymize,hard-delete} — DPDP erasure
app.use('/api', hrRoutes)           // /hr/* attendance + leave — proxied to services/hr when HR_SERVICE_URL is set, else in-process

// ── Static files + React Router catch-all (must follow all API routes) ───────
const DIST = path.join(__dirname, 'dist')

// Hashed assets — cache forever
app.use('/assets', express.static(path.join(DIST, 'assets'), {
  maxAge: '1y',
  immutable: true,
}))

// Service worker (HR tab offline support): never HTTP-cached, or an old worker
// could keep serving after a deploy.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(path.join(DIST, 'sw.js'))
})

// FieldFlow Org (/org/ — the HR + Finance phone app) manifest. Served from
// dist/org-app/ with start_url carrying the org's login slug, so an app
// installed from an org's link can still sign in after logging out.
let orgAppManifest = null
app.get('/org-app/manifest.webmanifest', async (req, res, next) => {
  try {
    orgAppManifest ??= JSON.parse(await fs.readFile(path.join(DIST, 'org-app', 'manifest.webmanifest'), 'utf8'))
    const slug = typeof req.query.org === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(req.query.org) ? req.query.org : null
    res.setHeader('Cache-Control', 'no-cache')
    res.type('application/manifest+json')
    res.send(JSON.stringify({ ...orgAppManifest, start_url: slug ? `/org/?org=${slug}` : orgAppManifest.start_url }))
  } catch (e) {
    next(e)
  }
})

app.use(express.static(DIST, { index: false, etag: false }))

// index.html + React Router catch-all — NEVER cache
function serveIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma',        'no-cache')
  res.setHeader('Expires',       '0')
  res.setHeader('Surrogate-Control', 'no-store')
  res.sendFile(path.join(DIST, 'index.html'))
}
// ── App Engine warmup: pre-warm the DB pool before real traffic ──────────────
app.get('/_ah/warmup', async (_req, res) => {
  try {
    const pool = (await import('./db/pool.js')).getPool()
    await pool.query('SELECT 1')
    res.status(200).send('warm')
  } catch (e) {
    res.status(200).send('warm (db pending)')  // still 200 — don't block startup
  }
})

app.get('/', serveIndex)
// Unknown API routes get a JSON 404, not the SPA shell with a 200.
app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }))
app.get('*', serveIndex)

// ─────────────────────────────────────────────────────────────────────────────
//  CRASH-PROOFING
// ─────────────────────────────────────────────────────────────────────────────
// Global error handler: JSON for /api/*, index.html for SPA routes. Never send
// err.message in production — PG errors leak schema names, paths and params;
// only the correlation ID is exposed.
const IS_PROD = process.env.NODE_ENV === 'production'
app.use((err, req, res, _next) => {
  const cid = req.correlationId || 'no-cid'
  console.error(`[express-error] cid=${cid} ${req.method} ${req.path}:`, err?.message || err)
  if (err?.stack) console.error(err.stack)
  if (res.headersSent) return  // can't send another response
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', cid })
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body', cid })
  }
  // Correlation id for support; message hidden in prod.
  res.status(500).json({
    error: 'Internal server error',
    cid,
    ...(IS_PROD ? {} : { detail: err?.message }),
  })
})

// Async route rejections reach the handler above via lib/asyncErrors.js.

// Never let an unhandled rejection take down the instance: a crash drops
// in-flight requests, so log loudly and keep running.
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[unhandledRejection]', reason)
  if (reason && reason.stack) console.error(reason.stack)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err)
  if (err?.stack) console.error(err.stack)
  // No process.exit(): App Engine restarts unhealthy instances anyway, and
  // staying up lets in-flight requests finish.
})

// ── Startup + graceful shutdown ────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`FieldFlow server running on port ${PORT}`)
  // Idempotent table bootstraps
  initUsageTracking().catch(e => console.warn('[startup] usage tracking init:', e.message))
  initAiLayer().catch(e => console.warn('[startup] AI layer init:', e.message))
  // Retention crons: 30 s after boot, then every 24 h.
  startRetention()
  // Nightly data-correctness reconciliation; 60 s delay so it doesn't compete with retention.
  setTimeout(() => {
    runDailyReconciliation().catch(e => console.warn('[reconciliation] initial pass failed:', e.message))
    setInterval(() => {
      runDailyReconciliation().catch(e => console.warn('[reconciliation] periodic pass failed:', e.message))
    }, 24 * 60 * 60 * 1000).unref()
  }, 60_000).unref()
})

// ── Request timeout — defend against slowloris ───────────────────────────────
// requestTimeout caps receiving the request, not streaming the response, so SSE is unaffected.
// keepAliveTimeout must exceed App Engine nginx's idle timeout: shorter, and nginx
// reuses a closed pooled connection → ECONNRESET → 502 (retried for GETs, not POSTs).
// Only nginx on localhost connects here, so a long keep-alive is safe.
server.requestTimeout = 60_000          // time to receive the whole request
server.keepAliveTimeout = 620_000       // > App Engine's proxy idle timeout
server.headersTimeout = 625_000         // must exceed keepAliveTimeout

// App Engine sends SIGTERM ~30s before killing the instance: stop accepting
// connections and let in-flight requests finish.
function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} received — closing HTTP server (no new requests, draining in-flight)`)
  server.close(err => {
    if (err) { console.error('[shutdown] server.close error:', err); process.exit(1) }
    console.log('[shutdown] HTTP server closed; exiting cleanly')
    process.exit(0)
  })
  // Force exit before App Engine kills us if draining takes too long
  setTimeout(() => {
    console.warn('[shutdown] drain timeout — forcing exit')
    process.exit(0)
  }, 25_000).unref()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))
