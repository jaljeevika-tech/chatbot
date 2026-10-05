// lib/ai/local/memoryStore.js — Persist AI learning candidates (lessons)

import { getPool } from '../../../db/pool.js'

// ── Lesson storage ────────────────────────────────────────────────────────────
/** Persist a lesson candidate from a user correction or feedback. */
export async function storeLesson(orgId, feature, { type, change, evidenceCount = 1 } = {}) {
  if (!orgId || !type || !change) return
  try {
    const pool = getPool()
    // An identical candidate gets its evidence count bumped instead
    const { rows } = await pool.query(
      `SELECT id, evidence_count FROM ai_learning_candidates
       WHERE org_id=$1 AND feature=$2 AND type=$3 AND status='pending'
         AND proposed_change::text = $4::text
       LIMIT 1`,
      [orgId, feature, type, JSON.stringify(change)]
    )
    if (rows.length) {
      await pool.query(
        `UPDATE ai_learning_candidates SET evidence_count=$1 WHERE id=$2`,
        [rows[0].evidence_count + evidenceCount, rows[0].id]
      )
    } else {
      await pool.query(
        `INSERT INTO ai_learning_candidates (org_id, feature, type, proposed_change, evidence_count)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, feature, type, JSON.stringify(change), evidenceCount]
      )
    }
  } catch (e) {
    console.warn('[memoryStore] storeLesson error:', e.message)
  }
}
