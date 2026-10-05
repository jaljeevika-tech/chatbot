// Versions, approves and rolls back learning improvements (validated → approved →
// promoted → active in ai_rule_versions); the previous version is kept for rollback.

import { getPool }            from '../../../db/pool.js'
import { invalidateOrgAliases } from '../local/intentMatcher.js'

// ── Promote a validated candidate ─────────────────────────────────────────────
/** Promote a candidate to a new active ai_rule_versions row → { ok, ruleVersionId, error }. */
export async function promoteCandidate(candidateId, approvedBy, orgId) {
  const pool = getPool()
  try {
    const { rows: cRows } = await pool.query(
      `SELECT type, feature, proposed_change FROM ai_learning_candidates
       WHERE id=$1 AND (org_id=$2 OR org_id IS NULL) AND status IN ('validated','approved')`,
      [candidateId, orgId]
    )
    if (!cRows[0]) return { ok: false, error: 'Candidate not found or not validated' }
    const { type, feature, proposed_change: change } = cRows[0]

    let ruleType, newConfig
    if (type === 'intent_alias') {
      ruleType  = 'intent_matcher'
      newConfig = await _mergeIntentAlias(orgId, feature, change)
    } else if (type === 'template_section') {
      ruleType  = 'report_template'
      newConfig = await _mergeTemplateSection(orgId, feature, change)
    } else {
      // Generic: just store the proposed_change as config
      ruleType  = type
      newConfig = change
    }

    await pool.query(
      `UPDATE ai_rule_versions SET active=false
       WHERE org_id=$1 AND feature=$2 AND rule_type=$3 AND active=true`,
      [orgId, feature, ruleType]
    )

    const { rows: vRows } = await pool.query(
      `SELECT MAX(version) AS mv FROM ai_rule_versions
       WHERE org_id=$1 AND feature=$2 AND rule_type=$3`,
      [orgId, feature, ruleType]
    )
    const nextVersion = (vRows[0]?.mv ?? 0) + 1

    const { rows: newRows } = await pool.query(
      `INSERT INTO ai_rule_versions (org_id, feature, rule_type, version, config, active, promoted_by, activated_at)
       VALUES ($1,$2,$3,$4,$5,true,$6,NOW()) RETURNING id`,
      [orgId, feature, ruleType, nextVersion, JSON.stringify(newConfig), approvedBy]
    )

    await pool.query(
      `UPDATE ai_learning_candidates SET status='promoted', reviewed_by=$1, promoted_at=NOW() WHERE id=$2`,
      [approvedBy, candidateId]
    )

    // Invalidate caches
    if (ruleType === 'intent_matcher') invalidateOrgAliases(orgId, feature)

    return { ok: true, ruleVersionId: newRows[0]?.id }
  } catch (e) {
    console.warn('[promotionManager] promoteCandidate error:', e.message)
    return { ok: false, error: e.message }
  }
}

// ── Roll back to previous version ─────────────────────────────────────────────
/** Reactivate the previous version of a rule → { ok, rolledBackTo }. */
export async function rollback(orgId, feature, ruleType) {
  const pool = getPool()
  try {
    const { rows: curr } = await pool.query(
      `SELECT version FROM ai_rule_versions
       WHERE org_id=$1 AND feature=$2 AND rule_type=$3 AND active=true`,
      [orgId, feature, ruleType]
    )
    if (!curr[0]) return { ok: false, error: 'No active version to roll back from' }

    const prevVersion = curr[0].version - 1
    if (prevVersion < 1) return { ok: false, error: 'No previous version available' }

    await pool.query(
      `UPDATE ai_rule_versions SET active=false
       WHERE org_id=$1 AND feature=$2 AND rule_type=$3 AND active=true`,
      [orgId, feature, ruleType]
    )
    await pool.query(
      `UPDATE ai_rule_versions SET active=true, activated_at=NOW()
       WHERE org_id=$1 AND feature=$2 AND rule_type=$3 AND version=$4`,
      [orgId, feature, ruleType, prevVersion]
    )

    if (ruleType === 'intent_matcher') invalidateOrgAliases(orgId, feature)

    return { ok: true, rolledBackTo: prevVersion }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── Reject a candidate ────────────────────────────────────────────────────────
// Scoped like promoteCandidate (this org's rows or shared org_id IS NULL ones) so
// one org can't reject another org's candidate.
export async function rejectCandidate(candidateId, reviewedBy, note = '', orgId) {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE ai_learning_candidates
       SET status='rejected', reviewed_by=$1, review_note=$2, reviewed_at=NOW()
       WHERE id=$3 AND (org_id=$4 OR org_id IS NULL)
       RETURNING id`,
      [reviewedBy, note, candidateId, orgId]
    )
    if (!rows.length) return { ok: false, error: 'Candidate not found' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── Get pending approvals ──────────────────────────────────────────────────────
export async function getPendingApprovals(orgId, limit = 20) {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, type, feature, proposed_change, eval_score, evidence_count, created_at
       FROM ai_learning_candidates
       WHERE (org_id=$1 OR org_id IS NULL) AND status IN ('validated','pending')
         AND (evidence_count >= 2 OR type='negative_feedback')
       ORDER BY eval_score DESC NULLS LAST, evidence_count DESC
       LIMIT $2`,
      [orgId, limit]
    )
    return rows
  } catch { return [] }
}

// ── Merge helpers ─────────────────────────────────────────────────────────────
async function _mergeIntentAlias(orgId, feature, change) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT config FROM ai_rule_versions
     WHERE org_id=$1 AND feature=$2 AND rule_type='intent_matcher' AND active=true LIMIT 1`,
    [orgId, feature]
  )
  const cfg = rows[0]?.config || { aliases: {} }
  cfg.aliases = cfg.aliases || {}

  const canonical = change.correctFlow || change.canonical || ''
  const alias     = change.suggestedAlias || change.message || ''
  if (canonical && alias) {
    cfg.aliases[canonical] = [...new Set([...(cfg.aliases[canonical] || []), alias])]
  }
  return cfg
}

async function _mergeTemplateSection(orgId, feature, change) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT config FROM ai_rule_versions
     WHERE org_id=$1 AND feature=$2 AND rule_type='report_template' AND active=true LIMIT 1`,
    [orgId, feature]
  )
  const cfg = rows[0]?.config || { avoidPhrases: [], preferPhrases: [] }
  cfg.avoidPhrases   = cfg.avoidPhrases  || []
  cfg.preferPhrases  = cfg.preferPhrases || []

  for (const kw of (change.removed || [])) {
    if (!cfg.avoidPhrases.includes(kw)) cfg.avoidPhrases.push(kw)
  }
  for (const kw of (change.added || [])) {
    if (!cfg.preferPhrases.includes(kw)) cfg.preferPhrases.push(kw)
  }
  return cfg
}
