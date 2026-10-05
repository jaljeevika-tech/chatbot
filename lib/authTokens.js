// lib/authTokens.js — single-use invite / password-reset links (migration 083).
// The raw token only ever exists in the emailed link; the DB keeps its SHA-256.

import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { sendOrgEmail, renderEmail, appBaseUrl, getOrgEmailConfig } from './mailer.js'

export const TOKEN_TTL_HOURS = { invite: 72, reset: 2 }
const hash = t => crypto.createHash('sha256').update(t).digest('hex')

export async function createAuthToken({ userId, orgId, purpose, createdBy }) {
  const raw = crypto.randomBytes(32).toString('base64url')
  const pool = getPool()
  // A new link supersedes older unused ones for the same user + purpose.
  await pool.query(`UPDATE auth_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose])
  await pool.query(
    `INSERT INTO auth_tokens (user_id, org_id, purpose, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5), $6)`,
    [userId, orgId, purpose, hash(raw), TOKEN_TTL_HOURS[purpose], createdBy]
  )
  return raw
}

/** Look up a token without consuming it. Returns null if unknown, used or expired. */
export async function peekAuthToken(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 100) return null
  const { rows } = await getPool().query(
    `SELECT t.id, t.purpose, t.user_id, t.org_id, u.name, u.firebase_uid, o.name AS org_name, o.slug AS org_slug
       FROM auth_tokens t JOIN users u ON u.id = t.user_id JOIN organizations o ON o.id = t.org_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()`,
    [hash(raw)]
  )
  return rows[0] || null
}

/** Atomically mark a token used. Returns the token row, or null if it was already used / expired. */
export async function consumeAuthToken(client, raw) {
  const { rows } = await client.query(
    `UPDATE auth_tokens SET used_at = NOW()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING id, purpose, user_id, org_id`,
    [hash(raw)]
  )
  return rows[0] || null
}

/** Create a link for a user and email it. Returns { link, emailed, error }. */
export async function sendAuthLink(req, { user, orgId, purpose, createdBy }) {
  const raw = await createAuthToken({ userId: user.id, orgId, purpose, createdBy })
  const link = `${appBaseUrl(req)}/set-password?token=${encodeURIComponent(raw)}`
  if (!user.email) return { link, emailed: false, error: 'This user has no email address.' }
  const cfg = await getOrgEmailConfig(orgId)
  const orgName = cfg?.branding?.org_name || cfg?.org_name || 'FieldFlow'
  const isInvite = purpose === 'invite'
  const { html, text } = renderEmail({
    branding: cfg?.branding, orgName,
    heading: isInvite ? `You've been invited to ${orgName}` : 'Reset your password',
    paragraphs: isInvite
      ? [`Hi ${user.name}, an account has been created for you on ${orgName}'s FieldFlow workspace.`,
         `Set your password to get started. This link works once and expires in ${TOKEN_TTL_HOURS.invite} hours. After that, sign in with your phone number (${user.phone}) and the password you choose.`]
      : [`Hi ${user.name}, we received a request to reset the password for your ${orgName} account.`,
         `This link works once and expires in ${TOKEN_TTL_HOURS.reset} hours. If you didn't ask for this, you can ignore this email: your password won't change.`],
    button: { label: isInvite ? 'Set your password' : 'Choose a new password', url: link },
  })
  try {
    await sendOrgEmail(orgId, { to: user.email, subject: isInvite ? `Your ${orgName} account` : `Reset your ${orgName} password`, html, text, kind: purpose }, cfg)
    return { link, emailed: true }
  } catch (e) {
    return { link, emailed: false, error: e.message }
  }
}
