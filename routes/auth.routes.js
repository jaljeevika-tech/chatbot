// routes/auth.routes.js — Authentication routes
// POST /api/auth/sheet-login  (public)
// POST /api/auth/login        (requireAuth applied at app level)
// POST /api/send-otp          (public)

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { timingSafeEqual, randomInt } from 'crypto'
import bcrypt from 'bcrypt'
import { admin, ensureFirebase } from '../lib/auth.js'
import { getPool } from '../db/pool.js'
import { getGoogleAccessToken, normPhone, USERS_SHEET_NAME } from '../lib/sheets.js'
import { stripSecretMeta } from '../lib/secretMeta.js'
import { peekAuthToken, consumeAuthToken, sendAuthLink } from '../lib/authTokens.js'

const router = Router()

// ── Rate limiters ────────────────────────────────────────────────────────────
// Brute-force cap: 8 login attempts / minute / IP (429 with retry-after). OPTIONS skipped.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a minute.' },
  skip: req => req.method === 'OPTIONS',
})
// OTP send: 3/min, since each costs SMS credit and could flood the recipient.
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Wait a minute before retrying.' },
  skip: req => req.method === 'OPTIONS',
})

// ── Server-side OTP store ─────────────────────────────────────────────────────
// TTL-keyed Map: phone → { code, expiresAt }. Purged on use or expiry.
const _otpStore = new Map()
const OTP_TTL_MS = 10 * 60 * 1000

function storeOtp(phone, code) {
  _otpStore.set(phone, { code: String(code), expiresAt: Date.now() + OTP_TTL_MS })
}
function verifyOtp(phone, code) {
  const entry = _otpStore.get(phone)
  if (!entry) return false
  if (Date.now() > entry.expiresAt) { _otpStore.delete(phone); return false }
  const valid = timingSafeEqual(Buffer.from(entry.code), Buffer.from(String(code)))
  if (valid) _otpStore.delete(phone)
  return valid
}

// timingSafeEqual throws on length mismatch, so check length first. That leaks
// only the length, and the legacy plaintext paths are rate-limited anyway.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''))
  const bufB = Buffer.from(String(b ?? ''))
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// 'superadmin' is platform-wide, so it can never come from an org-controlled value
// such as the org's Google users sheet — only from a DB role, which only an existing
// superadmin can grant (superadmin.routes.js, workers.routes.js _canAssignRole).
const ORG_ROLES = new Set(['employee', 'manager', 'admin'])
function clampRole(rawRole, existingDbRole) {
  const r = String(rawRole || 'employee').toLowerCase().trim()
  if (r === 'superadmin') return existingDbRole === 'superadmin' ? 'superadmin' : 'admin'
  return ORG_ROLES.has(r) ? r : 'employee'
}

