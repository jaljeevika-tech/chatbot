// routes/correctness.routes.js — Data-correctness layer REST surface
//
// GET  /api/correctness/flags             list recent flagged items (14d default)
// GET  /api/correctness/reconciliation    list latest reconciliation_checks rows
// GET  /api/correctness/policy            current per-org policy (enforcement, tolerances)
// PUT  /api/correctness/policy            update per-org policy (admin)
// POST /api/correctness/override          mark a flag as false positive (manager+)
// POST /api/correctness/reconcile-now     trigger reconciliation immediately (admin)
//
// Consumed by src/components/admin/CorrectnessDashboard.tsx.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { getPolicy, getTolerances, invalidatePolicyCache } from '../lib/dataCorrectness/policy.js'
import { runReconciliationForOrg } from '../lib/dataCorrectness/reconciliation.js'

const router = Router()

function requireAuth(req, res, next) {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Auth required' })
  next()
}
function requireAdmin(req, res, next) {
  const role = req.user?.role
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin role required' })
  }
  next()
}
function requireManager(req, res, next) {
  const role = req.user?.role
  if (!['manager', 'admin', 'superadmin'].includes(role)) {
    return res.status(403).json({ error: 'Manager role required' })
  }
  next()
}

// ── GET /api/correctness/flags ──────────────────────────────────────────────
router.get('/correctness/flags', requireAuth, async (req, res) => {
  const period = (req.query.period || '14d').toString()
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 14
  const pool = getPool()
  try {
    const [dr, sr] = await Promise.all([
      pool.query(
        `SELECT quality_flag, COUNT(*) AS n
           FROM daily_reports
          WHERE org_id = $1
            AND quality_flag IS NOT NULL
            AND report_date >= NOW() - ($2 || ' days')::INTERVAL
          GROUP BY quality_flag`,
        [req.user.orgId, String(days)]
      ),
      pool.query(
        `SELECT quality_flag, COUNT(*) AS n
           FROM saved_reports
          WHERE org_id = $1
            AND quality_flag IS NOT NULL
            AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          GROUP BY quality_flag`,
        [req.user.orgId, String(days)]
      ),
    ])
    const summary = { total: 0, needs_review: 0, low_confidence: 0, photo_mismatch: 0 }
    for (const r of [...dr.rows, ...sr.rows]) {
      const n = Number(r.n) || 0
      summary.total += n
      if (r.quality_flag in summary) summary[r.quality_flag] += n
    }
    res.json({ summary, period_days: days })
  } catch (e) {
    console.warn('[correctness/flags]', e.message)
    res.status(500).json({ error: 'Failed to load flag summary' })
  }
})

