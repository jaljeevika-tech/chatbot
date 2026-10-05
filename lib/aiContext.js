// lib/aiContext.js — builds the org's ai_memories into a context block for AI prompts.
// Cached 5 min per org; call invalidateOrgContext() after any memory write.

import { getPool } from '../db/pool.js'

/** orgId → { text, exp } */
const _cache = new Map()

/** Org context string for AI prompts; '' when the org has no memories. */
export async function buildOrgContext(orgId) {
  if (!orgId) return ''

  const cached = _cache.get(orgId)
  if (cached && cached.exp > Date.now()) return cached.text

  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT memory_type, subject, content, confidence
       FROM ai_memories
       WHERE org_id = $1
       ORDER BY confidence DESC, reinforced_at DESC
       LIMIT 40`,
      [orgId]
    )

    const lines = rows.map(r =>
      r.subject
        ? `[${r.memory_type}] ${r.subject}: ${r.content}`
        : `[${r.memory_type}] ${r.content}`
    )

    const text = lines.length
      ? `=== Organisational Context ===\n${lines.join('\n')}\n===`
      : ''

    _cache.set(orgId, { text, exp: Date.now() + 5 * 60 * 1000 })
    return text
  } catch (e) {
    console.warn('[aiContext] buildOrgContext error:', e.message)
    return ''
  }
}

export function invalidateOrgContext(orgId) {
  if (orgId) _cache.delete(orgId)
}
