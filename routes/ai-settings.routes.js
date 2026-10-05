// routes/ai-settings.routes.js — AI Gateway settings + learning management
//
// Admin:       org-scoped — always uses their own orgId
// Superadmin:  cross-org — optional ?orgId= param; without it, sees all orgs
//
// GET    /api/ai/settings                — org AI settings
// PUT    /api/ai/settings                — update org AI settings
// GET    /api/ai/health                  — provider health (circuit breaker + live ping)
// GET    /api/ai/stats                   — usage stats (cost, latency, provider breakdown)
// GET    /api/ai/orgs                    — superadmin: list all orgs with AI usage summary
// GET    /api/ai/learning/candidates     — pending improvement candidates
// POST   /api/ai/learning/candidates/:id/approve
// POST   /api/ai/learning/candidates/:id/reject
// POST   /api/ai/learning/rollback
// POST   /api/ai/learning/run-batch
// GET    /api/ai/rule-versions

import { Router } from 'express'
import { getPool }               from '../db/pool.js'
import { getProviderHealth, invalidateOrgPolicy } from '../lib/ai/runAI.js'
import { checkHealth, checkModelUrl } from '../lib/ai/providers/selfHosted.js'
import { getPendingApprovals }   from '../lib/ai/learning/promotionManager.js'
import { promoteCandidate, rejectCandidate, rollback } from '../lib/ai/learning/promotionManager.js'
import { runBatch }              from '../lib/ai/learning/lessonExtractor.js'

const router = Router()

// ── Helpers ───────────────────────────────────────────────────────────────────
function isSuper(req) { return req.user?.role === 'superadmin' }
function isAdminOrSuper(req) { return req.user?.role === 'admin' || req.user?.role === 'superadmin' }
function parseDays(raw) {
  const days = Number(raw ?? 7)
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null
}

/**
 * Resolve the orgId for this request:
 *   Admin      → always their own orgId (cannot scope to another org)
 *   Superadmin → uses ?orgId= query param if supplied; otherwise null (all orgs)
 */
function _resolveOrgId(req) {
  if (isSuper(req)) return req.query.orgId || req.body?.orgId || null
  return req.user?.orgId || null
}

// ── Auth guard (applied once, covers every sub-path) ─────────────────────────
router.use([
  '/ai/settings', '/ai/health', '/ai/stats', '/ai/orgs',
  '/ai/learning', '/ai/rule-versions',
], (req, res, next) => {
  if (!isAdminOrSuper(req)) return res.status(403).json({ error: 'Admin only' })
  next()
})