// ── POST /api/auth/sheet-login ────────────────────────────────────────────────
router.post('/auth/sheet-login', loginLimiter, async (req, res) => {
  // One message for every failure, so users/orgs can't be enumerated
  const DENIED = 'Invalid credentials.'
  try {
    const { phone, password, orgSlug } = req.body || {}
    // orgSlug is required — no default tenant
    if (!phone || !password || !orgSlug) {
      return res.status(400).json({ error: 'phone, password and orgSlug are required' })
    }

    const target = normPhone(phone)

    const pool = getPool()
    const { rows: orgRows } = await pool.query(
      // Case-insensitive: login links get typed and shared by hand (?org=pratham vs Pratham).
      'SELECT id, slug, metadata FROM organizations WHERE lower(slug) = lower($1) ORDER BY (slug = $1) DESC LIMIT 1', [orgSlug]
    )
    if (!orgRows.length) return res.status(403).json({ error: DENIED })
    const org = orgRows[0]
    const orgId = org.id

    ensureFirebase()

    // ── 1. DB-managed users first ──
    let dbUsers = []
    try {
      const dbRes = await pool.query(
        `SELECT id, name, role, password, exit_date, to_jsonb(u) ->> 'active' AS active
           FROM users u WHERE org_id = $1 AND phone = $2`,
        [orgId, target]
      )
      dbUsers = dbRes.rows
    } catch (dbErr) {
      // password column may not exist on first boot — fall through to sheet login
      console.warn('[sheet-login] DB lookup skipped:', dbErr.message)
    }
    if (dbUsers.length && dbUsers[0].password) {
      const dbUser = dbUsers[0]
      const isLegacyPlaintext = !dbUser.password.startsWith('$2')
      // bcrypt, with a plaintext fallback for unmigrated rows
      const passOk = isLegacyPlaintext
        ? timingSafeStringEqual(dbUser.password.trim(), password.trim())
        : await bcrypt.compare(password, dbUser.password)
      if (!passOk) return res.status(403).json({ error: DENIED })
      if ((dbUser.exit_date && new Date(dbUser.exit_date) <= new Date()) || dbUser.active === 'false') {
        return res.status(403).json({ error: 'Your account has been deactivated. Please contact your administrator.' })
      }
      // DPDP §8(5): rehash a plaintext row as soon as it authenticates. Once the
      // warning below stops appearing, the plaintext branch can be deleted.
      if (isLegacyPlaintext) {
        console.warn(`[sheet-login] migrating plaintext password to bcrypt for user ${dbUser.id} (org ${orgId})`)
        bcrypt.hash(password, 10)
          .then(newHash => pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [newHash, dbUser.id]))
          .catch(e => console.warn('[sheet-login] plaintext->bcrypt migration failed:', e.message))
      }
      // DB role is authoritative here (only superadmin can write 'superadmin' to it).
      const normRole = clampRole(dbUser.role, String(dbUser.role || '').toLowerCase().trim())
      const uid = `sheet_${org.slug}_${target}`
      const customToken = await admin.auth().createCustomToken(uid, {
        orgId, role: normRole, name: dbUser.name, phone: target,
      })
      await pool.query(
        `UPDATE users SET firebase_uid = $1 WHERE id = $2`,
        [uid, dbUser.id]
      )
      return res.json({ customToken })
    }

    // ── 2. Fall back to Google Sheet (sheet-configured orgs) ──
    // An org without its own users_sheet_id must never fall back to the shared
    // USERS_SHEET_ID default — that is Jaljeevika's live roster. Deny instead.
    const sheetId = org.metadata?.data_sources?.users_sheet_id
    if (!sheetId) return res.status(403).json({ error: DENIED })
    const gToken = await getGoogleAccessToken()
    if (!gToken) return res.status(503).json({ error: 'Google service account not configured' })

    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A:G`,
      { headers: { Authorization: `Bearer ${gToken}` } }
    )
    if (!sheetRes.ok) return res.status(403).json({ error: DENIED })
    const sheetData = await sheetRes.json()
    const rows = sheetData.values || []
    const userRow = rows.slice(1).find(r => normPhone(r[1] || '') === target)
    if (!userRow) return res.status(403).json({ error: DENIED })

    const [name, , , role, , sheetPassword, activeFlag] = userRow
    if ((activeFlag || 'TRUE').toUpperCase() === 'FALSE') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact your administrator.' })
    }
    if (!timingSafeStringEqual((sheetPassword || '').trim(), (password || '').trim())) {
      return res.status(403).json({ error: DENIED })
    }

    // Sheet role is org-controlled → clamp; 'superadmin' only survives if the
    // DB row already had it (granted by an existing superadmin).
    const normRole = clampRole(role, String(dbUsers[0]?.role || '').toLowerCase().trim())
    const uid = `sheet_${org.slug}_${target}`
    const customToken = await admin.auth().createCustomToken(uid, {
      orgId, role: normRole, name, phone: target,
    })
    await pool.query(
      `INSERT INTO users (org_id, phone, name, role, firebase_uid)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, phone) DO UPDATE SET name=$3, role=$4, firebase_uid=$5`,
      [orgId, target, name, normRole, uid]
    )
    res.json({ customToken })
  } catch (e) {
    console.error('[sheet-login]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/auth/login — set Firebase custom claims after phone-OTP verification
router.post('/auth/login', async (req, res) => {
  try {
    const pool = getPool()

    // Look up user by firebase_uid first, then fall back to phone number
    const phone = (req.user.phone || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
    let { rows } = await pool.query(
      'SELECT u.id, u.org_id, u.name, u.role, o.metadata FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.firebase_uid = $1',
      [req.user.uid]
    )

    if (!rows.length && phone) {
      // The same phone can belong to users in several orgs. Link exactly one row:
      // the org being signed in to (orgSlug), or the only match if the phone is unique.
      const orgSlug = String(req.body?.orgSlug || '').trim()
      const { rows: matches } = await pool.query(
        `SELECT u.id, u.org_id FROM users u JOIN organizations o ON o.id = u.org_id
          WHERE u.phone = $1 AND ($2 = '' OR lower(o.slug) = lower($2))`,
        [phone, orgSlug]
      )
      if (matches.length > 1) {
        return res.status(409).json({ error: 'This number is registered with more than one organisation. Please sign in using your organisation\'s login link.' })
      }
      if (matches.length === 1) {
        const byPhone = await pool.query(
          'UPDATE users SET firebase_uid = $1 WHERE id = $2 RETURNING id, org_id, name, role',
          [req.user.uid, matches[0].id]
        )
        const u = byPhone.rows[0]
        const orgRes = await pool.query('SELECT metadata FROM organizations WHERE id = $1', [u.org_id])
        rows = [{ ...u, metadata: orgRes.rows[0]?.metadata }]
      }
    }

    if (!rows.length) {
      return res.status(403).json({ error: 'User not registered in this platform. Contact your administrator.' })
    }

    const { id: userId, org_id: orgId, name, role, metadata } = rows[0]
    await admin.auth().setCustomUserClaims(req.user.uid, { orgId, role, name })
    res.json({ success: true, orgId, metadata: stripSecretMeta(metadata) })
  } catch (e) {
    console.error('[auth/login]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/send-otp ────────────────────────────────────────────────────────
// OTP is generated server-side and kept in memory (10 min TTL) for /api/verify-otp.
router.post('/send-otp', otpLimiter, async (req, res) => {
  const { phone, channel } = req.body
  if (!phone) return res.status(400).json({ success: false, error: 'phone required' })

  const otp = String(randomInt(100000, 999999))
  storeOtp(phone, otp)

  const TWILIO_SID      = process.env.TWILIO_SID
  const TWILIO_TOKEN    = process.env.TWILIO_TOKEN
  const TWILIO_PHONE    = process.env.TWILIO_PHONE
  const TWILIO_WHATSAPP = process.env.TWILIO_WHATSAPP
  const FAST2SMS_KEY    = process.env.FAST2SMS_KEY

  let success = false
  let error   = null

  if (TWILIO_SID && TWILIO_TOKEN && channel === 'sms') {
    try {
      const auth  = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')
      const twRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method:  'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            From: TWILIO_PHONE || '',
            To:   phone.startsWith('+') ? phone : `+${phone}`,
            Body: `Your FieldFlow verification code is: ${otp}. Do not share this with anyone.`,
          }),
        }
      )
      if (twRes.ok) success = true
      else error = 'Failed to send SMS'
    } catch (e) { error = 'Failed to send SMS' }

  } else if (TWILIO_SID && TWILIO_TOKEN && channel === 'whatsapp') {
    try {
      const auth  = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')
      const twRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method:  'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            From: `whatsapp:${(TWILIO_WHATSAPP || '').replace('whatsapp:', '')}`,
            To:   `whatsapp:${phone.startsWith('+') ? phone : `+${phone}`}`,
            Body: `Your FieldFlow verification code is: ${otp}. Do not share this with anyone.`,
          }),
        }
      )
      if (twRes.ok) success = true
      else error = 'Failed to send WhatsApp message'
    } catch (e) { error = 'Failed to send WhatsApp message' }

  } else if (FAST2SMS_KEY && channel === 'sms') {
    try {
      const f2Res = await fetch(
        `https://www.fast2sms.com/dev/bulkV2?authorization=${FAST2SMS_KEY}&route=otp&variables_values=${otp}&numbers=${phone.replace(/\+/g, '')}`
      )
      if (f2Res.ok) success = true
      else error = 'Failed to send SMS'
    } catch (e) { error = 'Failed to send SMS' }

  } else {
    // No provider matched `channel`: either none is configured (fine in dev) or
    // the channel is invalid. Never report success or log the OTP in production.
    const hasAnyProvider = !!((TWILIO_SID && TWILIO_TOKEN) || FAST2SMS_KEY)
    if (hasAnyProvider) {
      // A provider is configured — this is a genuine unsupported/invalid channel.
      success = false
      error = `Unsupported or missing channel: "${channel}"`
    } else if (process.env.NODE_ENV === 'production') {
      // No provider in production: fail rather than pretend an OTP was sent.
      success = false
      error = 'SMS/WhatsApp provider not configured'
      console.error('[send-otp] No SMS provider configured in production — refusing to fake success.')
    } else {
      // Local/dev/demo environment with no provider configured — safe to log.
      success = true
      console.log(`[send-otp] DEV MODE: OTP for ${phone} is ${otp}`)
    }
  }

  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ success, error }))
})

