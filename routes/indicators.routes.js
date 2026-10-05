// Indicator framework: per-project indicator definitions (Activity/Output/Outcome/
// Impact), disaggregations and per-FY targets (schema in 028).
//
//   GET    /api/projects/:projectKey/indicators                — list + filters
//   POST   /api/projects/:projectKey/indicators                — create
//   PUT    /api/projects/:projectKey/indicators/:id             — edit
//   POST   /api/projects/:projectKey/indicators/:id/deactivate
//   POST   /api/projects/:projectKey/indicators/:id/archive
//   PUT    /api/projects/:projectKey/indicators/:id/targets      — upsert one FY/scope target
//   POST   /api/projects/:projectKey/indicators/copy             — copy from another project/FY
//   POST   /api/projects/:projectKey/indicators/bulk-import      — Excel bulk import
//   GET    /api/projects/:projectKey/indicators/:id/history       — change history
//
// All endpoints require role manager|admin|superadmin (requireEditor).

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'

const router = Router()

const LEVELS = ['activity', 'output', 'outcome', 'impact']
const FREQUENCIES = ['monthly', 'quarterly', 'annual', 'baseline_endline']
const AGGREGATIONS = ['sum', 'cumulative', 'average', 'latest', 'percentage']
const TARGET_SCOPES = ['org', 'project', 'geography', 'gender', 'beneficiary_category']
const DISAGGREGATION_DIMENSIONS = [
  'gender', 'age_group', 'social_category', 'disability', 'geography',
  'occupation', 'intervention_type', 'shg_membership', 'waterbody', 'beneficiary_category',
]

// Blank numeric cells arrive as '', which `?? null` misses and Postgres rejects for NUMERIC.
function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function isDuplicateCodeError(e) {
  return e?.code === '23505' && /indicators_org_project_code_key/.test(e?.constraint || '')
}

function logAudit(pool, { orgId, actorUid, actorName, action, targetId, diff }) {
  pool.query(
    `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
     VALUES ($1,$2,$3,$4,'indicators',$5,$6)`,
    [orgId, actorUid, actorName, action, targetId, JSON.stringify(diff || {})]
  ).catch(() => {})
}

