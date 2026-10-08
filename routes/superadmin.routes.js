// Superadmin-only routes. Every write is recorded in platform_audit_log
// (lib/platformAudit.js, migration 082).
// GET  /api/superadmin/orgs
// GET  /api/superadmin/stats
// POST /api/superadmin/orgs
// PATCH /api/superadmin/org/:id/metadata
// POST /api/superadmin/org/:id/suspend
// POST /api/superadmin/org/:id/unsuspend
// GET  /api/superadmin/plans
// POST /api/superadmin/plans
// PATCH /api/superadmin/plans/:id
// GET  /api/superadmin/org/:id/subscription
// POST /api/superadmin/org/:id/subscription
// GET  /api/superadmin/org/:id/users
// POST /api/superadmin/org/:id/users
// PATCH /api/superadmin/org/:id/users/:uid
// DELETE /api/superadmin/org/:id/users/:uid
// GET  /api/superadmin/audit

import { Router } from 'express'
import bcrypt from 'bcrypt'
import { requireSuperAdmin, admin, ensureFirebase } from '../lib/auth.js'
import { getPool } from '../db/pool.js'
import { normPhone } from '../lib/sheets.js'
import { invalidateOrgMeta } from '../lib/orgMetaCache.js'
import { maskSecretMeta, prepareSecretPatch } from '../lib/secretMeta.js'
import { auditPlatform, writePlatformAudit } from '../lib/platformAudit.js'
import { computeAccess, invalidateOrgAccess, checkSeatAvailable, APP_PREFIXES } from '../lib/subscriptionGuard.js'

// plans.apps: null = every app, else a subset of APP_PREFIXES keys. undefined = not sent.
const badApps = apps => apps !== undefined && apps !== null &&
  (!Array.isArray(apps) || apps.some(a => !Object.hasOwn(APP_PREFIXES, a)))

const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LEN = 10
const USER_ROLES = new Set(['employee', 'manager', 'admin'])
const SUB_STATUSES = new Set(['active', 'trialing', 'expired', 'inactive'])

const router = Router()

router.use('/superadmin', requireSuperAdmin)

const passwordError = (pw) =>
  pw && pw.length < MIN_PASSWORD_LEN ? `Password must be at least ${MIN_PASSWORD_LEN} characters` : null

// Signs the user out everywhere after a password / role change or removal, so
// an old ID token can't keep acting with stale rights (requireAuth verifies
// with checkRevoked=true).
async function revokeSessions(firebaseUid) {
  if (!firebaseUid) return
  try { ensureFirebase(); await admin.auth().revokeRefreshTokens(firebaseUid) }
  catch (e) { if (e.code !== 'auth/user-not-found') console.warn('[superadmin] revoke failed:', e.message) }
}

