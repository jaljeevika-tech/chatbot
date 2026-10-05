// Plan CRUD: list, fetch, create, portfolio fields, activity tracking fields,
// archive/delete, clear-plan, restore and the archived list.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { requireEditor, requireAdmin, requireAuth } from '../../lib/routeGuards.js'
import { healthFromTargets, complianceStatusForItem, aggregateActionPlans } from './helpers.js'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/action-plans — list, with Portfolio Overview / Org Dashboard fields
// (donor, region, budget, health/compliance or overrides, target% / budgetUsed%).
router.get('/action-plans', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    // Soft-deleted plans only appear via /archived
    const includeArchived = req.query.include_archived === '1'
    const { rows: plans } = await pool.query(
      `SELECT id, project_key, name, year, start_month, locations,
              jsonb_array_length(activities) AS activity_count,
              uploaded_by, created_at, updated_at, active,
              donor, region, budget, end_date, health_override, compliance_override
       FROM action_plans
       WHERE org_id = $1 ${includeArchived ? '' : 'AND active = true'}
       ORDER BY active DESC, updated_at DESC`,
      [orgId]
    )
    if (!plans.length) return res.json({ plans: [] })

    const projectKeys = plans.map(p => p.project_key)

    // Seed-merged totals for active plans only; an archived plan pulled in via
    // ?include_archived=1 falls back to {target:0, achieved:0}.
    const { perProject } = await aggregateActionPlans(orgId)

    // `utilised` comes live from budget_utilisation_reports, not the budget_heads
    // cache: budget_heads keeps stale rows when a section is renamed between
    // uploads, which double-counts spend. `budget` is the project's headline
    // Total Budget (action_plans.budget), not a sum of line items.
    const { rows: budgetRows } = await pool.query(
      `SELECT project_key, COALESCE(SUM(expenses), 0)::numeric AS utilised
       FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = ANY($2)
       GROUP BY project_key`,
      [orgId, projectKeys]
    ).catch(() => ({ rows: [] }))
    const utilisedByProject = new Map(budgetRows.map(r => [r.project_key, Number(r.utilised)]))

    const { rows: complianceRows } = await pool.query(
      `SELECT project_key, due_date, manual_status
       FROM compliance_items
       WHERE org_id = $1 AND project_key = ANY($2)`,
      [orgId, projectKeys]
    ).catch(() => ({ rows: [] }))
    const complianceByProject = new Map()
    for (const c of complianceRows) {
      const status = c.manual_status || complianceStatusForItem(c.due_date)
      const rank = { overdue: 2, upcoming: 1, valid: 0 }
      const worst = complianceByProject.get(c.project_key)
      if (!worst || rank[status] > rank[worst]) complianceByProject.set(c.project_key, status)
    }
    // Map compliance's overdue/upcoming/valid vocabulary onto the red/amber/green badges Portfolio cards use.
    const complianceColorFor = { overdue: 'red', upcoming: 'amber', valid: 'green' }

    const enriched = plans.map(p => {
      const t = perProject.get(p.project_key) || { target: 0, achieved: 0 }
      const budget = Number(p.budget) || 0
      const utilised = utilisedByProject.get(p.project_key) || 0
      const target = t.target > 0 ? Math.round((t.achieved / t.target) * 100) : 0
      const budgetUsed = budget > 0 ? Math.round((utilised / budget) * 100) : 0
      const complianceKey = complianceByProject.get(p.project_key) || 'valid'
      return {
        ...p,
        target,
        budgetUsed,
        health: p.health_override || healthFromTargets(t.target, t.achieved),
        compliance: p.compliance_override || complianceColorFor[complianceKey],
      }
    })

    res.json({ plans: enriched })
  } catch (e) {
    console.error('[action-plans GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/action-plans/:id/portfolio — EditProjectModal.tsx's "Edit Project".
// Full-replace: the modal pre-fills every field from GET /:id, so the body is the
// complete state. Admin-only, stricter than create/delete.
router.put('/action-plans/:id([0-9a-fA-F-]{36})/portfolio', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const {
      name, year, start_month, donor, region, budget, end_date, health_override, compliance_override,
      location_state_code, location_state_name, location_district_code, location_district_name,
      location_block_code, location_block_name, location_panchayat_code, location_panchayat_name,
      location_village_code, location_village_name,
      locations, locations_detail,
    } = req.body || {}
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' })
    if (health_override && !['green', 'amber', 'red'].includes(health_override)) {
      return res.status(400).json({ error: 'health_override must be green|amber|red' })
    }
    if (compliance_override && !['green', 'amber', 'red'].includes(compliance_override)) {
      return res.status(400).json({ error: 'compliance_override must be green|amber|red' })
    }
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE action_plans
       SET name = $1, year = $2, start_month = $3,
           donor = $4, region = $5, budget = $6, end_date = $7,
           health_override = $8, compliance_override = $9,
           locations = $10,
           location_state_code = $11, location_state_name = $12,
           location_district_code = $13, location_district_name = $14,
           location_block_code = $15, location_block_name = $16,
           location_panchayat_code = $17, location_panchayat_name = $18,
           location_village_code = $19, location_village_name = $20,
           updated_at = NOW()
       WHERE id = $21 AND org_id = $22
       RETURNING id, project_key, name`,
      [
        String(name).trim(), year || null, start_month || 4,
        donor ?? null, region ?? null, budget ?? null, end_date ?? null,
        health_override ?? null, compliance_override ?? null,
        Array.isArray(locations) ? locations : [],
        location_state_code ?? null, location_state_name ?? null,
        location_district_code ?? null, location_district_name ?? null,
        location_block_code ?? null, location_block_name ?? null,
        location_panchayat_code ?? null, location_panchayat_name ?? null,
        location_village_code ?? null, location_village_name ?? null,
        req.params.id, req.user.orgId,
      ]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const planId = rows[0].id

    // Full-replace of locations, as in POST /action-plans; the modal always sends the list.
    if (Array.isArray(locations_detail)) {
      await pool.query(`DELETE FROM action_plan_locations WHERE action_plan_id = $1`, [planId])
      if (locations_detail.length) {
        const cols = [
          'action_plan_id', 'org_id', 'state_code', 'state_name', 'district_code', 'district_name',
          'block_code', 'block_name', 'panchayat_code', 'panchayat_name', 'village_code', 'village_name', 'sort_order',
        ]
        const values = []
        const placeholders = locations_detail.map((loc, i) => {
          const base = i * cols.length
          values.push(
            planId, req.user.orgId,
            loc?.state_code ?? null, loc?.state_name ?? null,
            loc?.district_code ?? null, loc?.district_name ?? null,
            loc?.block_code ?? null, loc?.block_name ?? null,
            loc?.panchayat_code ?? null, loc?.panchayat_name ?? null,
            loc?.village_code ?? null, loc?.village_name ?? null,
            i,
          )
          return `(${cols.map((_, ci) => `$${base + ci + 1}`).join(', ')})`
        })
        await pool.query(
          `INSERT INTO action_plan_locations (${cols.join(', ')}) VALUES ${placeholders.join(', ')}`,
          values
        )
      }
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.edit','action_plans',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, planId,
       JSON.stringify({ name: rows[0].name, project_key: rows[0].project_key, locations_count: locations_detail?.length ?? null })]
    ).catch(() => {})

    res.json({ ok: true, id: rows[0].id, project_key: rows[0].project_key, name: rows[0].name })
  } catch (e) {
    console.error('[action-plans/:id/portfolio PUT]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id — full row plus locations_detail[] for EditProjectModal.tsx.
// :id is UUID-only so /template.xlsx falls through to its own handler.
router.get('/action-plans/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT * FROM action_plans WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const { rows: locations_detail } = await pool.query(
      `SELECT state_code, state_name, district_code, district_name, block_code, block_name,
              panchayat_code, panchayat_name, village_code, village_name
       FROM action_plan_locations WHERE action_plan_id = $1 ORDER BY sort_order`,
      [req.params.id]
    )
    res.json({ ...rows[0], locations_detail })
  } catch (e) {
    console.error('[action-plan]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const ACTIVITY_STATUS_VALUES   = ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Cancelled']
const ACTIVITY_PRIORITY_VALUES = ['High', 'Medium', 'Low']
const ACTIVITY_TRACKING_FIELDS = ['status', 'priority', 'due_date', 'evidence_link', 'challenges', 'next_action']

// PATCH /api/action-plans/:id/activities/:sn — lightweight tracking fields on one
// activity in the `activities` JSONB (numeric cells go through PUT /action-plan/progress).
// Body: any subset of { status, priority, due_date, evidence_link, challenges, next_action }.
// Only keys present are written, so concurrent edits to other fields aren't clobbered.
router.patch('/action-plans/:id([0-9a-fA-F-]{36})/activities/:sn(\\d+)', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const sn = parseInt(req.params.sn, 10)
    const patch = {}
    for (const f of ACTIVITY_TRACKING_FIELDS) {
      if (req.body?.[f] !== undefined) patch[f] = req.body[f]
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid tracking fields in body' })
    }
    if (patch.status !== null && patch.status !== undefined && !ACTIVITY_STATUS_VALUES.includes(patch.status)) {
      return res.status(400).json({ error: `status must be one of: ${ACTIVITY_STATUS_VALUES.join(', ')}` })
    }
    if (patch.priority !== null && patch.priority !== undefined && !ACTIVITY_PRIORITY_VALUES.includes(patch.priority)) {
      return res.status(400).json({ error: `priority must be one of: ${ACTIVITY_PRIORITY_VALUES.join(', ')}` })
    }
    if (patch.evidence_link != null && patch.evidence_link !== '' && !/^https?:\/\//i.test(patch.evidence_link)) {
      return res.status(400).json({ error: 'evidence_link must start with http:// or https://' })
    }

    const pool = getPool()
    const orgId = req.user.orgId

    // jsonb_agg "succeeds" even if no element matched, so 404 a bad :sn up front.
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM action_plans, jsonb_array_elements(activities) AS elem
       WHERE id = $1 AND org_id = $2 AND (elem->>'sn')::int = $3`,
      [req.params.id, orgId, sn]
    )
    if (!exists.length) return res.status(404).json({ error: 'Plan or activity not found' })

    // "Before" values for the audit diff (structured fields only).
    const { rows: beforeRows } = await pool.query(
      `SELECT elem AS activity FROM action_plans, jsonb_array_elements(activities) AS elem
       WHERE id = $1 AND org_id = $2 AND (elem->>'sn')::int = $3`,
      [req.params.id, orgId, sn]
    )
    const before = beforeRows[0]?.activity || {}

    // Single UPDATE; READ COMMITTED already serializes racing updates on the row.
    await pool.query(
      `UPDATE action_plans
       SET activities = (
             SELECT COALESCE(jsonb_agg(
               CASE WHEN (elem->>'sn')::int = $2
                    THEN elem || $3::jsonb
                    ELSE elem END
             ), '[]'::jsonb)
             FROM jsonb_array_elements(activities) AS elem
           ),
           updated_at = NOW()
       WHERE id = $1 AND org_id = $4`,
      [req.params.id, sn, JSON.stringify(patch), orgId]
    )

    // Structured fields get before/after; free-text/URL fields only a "_changed"
    // flag so their content never lands in audit_log.diff.
    const diff = { sn }
    if (patch.status   !== undefined && patch.status   !== before.status)   diff.status   = { before: before.status   ?? null, after: patch.status }
    if (patch.priority !== undefined && patch.priority !== before.priority) diff.priority = { before: before.priority ?? null, after: patch.priority }
    if (patch.due_date !== undefined && patch.due_date !== before.due_date) diff.due_date = { before: before.due_date ?? null, after: patch.due_date }
    if (patch.evidence_link !== undefined && patch.evidence_link !== before.evidence_link) diff.evidence_link_changed = true
    if (patch.challenges    !== undefined && patch.challenges    !== before.challenges)    diff.challenges_changed    = true
    if (patch.next_action   !== undefined && patch.next_action   !== before.next_action)   diff.next_action_changed   = true

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.activity_tracking_update','action_plans',$4,$5)`,
      [orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify(diff)]
    ).catch(() => {})

    res.json({ ok: true })
  } catch (e) {
    console.error('[action-plans activity PATCH]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans — create OR update-in-place
// Body: { name, year, start_month, locations[], activities[], project_key? }
router.post('/action-plans', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const {
      name, year, start_month, locations, activities, donor, region, budget, end_date, project_id, project_key: pinnedProjectKey,
      location_state_code, location_state_name, location_district_code, location_district_name,
      location_block_code, location_block_name, location_panchayat_code, location_panchayat_name,
      location_village_code, location_village_name,
      // locations_detail[]: one full State→Village chain per location
      // (037_action_plan_locations_table.sql). location_*_code/name mirror locations_detail[0].
      locations_detail,
    } = req.body || {}
    if (!name) return res.status(400).json({ error: 'name required' })
    // locations/activities are optional: "+ New Project" creates an empty shell
    // that "Upload Plan" fills later via the ON CONFLICT upsert below, which
    // never touches donor/region/budget/end_date.
    const locs = Array.isArray(locations) ? locations : []
    const acts = Array.isArray(activities) ? activities : []

    // project_key resolution:
    //   • pinnedProjectKey — uploading into an already-open project; use it as-is so
    //     a Name/Year mismatch in the file can't miss ON CONFLICT and create a new card.
    //   • otherwise slugify name + year, using the matched organizations.metadata.projects
    //     entry's id (project_id) as the slug base when there is one.
    let project_key
    if (pinnedProjectKey && String(pinnedProjectKey).trim()) {
      project_key = String(pinnedProjectKey).trim()
    } else {
      const slugSource = project_id ? String(project_id) : String(name)
      const slugBase = slugSource.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      // No year given → current Apr–Mar FY start year, in IST (server is UTC).
      const ist = new Date(Date.now() + 330 * 60 * 1000)
      const fyStart = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
      project_key = `${slugBase}-${year || fyStart}`
    }

    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO action_plans (
         org_id, project_key, name, year, start_month, locations, activities, uploaded_by, donor, region, budget, end_date,
         location_state_code, location_state_name, location_district_code, location_district_name,
         location_block_code, location_block_name, location_panchayat_code, location_panchayat_name,
         location_village_code, location_village_name
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (org_id, project_key)
         -- name/year/start_month are deliberately NOT overwritten here (unlike
         -- a first-ever INSERT, which legitimately sets them from the file).
         -- Action Plan is a feature living under a project, like a financial
         -- tracker would be — re-uploading or replacing its structure must
         -- never change the project's own identity/metadata. Whatever the
         -- uploaded file's "Plan Info" sheet says under Name/Year/Start Month
         -- is ignored for an existing project (this used to only guard Name,
         -- which let a re-upload silently reset an existing project's Year to
         -- whatever the uploaded file happened to have — e.g. a reused/blank
         -- template); the ONLY place a project's Year changes is the
         -- dedicated "Edit Project" action (PUT /action-plans/:id/portfolio
         -- below), which the user explicitly intends as an edit.
         DO UPDATE SET
                       locations = CASE WHEN array_length($6::text[], 1) > 0 THEN $6 ELSE action_plans.locations END,
                       activities = CASE WHEN jsonb_array_length($7::jsonb) > 0 THEN $7::jsonb ELSE action_plans.activities END,
                       uploaded_by=$8, updated_at=NOW(), active=true,
                       location_state_code=$13, location_state_name=$14, location_district_code=$15, location_district_name=$16,
                       location_block_code=$17, location_block_name=$18, location_panchayat_code=$19, location_panchayat_name=$20,
                       location_village_code=$21, location_village_name=$22
       RETURNING id, project_key, name`,
      [
        req.user.orgId, project_key, name,
        year || null, start_month || 4,
        locs,
        JSON.stringify(acts),
        req.user.name || 'unknown',
        donor || null, region || null, budget || null, end_date || null,
        location_state_code || null, location_state_name || null,
        location_district_code || null, location_district_name || null,
        location_block_code || null, location_block_name || null,
        location_panchayat_code || null, location_panchayat_name || null,
        location_village_code || null, location_village_name || null,
      ]
    )

    // locations_detail[] fully replaces this plan's rows, but only when sent —
    // Excel uploads never send it and mustn't wipe the form's locations.
    if (Array.isArray(locations_detail)) {
      const planId = rows[0].id
      await pool.query(`DELETE FROM action_plan_locations WHERE action_plan_id = $1`, [planId])
      if (locations_detail.length) {
        const cols = [
          'action_plan_id', 'org_id', 'state_code', 'state_name', 'district_code', 'district_name',
          'block_code', 'block_name', 'panchayat_code', 'panchayat_name', 'village_code', 'village_name', 'sort_order',
        ]
        const values = []
        const placeholders = locations_detail.map((loc, i) => {
          const base = i * cols.length
          values.push(
            planId, req.user.orgId,
            loc?.state_code ?? null, loc?.state_name ?? null,
            loc?.district_code ?? null, loc?.district_name ?? null,
            loc?.block_code ?? null, loc?.block_name ?? null,
            loc?.panchayat_code ?? null, loc?.panchayat_name ?? null,
            loc?.village_code ?? null, loc?.village_name ?? null,
            i,
          )
          return `(${cols.map((_, ci) => `$${base + ci + 1}`).join(', ')})`
        })
        await pool.query(
          `INSERT INTO action_plan_locations (${cols.join(', ')}) VALUES ${placeholders.join(', ')}`,
          values
        )
      }
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.upload','action_plans',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, rows[0].id,
       JSON.stringify({ name, project_key, activities_count: acts.length, locations_count: locs.length })]
    ).catch(() => {})

    res.json({ id: rows[0].id, project_key: rows[0].project_key, name: rows[0].name })
  } catch (e) {
    console.error('[action-plans POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/action-plans/:id — soft-delete by default (active=false; restorable
// for 7 days). ?purge=1 hard-deletes the plan and its cell data.
router.delete('/action-plans/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireEditor(req, res)) return
  const purge = req.query.purge === '1'
  try {
    const pool = getPool()
    const { rows: plan } = await pool.query(
      `SELECT project_key FROM action_plans WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )
    if (!plan[0]) return res.status(404).json({ error: 'Not found' })

    if (purge) {
      // Hard delete — cell data + plan row both gone
      await pool.query(
        `DELETE FROM project_deliverables WHERE org_id = $1 AND project = $2 AND data_type = 'action_plan'`,
        [req.user.orgId, plan[0].project_key]
      )
      await pool.query(
        `DELETE FROM action_plans WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.user.orgId]
      )
    } else {
      // Soft delete — flip active off; row + cells survive
      await pool.query(
        `UPDATE action_plans SET active = false, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.user.orgId]
      )
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,$4,'action_plans',$5,$6)`,
      [req.user.orgId, req.user.uid, req.user.name,
       purge ? 'action_plan.purge' : 'action_plan.archive',
       req.params.id, JSON.stringify({ purge, project_key: plan[0].project_key })]
    ).catch(() => {})

    res.json({ ok: true, purged: purge, archived: !purge })
  } catch (e) {
    console.error('[action-plan]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/clear-plan — resets only the Action Plan structure
// (activities + locations) for a fresh upload. Unlike DELETE, the project record
// and its project_deliverables stay; re-uploading re-attaches progress by indicator.
router.post('/action-plans/:id([0-9a-fA-F-]{36})/clear-plan', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE action_plans
       SET activities = '[]'::jsonb, locations = '{}', updated_at = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING id, name, project_key`,
      [req.params.id, req.user.orgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.clear','action_plans',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({ name: rows[0].name })]
    ).catch(() => {})
    res.json({ ok: true, name: rows[0].name })
  } catch (e) {
    console.error('[action-plan]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/restore — undo a soft-delete (admin/manager only)
router.post('/action-plans/:id([0-9a-fA-F-]{36})/restore', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE action_plans SET active = true, updated_at = NOW()
       WHERE id = $1 AND org_id = $2 AND active = false
       RETURNING id, name`,
      [req.params.id, req.user.orgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found or already active' })
    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'action_plan.restore','action_plans',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({ name: rows[0].name })]
    ).catch(() => {})
    res.json({ ok: true, name: rows[0].name })
  } catch (e) {
    console.error('[action-plan]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/archived — list soft-deleted plans for the org
router.get('/action-plans/archived', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, project_key, name, year, locations, jsonb_array_length(activities) AS activity_count,
              uploaded_by, created_at, updated_at
       FROM action_plans
       WHERE org_id = $1 AND active = false
       ORDER BY updated_at DESC`,
      [req.user.orgId]
    )
    res.json({ plans: rows })
  } catch (e) {
    console.error('[action-plan]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
