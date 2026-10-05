// Processes pending ai_learning_candidates: validates those with enough evidence,
// merges duplicates and records eval_score. Run periodically or after admin review.

import { getPool } from '../../../db/pool.js'

// ── Thresholds ─────────────────────────────────────────────────────────────────
// How many observations before auto-validating a low-risk candidate
const AUTO_VALIDATE_THRESHOLD = {
  intent_alias:     3,   // seen 3 times → likely real pattern
  slot_pattern:     5,   // less common, need more evidence
  template_section: 2,   // editor corrections are strong signal
  negative_feedback: 1,  // always worth human review
  scoring_weight:   10,
}

// ── Score a candidate ─────────────────────────────────────────────────────────
function _scoreCandidate(candidate) {
  const { type, evidence_count, proposed_change } = candidate
  const threshold = AUTO_VALIDATE_THRESHOLD[type] || 5
  const coverageScore = Math.min(1.0, evidence_count / threshold)

  // Additional heuristics per type
  let qualityScore = 0.5
  if (type === 'intent_alias') {
    const alias = proposed_change?.suggestedAlias || ''
    // Longer, more specific aliases are better
    qualityScore = Math.min(1.0, 0.3 + alias.length * 0.05)
  } else if (type === 'template_section') {
    const addedLen   = (proposed_change?.added   || []).join(' ').length
    const removedLen = (proposed_change?.removed || []).join(' ').length
    // Substantive edits are more informative
    qualityScore = Math.min(1.0, 0.4 + (addedLen + removedLen) / 500)
  } else if (type === 'negative_feedback') {
    qualityScore = 0.6  // always medium priority
  }

  return (coverageScore * 0.6 + qualityScore * 0.4)
}

// ── Extract lessons from a batch ──────────────────────────────────────────────
/** Process up to `limit` pending candidates for an org → { processed, validated, skipped }. */
export async function runBatch(orgId, limit = 50) {
  const pool = getPool()
  let processed = 0, validated = 0, skipped = 0

  try {
    const { rows } = await pool.query(
      `SELECT id, type, feature, proposed_change, evidence_count
       FROM ai_learning_candidates
       WHERE (org_id = $1 OR org_id IS NULL)
         AND status = 'pending'
       ORDER BY evidence_count DESC, created_at ASC
       LIMIT $2`,
      [orgId, limit]
    )

    for (const candidate of rows) {
      processed++
      const threshold = AUTO_VALIDATE_THRESHOLD[candidate.type] || 5
      const score     = _scoreCandidate(candidate)

      if (candidate.evidence_count >= threshold && score >= 0.55) {
        // Auto-validate low-risk, high-evidence candidates
        const requiresApproval = candidate.type === 'negative_feedback'
          || candidate.type === 'scoring_weight'

        await pool.query(
          `UPDATE ai_learning_candidates
           SET status=$1, eval_score=$2, reviewed_at=NOW()
           WHERE id=$3`,
          [requiresApproval ? 'pending' : 'validated', score, candidate.id]
        )
        if (!requiresApproval) validated++
      } else if (candidate.evidence_count < 1) {
        skipped++
      } else {
        // Update eval score without changing status
        await pool.query(
          `UPDATE ai_learning_candidates SET eval_score=$1 WHERE id=$2`,
          [score, candidate.id]
        )
      }
    }
  } catch (e) {
    console.warn('[lessonExtractor] runBatch error:', e.message)
  }

  return { processed, validated, skipped }
}
