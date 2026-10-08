// lib/secretManager.js — at boot, load secrets from Google Secret Manager into
// process.env so they never live in app.yaml/git. Values already in env win;
// a missing secret only degrades the feature that uses it.
// Setup: `gcloud secrets create <NAME> --data-file=-`, then grant the App
// Engine service account roles/secretmanager.secretAccessor.

// Secrets to pull. Format: { envVarName: secretId }. If secretId is omitted,
// envVarName is used as the Secret Manager secret name.
const SECRETS = [
  'GEMINI_API_KEY',
  'DATABASE_URL',
  'FIREBASE_ADMIN_SDK_JSON',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'WA_WEBHOOK_VERIFY_TOKEN',
  'ENCRYPTION_KEY',           // used by lib/crypto.js for AES-256-GCM
  'WA_APP_SECRET',           // global webhook signature secret
  'GOOGLE_DRIVE_API_KEY',  'WA_REPORT_WEBHOOK_SECRET',// WA_REPORT_WEBHOOK_SECRET is unread (reports submit runs in-process); delete after rotation
  'SMTP_PASS',                // Gmail / Workspace app password — Finance Management email alerts (services/finance/src/notify.js)
  'FINANCE_INTERNAL_KEY',     // shared secret the monolith sends to the Finance Cloud Run service
  'NOTEBOOK_INTERNAL_KEY',    // … to the Notebook Cloud Run service
  'RW_INTERNAL_KEY',          // … to the Report Writer Cloud Run service
  'RESEND_API_KEY',           // platform email (lib/mailer.js) — "<Org> via FieldFlow" sender
]

let _client = null
async function getClient() {
  if (_client) return _client
  try {
    // Dynamic import so the heavy GCP client isn't loaded when secrets are
    // already in env (local dev, tests). Only paid on first access.
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
    _client = new SecretManagerServiceClient()
    return _client
  } catch (e) {
    console.warn('[secretManager] failed to init client:', e.message)
    return null
  }
}

async function fetchSecret(secretId, projectId) {
  const client = await getClient()
  if (!client) return null
  try {
    const name = `projects/${projectId}/secrets/${secretId}/versions/latest`
    const [version] = await client.accessSecretVersion({ name })
    const payload = version.payload?.data?.toString('utf8')
    return payload || null
  } catch (e) {
    // NOT_FOUND just means the secret is still in app.yaml; log anything else.
    if (e.code !== 5 /* NOT_FOUND */) {
      console.warn(`[secretManager] fetch "${secretId}" failed:`, e.message)
    }
    return null
  }
}

/** Populate process.env from Secret Manager for keys not already set (idempotent). */
export async function loadSecretsFromManager() {
  // Only on App Engine; locally, secrets come from .env.
  const isAppEngine = !!process.env.GAE_APPLICATION
  if (!isAppEngine) {
    console.log('[secretManager] not on App Engine — skipping Secret Manager (using env vars)')
    return { fetched: 0, skipped: 0 }
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
                 || process.env.GCLOUD_PROJECT
                 || (process.env.GAE_APPLICATION || '').replace(/^s~/, '')
  if (!projectId) {
    console.warn('[secretManager] no project id available — skipping')
    return { fetched: 0, skipped: 0 }
  }

  let fetched = 0
  let skipped = 0
  for (const key of SECRETS) {
    if (process.env[key]) { skipped++; continue }   // already set, prefer existing
    const val = await fetchSecret(key, projectId)
    if (val) {
      process.env[key] = val
      fetched++
      console.log(`[secretManager] loaded ${key} (${val.length} chars)`)
    }
  }
  if (fetched > 0) console.log(`[secretManager] loaded ${fetched} secrets, kept ${skipped} from env`)
  return { fetched, skipped }
}