// ── GET /api/correctness/reconciliation ─────────────────────────────────────
router.get('/correctness/reconciliation', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT metric, source_a, value_a, source_b, value_b,
              drift_pct, drift_pass, period_label, checked_at
         FROM reconciliation_checks
        WHERE org_id = $1
        ORDER BY checked_at DESC
        LIMIT $2`,
      [req.user.orgId, limit]
    )
    res.json({ checks: rows })
  } catch (e) {
    console.warn('[correctness/reconciliation]', e.message)
    res.status(500).json({ error: 'Failed to load reconciliation history' })
  }
})

// ── GET /api/correctness/policy ─────────────────────────────────────────────
router.get('/correctness/policy', requireAuth, async (req, res) => {
  try {
    const p = await getPolicy(req.user.orgId)
    res.json({ policy: p })
  } catch (e) {
    console.error('[correctness]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/correctness/policy ─────────────────────────────────────────────
router.put('/correctness/policy', requireAuth, requireAdmin, async (req, res) => {
  const { enforcement_mode, photo_sample_rate, tolerances } = req.body || {}
  if (enforcement_mode && !['soft', 'tiered'].includes(enforcement_mode)) {
    return res.status(400).json({ error: 'enforcement_mode must be "soft" or "tiered"' })
  }
  if (photo_sample_rate != null && (photo_sample_rate < 0 || photo_sample_rate > 1)) {
    return res.status(400).json({ error: 'photo_sample_rate must be in [0,1]' })
  }
  const pool = getPool()
  try {
    // Merge into ai_settings.feature_policies.validation
    const { rows } = await pool.query(
      `SELECT feature_policies FROM ai_settings WHERE org_id = $1`,
      [req.user.orgId]
    )
    const fp = rows[0]?.feature_policies || {}
    const next = {
      ...fp,
      validation: {
        ...(fp.validation || {}),
        ...(enforcement_mode ? { enforcement_mode } : {}),
        ...(photo_sample_rate != null ? { photo_sample_rate } : {}),
        ...(tolerances ? { tolerances } : {}),
      },
    }
    await pool.query(
      `INSERT INTO ai_settings (org_id, feature_policies, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (org_id) DO UPDATE
         SET feature_policies = EXCLUDED.feature_policies,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by`,
      [req.user.orgId, JSON.stringify(next), req.user.uid]
    )
    invalidatePolicyCache(req.user.orgId)
    const refreshed = await getPolicy(req.user.orgId)
    res.json({ ok: true, policy: refreshed })
  } catch (e) {
    console.warn('[correctness/policy PUT]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/correctness/override — manager marks a flag false-positive ───
// A static per-table query map, so target_table is never interpolated into SQL
// even if the allowlist is edited later.
const OVERRIDE_TABLE_QUERIES = {
  daily_reports: {
    select: `SELECT quality_flag FROM daily_reports WHERE id = $1 AND org_id = $2`,
    clear:  `UPDATE daily_reports SET quality_flag = NULL WHERE id = $1 AND org_id = $2`,
  },
  saved_reports: {
    select: `SELECT quality_flag FROM saved_reports WHERE id = $1 AND org_id = $2`,
    clear:  `UPDATE saved_reports SET quality_flag = NULL WHERE id = $1 AND org_id = $2`,
  },
  project_deliverables: {
    select: `SELECT quality_flag FROM project_deliverables WHERE id = $1 AND org_id = $2`,
    clear:  `UPDATE project_deliverables SET quality_flag = NULL WHERE id = $1 AND org_id = $2`,
  },
}

router.post('/correctness/override', requireAuth, requireManager, async (req, res) => {
  const { target_table, target_id, note } = req.body || {}
  if (!target_table || !target_id) return res.status(400).json({ error: 'target_table + target_id required' })
  const tableQueries = OVERRIDE_TABLE_QUERIES[target_table]
  if (!tableQueries) return res.status(400).json({ error: 'invalid target_table' })
  const pool = getPool()
  try {
    // Capture the prior flag for the learning candidate before we clear it.
    let priorFlag = null
    try {
      const { rows: pr } = await pool.query(tableQueries.select, [target_id, req.user.orgId])
      priorFlag = pr[0]?.quality_flag || null
    } catch { /* ignore */ }

    const cleared = await pool.query(tableQueries.clear, [target_id, req.user.orgId])
    if (!cleared.rowCount) return res.status(404).json({ error: 'Not found' })
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1, $2, $3, 'correctness.override', $4, $5, $6)`,
      [req.user.orgId, req.user.uid, req.user.name || 'unknown',
       target_table, target_id,
       JSON.stringify({ reason: note || '', flag_cleared: true, prior_flag: priorFlag })]
    )

    // Every override becomes a learning candidate; recurring patterns auto-promote
    // into ai_rule_versions to relax tolerances for legitimate edge cases.
    try {
      await pool.query(
        `INSERT INTO ai_learning_candidates
           (org_id, type, feature, proposed_change, evidence_count, status, created_at)
         VALUES ($1, $2, $3, $4, 1, 'pending', NOW())`,
        [
          req.user.orgId,
          'tolerance_relaxation',
          'validation',
          JSON.stringify({
            target_table,
            target_id,
            prior_flag: priorFlag,
            reason: note || '',
            reviewer: req.user.name,
          }),
        ]
      )
    } catch (e) {
      // Schema mismatch on ai_learning_candidates must never block the override
      console.warn('[correctness/override] learning candidate write skipped:', e.message)
    }

    res.json({ ok: true })
  } catch (e) {
    console.warn('[correctness/override]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/correctness/reconcile-now ────────────────────────────────────
router.post('/correctness/reconcile-now', requireAuth, requireAdmin, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(`SELECT metadata FROM organizations WHERE id = $1`, [req.user.orgId])
    const orgMeta = rows[0]?.metadata || {}
    const tolerances = await getTolerances(req.user.orgId)
    const results = await runReconciliationForOrg(pool, req.user.orgId, { orgMeta, tolerances })
    res.json({ ok: true, results })
  } catch (e) {
    console.warn('[correctness/reconcile-now]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