// ── GET /api/superadmin/orgs ──────────────────────────────────────────────────
router.get('/superadmin/orgs', async (req, res) => {
  try {
    const pool = getPool()
    const { rows } = await pool.query(`
      SELECT o.id, o.slug, o.name, o.metadata, o.created_at,
             o.subscription_status, o.subscription_expires_at, o.billing_email, o.suspended_reason,
             p.id AS plan_id, p.name AS plan_name, p.slug AS plan_slug, p.ai_enabled, p.max_users,
             (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS user_count
      FROM organizations o
      LEFT JOIN plans p ON p.id = o.plan_id
      ORDER BY o.name
    `)
    // Secrets never leave the server — the console only learns they're set.
    res.json(rows.map(r => ({ ...r, metadata: maskSecretMeta(r.metadata), access_state: computeAccess(r).state })))
  } catch (e) {
    console.error('[superadmin]', req.method, req.path, e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/superadmin/stats ─────────────────────────────────────────────────
router.get('/superadmin/stats', async (req, res) => {
  try {
    const pool = getPool()
    const [orgsRes, plansRes, usersRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_orgs,
          COUNT(*) FILTER (WHERE subscription_status = 'active')   AS active_orgs,
          COUNT(*) FILTER (WHERE subscription_status = 'trialing') AS trialing_orgs,
          COUNT(*) FILTER (WHERE subscription_status = 'expired')  AS expired_orgs,
          COUNT(*) FILTER (WHERE subscription_status = 'suspended') AS suspended_orgs,
          COUNT(*) FILTER (WHERE subscription_status = 'inactive' OR subscription_status IS NULL) AS inactive_orgs
        FROM organizations
      `),
      pool.query(`
        SELECT p.name AS plan_name, p.slug, COUNT(o.id) AS org_count
        FROM plans p
        LEFT JOIN organizations o ON o.plan_id = p.id
        GROUP BY p.id, p.name, p.slug
        ORDER BY p.sort_order
      `),
      pool.query('SELECT COUNT(*) AS total_users FROM users'),
    ])
    res.json({
      orgs:  orgsRes.rows[0],
      plans: plansRes.rows,
      users: usersRes.rows[0],
    })
  } catch (e) {
    console.error('[superadmin]', req.method, req.path, e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/superadmin/orgs — create a new organization ─────────────────────
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
router.post('/superadmin/orgs',
  auditPlatform('org.create', 'organization', { orgId: (_req, body) => body?.id || null, targetId: (_req, body) => body?.id || null }),
  async (req, res) => {
  const { slug, name, plan_id = null, billing_email = '' } = req.body || {}
  // New orgs start as a 30-day trial (agreed 2026-10-03) unless told otherwise.
  const trialDays = Math.min(Math.max(parseInt(req.body?.trial_days ?? 30, 10) || 30, 1), 365)
  if (!slug?.trim() || !name?.trim()) {
    return res.status(400).json({ error: 'slug and name are required' })
  }
  const cleanSlug = slug.trim().toLowerCase()
  if (!SLUG_RE.test(cleanSlug)) {
    return res.status(400).json({ error: 'Slug may only contain lowercase letters, numbers and hyphens (max 50)' })
  }
  // Full metadata isn't accepted here: it would bypass PATCH /metadata's key
  // allowlist and secret encryption.
  const defaultMetadata = {
    branding: {
      org_name: name.trim(),
      tagline: '',
      dashboard_title: `${name.trim()} Dashboard`,
      logo_url: '',
      theme: {
        primary:    '#1D0752',
        sidebar:    '#341272',
        accent:     '#A78BFA',
        background: '#F5F3FB',
      },
    },
    modules: {
      dashboard:     { enabled: true  },
      workers:       { enabled: true  },
      reports:       { enabled: true  },
      notebook:      { enabled: false },
      finance:       { enabled: false },
      report_writer: { enabled: false },
      social_posts:  { enabled: false },
    },
    ai_config: {
      system_persona: `You are a helpful assistant for ${name.trim()}, an NGO focused on community development.`,
    },
  }
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO organizations (slug, name, metadata, plan_id, billing_email, subscription_status, subscription_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'trialing', NOW() + make_interval(days => $6))
       RETURNING id, slug, name, subscription_status, subscription_expires_at`,
      [cleanSlug, name.trim(), JSON.stringify(defaultMetadata), plan_id || null, String(billing_email || '').trim(), trialDays]
    )
    res.json(rows[0])
  } catch (e) {
    const isDup = e.code === '23505'
    res.status(isDup ? 409 : 500).json({ error: isDup ? 'Slug already exists — choose a different one' : 'Internal server error' })
  }
})

// ── Allowlist of top-level metadata keys a superadmin may patch ───────────────
// Permission keys use the camelCase names the app actually reads.
const METADATA_ALLOWED_KEYS = new Set([
  'branding', 'modules', 'ai_config', 'data_sources', 'features',
  'contentHubPermissions', 'tabPermissions', 'glific_webhook_secret',
  'glific_org_code', 'subscription_notes',
])

// ── PATCH /api/superadmin/org/:id/metadata ────────────────────────────────────
router.patch('/superadmin/org/:id/metadata',
  auditPlatform('org.metadata.update', 'organization'),
  async (req, res) => {
  const { id } = req.params
  const patch = req.body
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' })
  }
  const unknownKeys = Object.keys(patch).filter(k => !METADATA_ALLOWED_KEYS.has(k))
  if (unknownKeys.length) {
    return res.status(400).json({ error: `Unknown metadata keys: ${unknownKeys.join(', ')}` })
  }
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      'UPDATE organizations SET metadata = metadata || $1::jsonb WHERE id = $2 RETURNING id, metadata',
      [JSON.stringify(prepareSecretPatch(patch)), id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    invalidateOrgMeta(id)
    res.json({ id: rows[0].id, metadata: maskSecretMeta(rows[0].metadata) })
  } catch (e) {
    console.error('[superadmin]', req.method, req.path, e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Suspend / unsuspend — manual kill switch (read-only immediately) ──────────
router.post('/superadmin/org/:id/suspend',
  auditPlatform('org.suspend', 'organization'),
  async (req, res) => {
  const reason = String(req.body?.reason || '').trim()
  if (!reason) return res.status(400).json({ error: 'A reason is required to suspend an organisation' })
  try {
    // The previous status is kept in metadata so unsuspend can restore it.
    const { rows } = await getPool().query(
      `UPDATE organizations
          SET metadata = metadata || jsonb_build_object('pre_suspend_status', COALESCE(subscription_status, 'inactive')),
              subscription_status = 'suspended', suspended_at = NOW(), suspended_reason = $2
        WHERE id = $1 AND subscription_status IS DISTINCT FROM 'suspended'
        RETURNING id, subscription_status`,
      [req.params.id, reason]
    )
    if (!rows.length) return res.status(409).json({ error: 'Organisation not found or already suspended' })
    invalidateOrgAccess(req.params.id)
    res.json(rows[0])
  } catch (e) {
    if (e.code === '23514' || e.code === '42703') {
      return res.status(500).json({ error: 'Database migration 082_superadmin_hardening.sql has not been run yet' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/superadmin/org/:id/unsuspend',
  auditPlatform('org.unsuspend', 'organization'),
  async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE organizations
          SET subscription_status = COALESCE(NULLIF(metadata->>'pre_suspend_status', 'suspended'), 'active'),
              metadata = metadata - 'pre_suspend_status',
              suspended_at = NULL, suspended_reason = NULL
        WHERE id = $1 AND subscription_status = 'suspended'
        RETURNING id, subscription_status`,
      [req.params.id]
    )
    if (!rows.length) return res.status(409).json({ error: 'Organisation not found or not suspended' })
    invalidateOrgAccess(req.params.id)
    res.json(rows[0])
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── Plans CRUD ────────────────────────────────────────────────────────────────

router.get('/superadmin/plans', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM plans ORDER BY sort_order, name')
    res.json(rows)
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

router.post('/superadmin/plans',
  auditPlatform('plan.create', 'plan', { orgId: () => null }),
  async (req, res) => {
  const { name, slug, description = '', price_monthly = 0, max_users = 10, ai_enabled = false, sort_order = 0, apps } = req.body || {}
  if (!name?.trim() || !slug?.trim()) return res.status(400).json({ error: 'name and slug required' })
  if (badApps(apps)) return res.status(400).json({ error: 'unknown app in apps' })
  try {
    const withApps = Array.isArray(apps)  // omit the column otherwise, so this works before migration 088
    const { rows } = await getPool().query(
      `INSERT INTO plans (name,slug,description,price_monthly,max_users,ai_enabled,sort_order${withApps ? ',apps' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7${withApps ? ',$8' : ''}) RETURNING *`,
      [name.trim(), slug.trim(), description, price_monthly, max_users, ai_enabled, sort_order, ...(withApps ? [apps] : [])]
    )
    res.json(rows[0])
  } catch (e) {
    const isDup = e.code === '23505'
    res.status(isDup ? 409 : 500).json({ error: isDup ? 'slug already exists' : 'Internal server error' })
  }
})

router.patch('/superadmin/plans/:id',
  auditPlatform('plan.update', 'plan', { orgId: () => null }),
  async (req, res) => {
  const { id } = req.params
  const { name, description, price_monthly, max_users, ai_enabled, sort_order, is_active, apps } = req.body || {}
  if (badApps(apps)) return res.status(400).json({ error: 'unknown app in apps' })
  try {
    const pool = getPool()
    const fields = [], vals = []
    let i = 1
    if (name          !== undefined) { fields.push(`name=$${i++}`);          vals.push(name) }
    if (description   !== undefined) { fields.push(`description=$${i++}`);   vals.push(description) }
    if (price_monthly !== undefined) { fields.push(`price_monthly=$${i++}`); vals.push(price_monthly) }
    if (max_users     !== undefined) { fields.push(`max_users=$${i++}`);     vals.push(max_users) }
    if (ai_enabled    !== undefined) { fields.push(`ai_enabled=$${i++}`);    vals.push(ai_enabled) }
    if (sort_order    !== undefined) { fields.push(`sort_order=$${i++}`);    vals.push(sort_order) }
    if (is_active     !== undefined) { fields.push(`is_active=$${i++}`);     vals.push(is_active) }
    if (apps          !== undefined) { fields.push(`apps=$${i++}`);          vals.push(apps) }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' })
    vals.push(id)
    const { rows } = await pool.query(
      `UPDATE plans SET ${fields.join(',')} WHERE id=$${i} RETURNING *`, vals
    )
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' })
    invalidateOrgAccess()   // plan limits feed every org's access state
    res.json(rows[0])
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── Org subscription management ───────────────────────────────────────────────

router.get('/superadmin/org/:id/subscription', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT o.id, o.name, o.slug, o.subscription_status, o.subscription_expires_at,
              o.billing_email, o.billing_notes, o.plan_id,
              p.name AS plan_name, p.slug AS plan_slug, p.ai_enabled, p.price_monthly, p.max_users
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id
       WHERE o.id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.json({ ...rows[0], access: computeAccess(rows[0]) })
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

router.post('/superadmin/org/:id/subscription',
  auditPlatform('org.subscription.update', 'organization'),
  async (req, res) => {
  const { id } = req.params
  const { plan_id, expires_at, billing_email, billing_notes } = req.body || {}
  // The editor round-trips the current status, so 'suspended' just means "unchanged".
  const status = req.body?.status === 'suspended' ? null : req.body?.status
  // 'suspended' is only set/cleared through /suspend + /unsuspend (reason required).
  if (status && !SUB_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Use Suspend / Unsuspend to change suspension; status must be active, trialing, expired or inactive' })
  }
  try {
    const { rows } = await getPool().query(
      `UPDATE organizations
       SET plan_id                  = COALESCE($1, plan_id),
           subscription_status     = CASE WHEN subscription_status = 'suspended' THEN subscription_status
                                          ELSE COALESCE($2, subscription_status) END,
           subscription_expires_at = CASE WHEN $7 THEN NULL ELSE COALESCE($3, subscription_expires_at) END,
           billing_email           = COALESCE($4, billing_email),
           billing_notes           = COALESCE($5, billing_notes)
       WHERE id = $6
       RETURNING id, name, subscription_status, subscription_expires_at, billing_email, plan_id`,
      [plan_id || null, status || null, expires_at || null, billing_email ?? null, billing_notes ?? null, id, expires_at === '']
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    invalidateOrgAccess(id)
    res.json(rows[0])
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── Org user management ───────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
const MIGRATION_083 = 'Database migration 083_org_integrations.sql has not been run yet, so emails can’t be saved.'
/** '' clears, undefined leaves unchanged, anything else must look like an email. */
function cleanEmail(v) {
  if (v === undefined) return { value: undefined }
  const e = String(v || '').trim().toLowerCase()
  if (e && !EMAIL_RE.test(e)) return { error: 'Enter a valid email address' }
  return { value: e || null }
}

router.get('/superadmin/org/:id/users', async (req, res) => {
  const sql = (withEmail) => `SELECT id, name, phone, role, created_at, ${withEmail ? 'email,' : ''}
              (password IS NOT NULL AND password != '') AS has_password
       FROM users WHERE org_id = $1 ORDER BY name`
  try {
    const { rows } = await getPool().query(sql(true), [req.params.id])
      .catch(e => { if (e.code === '42703') return getPool().query(sql(false), [req.params.id]); throw e })
    res.json(rows)
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

// Passwords are never echoed in the audit diff (redactDeep masks the key).
router.post('/superadmin/org/:id/users',
  auditPlatform('user.create', 'user', { targetId: (_req, body) => body?.id || null }),
  async (req, res) => {
  const { name, phone, role = 'employee', password = '', override_seat_limit = false } = req.body || {}
  if (!name?.trim() || !phone?.trim()) return res.status(400).json({ error: 'name and phone required' })
  const email = cleanEmail(req.body?.email)
  if (email.error) return res.status(400).json({ error: email.error })
  const cleanRole = String(role).toLowerCase().trim()
  if (!USER_ROLES.has(cleanRole)) return res.status(400).json({ error: 'role must be employee, manager or admin' })
  const pwErr = passwordError(password)
  if (pwErr) return res.status(400).json({ error: pwErr })
  try {
    const pool = getPool()
    const exists = await pool.query('SELECT 1 FROM users WHERE org_id = $1 AND phone = $2', [req.params.id, normPhone(phone)])
    if (!exists.rows.length && !override_seat_limit) {
      const seat = await checkSeatAvailable(req.params.id)
      if (!seat.ok) {
        return res.status(409).json({ error: `Plan seat limit reached (${seat.used}/${seat.max}). Upgrade the plan or add with override.`, code: 'SEAT_LIMIT' })
      }
    }
    const hashed = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : ''
    // Re-adding an existing phone with no password (e.g. "invite instead")
    // must not wipe the password that user already has.
    const { rows } = await pool.query(
      `INSERT INTO users (org_id, phone, name, role, password, firebase_uid${email.value !== undefined ? ', email' : ''})
       VALUES ($1, $2, $3, $4, $5, $6${email.value !== undefined ? ', $7' : ''})
       ON CONFLICT (org_id, phone) DO UPDATE SET name=$3, role=$4,
         password = CASE WHEN $5 = '' THEN users.password ELSE $5 END
         ${email.value !== undefined ? ', email = $7' : ''}
       RETURNING id, name, phone, role,
                 (password IS NOT NULL AND password != '') AS has_password`,
      [req.params.id, normPhone(phone), name.trim(), cleanRole, hashed, `db_${req.params.id}_${normPhone(phone)}`,
       ...(email.value !== undefined ? [email.value] : [])]
    )
    res.json(rows[0])
  } catch (e) {
    if (e.code === '42703') return res.status(500).json({ error: MIGRATION_083 })
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/superadmin/org/:id/users/:uid',
  auditPlatform('user.update', 'user'),
  async (req, res) => {
  const { name, role, password } = req.body || {}
  if (role && !USER_ROLES.has(String(role).toLowerCase().trim())) {
    return res.status(400).json({ error: 'role must be employee, manager or admin' })
  }
  const pwErr = passwordError(password)
  if (pwErr) return res.status(400).json({ error: pwErr })
  const email = cleanEmail(req.body?.email)
  if (email.error) return res.status(400).json({ error: email.error })
  try {
    const sets = []; const vals = []
    if (name)                { sets.push(`name     = $${sets.length + 1}`); vals.push(name.trim()) }
    if (email.value !== undefined) { sets.push(`email = $${sets.length + 1}`); vals.push(email.value) }
    if (role)                { sets.push(`role     = $${sets.length + 1}`); vals.push(role.toLowerCase().trim()) }
    if (password !== undefined) {
      const hashed = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : ''
      sets.push(`password = $${sets.length + 1}`)
      vals.push(hashed)
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
    vals.push(req.params.uid, req.params.id)
    const { rows } = await getPool().query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND org_id = $${vals.length}
       RETURNING id, name, phone, role, firebase_uid,
                 (password IS NOT NULL AND password != '') AS has_password`,
      vals
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    const { firebase_uid, ...user } = rows[0]
    if (role || password !== undefined) await revokeSessions(firebase_uid)
    res.json(user)
  } catch (e) { console.error('[superadmin]', req.method, req.path, e); res.status(500).json({ error: 'Internal server error' }) }
})

router.delete('/superadmin/org/:id/users/:uid', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'DELETE FROM users WHERE id = $1 AND org_id = $2 RETURNING name, phone, role, firebase_uid',
      [req.params.uid, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    await revokeSessions(rows[0].firebase_uid)
    writePlatformAudit(req, {
      action: 'user.delete', targetOrgId: req.params.id, targetType: 'user', targetId: req.params.uid,
      diff: { name: rows[0].name, phone: rows[0].phone, role: rows[0].role },
    })
    res.json({ ok: true })
  } catch (e) {
    if (e.code === '23503') {
      return res.status(409).json({ error: 'This user has records (reports, approvals…) linked to them and cannot be deleted. Change their role or reset their password instead.' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/superadmin/audit — platform audit trail viewer ──────────────────
router.get('/superadmin/audit', async (req, res) => {
  const { org_id, action, before } = req.query
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  const where = [], vals = []
  if (org_id) { vals.push(org_id); where.push(`a.target_org_id = $${vals.length}`) }
  if (action) { vals.push(`${action}%`); where.push(`a.action LIKE $${vals.length}`) }
  if (before) { vals.push(before); where.push(`a.id < $${vals.length}`) }
  vals.push(limit)
  try {
    const { rows } = await getPool().query(
      `SELECT a.id, a.actor_uid, a.actor_name, a.action, a.target_org_id, o.name AS target_org_name,
              a.target_type, a.target_id, a.diff, a.ip, a.created_at
         FROM platform_audit_log a
         LEFT JOIN organizations o ON o.id = a.target_org_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC LIMIT $${vals.length}`,
      vals
    )
    res.json(rows)
  } catch (e) {
    if (e.code === '42P01') return res.json([])   // migration 082 not run yet
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
