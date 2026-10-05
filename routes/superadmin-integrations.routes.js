// Super admin: per-org email, WhatsApp (Meta Cloud API) and Google Sheets, plus
// invite / reset links. Every write is in platform_audit_log.
//
// GET  /api/superadmin/platform/integrations
// GET  /api/superadmin/org/:id/integrations
// PUT  /api/superadmin/org/:id/email
// POST /api/superadmin/org/:id/email/test
// PUT  /api/superadmin/org/:id/whatsapp
// POST /api/superadmin/org/:id/whatsapp/test
// POST /api/superadmin/sheets/test
// POST /api/superadmin/org/:id/users/:uid/send-link

import { Router } from 'express'
import { requireSuperAdmin } from '../lib/auth.js'
import { getPool } from '../db/pool.js'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { SECRET_MASK } from '../lib/secretMeta.js'
import { auditPlatform } from '../lib/platformAudit.js'
import { platformEmailStatus, sendOrgEmail, renderEmail, getOrgEmailConfig, appBaseUrl } from '../lib/mailer.js'
import { sendAuthLink } from '../lib/authTokens.js'
import { getGoogleAccessToken } from '../lib/sheets.js'

const router = Router()
router.use('/superadmin', requireSuperAdmin)

const WA_GRAPH = 'https://graph.facebook.com/v19.0'
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
const MIGRATION_083 = 'Database migration 083_org_integrations.sql has not been run yet.'
const isMissingTable = e => e?.code === '42P01' || e?.code === '42703'

function serviceAccountEmail() {
  try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}').client_email || null } catch { return null }
}

// ── Platform-wide status ──────────────────────────────────────────────────────
router.get('/superadmin/platform/integrations', (req, res) => {
  let base = null
  try { base = appBaseUrl(req) } catch { /* reported below */ }
  res.json({
    email: platformEmailStatus(),
    google: { service_account_email: serviceAccountEmail() },
    whatsapp: {
      webhook_url: base ? `${base}/api/wa/webhook` : null,
      global_verify_token: !!process.env.WA_WEBHOOK_VERIFY_TOKEN,
      global_app_secret: !!process.env.WA_APP_SECRET,
    },
    app_base_url: base,
  })
})