// GET /api/projects/:projectKey/indicators?level=&active=&search=
router.get('/projects/:projectKey/indicators', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const level = (req.query.level || '').trim()
    const active = req.query.active // 'true' | 'false' | undefined
    const search = (req.query.search || '').trim()

    const where = ['i.org_id = $1', 'i.project_key = $2']
    const params = [orgId, projectKey]
    if (level) { params.push(level); where.push(`i.level = $${params.length}`) }
    if (active === 'true') where.push(`i.archived_at IS NULL AND i.is_active = true`)
    if (active === 'false') where.push(`(i.archived_at IS NOT NULL OR i.is_active = false)`)
    if (search) {
      params.push(`%${search}%`)
      where.push(`(i.code ILIKE $${params.length} OR i.name ILIKE $${params.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows } = await pool.query(
      `SELECT i.*,
         coalesce(
           (SELECT json_agg(d.dimension ORDER BY d.dimension) FROM indicator_disaggregations d WHERE d.indicator_id = i.id),
           '[]'
         ) AS disaggregations,
         coalesce(
           (SELECT json_agg(json_build_object(
              'id', t.id, 'fy_start_year', t.fy_start_year, 'scope', t.scope,
              'scope_value', t.scope_value, 'annual_target', t.annual_target
            ) ORDER BY t.fy_start_year DESC) FROM indicator_targets t WHERE t.indicator_id = i.id),
           '[]'
         ) AS targets
       FROM indicators i
       WHERE ${whereSql}
       ORDER BY i.level, i.code`,
      params
    )
    res.json({ indicators: rows })
  } catch (e) {
    console.error('[indicators GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

function validateIndicatorBody(body) {
  const code = String(body.code || '').trim()
  const name = String(body.name || '').trim()
  const level = String(body.level || '').trim()
  if (!code) return 'code is required'
  if (!name) return 'name is required'
  if (!LEVELS.includes(level)) return `level must be one of ${LEVELS.join(', ')}`
  if (body.frequency && !FREQUENCIES.includes(body.frequency)) return `frequency must be one of ${FREQUENCIES.join(', ')}`
  if (body.aggregation_method && !AGGREGATIONS.includes(body.aggregation_method)) return `aggregation_method must be one of ${AGGREGATIONS.join(', ')}`
  if (Array.isArray(body.disaggregations)) {
    for (const d of body.disaggregations) {
      if (!DISAGGREGATION_DIMENSIONS.includes(d)) return `Unknown disaggregation dimension "${d}"`
    }
  }
  return null
}

// POST /api/projects/:projectKey/indicators
// Body: { code, name, level, unit?, frequency?, aggregation_method?, data_source?,
//         responsible_person?, baseline_value?, baseline_date?, definition?,
//         disaggregations?: string[], initial_target?: { fy_start_year, scope, scope_value?, annual_target } }
router.post('/projects/:projectKey/indicators', async (req, res) => {
  if (!requireEditor(req, res)) return
  const body = req.body || {}
  const validationError = validateIndicatorBody(body)
  if (validationError) return res.status(400).json({ error: validationError })

  const pool = getPool()
  const orgId = req.user.orgId
  const projectKey = req.params.projectKey
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [indicator] } = await client.query(
      `INSERT INTO indicators
         (org_id, project_key, code, name, level, unit, frequency, aggregation_method,
          data_source, responsible_person, baseline_value, baseline_date, definition, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        orgId, projectKey, body.code.trim(), body.name.trim(), body.level,
        body.unit || null, body.frequency || 'monthly', body.aggregation_method || 'sum',
        body.data_source || null, body.responsible_person || null,
        numOrNull(body.baseline_value), body.baseline_date || null, body.definition || null,
        req.user.name || 'unknown',
      ]
    )

    for (const dimension of body.disaggregations || []) {
      await client.query(
        `INSERT INTO indicator_disaggregations (indicator_id, dimension) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [indicator.id, dimension]
      )
    }

    if (body.initial_target) {
      const t = body.initial_target
      if (!Number.isInteger(t.fy_start_year) || !TARGET_SCOPES.includes(t.scope)) {
        throw new Error('initial_target requires a valid fy_start_year and scope')
      }
      await client.query(
        `INSERT INTO indicator_targets (indicator_id, fy_start_year, scope, scope_value, annual_target)
         VALUES ($1,$2,$3,$4,$5)`,
        [indicator.id, t.fy_start_year, t.scope, t.scope_value || null, numOrNull(t.annual_target)]
      )
    }

    await client.query('COMMIT')
    logAudit(pool, { orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'indicator.create', targetId: indicator.id, diff: { code: indicator.code, name: indicator.name } })
    res.status(201).json({ ok: true, indicator })
  } catch (e) {
    await client.query('ROLLBACK')
    if (isDuplicateCodeError(e)) {
      return res.status(409).json({ error: `An indicator with code "${body.code}" already exists in this project` })
    }
    console.error('[indicators POST]', e.message)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// PUT /api/projects/:projectKey/indicators/:id
router.put('/projects/:projectKey/indicators/:id', async (req, res) => {
  if (!requireEditor(req, res)) return
  const body = req.body || {}
  const validationError = validateIndicatorBody(body)
  if (validationError) return res.status(400).json({ error: validationError })

  const pool = getPool()
  const orgId = req.user.orgId
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [before] } = await client.query(
      `SELECT * FROM indicators WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, orgId, req.params.projectKey]
    )
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }

    const { rows: [indicator] } = await client.query(
      `UPDATE indicators SET
         code = $1, name = $2, level = $3, unit = $4, frequency = $5, aggregation_method = $6,
         data_source = $7, responsible_person = $8, baseline_value = $9, baseline_date = $10,
         definition = $11, updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [
        body.code.trim(), body.name.trim(), body.level, body.unit || null,
        body.frequency || 'monthly', body.aggregation_method || 'sum',
        body.data_source || null, body.responsible_person || null,
        numOrNull(body.baseline_value), body.baseline_date || null, body.definition || null,
        req.params.id,
      ]
    )

    if (Array.isArray(body.disaggregations)) {
      await client.query(`DELETE FROM indicator_disaggregations WHERE indicator_id = $1`, [req.params.id])
      for (const dimension of body.disaggregations) {
        await client.query(
          `INSERT INTO indicator_disaggregations (indicator_id, dimension) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [req.params.id, dimension]
        )
      }
    }

    await client.query('COMMIT')
    logAudit(pool, {
      orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'indicator.update', targetId: req.params.id,
      diff: { before: { code: before.code, name: before.name }, after: { code: indicator.code, name: indicator.name } },
    })
    res.json({ ok: true, indicator })
  } catch (e) {
    await client.query('ROLLBACK')
    if (isDuplicateCodeError(e)) {
      return res.status(409).json({ error: `An indicator with code "${body.code}" already exists in this project` })
    }
    console.error('[indicators PUT]', e.message)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

async function setActiveState(req, res, { isActive, archive }) {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE indicators SET is_active = $1, archived_at = $2, updated_at = NOW()
       WHERE id = $3 AND org_id = $4 AND project_key = $5 RETURNING *`,
      [isActive, archive ? new Date() : null, req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    logAudit(getPool(), {
      orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name,
      action: archive ? 'indicator.archive' : 'indicator.deactivate', targetId: req.params.id, diff: {},
    })
    res.json({ ok: true, indicator: rows[0] })
  } catch (e) {
    console.error('[indicators status change]', e.message)
    res.status(500).json({ error: e.message })
  }
}

router.post('/projects/:projectKey/indicators/:id/deactivate', (req, res) => setActiveState(req, res, { isActive: false, archive: false }))
router.post('/projects/:projectKey/indicators/:id/reactivate', (req, res) => setActiveState(req, res, { isActive: true, archive: false }))
router.post('/projects/:projectKey/indicators/:id/archive', (req, res) => setActiveState(req, res, { isActive: false, archive: true }))

// PUT /api/projects/:projectKey/indicators/:id/targets
// Body: { fy_start_year, scope, scope_value?, annual_target }
router.put('/projects/:projectKey/indicators/:id/targets', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { fy_start_year, scope, scope_value, annual_target } = req.body || {}
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!TARGET_SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of ${TARGET_SCOPES.join(', ')}` })

    const pool = getPool()
    const { rows: [indicator] } = await pool.query(
      `SELECT id FROM indicators WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!indicator) return res.status(404).json({ error: 'Not found' })

    const { rows: [target] } = await pool.query(
      `INSERT INTO indicator_targets (indicator_id, fy_start_year, scope, scope_value, annual_target)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (indicator_id, fy_start_year, scope, COALESCE(scope_value, ''))
         DO UPDATE SET annual_target = $5, updated_at = NOW()
       RETURNING *`,
      [req.params.id, fy_start_year, scope, scope_value || null, numOrNull(annual_target)]
    )
    logAudit(pool, {
      orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name,
      action: 'indicator.target_set', targetId: req.params.id,
      diff: { fy_start_year, scope, scope_value: scope_value || null, annual_target: numOrNull(annual_target) },
    })
    res.json({ ok: true, target })
  } catch (e) {
    console.error('[indicators targets PUT]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/projects/:projectKey/indicators/copy
// Body: { fromProjectKey, fromFyStartYear?, toFyStartYear?, indicatorIds: string[] }
// Copies the selected indicators (+ disaggregations, + one target if fromFyStartYear
// given) from another project (or another FY of this same project) into this project.
router.post('/projects/:projectKey/indicators/copy', async (req, res) => {
  if (!requireEditor(req, res)) return
  const { fromProjectKey, fromFyStartYear, toFyStartYear, indicatorIds } = req.body || {}
  if (!fromProjectKey) return res.status(400).json({ error: 'fromProjectKey required' })
  if (!Array.isArray(indicatorIds) || !indicatorIds.length) return res.status(400).json({ error: 'indicatorIds[] required' })

  const pool = getPool()
  const orgId = req.user.orgId
  const toProjectKey = req.params.projectKey
  const client = await pool.connect()
  const copied = []
  const skipped = []
  try {
    await client.query('BEGIN')
    const { rows: sourceIndicators } = await client.query(
      `SELECT * FROM indicators WHERE org_id = $1 AND project_key = $2 AND id = ANY($3::uuid[])`,
      [orgId, fromProjectKey, indicatorIds]
    )
    for (const src of sourceIndicators) {
      try {
        const { rows: [copy] } = await client.query(
          `INSERT INTO indicators
             (org_id, project_key, code, name, level, unit, frequency, aggregation_method,
              data_source, responsible_person, baseline_value, baseline_date, definition, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            orgId, toProjectKey, src.code, src.name, src.level, src.unit, src.frequency,
            src.aggregation_method, src.data_source, src.responsible_person,
            src.baseline_value, src.baseline_date, src.definition, req.user.name || 'unknown',
          ]
        )
        const { rows: dims } = await client.query(`SELECT dimension FROM indicator_disaggregations WHERE indicator_id = $1`, [src.id])
        for (const d of dims) {
          await client.query(`INSERT INTO indicator_disaggregations (indicator_id, dimension) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [copy.id, d.dimension])
        }
        if (Number.isInteger(fromFyStartYear)) {
          const { rows: targets } = await client.query(
            `SELECT * FROM indicator_targets WHERE indicator_id = $1 AND fy_start_year = $2`,
            [src.id, fromFyStartYear]
          )
          const targetFy = Number.isInteger(toFyStartYear) ? toFyStartYear : fromFyStartYear
          for (const t of targets) {
            await client.query(
              `INSERT INTO indicator_targets (indicator_id, fy_start_year, scope, scope_value, annual_target)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (indicator_id, fy_start_year, scope, COALESCE(scope_value, '')) DO NOTHING`,
              [copy.id, targetFy, t.scope, t.scope_value, t.annual_target]
            )
          }
        }
        copied.push(copy)
      } catch (e) {
        if (isDuplicateCodeError(e)) skipped.push({ code: src.code, reason: 'duplicate code in target project' })
        else throw e
      }
    }
    await client.query('COMMIT')
    logAudit(pool, {
      orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'indicator.copy', targetId: toProjectKey,
      diff: { fromProjectKey, copiedCodes: copied.map(c => c.code), skipped },
    })
    res.json({ ok: true, copied, skipped })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[indicators copy]', e.message)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// POST /api/projects/:projectKey/indicators/bulk-import
// Body: { rows: [{ code, name, level, unit?, frequency?, aggregation_method?, ... }] }
// Duplicate codes (in the request or already in the project) are skipped and
// reported, never overwritten with defaults.
router.post('/projects/:projectKey/indicators/bulk-import', async (req, res) => {
  if (!requireEditor(req, res)) return
  const { rows } = req.body || {}
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

  const pool = getPool()
  const orgId = req.user.orgId
  const projectKey = req.params.projectKey
  const client = await pool.connect()
  const created = []
  const errors = []
  try {
    await client.query('BEGIN')
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const validationError = validateIndicatorBody(r)
      if (validationError) { errors.push({ row: i + 1, code: r.code, error: validationError }); continue }
      try {
        const { rows: [indicator] } = await client.query(
          `INSERT INTO indicators
             (org_id, project_key, code, name, level, unit, frequency, aggregation_method,
              data_source, responsible_person, baseline_value, baseline_date, definition, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            orgId, projectKey, String(r.code).trim(), String(r.name).trim(), r.level,
            r.unit || null, r.frequency || 'monthly', r.aggregation_method || 'sum',
            r.data_source || null, r.responsible_person || null,
            numOrNull(r.baseline_value), r.baseline_date || null, r.definition || null,
            req.user.name || 'unknown',
          ]
        )
        created.push(indicator)
      } catch (e) {
        if (isDuplicateCodeError(e)) errors.push({ row: i + 1, code: r.code, error: `Duplicate code "${r.code}" — skipped` })
        else throw e
      }
    }
    await client.query('COMMIT')
    logAudit(pool, {
      orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'indicator.bulk_import', targetId: projectKey,
      diff: { createdCount: created.length, errorCount: errors.length },
    })
    res.json({ ok: true, created: created.length, errors })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[indicators bulk-import]', e.message)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// GET /api/projects/:projectKey/indicators/:id/history
router.get('/projects/:projectKey/indicators/:id/history', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows } = await getPool().query(
      `SELECT action, actor_name, diff, created_at FROM audit_log
       WHERE org_id = $1 AND target_type = 'indicators' AND target_id = $2
       ORDER BY created_at DESC LIMIT 200`,
      [req.user.orgId, req.params.id]
    )
    res.json({ history: rows })
  } catch (e) {
    console.error('[indicators history]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