// ── GET /api/ai/settings ──────────────────────────────────────────────────────
router.get('/ai/settings', async (req, res) => {
  const orgId = _resolveOrgId(req)
  if (!orgId) {
    // Superadmin without a specific org: return all orgs' settings
    if (!isSuper(req)) return res.status(400).json({ error: 'No orgId' })
    try {
      const pool = getPool()
      const { rows } = await pool.query(
        `SELECT s.*, o.name AS org_name
         FROM ai_settings s
         JOIN organizations o ON o.id = s.org_id
         ORDER BY o.name`
      )
      return res.json({ all: true, settings: rows })
    } catch (e) { console.error('[ai-settings]', e); return res.status(500).json({ error: 'Internal server error' }) }
  }

  try {
    const pool = getPool()
    const { rows } = await pool.query(`SELECT * FROM ai_settings WHERE org_id=$1`, [orgId])
    res.json(rows[0] || {
      org_id: orgId, external_enabled: true,
      local_model_url: null, local_model_name: null,
      budget_usd_daily: 5.0, feature_policies: {},
    })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── PUT /api/ai/settings ──────────────────────────────────────────────────────
router.put('/ai/settings', async (req, res) => {
  const orgId = _resolveOrgId(req)
  if (!orgId) return res.status(400).json({ error: 'orgId is required (pass as query param for superadmin)' })

  const body = req.body || {}
  const { external_enabled, budget_usd_daily, feature_policies } = body
  // Omitted → keep; null or '' → clear.
  const urlGiven  = 'local_model_url' in body
  const nameGiven = 'local_model_name' in body
  const local_model_url  = String(body.local_model_url ?? '').trim() || null
  const local_model_name = String(body.local_model_name ?? '').trim() || null
  if (local_model_url) {
    const reason = await checkModelUrl(local_model_url)
    if (reason) return res.status(400).json({ error: `Model URL not allowed: ${reason}` })
  }
  try {
    const pool = getPool()
    await pool.query(
      `INSERT INTO ai_settings
         (org_id, external_enabled, local_model_url, local_model_name,
          budget_usd_daily, feature_policies, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (org_id) DO UPDATE SET
         external_enabled  = COALESCE($2, ai_settings.external_enabled),
         local_model_url   = CASE WHEN $8::boolean THEN $3 ELSE ai_settings.local_model_url END,
         local_model_name  = CASE WHEN $9::boolean THEN $4 ELSE ai_settings.local_model_name END,
         budget_usd_daily  = COALESCE($5, ai_settings.budget_usd_daily),
         feature_policies  = COALESCE($6, ai_settings.feature_policies),
         updated_at        = NOW(),
         updated_by        = $7`,
      [orgId, external_enabled ?? null, local_model_url, local_model_name,
       budget_usd_daily ?? null, feature_policies ? JSON.stringify(feature_policies) : null,
       req.user?.uid || req.user?.role, urlGiven, nameGiven]
    )
    invalidateOrgPolicy(orgId)
    res.json({ ok: true })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── GET /api/ai/health ────────────────────────────────────────────────────────
router.get('/ai/health', async (req, res) => {
  const orgId    = _resolveOrgId(req)
  const inProcess = getProviderHealth()

  let selfHosted = { ok: false, models: [], latencyMs: null }
  if (orgId) {
    try {
      const pool = getPool()
      const { rows } = await pool.query(
        `SELECT local_model_url FROM ai_settings WHERE org_id=$1`, [orgId]
      )
      const url = rows[0]?.local_model_url
      if (url) selfHosted = await checkHealth(url)
    } catch { /* ignore */ }
  }

  res.json({
    gemini:      inProcess.gemini,
    self_hosted: { ...inProcess.self_hosted, ...selfHosted },
    timestamp:   new Date().toISOString(),
  })
})

// ── GET /api/ai/stats ─────────────────────────────────────────────────────────
router.get('/ai/stats', async (req, res) => {
  const orgId = _resolveOrgId(req)
  const days  = parseDays(req.query.days)
  if (!days) return res.status(400).json({ error: 'days must be a whole number between 1 and 3650' })

  try {
    const pool = getPool()
    let rows

    if (orgId) {
      // Single-org view
      const result = await pool.query(
        `SELECT
           provider,
           COUNT(*)                            AS requests,
           ROUND(AVG(latency_ms))              AS avg_latency_ms,
           ROUND(SUM(cost_usd)::numeric, 4)    AS total_cost_usd,
           ROUND(AVG(confidence)::numeric, 2)  AS avg_confidence,
           COUNT(*) FILTER (WHERE feedback=1)  AS thumbs_up,
           COUNT(*) FILTER (WHERE feedback=-1) AS thumbs_down
         FROM ai_interactions
         WHERE org_id=$1
           AND created_at >= NOW() - ($2 || ' days')::INTERVAL
         GROUP BY provider
         ORDER BY requests DESC`,
        [orgId, days]
      )
      rows = result.rows
    } else {
      // All-orgs view for superadmin
      const result = await pool.query(
        `SELECT
           provider,
           COUNT(*)                            AS requests,
           ROUND(AVG(latency_ms))              AS avg_latency_ms,
           ROUND(SUM(cost_usd)::numeric, 4)    AS total_cost_usd,
           ROUND(AVG(confidence)::numeric, 2)  AS avg_confidence,
           COUNT(*) FILTER (WHERE feedback=1)  AS thumbs_up,
           COUNT(*) FILTER (WHERE feedback=-1) AS thumbs_down
         FROM ai_interactions
         WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         GROUP BY provider
         ORDER BY requests DESC`,
        [days]
      )
      rows = result.rows
    }

    const total = rows.reduce((s, r) => s + parseInt(r.requests), 0)
    const saved = rows.filter(r => r.provider !== 'gemini' && !r.provider?.startsWith('gemini'))
                     .reduce((s, r) => s + parseInt(r.requests), 0)

    res.json({
      period:     `last ${days} days`,
      scope:      orgId ? 'org' : 'all_orgs',
      total,
      localSaved: saved,
      savingsPct: total > 0 ? Math.round(saved / total * 100) : 0,
      breakdown:  rows,
    })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── GET /api/ai/orgs (superadmin only) ────────────────────────────────────────
// Returns all orgs with a brief AI usage summary for the org-selector dropdown.
router.get('/ai/orgs', async (req, res) => {
  if (!isSuper(req)) return res.status(403).json({ error: 'Superadmin only' })
  const days = parseDays(req.query.days)
  if (!days) return res.status(400).json({ error: 'days must be a whole number between 1 and 3650' })
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT
         o.id, o.name, o.slug,
         COUNT(i.id)                          AS requests,
         ROUND(SUM(i.cost_usd)::numeric, 4)   AS cost_usd,
         MAX(i.created_at)                    AS last_active
       FROM organizations o
       LEFT JOIN ai_interactions i
         ON i.org_id = o.id
         AND i.created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY o.id, o.name, o.slug
       ORDER BY requests DESC NULLS LAST, o.name`,
      [days]
    )
    res.json({ orgs: rows })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── GET /api/ai/learning/candidates ──────────────────────────────────────────
router.get('/ai/learning/candidates', async (req, res) => {
  const orgId = _resolveOrgId(req)
  try {
    const pool = getPool()
    const params = orgId ? [orgId] : []
    const where  = orgId
      ? `WHERE (org_id=$1 OR org_id IS NULL) AND status IN ('validated','pending') AND (evidence_count >= 2 OR type='negative_feedback')`
      : `WHERE status IN ('validated','pending') AND (evidence_count >= 2 OR type='negative_feedback')`

    const { rows } = await pool.query(
      `SELECT id, org_id, type, feature, proposed_change, eval_score, evidence_count, created_at
       FROM ai_learning_candidates
       ${where}
       ORDER BY eval_score DESC NULLS LAST, evidence_count DESC
       LIMIT 50`,
      params
    )
    res.json({ candidates: rows })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── POST /api/ai/learning/candidates/:id/approve ─────────────────────────────
router.post('/ai/learning/candidates/:id/approve', async (req, res) => {
  const candidateId = parseInt(req.params.id)
  if (!candidateId) return res.status(400).json({ error: 'Invalid id' })

  // For superadmin, resolve the candidate's orgId from the DB
  let orgId = _resolveOrgId(req)
  if (!orgId && isSuper(req)) {
    try {
      const pool = getPool()
      const { rows } = await pool.query(
        `SELECT org_id FROM ai_learning_candidates WHERE id=$1`, [candidateId]
      )
      orgId = rows[0]?.org_id
    } catch { /* ignore */ }
  }
  if (!orgId) return res.status(400).json({ error: 'Cannot determine orgId for this candidate' })

  try {
    const result = await promoteCandidate(candidateId, req.user?.uid || req.user?.role, orgId)
    res.json(result)
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── POST /api/ai/learning/candidates/:id/reject ──────────────────────────────
router.post('/ai/learning/candidates/:id/reject', async (req, res) => {
  const candidateId = parseInt(req.params.id)
  const { note }    = req.body || {}
  if (!candidateId) return res.status(400).json({ error: 'Invalid id' })

  // Pin to an orgId as /approve does, so rejectCandidate checks ownership.
  let orgId = _resolveOrgId(req)
  if (!orgId && isSuper(req)) {
    try {
      const pool = getPool()
      const { rows } = await pool.query(
        `SELECT org_id FROM ai_learning_candidates WHERE id=$1`, [candidateId]
      )
      orgId = rows[0]?.org_id
    } catch { /* ignore */ }
  }
  if (!orgId) return res.status(400).json({ error: 'Cannot determine orgId for this candidate' })

  try {
    const result = await rejectCandidate(candidateId, req.user?.uid || req.user?.role, note, orgId)
    res.json(result)
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── POST /api/ai/learning/rollback ────────────────────────────────────────────
router.post('/ai/learning/rollback', async (req, res) => {
  const orgId    = _resolveOrgId(req)
  const { feature, rule_type: ruleType } = req.body || {}
  if (!orgId || !feature || !ruleType)
    return res.status(400).json({ error: 'orgId, feature, and rule_type are required' })
  try {
    const result = await rollback(orgId, feature, ruleType)
    res.json(result)
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── POST /api/ai/learning/run-batch ──────────────────────────────────────────
router.post('/ai/learning/run-batch', async (req, res) => {
  const orgId = _resolveOrgId(req)
  if (!orgId) return res.status(400).json({ error: 'orgId is required' })
  try {
    const result = await runBatch(orgId, 100)
    res.json(result)
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

// ── GET /api/ai/rule-versions ─────────────────────────────────────────────────
router.get('/ai/rule-versions', async (req, res) => {
  const orgId = _resolveOrgId(req)
  try {
    const pool = getPool()
    let rows
    if (orgId) {
      const result = await pool.query(
        `SELECT id, org_id, feature, rule_type, version, config, eval_metrics, active, promoted_by, activated_at
         FROM ai_rule_versions
         WHERE org_id=$1 OR org_id IS NULL
         ORDER BY feature, rule_type, version DESC`,
        [orgId]
      )
      rows = result.rows
    } else {
      // Superadmin: all orgs
      const result = await pool.query(
        `SELECT r.id, r.org_id, o.name AS org_name, r.feature, r.rule_type,
                r.version, r.config, r.eval_metrics, r.active, r.promoted_by, r.activated_at
         FROM ai_rule_versions r
         LEFT JOIN organizations o ON o.id = r.org_id
         ORDER BY o.name, r.feature, r.rule_type, r.version DESC`
      )
      rows = result.rows
    }
    res.json({ versions: rows })
  } catch (e) { console.error('[ai-settings]', e); res.status(500).json({ error: 'Internal server error' }) }
})

export default router