// ── POST /api/verify-otp ──────────────────────────────────────────────────────
// Verify the server-generated OTP. Returns { valid: bool }.
router.post('/verify-otp', loginLimiter, (req, res) => {
  const { phone, otp } = req.body || {}
  if (!phone || !otp) return res.status(400).json({ valid: false, error: 'phone and otp required' })
  const valid = verifyOtp(phone, String(otp))
  res.json({ valid })
})

// ── Invite / password-reset links (public; lib/authTokens.js, migration 083) ──
const MIN_PASSWORD_LEN = 10

// GET /api/auth/token-info?token= — lets the set-password page greet the user
// and show which org they're joining, without consuming the token.
router.get('/auth/token-info', loginLimiter, async (req, res) => {
  try {
    const t = await peekAuthToken(String(req.query.token || ''))
    if (!t) return res.json({ valid: false })
    res.json({ valid: true, purpose: t.purpose, name: t.name, org_name: t.org_name, org_slug: t.org_slug })
  } catch (e) {
    console.error('[auth/token-info]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/auth/set-password { token, password }
router.post('/auth/set-password', loginLimiter, async (req, res) => {
  const { token, password } = req.body || {}
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` })
  }
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const t = await consumeAuthToken(client, String(token || ''))
    if (!t) {
      await client.query('ROLLBACK')
      return res.status(410).json({ error: 'This link has expired or was already used. Ask your administrator for a new one, or use "Forgot password".' })
    }
    const hashed = await bcrypt.hash(password, 12)
    const { rows } = await client.query(
      `UPDATE users u SET password = $1 FROM organizations o WHERE u.id = $2 AND o.id = u.org_id RETURNING u.firebase_uid, o.slug`,
      [hashed, t.user_id]
    )
    await client.query('COMMIT')
    // Signs out every existing session — the point of a reset.
    if (rows[0]?.firebase_uid) {
      try { ensureFirebase(); await admin.auth().revokeRefreshTokens(rows[0].firebase_uid) }
      catch (e) { if (e.code !== 'auth/user-not-found') console.warn('[auth/set-password] revoke failed:', e.message) }
    }
    res.json({ ok: true, org_slug: rows[0]?.slug })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[auth/set-password]', e)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// POST /api/auth/forgot-password { orgSlug, phone } — always answers the same
// way, so it can't be used to find out which numbers have accounts.
router.post('/auth/forgot-password', loginLimiter, async (req, res) => {
  const GENERIC = { ok: true, message: 'If this number has an account with an email address, a reset link has been sent to it.' }
  const { orgSlug, phone } = req.body || {}
  if (!orgSlug || !phone) return res.status(400).json({ error: 'orgSlug and phone are required' })
  try {
    const { rows } = await getPool().query(
      `SELECT u.id, u.name, u.phone, u.email, u.org_id,
              EXISTS (SELECT 1 FROM auth_tokens t WHERE t.user_id = u.id AND t.purpose = 'reset'
                       AND t.created_at > NOW() - INTERVAL '2 minutes') AS recently_sent
         FROM users u JOIN organizations o ON o.id = u.org_id
        WHERE lower(o.slug) = lower($1) AND u.phone = $2`,
      [String(orgSlug), normPhone(phone)]
    )
    const u = rows[0]
    if (u?.email && !u.recently_sent) {
      const r = await sendAuthLink(req, { user: u, orgId: u.org_id, purpose: 'reset', createdBy: 'self' })
      if (!r.emailed) console.warn('[auth/forgot-password] email not sent:', r.error)
    }
    res.json(GENERIC)
  } catch (e) {
    console.error('[auth/forgot-password]', e)
    res.json(GENERIC)
  }
})

export default router