// ── One org's integrations ────────────────────────────────────────────────────
router.get('/superadmin/org/:id/integrations', async (req, res) => {
  const pool = getPool()
  const orgId = req.params.id
  try {
    const { rows: orgRows } = await pool.query(`SELECT metadata->'data_sources' AS ds FROM organizations WHERE id = $1`, [orgId])
    if (!orgRows.length) return res.status(404).json({ error: 'Organization not found' })
    const ds = orgRows[0].ds || {}

    const { rows: waRows } = await pool.query(
      `SELECT phone_number_id, business_id, display_phone, enabled, updated_at,
              (access_token IS NOT NULL AND access_token <> '') AS has_access_token,
              (app_secret IS NOT NULL AND app_secret <> '')     AS has_app_secret,
              webhook_secret
         FROM wa_config WHERE org_id = $1`, [orgId])
    const wa = waRows[0]

    let email = null, emailLog = [], migrationNeeded = false
    try {
      const { rows } = await pool.query(`SELECT * FROM org_email_config WHERE org_id = $1`, [orgId])
      const c = rows[0]
      email = {
        mode: c?.mode || 'platform', from_name: c?.from_name || '', reply_to: c?.reply_to || '',
        smtp_host: c?.smtp_host || '', smtp_port: c?.smtp_port || 465, smtp_secure: c?.smtp_secure !== false,
        smtp_user: c?.smtp_user || '', smtp_pass: c?.smtp_pass ? SECRET_MASK : '', smtp_from_email: c?.smtp_from_email || '',
        last_test_at: c?.last_test_at || null, last_test_ok: c?.last_test_ok ?? null, last_test_error: c?.last_test_error || null,
      }
      ;({ rows: emailLog } = await pool.query(
        `SELECT kind, to_address, subject, provider, ok, error, created_at FROM email_log WHERE org_id = $1 ORDER BY id DESC LIMIT 10`, [orgId]))
    } catch (e) {
      if (!isMissingTable(e)) throw e
      migrationNeeded = true
    }

    res.json({
      migration_needed: migrationNeeded,
      email, email_log: emailLog,
      whatsapp: wa ? {
        configured: true, phone_number_id: wa.phone_number_id, business_id: wa.business_id || '',
        display_phone: wa.display_phone || '', enabled: wa.enabled, updated_at: wa.updated_at,
        access_token: wa.has_access_token ? SECRET_MASK : '', app_secret: wa.has_app_secret ? SECRET_MASK : '',
        // The verify token is shown: it is typed into Meta's dashboard and sent by Meta in the clear.
        webhook_secret: wa.webhook_secret || '',
      } : { configured: false },
      sheets: { service_account_email: serviceAccountEmail(), users_sheet_id: ds.users_sheet_id || '', reports_sheet_id: ds.reports_sheet_id || '' },
    })
  } catch (e) {
    console.error('[sa-integrations] get', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email ─────────────────────────────────────────────────────────────────────
const emailDiff = b => ({ ...b, smtp_pass: b?.smtp_pass && b.smtp_pass !== SECRET_MASK ? '[changed]' : undefined })

router.put('/superadmin/org/:id/email',
  auditPlatform('org.email.update', 'integration', { diff: req => emailDiff(req.body) }),
  async (req, res) => {
  const b = req.body || {}
  const mode = b.mode === 'smtp' ? 'smtp' : 'platform'
  const from_name = String(b.from_name || '').replace(/["<>\r\n]/g, '').trim().slice(0, 80)
  const reply_to = String(b.reply_to || '').trim()
  if (reply_to && !EMAIL_RE.test(reply_to)) return res.status(400).json({ error: 'Reply-to must be a valid email address' })
  const smtp_port = parseInt(b.smtp_port, 10) || 465
  const smtp_from_email = String(b.smtp_from_email || '').trim()
  if (mode === 'smtp') {
    if (!String(b.smtp_host || '').trim() || !String(b.smtp_user || '').trim()) return res.status(400).json({ error: 'SMTP host and username are required' })
    if (!EMAIL_RE.test(smtp_from_email)) return res.status(400).json({ error: 'From address must be a valid email address' })
    if (smtp_port < 1 || smtp_port > 65535) return res.status(400).json({ error: 'Invalid SMTP port' })
  }
  // Masked password = keep the stored one; empty = clear it.
  const passProvided = b.smtp_pass !== undefined && b.smtp_pass !== SECRET_MASK
  try {
    await getPool().query(
      `INSERT INTO org_email_config (org_id, mode, from_name, reply_to, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from_email, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (org_id) DO UPDATE SET
         mode = $2, from_name = $3, reply_to = $4, smtp_host = $5, smtp_port = $6, smtp_secure = $7, smtp_user = $8,
         smtp_pass = CASE WHEN $11 THEN $9 ELSE org_email_config.smtp_pass END,
         smtp_from_email = $10, updated_at = NOW()`,
      [req.params.id, mode, from_name || null, reply_to || null, String(b.smtp_host || '').trim() || null, smtp_port,
       b.smtp_secure !== false, String(b.smtp_user || '').trim() || null,
       passProvided && b.smtp_pass ? encryptSecret(String(b.smtp_pass)) : null, smtp_from_email || null, passProvided]
    )
    res.json({ ok: true })
  } catch (e) {
    if (isMissingTable(e)) return res.status(500).json({ error: MIGRATION_083 })
    if (e.code === '23503') return res.status(404).json({ error: 'Organization not found' })
    console.error('[sa-integrations] email put', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/superadmin/org/:id/email/test',
  auditPlatform('org.email.test', 'integration'),
  async (req, res) => {
  const to = String(req.body?.to || '').trim()
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address to send the test to' })
  const pool = getPool()
  try {
    const cfg = await getOrgEmailConfig(req.params.id)
    if (!cfg) return res.status(404).json({ error: 'Organization not found' })
    const orgName = cfg.branding?.org_name || cfg.org_name
    const { html, text } = renderEmail({
      branding: cfg.branding, orgName,
      heading: 'Email is working',
      paragraphs: [`This is a test message from ${orgName}'s FieldFlow workspace.`, `Sent ${cfg.mode === 'smtp' ? `through the organisation's own SMTP server (${cfg.smtp_host})` : 'through the FieldFlow platform sender'}.`],
    })
    let ok = true, error = null, provider = null
    try { ({ provider } = await sendOrgEmail(req.params.id, { to, subject: `Test email from ${orgName}`, html, text, kind: 'test' }, cfg)) }
    catch (e) { ok = false; error = e.message }
    await pool.query(
      `UPDATE org_email_config SET last_test_at = NOW(), last_test_ok = $2, last_test_error = $3 WHERE org_id = $1`,
      [req.params.id, ok, error]).catch(() => {})
    if (!ok) return res.status(502).json({ error })
    res.json({ ok: true, provider })
  } catch (e) {
    if (isMissingTable(e)) return res.status(500).json({ error: MIGRATION_083 })
    console.error('[sa-integrations] email test', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────────────
const waDiff = b => {
  const out = { ...b }
  for (const k of ['access_token', 'app_secret']) out[k] = b?.[k] && b[k] !== SECRET_MASK ? '[changed]' : undefined
  return out
}

router.put('/superadmin/org/:id/whatsapp',
  auditPlatform('org.whatsapp.update', 'integration', { diff: req => waDiff(req.body) }),
  async (req, res) => {
  const orgId = req.params.id
  const b = req.body || {}
  const phone_number_id = String(b.phone_number_id || '').trim()
  if (!/^\d{5,30}$/.test(phone_number_id)) return res.status(400).json({ error: 'Phone number ID must be the numeric ID from Meta (not the phone number itself)' })
  const keep = v => v === undefined || v === SECRET_MASK
  // An empty access token never clears the stored one (WhatsApp would stop working);
  // an empty app secret does clear it (falls back to the global WA_APP_SECRET).
  const keepToken = keep(b.access_token) || !String(b.access_token).trim()
  const keepAppSecret = keep(b.app_secret)
  const pool = getPool()
  try {
    // Same rule as PUT /wa/config: a phone_number_id identifies exactly one org
    // for inbound webhook routing, so it can't be claimed twice.
    const { rows: claimed } = await pool.query(`SELECT 1 FROM wa_config WHERE phone_number_id = $1 AND org_id <> $2`, [phone_number_id, orgId])
    if (claimed.length) return res.status(409).json({ error: 'This WhatsApp number is already connected to another organisation.' })
    const { rows: existing } = await pool.query(`SELECT 1 FROM wa_config WHERE org_id = $1`, [orgId])
    if (!existing.length && keepToken) return res.status(400).json({ error: 'An access token is required to connect WhatsApp' })

    await pool.query(
      `INSERT INTO wa_config (org_id, phone_number_id, access_token, app_secret, webhook_secret, business_id, display_phone, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE SET
         phone_number_id = $2,
         access_token   = CASE WHEN $9  THEN wa_config.access_token ELSE $3 END,
         app_secret     = CASE WHEN $10 THEN wa_config.app_secret   ELSE $4 END,
         webhook_secret = $5, business_id = $6, display_phone = $7, enabled = $8, updated_at = NOW()`,
      [orgId, phone_number_id,
       keepToken ? '' : encryptSecret(String(b.access_token).trim()),
       keepAppSecret || !String(b.app_secret).trim() ? null : encryptSecret(String(b.app_secret).trim()),
       String(b.webhook_secret || '').trim() || null, String(b.business_id || '').trim() || null,
       String(b.display_phone || '').trim() || null, b.enabled !== false,
       keepToken, keepAppSecret]
    )
    res.json({ ok: true })
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Organization not found' })
    console.error('[sa-integrations] wa put', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/superadmin/org/:id/whatsapp/test', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT phone_number_id, access_token FROM wa_config WHERE org_id = $1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'WhatsApp is not connected for this organisation' })
    const token = decryptSecret(rows[0].access_token)
    if (!token) return res.status(400).json({ error: 'The stored access token could not be read. Enter it again.' })
    const fields = 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier'
    const r = await fetch(`${WA_GRAPH}/${encodeURIComponent(rows[0].phone_number_id)}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      const m = body?.error?.message || `Meta returned ${r.status}`
      const hint = body?.error?.code === 190 ? ' The access token is invalid or expired. Use a permanent System User token.' : ''
      return res.status(502).json({ error: `${m}.${hint}` })
    }
    res.json({ ok: true, ...body })
  } catch (e) {
    console.error('[sa-integrations] wa test', e)
    res.status(502).json({ error: e.name === 'TimeoutError' ? 'Meta did not respond in time.' : 'Could not reach Meta.' })
  }
})

// ── Google Sheets ─────────────────────────────────────────────────────────────
router.post('/superadmin/sheets/test', async (req, res) => {
  const id = String(req.body?.sheet_id || '').trim()
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id)) return res.status(400).json({ error: 'That doesn’t look like a Google Sheet ID' })
  const sa = serviceAccountEmail()
  const token = await getGoogleAccessToken()
  if (!token) return res.status(503).json({ error: 'The platform Google service account is not configured on the server.' })
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (r.status === 403) return res.status(502).json({ error: `No access. Share the sheet with ${sa} as an Editor.`, code: 'NOT_SHARED' })
    if (r.status === 404) return res.status(502).json({ error: 'Sheet not found. Check the link.', code: 'NOT_FOUND' })
    if (!r.ok) return res.status(502).json({ error: `Google returned ${r.status}` })
    const body = await r.json()
    res.json({ ok: true, title: body.properties?.title, tabs: (body.sheets || []).map(s => s.properties?.title) })
  } catch (e) {
    res.status(502).json({ error: e.name === 'TimeoutError' ? 'Google did not respond in time.' : 'Could not reach Google.' })
  }
})

// ── Invite / reset links ──────────────────────────────────────────────────────
router.post('/superadmin/org/:id/users/:uid/send-link',
  auditPlatform('user.send_link', 'user', { diff: req => ({ purpose: req.body?.purpose }) }),
  async (req, res) => {
  const purpose = req.body?.purpose === 'reset' ? 'reset' : 'invite'
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, phone, email FROM users WHERE id = $1 AND org_id = $2`, [req.params.uid, req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    const result = await sendAuthLink(req, { user: rows[0], orgId: req.params.id, purpose, createdBy: req.user.uid })
    // The link is returned so it can be shared another way (e.g. WhatsApp) if email fails.
    res.json(result)
  } catch (e) {
    if (isMissingTable(e)) return res.status(500).json({ error: MIGRATION_083 })
    console.error('[sa-integrations] send-link', e)
    res.status(500).json({ error: e.message?.startsWith('APP_BASE_URL') ? e.message : 'Internal server error' })
  }
})

export default router
