// lib/consent.js — read-only consent lookups. consent_records is append-only, so the
// latest row per purpose is the current status; routes/consent.routes.js is the writer.
// Fails closed: no record or a lookup error is 'unknown', never consent.

import { getPool } from '../db/pool.js'

const VALID_PURPOSES = ['data_collection', 'photo_video', 'named_attribution', 'whatsapp_comms']

/**
 * The most recent consent status for one beneficiary + purpose.
 * @returns {Promise<'granted'|'withdrawn'|'unknown'>}
 */
export async function getConsentStatus(orgId, beneficiaryUid, purpose) {
  if (!orgId || !beneficiaryUid || !VALID_PURPOSES.includes(purpose)) return 'unknown'
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT status FROM consent_records
       WHERE org_id = $1 AND beneficiary_uid = $2 AND purpose = $3
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, beneficiaryUid, purpose]
    )
    return rows[0]?.status === 'granted' ? 'granted' : rows[0]?.status === 'withdrawn' ? 'withdrawn' : 'unknown'
  } catch (e) {
    console.warn('[consent] getConsentStatus failed:', e.message)
    return 'unknown'
  }
}

/** Feature gate: 'unknown' counts as no consent. */
export async function hasConsent(orgId, beneficiaryUid, purpose) {
  return (await getConsentStatus(orgId, beneficiaryUid, purpose)) === 'granted'
}

/** Full grant/withdraw history for one beneficiary, newest first. */
export async function getConsentHistory(orgId, beneficiaryUid) {
  if (!orgId || !beneficiaryUid) return []
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT purpose, status, granted_by, recorded_by_uid, recorded_by_name, method, notes, created_at
       FROM consent_records
       WHERE org_id = $1 AND beneficiary_uid = $2
       ORDER BY created_at DESC`,
      [orgId, beneficiaryUid]
    )
    return rows
  } catch (e) {
    console.warn('[consent] getConsentHistory failed:', e.message)
    return []
  }
}

/**
 * Latest status per purpose for one beneficiary, e.g.
 * { data_collection: 'granted', photo_video: 'unknown', ... }
 */
export async function getConsentSummary(orgId, beneficiaryUid) {
  const history = await getConsentHistory(orgId, beneficiaryUid)
  const summary = Object.fromEntries(VALID_PURPOSES.map(p => [p, 'unknown']))
  for (const row of history) {
    // history is newest-first, so the first row seen per purpose is the latest
    if (summary[row.purpose] === 'unknown') summary[row.purpose] = row.status
  }
  return summary
}

export { VALID_PURPOSES }
