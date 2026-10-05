// Per-org policy & tolerances for the data-correctness layer:
// ai_settings.feature_policies.validation over the defaults below, cached 5 min per org.

import { getPool } from '../../db/pool.js'

const DEFAULT_POLICY = {
  enforcement_mode: 'soft',          // 'soft' | 'tiered'
  photo_sample_rate: 0.10,           // 0..1
  tolerances: {
    beneficiaries: 0.02,             // 2%
    activities:    0,                // exact
    projects:      0,
    locations:     0,
  },
}

const _cache = new Map()
const CACHE_TTL = 5 * 60_000

function _isFresh(entry) {
  return entry && Date.now() - entry.ts < CACHE_TTL
}

async function _load(orgId) {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT feature_policies FROM ai_settings WHERE org_id = $1`,
      [orgId]
    )
    const validation = rows[0]?.feature_policies?.validation || {}
    const merged = {
      enforcement_mode: validation.enforcement_mode || DEFAULT_POLICY.enforcement_mode,
      photo_sample_rate: typeof validation.photo_sample_rate === 'number' ? validation.photo_sample_rate : DEFAULT_POLICY.photo_sample_rate,
      tolerances: { ...DEFAULT_POLICY.tolerances, ...(validation.tolerances || {}) },
      ts: Date.now(),
    }
    _cache.set(orgId, merged)
    return merged
  } catch {
    return { ...DEFAULT_POLICY, ts: Date.now() }
  }
}

async function _resolve(orgId) {
  if (!orgId) return DEFAULT_POLICY
  const cached = _cache.get(orgId)
  if (_isFresh(cached)) return cached
  return await _load(orgId)
}

/** @returns {Promise<'soft'|'tiered'>} */
export async function getEnforcementMode(orgId) {
  const policy = await _resolve(orgId)
  return policy.enforcement_mode === 'tiered' ? 'tiered' : 'soft'
}

/** Tolerances for reconciliation drift checks. */
export async function getTolerances(orgId) {
  const policy = await _resolve(orgId)
  return policy.tolerances
}

/** Full resolved policy (admin display + writes). */
export async function getPolicy(orgId) {
  return await _resolve(orgId)
}

/** Invalidate the cache for an org after a PUT. */
export function invalidatePolicyCache(orgId) {
  _cache.delete(orgId)
}
