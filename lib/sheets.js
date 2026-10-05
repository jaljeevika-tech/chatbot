// lib/sheets.js — Google Sheets auth + read/write helpers
// Used by auth (sheet-login fallback) and user management routes.

import { createSign } from 'crypto'
import { getPool } from '../db/pool.js'

export const USERS_SHEET_ID   = '14qcsnumtAQp2u8mTkQ-3hvioQ_8RDfweNGEZSsv3HrE'
export const USERS_SHEET_NAME = 'Sheet1'

/** Normalise a phone number to 12-digit format (91xxxxxxxxxx) */
export function normPhone(p) {
  const c = String(p || '').replace(/\D/g, '')
  if (c.length === 10) return '91' + c
  if (c.length === 12 && c.startsWith('91')) return c
  if (c.length > 12 && c.startsWith('9191')) return c.slice(2)
  return c
}

/** Generate a short-lived Google OAuth2 access token using a service account */
export async function getGoogleAccessToken() {
  const keyJson = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
  if (!keyJson) return null
  try {
    const sa  = JSON.parse(keyJson)
    const now = Math.floor(Date.now() / 1000)
    const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const pld = Buffer.from(JSON.stringify({
      iss:   sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now + 3600,
      iat:   now,
    })).toString('base64url')
    const signer = createSign('RSA-SHA256')
    signer.update(`${hdr}.${pld}`)
    const jwt = `${hdr}.${pld}.${signer.sign(sa.private_key, 'base64url')}`
    const tr  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    })
    const td = await tr.json()
    return td.access_token || null
  } catch (e) {
    console.error('[user-mgmt] token error:', e)
    return null
  }
}

/** Find the 1-indexed row number in a Sheets column by phone number */
// No default sheetId on purpose: a shared default would let a caller that forgot
// the org's own sheet read/modify another tenant's users.
export async function findUserRowIndex(token, phone, sheetId) {
  if (!sheetId) return -1
  const data = await (await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A:B`,
    { headers: { Authorization: `Bearer ${token}` } }
  )).json()
  const rows   = data.values || []
  const target = normPhone(phone)
  for (let i = 1; i < rows.length; i++) {
    if (normPhone(rows[i][1] || '') === target) return i + 1 // 1-indexed Sheets row
  }
  return -1
}

/**
 * Resolve the requesting org's users sheet ID, or null if it has none.
 * Callers MUST refuse on null — never fall back to the shared USERS_SHEET_ID.
 */
export async function resolveUsersSheetId(user) {
  if (!user.orgId) return null
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      'SELECT metadata FROM organizations WHERE id = $1', [user.orgId]
    )
    const id = rows[0]?.metadata?.data_sources?.users_sheet_id
    return typeof id === 'string' && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}
