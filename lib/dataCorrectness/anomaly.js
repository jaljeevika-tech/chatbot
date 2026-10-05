// Layer 1: anomaly detection on submissions. Cheap deterministic checks first; only a
// confidence in the uncertainty band [0.3, 0.7] escalates to an LLM check.
// Returns { severity: 'clean'|'low'|'medium'|'high', confidence, reasons, action, llm_used };
// action is 'flag', except 'block' for high severity when the org's mode is 'tiered'.

import { getPool } from '../../db/pool.js'
import { runAI } from '../ai/runAI.js'
import { getOrgPrompt } from '../promptStore.js'
import { VALIDATION_PROMPTS } from './prompts.js'
import { redact } from '../contentModeration.js'
import { getEnforcementMode } from './policy.js'

// ── Deterministic checks ────────────────────────────────────────────────────

/** Range check on beneficiaries vs. worker's 14-day median */
async function _checkWorkerRange(payload, ctx, reasons) {
  if (!ctx?.submitter || payload.beneficiaries == null) return null
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY beneficiaries) AS median,
              COUNT(*) AS n
         FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date >= NOW() - INTERVAL '14 days'
          AND beneficiaries IS NOT NULL`,
      [ctx.orgId, ctx.submitter]
    )
    const median = Number(rows[0]?.median) || null
    const n = Number(rows[0]?.n) || 0
    if (n < 3 || !median) return null // not enough history
    const b = Number(payload.beneficiaries)
    if (b < 0) {
      reasons.push('negative beneficiary count')
      return { breach: 'severe', factor: 0 }
    }
    const factor = b / Math.max(median, 1)
    if (factor > 10 || factor < 0.1) {
      reasons.push(`beneficiaries ${b} is ${factor.toFixed(1)}× the worker's 14-day median (${median.toFixed(0)})`)
      return { breach: 'severe', factor }
    }
    if (factor > 5 || factor < 0.2) {
      reasons.push(`beneficiaries ${b} is ${factor.toFixed(1)}× the worker's 14-day median (${median.toFixed(0)})`)
      return { breach: 'moderate', factor }
    }
    return null
  } catch {
    return null
  }
}

/** Plan-vs-actual: achieved cannot exceed planned by huge margin */
function _checkPlanVsActual(payload, _ctx, reasons) {
  const planned = Number(payload.planned)
  const achieved = Number(payload.achieved)
  if (!Number.isFinite(planned) || !Number.isFinite(achieved) || planned <= 0) return null
  if (achieved < 0) {
    reasons.push(`achieved (${achieved}) is negative`)
    return { breach: 'severe', ratio: achieved / planned }
  }
  const ratio = achieved / planned
  if (ratio > 2.0) {
    reasons.push(`achieved (${achieved}) is ${ratio.toFixed(1)}× the planned target (${planned})`)
    return { breach: 'severe', ratio }
  }
  if (ratio > 1.5) {
    reasons.push(`achieved (${achieved}) exceeds planned (${planned}) by ${Math.round((ratio - 1) * 100)}%`)
    return { breach: 'moderate', ratio }
  }
  return null
}

/** Field consistency: certain activities should not have zero beneficiaries */
function _checkFieldConsistency(payload, _ctx, reasons) {
  const desc = (payload.description || payload.activity || '').toLowerCase()
  const trainingWords = ['training', 'workshop', 'session', 'meeting', 'awareness', 'orientation']
  const hasTraining = trainingWords.some(w => desc.includes(w))
  if (hasTraining && payload.beneficiaries === 0) {
    reasons.push('training/workshop activity logged with 0 beneficiaries')
    return { breach: 'moderate' }
  }
  return null
}

/** Date sanity: report_date should be within plausible window */
function _checkDateSanity(payload, _ctx, reasons) {
  if (!payload.report_date) return null
  const reportDate = new Date(payload.report_date)
  if (Number.isNaN(reportDate.getTime())) return null
  const now = Date.now()
  const diffDays = (now - reportDate.getTime()) / 86400000
  if (diffDays < -1) {
    reasons.push(`report date is ${Math.abs(diffDays).toFixed(0)} days in the future`)
    return { breach: 'severe' }
  }
  if (diffDays > 90) {
    reasons.push(`report date is ${diffDays.toFixed(0)} days old`)
    return { breach: 'moderate' }
  }
  return null
}

