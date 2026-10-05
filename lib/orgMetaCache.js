// Cached organizations.metadata lookup (5-minute TTL): every AI route needs
// `sector` / `fiscal_year_start`, which rarely change.

import { getPool } from '../db/pool.js'

const _cache = new Map()
const TTL = 5 * 60_000

/** The org's metadata JSONB; {} if not found or on error. */
export async function getOrgMeta(orgId) {
  if (!orgId) return {}
  const cached = _cache.get(orgId)
  if (cached && Date.now() - cached.ts < TTL) return cached.meta
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT metadata FROM organizations WHERE id = $1 LIMIT 1`,
      [orgId]
    )
    const meta = rows[0]?.metadata || {}
    _cache.set(orgId, { meta, ts: Date.now() })
    return meta
  } catch {
    return {}
  }
}

/** Convenience: get the org's sector (e.g. 'fisheries') with a 'general' default. */
export async function getOrgSector(orgId) {
  const meta = await getOrgMeta(orgId)
  const s = meta?.sector
  return typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : 'general'
}

/** Invalidate after a PUT to org metadata. */
export function invalidateOrgMeta(orgId) {
  _cache.delete(orgId)
}
