// Per-org AI prompt resolver: org override (DB) → hardcoded default, cached 5 minutes per org.

import { getPool } from '../db/pool.js'

// ── In-memory cache: orgId → { promptId → text, _at: timestamp } ─────────────
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

function isFresh(entry) {
  return entry && Date.now() - entry._at < CACHE_TTL
}

/** Invalidate the cache for a specific org (call after a PUT/DELETE) */
export function invalidateOrgPrompts(orgId) {
  _cache.delete(orgId)
}

/** Load all org overrides from DB (returns map of promptId→text) */
async function loadOrgOverrides(orgId) {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT prompt_id, prompt_text, status
         FROM org_prompts
        WHERE org_id = $1 AND status != 'disabled'`,
      [orgId]
    )
    const map = { _at: Date.now() }
    for (const r of rows) map[r.prompt_id] = r.prompt_text
    return map
  } catch {
    // DB unavailable (local dev) — no overrides
    return { _at: Date.now() }
  }
}

/** Ensure the cache is warm for this org */
async function warmCache(orgId) {
  const cached = _cache.get(orgId)
  if (isFresh(cached)) return cached
  const fresh = await loadOrgOverrides(orgId)
  _cache.set(orgId, fresh)
  return fresh
}

/** The org's custom prompt text for promptId, else defaultText. */
export async function getOrgPrompt(orgId, promptId, defaultText = '') {
  if (!orgId) return defaultText
  try {
    const map = await warmCache(orgId)
    return map[promptId] ?? defaultText
  } catch {
    return defaultText
  }
}