/** Duplicate detection: same worker, date, location, activity = likely duplicate */
async function _checkDuplicate(payload, ctx, reasons) {
  if (!ctx?.submitter || !payload.report_date || !payload.location) return null
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT id FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date = $3
          AND location = $4
          AND area_of_intervention IS NOT DISTINCT FROM $5
        LIMIT 1`,
      [
        ctx.orgId,
        ctx.submitter,
        payload.report_date,
        payload.location,
        payload.area_of_intervention || null,
      ]
    )
    if (rows.length > 0) {
      reasons.push('a report with the same worker, date, location, and activity already exists')
      return { breach: 'severe' }
    }
    return null
  } catch {
    return null
  }
}

// ── Severity aggregator ─────────────────────────────────────────────────────
function _aggregate(findings) {
  const severities = findings.filter(Boolean).map(f => f.breach)
  if (severities.includes('severe')) return { severity: 'high', confidence: 0.85 }
  if (severities.filter(s => s === 'moderate').length >= 2) return { severity: 'medium', confidence: 0.75 }
  if (severities.includes('moderate')) return { severity: 'low', confidence: 0.55 }
  return { severity: 'clean', confidence: 0.95 }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run anomaly checks on a submission payload.
 * @param {object} ctx  { orgId, submitter (user id), kind: 'daily_report'|'action_plan_cell' }
 */
export async function checkAnomaly(payload, ctx = {}) {
  const reasons = []
  const checks = ctx.kind === 'action_plan_cell'
    ? [_checkPlanVsActual(payload, ctx, reasons), _checkDateSanity(payload, ctx, reasons)]
    : [
        await _checkWorkerRange(payload, ctx, reasons),
        _checkFieldConsistency(payload, ctx, reasons),
        _checkDateSanity(payload, ctx, reasons),
        await _checkDuplicate(payload, ctx, reasons),
      ]

  let agg = _aggregate(checks)
  let llmUsed = false

  // ── LLM semantic pass: only for judgement-call confidences in [0.3, 0.7].
  //     The payload is redacted — never raw PII into Gemini logs.
  if (ctx?.orgId && agg.confidence >= 0.3 && agg.confidence <= 0.7) {
    try {
      const systemPrompt = await getOrgPrompt(
        ctx.orgId,
        'validation_anomaly_semantic',
        VALIDATION_PROMPTS.validation_anomaly_semantic
      )
      // Recent override notes (false positives a manager cleared) make the judge more conservative.
      const overrideNotes = await _recentOverrideNotes(ctx.orgId, 5)
      const userPrompt = JSON.stringify({
        submission: {
          beneficiaries: payload.beneficiaries,
          description:   redact(payload.description || ''),
          location:      payload.location,
          activity:      payload.area_of_intervention,
        },
        deterministic_findings: reasons,
        deterministic_severity: agg.severity,
        manager_precedents: overrideNotes,
      })
      const out = await runAI({
        feature: 'validation',
        operation: 'anomaly_semantic',
        prompt: userPrompt,
        systemPrompt,
        orgId: ctx.orgId,
        userId: ctx.userId,
      })
      const parsed = _safeJson(out?.text)
      if (parsed) {
        llmUsed = true
        if (parsed.plausible === false && parsed.confidence > 0.6) {
          // LLM judged implausible with confidence → bump severity
          agg = { severity: 'high', confidence: Math.max(agg.confidence, parsed.confidence) }
          reasons.push(`semantic judge: ${parsed.reasoning || 'implausible'}`)
        } else if (parsed.plausible === true && parsed.confidence > 0.6) {
          // LLM rescued — downgrade to clean if no severe deterministic breach
          if (!checks.some(c => c?.breach === 'severe')) {
            agg = { severity: 'clean', confidence: parsed.confidence }
            reasons.push(`semantic judge: plausible (${parsed.reasoning || 'OK'})`)
          }
        }
      }
    } catch (e) {
      // LLM unavailable / over budget / circuit open — keep the deterministic verdict
      console.warn('[anomaly] semantic pass failed:', e.message)
    }
  }

  // Enforcement mode: 'soft' flags everything; 'tiered' blocks high severity
  const mode = ctx?.orgId ? await getEnforcementMode(ctx.orgId) : 'soft'
  let action
  if (agg.severity === 'clean')      action = 'allow'
  else if (agg.severity === 'low')   action = 'flag'
  else if (agg.severity === 'medium') action = 'flag'
  else /* high */                     action = mode === 'tiered' ? 'block' : 'flag'

  return {
    severity: agg.severity,
    confidence: agg.confidence,
    reasons,
    action,
    llm_used: llmUsed,
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function _safeJson(text) {
  if (!text || typeof text !== 'string') return null
  // The LLM may wrap JSON in code fences or prose
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// Cache override notes for 10 minutes per org to avoid a DB hit per submission
const _overrideCache = new Map()
const OVERRIDE_TTL = 10 * 60_000

async function _recentOverrideNotes(orgId, limit = 5) {
  const cached = _overrideCache.get(orgId)
  if (cached && Date.now() - cached.ts < OVERRIDE_TTL) return cached.notes
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT diff->>'reason' AS reason, diff->>'prior_flag' AS prior_flag, created_at
         FROM audit_log
        WHERE org_id = $1
          AND action = 'correctness.override'
          AND created_at >= NOW() - INTERVAL '60 days'
        ORDER BY created_at DESC
        LIMIT $2`,
      [orgId, limit]
    )
    const notes = rows
      .map(r => (r.reason || '').trim())
      .filter(Boolean)
      .slice(0, limit)
    _overrideCache.set(orgId, { notes, ts: Date.now() })
    return notes
  } catch {
    return []
  }
}
