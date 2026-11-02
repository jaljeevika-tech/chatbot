// lib/superadminOtp.js — email one-time code as the second factor for superadmin sign-in.
// Codes are hashed in superadmin_otp (migration 092): 10 minutes, 5 attempts, single use.

import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { sendOrgEmail, renderEmail, getOrgEmailConfig } from './mailer.js'

export const OTP_TTL_MINUTES = 10
export const OTP_MAX_ATTEMPTS = 5
const hash = c => crypto.createHash('sha256').update(c).digest('hex')

/** "ayu***@jaljeevika.org" — shown on the code screen so the user knows where it went. */
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@')
  if (!domain) return ''
  return `${local.slice(0, 3)}***@${domain}`
}

/** Create a fresh code (older unused codes are voided) and email it. Returns { emailed, error }. */
export async function sendSuperadminOtp({ user, orgId }) {
  if (!user.email) return { emailed: false, error: 'This superadmin has no email address on file.' }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const pool = getPool()
  await pool.query(`UPDATE superadmin_otp SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id])
  await pool.query(
    `INSERT INTO superadmin_otp (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
    [user.id, hash(code), OTP_TTL_MINUTES]
  )
  const cfg = await getOrgEmailConfig(orgId)
  const { html, text } = renderEmail({
    branding: cfg?.branding, orgName: 'FieldFlow',
    heading: 'Your superadmin sign-in code',
    paragraphs: [
      `Your sign-in code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes and works once.`,
      `If you didn't try to sign in, change your superadmin password now.`,
    ],
  })
  try {
    await sendOrgEmail(orgId, { to: user.email, subject: 'Your FieldFlow superadmin sign-in code', html, text, kind: 'otp' }, cfg)
    return { emailed: true }
  } catch (e) {
    return { emailed: false, error: e.message }
  }
}

/** True only for the newest live code, while attempts remain, and only once. */
export async function checkSuperadminOtp(userId, code) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts FROM superadmin_otp
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  )
  const row = rows[0]
  if (!row || row.attempts >= OTP_MAX_ATTEMPTS) return false
  await pool.query(`UPDATE superadmin_otp SET attempts = attempts + 1 WHERE id = $1`, [row.id])
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(String(code))))
  if (!ok) return false
  const { rowCount } = await pool.query(`UPDATE superadmin_otp SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id])
  return rowCount === 1
}
