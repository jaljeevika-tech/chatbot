// FieldFlow Finance microservice (Cloud Run): advances, settlements, ledger-statement
// requests and their notifications; owns the fm_* tables (079). Routes live in
// src/router.js, which the monolith also mounts in-process as its fallback.
//
// Only the monolith may call it: deployed private (Cloud Run ID token) and every
// request needs x-internal-key = FINANCE_INTERNAL_KEY (missing key fails closed).
// Identity comes from the monolith's x-org-id / x-user-uid / x-user-role headers.
// Setup shared with the other services: lib/serviceApp.js.
//
// Env:
//   FINANCE_INTERNAL_KEY            shared secret with the monolith (Secret Manager)
//   FM_DATABASE_URL | DATABASE_URL  connection string, or Cloud SQL via:
//   CLOUD_SQL_INSTANCE, DB_NAME, FM_DB_USER (fm_service), FM_DB_PASSWORD
//   ENCRYPTION_KEY                  decrypts wa_config tokens (WhatsApp alerts)
//   SMTP_USER, SMTP_PASS, SMTP_FROM Gmail / Workspace SMTP (email alerts)
//   APP_BASE_URL                    link included in notification emails
//
// Build context is the REPO ROOT (it reuses lib/serviceApp.js), so:
//   docker build -f services/finance/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/finance .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/finance
//   gcloud run deploy fieldflow-finance --image asia-south1-docker.pkg.dev/<project>/fieldflow/finance \
//     --region asia-south1 --no-allow-unauthenticated \
//     --set-secrets FINANCE_INTERNAL_KEY=FINANCE_INTERNAL_KEY:latest,FM_DATABASE_URL=FM_DATABASE_URL:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest,SMTP_PASS=SMTP_PASS:latest \
//     --set-env-vars NODE_ENV=production,SMTP_USER=<mailbox>,APP_BASE_URL=<app url>
//   then grant the App Engine service account roles/run.invoker on the service
//   and set FINANCE_SERVICE_URL (+ FINANCE_INTERNAL_KEY) on the monolith.

import pg from 'pg'
import { createServiceApp } from '../../lib/serviceApp.js'
import { isOrgId } from '../../lib/internalCaller.js'
import { createFinanceRouter } from './src/router.js'

const { Pool } = pg
const PORT = process.env.PORT || 8083

// ── DB pool (fm_service role on Cloud SQL; connection string elsewhere) ──────
let _pool = null
function getPool() {
  if (_pool) return _pool
  const url = process.env.FM_DATABASE_URL || process.env.DATABASE_URL
  _pool = new Pool(url
    ? { connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 }
    : process.env.K_SERVICE && process.env.CLOUD_SQL_INSTANCE
      ? {
          host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE}`,
          database: process.env.DB_NAME        || 'fieldflow',
          user:     process.env.FM_DB_USER     || 'fm_service',
          password: process.env.FM_DB_PASSWORD || '',
          max: 5,
        }
      : {
          host:     process.env.DB_HOST     || 'localhost',
          port:     parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME     || 'fieldflow',
          user:     process.env.FM_DB_USER  || process.env.DB_USER || 'fieldflow_app',
          password: process.env.FM_DB_PASSWORD || process.env.DB_PASSWORD || '',
          ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
          max: 5,
        })
  _pool.on('error', err => console.error('[finance-db] Pool error:', err.message))
  return _pool
}

createServiceApp({
  name: 'finance', version: '1.0.0', keyEnv: 'FINANCE_INTERNAL_KEY', bodyLimit: '20mb',
  identityKey: 'fm',
  identity: req => {
    const orgId = String(req.headers['x-org-id'] || '')
    const uid   = String(req.headers['x-user-uid'] || '')
    if (!isOrgId(orgId) || !uid) return null
    return {
      orgId, uid,
      role:  String(req.headers['x-user-role'] || 'employee'),
      phone: String(req.headers['x-user-phone'] || '') || null,
    }
  },
  mount: app => app.use('/api', createFinanceRouter({ getPool })),
}).listen(PORT, () => console.log(`[finance] listening on :${PORT}`))
