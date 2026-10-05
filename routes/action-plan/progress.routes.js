// Plan-aware cell data: load/save progress cells (single + bulk) and edit history.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { check, recordVerdict } from '../../lib/dataCorrectness/index.js'
import { requireEditor, requireAuth } from '../../lib/routeGuards.js'
import { resolvePlanKey } from './helpers.js'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
//  CELL DATA (plan-aware)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/action-plan/progress?plan=key
router.get('/action-plan/progress', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const planKey = await resolvePlanKey(req)
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT indicator, planned, achieved, notes, uploaded_by, updated_at, created_at
       FROM project_deliverables
       WHERE org_id = $1 AND project = $2 AND data_type = 'action_plan'`,
      [req.user.orgId, planKey]
    )
    const map = {}
    for (const r of rows) {
      map[r.indicator] = {
        target:    r.planned,
        achieved:  r.achieved,
        notes:     r.notes || '',
        updatedBy: r.uploaded_by,
        updatedAt: r.updated_at,
      }
    }
    res.json(map)
  } catch (e) {
    console.error('[action-plan/progress GET]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/action-plan/progress — body: { plan?, indicator, target?, achieved?, notes? }
router.put('/action-plan/progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const planKey = await resolvePlanKey(req)
    const { orgId, name, uid } = req.user
    const { indicator, target, achieved, notes } = req.body || {}
    if (!indicator) return res.status(400).json({ error: 'indicator is required' })

    const parts  = indicator.split('|')
    const period = parts[2] || ''
    const pool   = getPool()

    const { rows: prev } = await pool.query(
      `SELECT planned, achieved, notes FROM project_deliverables
       WHERE org_id = $1 AND project = $2 AND indicator = $3`,
      [orgId, planKey, indicator]
    )
    const before = prev[0] || { planned: null, achieved: null, notes: null }

    await pool.query(
      `INSERT INTO project_deliverables
         (org_id, project, indicator, planned, achieved, notes, period, data_type, uploaded_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'action_plan',$8, NOW())
       ON CONFLICT (org_id, project, indicator)
         DO UPDATE SET planned     = COALESCE(EXCLUDED.planned,    project_deliverables.planned),
                       achieved    = COALESCE(EXCLUDED.achieved,   project_deliverables.achieved),
                       notes       = COALESCE(EXCLUDED.notes,      project_deliverables.notes),
                       uploaded_by = EXCLUDED.uploaded_by,
                       updated_at  = NOW()`,
      [orgId, planKey, indicator, target ?? null, achieved ?? null, notes ?? null, period, name ?? 'unknown']
    )

    // Notes may hold PII; audit only that they changed.
    const diff = { indicator, plan: planKey }
    if (target !== undefined   && target   !== before.planned)  diff.target   = { before: before.planned,  after: target ?? null }
    if (achieved !== undefined && achieved !== before.achieved) diff.achieved = { before: before.achieved, after: achieved ?? null }
    if (notes !== undefined    && (notes ?? '') !== (before.notes ?? '')) {
      diff.notes_changed = true
    }
    if (Object.keys(diff).length > 2) {
      pool.query(
        `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
         VALUES ($1,$2,$3,'action_plan.update','project_deliverables',$4,$5)`,
        [orgId, uid || 'system', name || 'unknown', indicator, JSON.stringify(diff)]
      ).catch(() => {})
    }

    // Data-correctness anomaly check (soft: flag only)
    check('anomaly', {
      planned:  target ?? before.planned,
      achieved: achieved ?? before.achieved,
      report_date: new Date().toISOString().slice(0, 10),
    }, {
      orgId, userId: uid, userName: name, kind: 'action_plan_cell', cid: req.cid,
    }).then(verdict => {
      if (verdict.action !== 'allow') {
        // For action plan cells we flag the project_deliverables row, looked up by the composite key
        pool.query(
          `UPDATE project_deliverables SET quality_flag = $1
             WHERE org_id = $2 AND project = $3 AND indicator = $4`,
          [verdict.severity === 'high' || verdict.severity === 'medium' ? 'needs_review' : 'low_confidence',
           orgId, planKey, indicator]
        ).catch(() => {})
        return recordVerdict(verdict, null, { orgId, userId: uid, userName: name, cid: req.cid })
      }
    }).catch(e => console.warn('[action-plan/progress] correctness check failed:', e.message))

    res.json({ ok: true })
  } catch (e) {
    console.error('[action-plan/progress PUT]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plan/progress/bulk — apply the same target+/-achieved value to
// many indicators in one request. Used by the Quickfill bar in ActionPlanTab.
// Body: { plan?, indicators: ["sn|loc|month", ...], target?: number|null, achieved?: number|null, notes?: string }
router.post('/action-plan/progress/bulk', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const planKey = await resolvePlanKey(req)
    const { indicators, target, achieved, notes } = req.body || {}
    if (!Array.isArray(indicators) || indicators.length === 0) {
      return res.status(400).json({ error: 'indicators[] required' })
    }
    if (target === undefined && achieved === undefined && notes === undefined) {
      return res.status(400).json({ error: 'at least one of target / achieved / notes required' })
    }
    const pool = getPool()
    const { orgId, name, uid } = req.user
    const MAX = 5000   // sanity cap
    if (indicators.length > MAX) return res.status(400).json({ error: `Too many indicators (max ${MAX})` })

    // Pre-clean indicators so we only operate on valid "sn|loc|month" strings
    const validInds = indicators.filter(ind => typeof ind === 'string' && ind.includes('|'))
    if (validInds.length === 0) return res.json({ ok: true, updated: 0 })

    // 500-row multi-row INSERTs: 5000 serial queries would hit the 60s App Engine timeout.
    const CHUNK_SIZE = 500
    let updated = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < validInds.length; i += CHUNK_SIZE) {
        const chunk = validInds.slice(i, i + CHUNK_SIZE)
        const valuesSQL = []
        const params = []
        chunk.forEach((ind, idx) => {
          const period = ind.split('|')[2] || ''
          const base = idx * 8
          valuesSQL.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},'action_plan',$${base+8},NOW())`)
          params.push(orgId, planKey, ind, target ?? null, achieved ?? null, notes ?? null, period, name ?? 'unknown')
        })
        await client.query(
          `INSERT INTO project_deliverables
             (org_id, project, indicator, planned, achieved, notes, period, data_type, uploaded_by, updated_at)
           VALUES ${valuesSQL.join(',')}
           ON CONFLICT (org_id, project, indicator)
             DO UPDATE SET planned     = COALESCE(EXCLUDED.planned,    project_deliverables.planned),
                           achieved    = COALESCE(EXCLUDED.achieved,   project_deliverables.achieved),
                           notes       = COALESCE(EXCLUDED.notes,      project_deliverables.notes),
                           uploaded_by = EXCLUDED.uploaded_by,
                           updated_at  = NOW()`,
          // ≤4000 params per chunk, well under PG's 65535 limit
          params
        )
        updated += chunk.length
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    // Single audit-log entry covering the whole bulk operation
    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.bulk_update','project_deliverables',$4,$5)`,
      [orgId, uid || 'system', name || 'unknown', planKey,
       JSON.stringify({ plan: planKey, count: updated, target: target ?? null, achieved: achieved ?? null, notes: notes != null ? '(set)' : undefined })]
    ).catch(() => {})

    res.json({ ok: true, updated })
  } catch (e) {
    console.error('[action-plan/progress/bulk]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plan/history?plan=key&indicator=...
router.get('/action-plan/history', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool      = getPool()
    const indicator = req.query.indicator ? String(req.query.indicator) : null
    const limit     = Math.min(parseInt(req.query.limit) || 50, 200)

    let sql, params
    if (indicator) {
      sql = `SELECT actor_name, target_id AS indicator, diff, created_at
             FROM audit_log
             WHERE org_id = $1 AND action = 'action_plan.update' AND target_id = $2
             ORDER BY created_at DESC LIMIT $3`
      params = [req.user.orgId, indicator, limit]
    } else {
      sql = `SELECT actor_name, target_id AS indicator, diff, created_at
             FROM audit_log
             WHERE org_id = $1 AND action = 'action_plan.update'
             ORDER BY created_at DESC LIMIT $2`
      params = [req.user.orgId, limit]
    }
    const { rows } = await pool.query(sql, params)
    res.json({ history: rows })
  } catch (e) {
    console.error('[action-plan/history]', e.message)
    res.json({ history: [] })
  }
})

export default router
