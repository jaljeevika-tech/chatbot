// Data-correctness layer entry point: check(kind, payload, ctx) for 'anomaly' (L1),
// 'hallucination' (L2) and 'photo_text' (L4). Org-wide reconciliation (L3) lives in
// ./reconciliation.js.

import { checkAnomaly } from './anomaly.js'
import { checkHallucination } from './hallucination.js'
import { checkPhotoText } from './photoTextConsistency.js'
import { getPool } from '../../db/pool.js'

/**
 * Run a correctness check.
 * @returns {Promise<{kind, severity: 'clean'|'low'|'medium'|'high', confidence,
 *   reasons: string[], action: 'allow'|'flag'|'block', extras}>}
 */
export async function check(kind, payload, ctx = {}) {
  let verdict
  try {
    if (kind === 'anomaly') {
      verdict = await checkAnomaly(payload, ctx)
    } else if (kind === 'hallucination') {
      verdict = await checkHallucination(payload.output, payload.sources, ctx)
    } else if (kind === 'photo_text') {
      verdict = await checkPhotoText(payload, ctx)
    } else {
      return { kind, severity: 'clean', confidence: 1, reasons: [], action: 'allow' }
    }
  } catch (e) {
    // Never take down a write, but never fail open either: a check that couldn't
    // run is flagged for review, not allowed.
    console.warn(`[dataCorrectness] ${kind} check threw:`, e.message)
    return {
      kind,
      severity: 'low',
      confidence: 0,
      reasons: ['correctness layer error — could not verify, flagged for manual review'],
      action: 'flag',
      extras: { error: e.message, checkFailed: true },
    }
  }
  return { kind, ...verdict }
}

/**
 * Audit-log a verdict and set the target row's quality_flag. Fire-and-forget.
 * @param {object} target  { table, id }  e.g. { table: 'daily_reports', id: 'uuid' }
 */
export async function recordVerdict(verdict, target, ctx = {}) {
  if (!verdict || verdict.action === 'allow') return
  const pool = getPool()

  // Map severity → quality_flag column value
  const flag = verdict.severity === 'high' ? 'needs_review'
             : verdict.severity === 'medium' ? 'needs_review'
             : verdict.severity === 'low' ? 'low_confidence'
             : null

  // Update the target row's quality_flag if we have one
  if (flag && target?.table && target?.id) {
    const allowedTables = new Set(['daily_reports', 'saved_reports', 'project_deliverables'])
    if (allowedTables.has(target.table)) {
      try {
        const hasConf = target.table === 'daily_reports'
        const hasScore = target.table === 'saved_reports'
        let sql = `UPDATE ${target.table} SET quality_flag = $1`
        const params = [flag]
        if (hasConf && verdict.confidence != null) {
          params.push(verdict.confidence)
          sql += `, quality_confidence = $${params.length}`
        }
        if (hasScore && verdict.grounding_score != null) {
          params.push(verdict.grounding_score)
          sql += `, grounding_score = $${params.length}`
        }
        params.push(target.id)
        sql += ` WHERE id = $${params.length}`
        await pool.query(sql, params)
      } catch (e) {
        console.warn('[dataCorrectness] quality_flag update failed:', e.message)
      }
    }
  }

  try {
    await pool.query(
      `INSERT INTO audit_log
         (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ctx.orgId || null,
        ctx.userId || null,
        ctx.userName || 'system',
        `correctness.${verdict.kind}.${verdict.severity}`,
        target?.table || verdict.kind,
        target?.id || null,
        JSON.stringify({
          severity: verdict.severity,
          confidence: verdict.confidence,
          reasons: verdict.reasons,
          action: verdict.action,
          cid: ctx.cid || null,
        }),
      ]
    )
  } catch (e) {
    console.warn('[dataCorrectness] audit log failed:', e.message)
  }
}
