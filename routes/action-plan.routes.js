// Multi-project action plans. Every endpoint takes optional ?plan=<project_key>;
// without it, the org's most recently updated plan is used.
//
//   GET    /api/action-plans                       — list plans for this org
//   POST   /api/action-plans                       — create plan (body = parsed JSON)
//   GET    /api/action-plans/:id                   — fetch one plan
//   DELETE /api/action-plans/:id                   — archive/purge the PROJECT (Portfolio Overview card and all)
//   POST   /api/action-plans/:id/clear-plan        — reset just the uploaded Action Plan structure; project untouched
//   GET    /api/action-plans/template.xlsx         — download blank template
//
//   GET    /api/action-plan/progress?plan=key      — load saved cells for a plan
//   PUT    /api/action-plan/progress               — body must include project_key
//   GET    /api/action-plan/history?plan=key       — recent edits
//   GET    /api/action-plan/export.xlsx?plan=key   — export, same shape as the upload template
//
// Reads are open to any org member (the UI has a read-only mode that needs the real
// plan); writes require manager|admin|superadmin.

import { Router } from 'express'
import { getPool }  from '../db/pool.js'
import { check, recordVerdict } from '../lib/dataCorrectness/index.js'
import { currentFY, toSqlDate } from '../lib/dataCorrectness/periodMath.js'
import { requireEditor, requireAdmin, requireAuth } from '../lib/routeGuards.js'
import { runAI } from '../lib/ai/runAI.js'

const router = Router()

// Legacy default for orgs that haven't uploaded a new plan
const DEFAULT_PROJECT_KEY = 'kosi_action_plan_2026'

// Plan year starts in April, matching ActionPlanTab.tsx's MONTHS_ELAPSED.
const PLAN_YEAR_START_MONTH = 4 // April
function monthsElapsedInPlanYear() {
  const now = new Date()
  const y = now.getMonth() + 1 >= PLAN_YEAR_START_MONTH ? now.getFullYear() : now.getFullYear() - 1
  const start = new Date(y, PLAN_YEAR_START_MONTH - 1, 1)
  const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
  // Fractional day/30, same as the client, so a plan's health matches across
  // the Action Plan page and Portfolio / Org Dashboard.
  return Math.max(0, Math.min(12, months + now.getDate() / 30))
}

// Same 80%/95%-of-expected thresholds as ActionPlanTab.tsx's yearStats.status,
// re-expressed as the green/amber/red vocabulary Portfolio/Org Dashboard use.
function healthFromTargets(target, achieved) {
  if (!target) return 'green'
  const expected = target * (monthsElapsedInPlanYear() / 12)
  if (!expected) return 'green'
  if (achieved < expected * 0.80) return 'red'
  if (achieved < expected * 0.95) return 'amber'
  return 'green'
}

function complianceStatusForItem(dueDate) {
  if (!dueDate) return 'valid'
  const due = new Date(dueDate)
  const now = new Date()
  if (due < now) return 'overdue'
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30)
  if (due < in30) return 'upcoming'
  return 'valid'
}

// Shared target/achieved roll-up across an org's active plans (list, /impact,
// /org-dashboard). Seed targets live in action_plans.activities; project_deliverables
// only has rows for edited cells, so the total is seed ∪ override — summing
// project_deliverables alone reports ~0 for an untouched plan.
async function aggregateActionPlans(orgId) {
  const pool = getPool()
  const { rows: plans } = await pool.query(
    `SELECT id, project_key, name, year, start_month, locations, activities,
            uploaded_by, created_at, updated_at, active,
            donor, region, budget, end_date, health_override, compliance_override
     FROM action_plans
     WHERE org_id = $1 AND active = true
     ORDER BY year DESC, name`,
    [orgId]
  )
  const { rows: cells } = await pool.query(
    `SELECT project, indicator, planned, achieved, period, updated_at
     FROM project_deliverables
     WHERE org_id = $1 AND data_type = 'action_plan'`,
    [orgId]
  )

  const planMeta = new Map()   // project_key → { id, name, year, locations, snToCat, snToActivity, seedCells, activities_count }
  for (const p of plans) {
    const acts = Array.isArray(p.activities) ? p.activities : []
    const snToCat = new Map()
    const snToActivity = new Map()
    const seedCells = new Map()   // indicator → { target, achieved }
    for (const a of acts) {
      snToCat.set(a.sn, (a.category || 'capacity'))
      snToActivity.set(a.sn, a.activity)
      for (const loc of (a.locations || [])) {
        for (const [m, d] of Object.entries(loc.monthly || {})) {
          // Uploaded achieved figures are the seed fallback (override ?? seed),
          // same as the Action Plan page's activityTotal().
          const target = d?.target
          const achieved = d?.achieved
          if (target != null || achieved != null) {
            seedCells.set(`${a.sn}|${loc.location}|${m}`, {
              target:   Number(target)   || 0,
              achieved: Number(achieved) || 0,
            })
          }
        }
      }
    }
    planMeta.set(p.project_key, {
      id: p.id, name: p.name, year: p.year, locations: p.locations || [],
      snToCat, snToActivity, seedCells, activities_count: acts.length,
    })
  }

  const perProject = new Map()   // project_key → totals
  const byCategory = {}
  const byLocation = {}
  const byMonth    = {}   // 'Apr' → { target, achieved }
  const byActivity = new Map()   // "project_key|sn" → { project_key, sn, name, category, target, achieved }
  const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']
  for (const m of MONTHS) byMonth[m] = { target: 0, achieved: 0 }

  function addToProj(pkey, t, a) {
    if (!perProject.has(pkey)) {
      const meta = planMeta.get(pkey)
      perProject.set(pkey, {
        project_key: pkey,
        id:   meta?.id || null,
        name: meta?.name || pkey,
        year: meta?.year || null,
        locations: meta?.locations || [],
        activities_count: meta?.activities_count || 0,
        target: 0, achieved: 0,
        updated_at: null,
      })
    }
    const p = perProject.get(pkey)
    p.target   += t || 0
    p.achieved += a || 0
  }
  function addToCat(cat, t, a) {
    const c = cat || 'capacity'
    if (!byCategory[c]) byCategory[c] = { target: 0, achieved: 0 }
    byCategory[c].target   += t || 0
    byCategory[c].achieved += a || 0
  }
  function addToLoc(loc, t, a) {
    const l = loc || 'Unknown'
    if (!byLocation[l]) byLocation[l] = { target: 0, achieved: 0 }
    byLocation[l].target   += t || 0
    byLocation[l].achieved += a || 0
  }
  function addToActivity(pkey, sn, t, a) {
    if (!sn) return
    const k = `${pkey}|${sn}`
    if (!byActivity.has(k)) {
      const meta = planMeta.get(pkey)
      byActivity.set(k, {
        project_key: pkey,
        project_name: meta?.name || pkey,
        sn,
        name:     meta?.snToActivity.get(sn) || `Activity ${sn}`,
        category: meta?.snToCat.get(sn)      || 'capacity',
        target: 0, achieved: 0,
      })
    }
    const e = byActivity.get(k)
    e.target   += t || 0
    e.achieved += a || 0
  }

  // Unified set of indicators: seed cells (from activity JSON) ∪ project_deliverables
  const seenKeys = new Set()
  const cellByKey = new Map()
  for (const c of cells) cellByKey.set(`${c.project}::${c.indicator}`, c)

  // First pass — every (plan × seed indicator) gives us the target; achieved comes from cells
  for (const [pkey, meta] of planMeta) {
    for (const [indicator, seed] of meta.seedCells) {
      const k = `${pkey}::${indicator}`
      const override = cellByKey.get(k)
      const target   = override?.planned  != null ? Number(override.planned)  : seed.target
      const achieved = override?.achieved != null ? Number(override.achieved) : seed.achieved
      const [snStr, loc, mon] = indicator.split('|')
      const sn = parseInt(snStr)
      const cat = meta.snToCat.get(sn) || 'capacity'

      addToProj(pkey, target, achieved)
      addToCat(cat,  target, achieved)
      addToLoc(loc,  target, achieved)
      addToActivity(pkey, sn, target, achieved)
      if (byMonth[mon]) {
        byMonth[mon].target   += target
        byMonth[mon].achieved += achieved
      }
      seenKeys.add(k)

      if (override?.updated_at) {
        const p = perProject.get(pkey)
        if (!p.updated_at || override.updated_at > p.updated_at) p.updated_at = override.updated_at
      }
    }
  }

  // Second pass — cells that exist in DB but NOT in any plan's seed (user added targets in UI)
  for (const c of cells) {
    const k = `${c.project}::${c.indicator}`
    if (seenKeys.has(k)) continue
    const meta = planMeta.get(c.project)
    const [snStr, loc, mon] = c.indicator.split('|')
    const sn = parseInt(snStr)
    const cat = meta?.snToCat.get(sn) || 'capacity'
    const target   = Number(c.planned)  || 0
    const achieved = Number(c.achieved) || 0
    addToProj(c.project, target, achieved)
    addToCat(cat, target, achieved)
    addToLoc(loc, target, achieved)
    addToActivity(c.project, sn, target, achieved)
    if (byMonth[mon]) {
      byMonth[mon].target   += target
      byMonth[mon].achieved += achieved
    }
  }

  return { plans, perProject, byCategory, byLocation, byMonth, byActivity, MONTHS }
}

// Resolve which plan to use: explicit ?plan param wins; else most recent for the org
async function resolvePlanKey(req) {
  const explicit = (req.query.plan || req.body?.plan || '').trim()
  if (explicit) return explicit
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT project_key FROM action_plans
     WHERE org_id = $1 AND active = true
     ORDER BY updated_at DESC LIMIT 1`,
    [req.user.orgId]
  ).catch(() => ({ rows: [] }))
  return rows[0]?.project_key || DEFAULT_PROJECT_KEY
}

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

// GET /api/action-plans/impact — org-wide aggregation across ALL action plans.
// Returns per-project totals, category breakdown, location breakdown, monthly trend.
// Used by the Impact Dashboard to show "all projects at a glance".
router.get('/action-plans/impact', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId

    const { perProject, byCategory, byLocation, byMonth, byActivity, MONTHS } = await aggregateActionPlans(orgId)

    // Beneficiaries from daily_reports over the org's fiscal year
    // (metadata.fiscal_year_start, default April); rolling 12 months if that lookup fails.
    const { rows: orgMetaRows } = await pool.query(
      `SELECT metadata FROM organizations WHERE id = $1 LIMIT 1`,
      [orgId]
    ).catch(() => ({ rows: [] }))
    const orgMeta = orgMetaRows[0]?.metadata || {}
    const fy = currentFY(orgMeta)
    const { rows: benefRows } = await pool.query(
      `SELECT COALESCE(SUM(beneficiaries), 0)::int AS total,
              COUNT(*)::int AS reports
       FROM daily_reports
       WHERE org_id = $1
         AND report_date >= $2::date
         AND report_date <  $3::date`,
      [orgId, toSqlDate(fy.start), toSqlDate(fy.end)]
    ).catch(() => ({ rows: [{ total: 0, reports: 0 }] }))

    // ── Totals + sort ───────────────────────────────────────────────────────
    const projects = Array.from(perProject.values())
      .map(p => ({ ...p, pct: p.target > 0 ? Math.round((p.achieved / p.target) * 100) : 0 }))
      .sort((a, b) => (b.target || 0) - (a.target || 0))

    const totalTarget   = projects.reduce((s, p) => s + p.target,   0)
    const totalAchieved = projects.reduce((s, p) => s + p.achieved, 0)

    const categoryArr = Object.entries(byCategory)
      .map(([id, v]) => ({ id, ...v, pct: v.target > 0 ? Math.round((v.achieved / v.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    const locationArr = Object.entries(byLocation)
      .map(([name, v]) => ({ name, ...v, pct: v.target > 0 ? Math.round((v.achieved / v.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    const monthArr = MONTHS.map(m => ({
      month: m,
      target:   byMonth[m].target,
      achieved: byMonth[m].achieved,
    }))

    const activitiesArr = Array.from(byActivity.values())
      .map(a => ({ ...a, pct: a.target > 0 ? Math.round((a.achieved / a.target) * 100) : 0 }))
      .sort((a, b) => b.target - a.target)

    // Top 3 activity names per category, for compact display on Category cards
    const topActivitiesByCategory = {}
    for (const a of activitiesArr) {
      const c = a.category || 'capacity'
      if (!topActivitiesByCategory[c]) topActivitiesByCategory[c] = []
      if (topActivitiesByCategory[c].length < 3) topActivitiesByCategory[c].push(a.name)
    }
    const categoryArrEnriched = categoryArr.map(c => ({
      ...c,
      activities_count: activitiesArr.filter(a => (a.category || 'capacity') === c.id).length,
      top_activities:   topActivitiesByCategory[c.id] || [],
    }))

    res.json({
      totals: {
        projects_count: projects.length,
        activities_count: activitiesArr.length,
        target:   totalTarget,
        achieved: totalAchieved,
        pct:      totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0,
        beneficiaries_reached: benefRows[0]?.total ?? 0,
        reports_filed:         benefRows[0]?.reports ?? 0,
      },
      projects,
      by_category: categoryArrEnriched,
      by_location: locationArr,
      by_month:    monthArr,
      activities:  activitiesArr,
    })
  } catch (e) {
    console.error('[action-plans/impact]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/org-dashboard — the /impact aggregation reshaped for the
// Org Dashboard (KPIs, growth chart, health summary, comparison table).
router.get('/action-plans/org-dashboard', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId

    // Seed-merged target/achieved, as in GET /api/action-plans.
    const { plans, perProject, byMonth, MONTHS } = await aggregateActionPlans(orgId)
    const projectKeys = plans.map(p => p.project_key)

    // `utilised` live from budget_utilisation_reports — see GET /api/action-plans.
    const { rows: budgetRows } = await pool.query(
      `SELECT project_key, COALESCE(SUM(expenses), 0)::numeric AS utilised
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = ANY($2) GROUP BY project_key`,
      [orgId, projectKeys]
    ).catch(() => ({ rows: [] }))
    const utilisedByProject = new Map(budgetRows.map(r => [r.project_key, Number(r.utilised)]))

    const totalTarget = Array.from(perProject.values()).reduce((s, v) => s + v.target, 0)
    let cumTarget = 0, cumAchieved = 0
    const combinedChart = MONTHS.map(m => {
      cumTarget   += byMonth[m].target
      cumAchieved += byMonth[m].achieved
      return {
        month: m,
        planPct:   totalTarget > 0 ? Math.round((cumTarget   / totalTarget) * 100) : 0,
        actualPct: totalTarget > 0 ? Math.round((cumAchieved / totalTarget) * 100) : 0,
      }
    })

    const healthCounts = { green: 0, amber: 0, red: 0 }
    const projectRows = plans.map(p => {
      const t = perProject.get(p.project_key) || { target: 0, achieved: 0 }
      const budget = Number(p.budget) || 0
      const utilised = utilisedByProject.get(p.project_key) || 0
      const target = t.target > 0 ? Math.round((t.achieved / t.target) * 100) : 0
      const budgetUsed = budget > 0 ? Math.round((utilised / budget) * 100) : 0
      const health = p.health_override || healthFromTargets(t.target, t.achieved)
      healthCounts[health] = (healthCounts[health] || 0) + 1
      return {
        project_key: p.project_key,
        name: p.name,
        budgetFmt: '₹' + Math.round(budget).toLocaleString('en-IN'),
        budgetUsed, target, health,
      }
    })

    const totalAchieved = Array.from(perProject.values()).reduce((s, v) => s + v.achieved, 0)
    res.json({
      kpis: [
        { label: 'Active Projects', value: String(plans.length), note: '', fg: '#5C7378' },
        { label: 'Annual Target', value: String(Math.round(totalTarget)), note: '', fg: '#5C7378' },
        { label: 'Achieved', value: String(Math.round(totalAchieved)), note: '', fg: '#5C7378' },
        { label: 'Overall Achievement', value: `${totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0}%`, note: '', fg: '#5C7378' },
      ],
      combinedChart,
      healthSummary: [
        { key: 'green', label: 'On Track',   count: healthCounts.green },
        { key: 'amber', label: 'At Risk',    count: healthCounts.amber },
        { key: 'red',   label: 'Critical',   count: healthCounts.red },
      ],
      projectRows,
    })
  } catch (e) {
    console.error('[action-plans/org-dashboard]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── ANNUAL PROGRESS REPORT ──────────────────────────────────────────────────
// Each annual_progress_reports row is a cumulative "as of this month" total per
// activity per location; rows are never summed, so a later upload can't double-count.
const AP_MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']

async function resolveProjectKey(id, orgId) {
  const { rows } = await getPool().query(
    `SELECT project_key FROM action_plans WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  )
  return rows[0]?.project_key || null
}

// GET /api/action-plans/:id/portfolio-snapshot — headline figure from each tab
// (Beneficiaries / Finance Tracker / Annual Progress) by project_key. A figure is
// null when its source has no data yet, as opposed to a real zero.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/portfolio-snapshot', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })
    const pool = getPool()

    const { rows: [benf] } = await pool.query(
      `SELECT count(*)::int AS total, sum(income_realised)::float8 AS income_sum
       FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )

    const { rows: apPeriods } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    let apAchievementPct = null
    if (apPeriods.length) {
      const latest = apPeriods.sort((a, b) => (b.fy_start_year * 12 + AP_MONTHS.indexOf(b.month)) - (a.fy_start_year * 12 + AP_MONTHS.indexOf(a.month)))[0]
      const { rows: [apAgg] } = await pool.query(
        `SELECT coalesce(sum(target), 0)::float8 AS target_sum, coalesce(sum(achievement_total), 0)::float8 AS achievement_sum
         FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
        [req.user.orgId, projectKey, latest.fy_start_year, latest.month]
      )
      apAchievementPct = apAgg.target_sum > 0 ? Math.round((apAgg.achievement_sum / apAgg.target_sum) * 100) : null
    }

    // Utilisation is cumulative SUM(expenses) over all uploaded months
    // (033_budget_utilisation_v2.sql) against the headline action_plans.budget.
    const { rows: [buLatest] } = await pool.query(
      `SELECT MAX(period_month)::text AS period_month FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    let buUtilisedPct = null
    if (buLatest?.period_month) {
      const { rows: [buAgg] } = await pool.query(
        `SELECT COALESCE((SELECT budget FROM action_plans WHERE id = $3 AND org_id = $1), 0)::float8 AS budget_sum,
                COALESCE(SUM(expenses), 0)::float8 AS expenses_sum
         FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2`,
        [req.user.orgId, projectKey, req.params.id]
      )
      buUtilisedPct = buAgg.budget_sum > 0 ? Math.round((buAgg.expenses_sum / buAgg.budget_sum) * 100) : null
    }

    res.json({
      beneficiaryCount: benf.total > 0 ? benf.total : null,
      incomeRealisedSum: benf.total > 0 ? (benf.income_sum || 0) : null,
      apAchievementPct,
      buUtilisedPct,
    })
  } catch (e) {
    console.error('[action-plans/:id/portfolio-snapshot GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/annual-progress-template.xlsx — blank template in the layout
// UploadAnnualProgressModal.tsx parses (header text must be exactly "Achievement";
// per-location column names go in the row below the header).
router.get('/action-plans/annual-progress-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    const LOCS = ['Khagaria', 'Alauli', 'Bhaptiyahi']
    const h1 = ['S.N.', 'Activity/Deliverables', 'Target', 'Achievement', '', '', '', 'Related Link', 'Remark']
    const h2 = ['', '', '', 'Total', ...LOCS, '', '']

    const rows = [h1, h2]
    rows.push([1, 'Survey software/Tools subscription', 300, 180, 60, 60, 60, 'https://example.org/evidence-1', 'On track'])
    rows.push([2, '2-day training for farmers', 120, 90, 30, 30, 30, 'https://example.org/evidence-2', ''])
    rows.push([3, 'Pond/chaur/maun listing', 50, 20, 10, 5, 5, '', 'Behind schedule'])

    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 6 }, { wch: 32 }, { wch: 10 }, { wch: 10 }, ...LOCS.map(() => ({ wch: 12 })), { wch: 28 }, { wch: 20 }]
    ws['!merges'] = [
      { s: { r: 0, c: 3 }, e: { r: 0, c: 3 + LOCS.length } }, // "Achievement" spans Total + per-location cols
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Annual Progress')

    const readme = [
      ['Annual Progress Report — Upload Template'],
      [''],
      ['Row 1 is the main header, Row 2 is a sub-header (only needed under "Achievement").'],
      [''],
      ['  S.N.                — sequential activity number'],
      ['  Activity/Deliverables — activity name (this, not S.N., is the row identity — reordering rows is safe)'],
      ['  Target              — planned target for the year'],
      ['  Achievement          — cumulative achievement so far; sub-header "Total"'],
      ['  (columns after Achievement, before Related Link) — one per location; name each in the row below the header'],
      ['  Related Link        — link to evidence (photo, doc, etc.), optional'],
      ['  Remark               — free-text note, optional'],
      [''],
      ['Add/remove location columns as needed between "Achievement" and "Related Link".'],
      ['The Financial Year and Month this snapshot is "as of" are picked in the upload dialog, not read from the file.'],
    ]
    const wsReadme = XLSX.utils.aoa_to_sheet(readme)
    wsReadme['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, wsReadme, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="annual-progress-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[annual-progress template]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/annual-progress — upload/update one FY+month snapshot.
// Body: { fy_start_year: 2026, month: 'Jun', rows: [{ sn, activity, target, achievement_total, locations: {loc: val}, related_link, remark }] }
router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { fy_start_year, month, rows } = req.body || {}
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // activity_name is the identity (the sheet's S.N. is usually blank);
      // activity_sn is just upload position, for display.
      let position = 0
      for (const r of rows) {
        position += 1
        const activityName = String(r.activity || '').trim()
        if (!activityName) continue
        const sn = Number.isInteger(r.sn) ? r.sn : position
        await client.query(
          `INSERT INTO annual_progress_reports
             (org_id, project_key, fy_start_year, month, activity_sn, activity_name, target, achievement_total, locations, related_link, remark, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (org_id, project_key, fy_start_year, month, activity_name)
             DO UPDATE SET activity_sn = $5, target = $7, achievement_total = $8,
                           locations = $9, related_link = $10, remark = $11,
                           uploaded_by = $12, updated_at = NOW()`,
          [
            req.user.orgId, projectKey, fy_start_year, month, sn,
            activityName, r.target ?? null, r.achievement_total ?? null,
            JSON.stringify(r.locations || {}), r.related_link || null, r.remark || null,
            req.user.name || 'unknown',
          ]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.upload','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, fy_start_year, month, activity_count: rows.length })]
    ).catch(() => {})

    res.json({ ok: true, fy_start_year, month, count: rows.length })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress?fy_start_year=2026&month=Jun
// Without month, returns the latest month with data in Apr-first fiscal order.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    let month = req.query.month
    if (!month) {
      const { rows: monthRows } = await pool.query(
        `SELECT DISTINCT month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3`,
        [req.user.orgId, projectKey, fy_start_year]
      )
      const available = monthRows.map(r => r.month).sort((a, b) => AP_MONTHS.indexOf(b) - AP_MONTHS.indexOf(a))
      month = available[0]
      if (!month) return res.json({ month: null, rows: [] })
    }

    const { rows } = await pool.query(
      `SELECT activity_sn AS sn, activity_name AS activity, category,
              target::float8 AS target, achievement_total::float8 AS achievement_total,
              locations, related_link, remark, updated_at
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_sn`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    res.json({ month, rows })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/action-plans/:id/annual-progress?fy_start_year=2026&month=Jun
// Admin-only: drops every row of one FY+month snapshot (e.g. a bad upload) with no undo.
router.delete('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    const month = req.query.month
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!rowCount) return res.status(404).json({ error: 'No snapshot found for that Financial Year + Month' })

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.delete','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, fy_start_year, month, activity_count: rowCount })]
    ).catch(() => {})

    res.json({ ok: true, deleted: rowCount })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress DELETE]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/annual-progress/categorize — AI-assign a category to
// each activity (the template has no category column). One batched Gemini call;
// the category is applied to every row with that activity_name across all months,
// since it depends on the wording, not the numbers.
const AP_CATEGORIES = [
  'Training', 'Exposure Visit', 'Community Mobilization', 'Enterprise & Livelihood',
  'Infrastructure', 'Financial Literacy', 'Livestock & Animal Husbandry',
  'Knowledge & Content', 'Other',
]
router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/categorize', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.body?.fy_start_year)
    const month = req.body?.month
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: activities } = await pool.query(
      `SELECT DISTINCT activity_name FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_name`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!activities.length) return res.status(404).json({ error: 'No activities found for this snapshot' })

    const systemPrompt =
      `You categorize NGO field-project activity descriptions into exactly one of these categories: ` +
      `${AP_CATEGORIES.join(', ')}. Respond with strict JSON only: ` +
      `{"categories": [{"activity": "<exact activity text>", "category": "<one of the categories>"}]}. ` +
      `Include every activity given, in the same order. If none fit well, use "Other".`
    const userPrompt = JSON.stringify({ activities: activities.map(a => a.activity_name) })

    const out = await runAI({
      feature: 'annual_progress',
      operation: 'categorize_activities',
      prompt: userPrompt,
      systemPrompt,
      orgId: req.user.orgId,
      userId: req.user.uid,
    }, { jsonMode: true, maxTokens: 2048, temperature: 0.2 })

    const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
    const items = Array.isArray(parsed?.categories) ? parsed.categories : null
    if (!items) return res.status(502).json({ error: 'AI categorization unavailable — try again shortly', fallbackReason: out?.fallbackReason })

    const categoryFor = new Map()
    for (const item of items) {
      const name = String(item?.activity || '').trim()
      const cat = AP_CATEGORIES.includes(item?.category) ? item.category : 'Other'
      if (name) categoryFor.set(name, cat)
    }

    const client = await pool.connect()
    let updated = 0
    try {
      await client.query('BEGIN')
      for (const [name, cat] of categoryFor) {
        const r = await client.query(
          `UPDATE annual_progress_reports SET category = $1
           WHERE org_id = $2 AND project_key = $3 AND activity_name = $4`,
          [cat, req.user.orgId, projectKey, name]
        )
        updated += r.rowCount
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({ categories: Object.fromEntries(categoryFor), rowsUpdated: updated })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/categorize POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/latest — most recent snapshot across any
// FY, for the Project Report's "Verified Totals" fallback when its own FY has no upload.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/latest', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: periods } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    if (!periods.length) return res.json({ fy_start_year: null, month: null, rows: [] })

    const latest = periods.sort((a, b) => (b.fy_start_year * 12 + AP_MONTHS.indexOf(b.month)) - (a.fy_start_year * 12 + AP_MONTHS.indexOf(a.month)))[0]
    const { rows } = await pool.query(
      `SELECT activity_sn AS sn, activity_name AS activity, category,
              target::float8 AS target, achievement_total::float8 AS achievement_total,
              locations, related_link, remark, updated_at
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_sn`,
      [req.user.orgId, projectKey, latest.fy_start_year, latest.month]
    )
    res.json({ fy_start_year: latest.fy_start_year, month: latest.month, rows })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/latest GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/months?fy_start_year=2026 — which
// months have a snapshot, so the dashboard's month picker only shows real options.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/months', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const { rows } = await getPool().query(
      `SELECT DISTINCT month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3`,
      [req.user.orgId, projectKey, fy_start_year]
    )
    const months = rows.map(r => r.month).sort((a, b) => AP_MONTHS.indexOf(a) - AP_MONTHS.indexOf(b))
    res.json({ months })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/months GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/trend?fy_start_year=2026
// Rows are already cumulative, so this is a per-month SUM (not a running total),
// plus a deterministic year-end projection like budget-utilisation's /trend.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/trend', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const { rows } = await getPool().query(
      `SELECT month, coalesce(sum(target), 0)::float8 AS target_sum, coalesce(sum(achievement_total), 0)::float8 AS achievement_sum
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3
       GROUP BY month`,
      [req.user.orgId, projectKey, fy_start_year]
    )
    const trend = rows
      .map(r => ({ month: r.month, target_sum: r.target_sum, achievement_sum: r.achievement_sum }))
      .sort((a, b) => AP_MONTHS.indexOf(a.month) - AP_MONTHS.indexOf(b.month))

    if (!trend.length) return res.json({ trend: [], projectedYearEnd: null, pace: 'unknown', elapsedPct: 0 })

    const latest = trend[trend.length - 1]
    const elapsedMonths = AP_MONTHS.indexOf(latest.month) + 1
    const elapsedPct = Math.round((elapsedMonths / 12) * 100)
    const projectedYearEnd = (latest.achievement_sum / elapsedMonths) * 12
    const achievedPct = latest.target_sum > 0 ? Math.round((latest.achievement_sum / latest.target_sum) * 100) : null
    const gap = achievedPct != null ? achievedPct - elapsedPct : null
    const pace = gap == null ? 'unknown' : gap > 20 ? 'ahead' : gap < -20 ? 'behind' : 'on_track'

    res.json({ trend, projectedYearEnd, pace, elapsedPct, achievedPct })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/trend GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/action-plans/:id/annual-progress/cell — admin-only correction of one
// activity's Target/Achievement without re-uploading (it bypasses the sheet as source of truth).
// Body: { fy_start_year, month, activity_name, target?, achievement_total? }; omitted fields are kept.
router.put('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/cell', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { fy_start_year, month, activity_name, target, achievement_total } = req.body || {}
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })
    if (!activity_name) return res.status(400).json({ error: 'activity_name required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: prev } = await pool.query(
      `SELECT target::float8 AS target, achievement_total::float8 AS achievement_total
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4 AND activity_name = $5`,
      [req.user.orgId, projectKey, fy_start_year, month, activity_name]
    )
    if (!prev[0]) return res.status(404).json({ error: 'Activity not found in this snapshot' })

    const { rows } = await pool.query(
      `UPDATE annual_progress_reports
       SET target = COALESCE($1, target), achievement_total = COALESCE($2, achievement_total), updated_at = NOW()
       WHERE org_id = $3 AND project_key = $4 AND fy_start_year = $5 AND month = $6 AND activity_name = $7
       RETURNING target::float8 AS target, achievement_total::float8 AS achievement_total`,
      [target ?? null, achievement_total ?? null, req.user.orgId, projectKey, fy_start_year, month, activity_name]
    )

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.cell_edit','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({
        activity_name, fy_start_year, month,
        target: target !== undefined ? { before: prev[0].target, after: rows[0].target } : undefined,
        achievement_total: achievement_total !== undefined ? { before: prev[0].achievement_total, after: rows[0].achievement_total } : undefined,
      })]
    ).catch(() => {})

    res.json({ ok: true, target: rows[0].target, achievement_total: rows[0].achievement_total })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/cell PUT]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/annual-progress/insights — AI narrative + anomaly flags
// for one FY+month snapshot (same layering as budget-utilisation insights).
// Field reports live in a Google Sheet fetched client-side only, so the frontend
// sends dailyReportCount in the body.
const ACH_DECREASE_TOLERANCE = 0 // achievement is cumulative, so any decrease is suspicious
const LOW_EVIDENCE_REPORT_FLOOR = 2 // min field reports expected when achievement grows

router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/insights', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { fy_start_year, month } = req.body || {}
    const dailyReportCount = Number.isInteger(req.body?.daily_report_count) ? req.body.daily_report_count : null
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: current } = await pool.query(
      `SELECT activity_name, category, target::float8 AS target, achievement_total::float8 AS achievement_total
       FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!current.length) return res.status(404).json({ error: 'No activities found for this snapshot' })

    // Previous snapshot with data may be in the prior FY (Apr → last FY's Mar).
    const fiscalSeq = (fy, m) => fy * 12 + AP_MONTHS.indexOf(m)
    const { rows: allMonths } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    const curSeq = fiscalSeq(fy_start_year, month)
    const prior = allMonths
      .filter(m => fiscalSeq(m.fy_start_year, m.month) < curSeq)
      .sort((a, b) => fiscalSeq(b.fy_start_year, b.month) - fiscalSeq(a.fy_start_year, a.month))[0]

    let priorByName = new Map()
    if (prior) {
      const { rows: priorRows } = await pool.query(
        `SELECT activity_name, achievement_total::float8 AS achievement_total
         FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
        [req.user.orgId, projectKey, prior.fy_start_year, prior.month]
      )
      priorByName = new Map(priorRows.map(r => [r.activity_name, r.achievement_total]))
    }

    // ── Deterministic checks ────────────────────────────────────────────────
    const flags = []
    let growthThisPeriod = 0
    for (const r of current) {
      const target = Number(r.target) || 0
      const achievement = Number(r.achievement_total) || 0
      if (target <= 0 && achievement > 0) {
        flags.push({ activity: r.activity_name, category: r.category, type: 'no_target',
          reason: `${achievement.toLocaleString('en-IN')} achieved with no target set for this activity` })
      }
      const priorAchievement = priorByName.get(r.activity_name)
      if (priorAchievement != null) {
        growthThisPeriod += Math.max(0, achievement - priorAchievement)
        if (achievement < priorAchievement - ACH_DECREASE_TOLERANCE) {
          flags.push({ activity: r.activity_name, category: r.category, type: 'achievement_decreased',
            reason: `Cumulative achievement dropped from ${priorAchievement.toLocaleString('en-IN')} (${prior.month}) to ${achievement.toLocaleString('en-IN')} — this figure should never decrease` })
        }
      }
    }

    // ── Cross-reference with daily field report volume ──────────────────────
    // Only flag real progress with thin evidence; no positive non-findings.
    if (dailyReportCount != null && growthThisPeriod > 0 && dailyReportCount < LOW_EVIDENCE_REPORT_FLOOR) {
      flags.push({ activity: null, category: null, type: 'low_field_evidence',
        reason: `Achievement grew by ${Math.round(growthThisPeriod).toLocaleString('en-IN')} this period but only ${dailyReportCount} daily field report(s) were filed for it — consider verifying the reported figures` })
    }

    // ── Category-level pace vs elapsed fiscal year ──────────────────────────
    const elapsedPct = Math.round(((AP_MONTHS.indexOf(month) + 1) / 12) * 100)
    const categoryMap = new Map()
    for (const r of current) {
      const cat = r.category || 'Uncategorized'
      const cur = categoryMap.get(cat) || { target: 0, achievement: 0 }
      cur.target += Number(r.target) || 0
      cur.achievement += Number(r.achievement_total) || 0
      categoryMap.set(cat, cur)
    }
    const categories = Array.from(categoryMap.entries()).map(([category, v]) => {
      const achievedPct = v.target > 0 ? Math.round((v.achievement / v.target) * 100) : null
      const gap = achievedPct != null ? achievedPct - elapsedPct : null
      const pace = gap == null ? 'unknown' : gap > 20 ? 'ahead' : gap < -20 ? 'behind' : 'on_track'
      return { category, target: v.target, achievement: v.achievement, achievedPct, pace }
    })
    const aheadCategories = categories.filter(c => c.pace === 'ahead')
    const behindCategories = categories.filter(c => c.pace === 'behind')

    // ── Templated fallback (used verbatim if AI is unavailable) ─────────────
    const fallbackNarrative = [
      `${elapsedPct}% of the fiscal year has elapsed.`,
      aheadCategories.length ? `${aheadCategories.length} of ${categories.length} categor${aheadCategories.length === 1 ? 'y is' : 'ies are'} ahead of pace (${aheadCategories.map(c => c.category).join(', ')}).` : null,
      behindCategories.length ? `${behindCategories.length} categor${behindCategories.length === 1 ? 'y is' : 'ies are'} behind pace (${behindCategories.map(c => c.category).join(', ')}).` : null,
      dailyReportCount != null ? `${dailyReportCount} daily field report(s) on record for this period.` : null,
      flags.length ? `${flags.length} item(s) flagged for review.` : 'No anomalies detected.',
    ].filter(Boolean).join(' ')

    let narrative = fallbackNarrative
    let rankedFlags = flags

    if (flags.length || aheadCategories.length || behindCategories.length) {
      try {
        const systemPrompt =
          `You are a program analyst assistant for an NGO. Given computed activity-progress statistics ` +
          `for one project's fiscal-year-to-date, including daily field report volume as supporting evidence, ` +
          `write a SHORT (2-4 sentence) plain-English narrative summarizing overall pace and highlighting the ` +
          `most important flagged items. Then re-rank the given flags by importance (most concerning first) ` +
          `and give each a one-line reason in plain English, non-technical. Respond with strict JSON only: ` +
          `{"narrative": "...", "flags": [{"activity": "..."|null, "category": "..."|null, "type": "...", "reason": "..."}]}. ` +
          `Include every flag given, do not invent new ones.`
        const userPrompt = JSON.stringify({ elapsedPct, categories, flags, dailyReportCount })
        const out = await runAI({
          feature: 'annual_progress',
          operation: 'insights',
          prompt: userPrompt,
          systemPrompt,
          orgId: req.user.orgId,
          userId: req.user.uid,
        }, { jsonMode: true, maxTokens: 1024, temperature: 0.3 })

        const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
        if (parsed?.narrative && Array.isArray(parsed?.flags)) {
          narrative = parsed.narrative
          rankedFlags = parsed.flags
        }
      } catch (e) {
        console.warn('[annual-progress/insights] AI narrative unavailable, using fallback:', e.message)
      }
    }

    res.json({ narrative, flags: rankedFlags, elapsedPct, categories })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/insights POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/dashboard-insights — cross-report AI narrative for
// ProjectDashboardPage.tsx, looking for mismatches between budget, annual progress,
// daily reports and compliance (e.g. spend outpacing delivery). Figures come in
// the body because the client already computed them (daily reports are sheet-backed)
// and the narrative must agree with what's on screen.
const DASHBOARD_PACE_GAP_THRESHOLD = 20 // percentage points between budget% and progress%
const DASHBOARD_LOW_EVIDENCE_FLOOR = 2  // field reports this month, despite real progress, worth flagging

router.post('/action-plans/:id([0-9a-fA-F-]{36})/dashboard-insights', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const b = req.body || {}
    const hasProgress = !!b.has_annual_progress
    const hasBudget = !!b.has_budget_data
    const overallTarget = Number(b.overall_target) || 0
    const overallAchievement = Number(b.overall_achievement) || 0
    const budgetTotal = Number(b.budget_total) || 0
    const budgetUsed = Number(b.budget_used) || 0
    const overdueComplianceCount = Number(b.overdue_compliance_count) || 0
    const dailyReportCount = Number.isInteger(b.daily_report_count) ? b.daily_report_count : null
    const dailyReportCountThisMonth = Number.isInteger(b.daily_report_count_this_month) ? b.daily_report_count_this_month : null
    const documentCount = Number.isInteger(b.document_count) ? b.document_count : null
    const beneficiaryTotal = Number.isInteger(b.beneficiary_total) ? b.beneficiary_total : null
    const indicatorsBehindCount = Number(b.indicators_behind_count) || 0
    const actionPlanOverdueCount = Number(b.action_plan_overdue_count) || 0
    const actionPlanOverdueHighPriorityCount = Number(b.action_plan_overdue_high_priority_count) || 0

    const progressPct = hasProgress && overallTarget > 0 ? Math.round((overallAchievement / overallTarget) * 100) : null
    const budgetPct = hasBudget && budgetTotal > 0 ? Math.round((budgetUsed / budgetTotal) * 100) : null

    // ── Deterministic checks ────────────────────────────────────────────────
    const flags = []
    if (progressPct != null && budgetPct != null) {
      const gap = budgetPct - progressPct
      if (gap >= DASHBOARD_PACE_GAP_THRESHOLD) {
        flags.push({ type: 'spend_ahead_of_delivery',
          reason: `${budgetPct}% of budget used but only ${progressPct}% of program targets achieved — spend is outpacing delivery` })
      } else if (gap <= -DASHBOARD_PACE_GAP_THRESHOLD) {
        flags.push({ type: 'delivery_ahead_of_spend',
          reason: `${progressPct}% of targets achieved with only ${budgetPct}% of budget used — delivery is ahead of disbursement` })
      }
    }
    if (overdueComplianceCount > 0) {
      flags.push({ type: 'compliance_overdue',
        reason: `${overdueComplianceCount} compliance item${overdueComplianceCount === 1 ? '' : 's'} overdue` })
    }
    if (progressPct != null && progressPct > 0 && dailyReportCountThisMonth != null && dailyReportCountThisMonth < DASHBOARD_LOW_EVIDENCE_FLOOR) {
      flags.push({ type: 'low_field_evidence',
        reason: `Only ${dailyReportCountThisMonth} field report(s) filed this month despite ongoing program progress` })
    }
    if (documentCount === 0) {
      flags.push({ type: 'no_documents', reason: 'No documents uploaded to the vault yet.' })
    }
    if (indicatorsBehindCount > 0) {
      flags.push({ type: 'indicators_behind',
        reason: `${indicatorsBehindCount} indicator(s) behind target this month` })
    }
    if (actionPlanOverdueHighPriorityCount > 0) {
      flags.push({ type: 'action_plan_overdue_high_priority',
        reason: `${actionPlanOverdueHighPriorityCount} high-priority Action Plan activit${actionPlanOverdueHighPriorityCount === 1 ? 'y is' : 'ies are'} overdue` })
    } else if (actionPlanOverdueCount > 0) {
      flags.push({ type: 'action_plan_overdue',
        reason: `${actionPlanOverdueCount} Action Plan activit${actionPlanOverdueCount === 1 ? 'y is' : 'ies are'} overdue` })
    }

    // ── Templated fallback (used verbatim if AI is unavailable) ─────────────
    const fallbackNarrative = [
      progressPct != null ? `Program progress is at ${progressPct}%.` : 'No Annual Progress Report uploaded yet.',
      budgetPct != null ? `Budget utilisation is at ${budgetPct}%.` : 'No Budget Utilisation report uploaded yet.',
      flags.length ? `${flags.length} item(s) flagged for review.` : 'No cross-cutting anomalies detected.',
    ].join(' ')

    let narrative = fallbackNarrative
    let rankedFlags = flags

    if (flags.length) {
      try {
        const systemPrompt =
          `You are a program + finance analyst assistant for an NGO, looking across a single project's ` +
          `Financial Tracker, Action Plan, Annual Progress Report, and Daily field reports together. Given the computed ` +
          `cross-cutting statistics and flags below, write a SHORT (2-4 sentence) plain-English executive ` +
          `summary for a program manager, and re-rank the flags by importance (most concerning first) with a ` +
          `one-line plain-English reason each. Respond with strict JSON only: ` +
          `{"narrative": "...", "flags": [{"type": "...", "reason": "..."}]}. ` +
          `Include every flag given, do not invent new ones.`
        const userPrompt = JSON.stringify({
          progressPct, budgetPct, overdueComplianceCount, dailyReportCount, dailyReportCountThisMonth,
          documentCount, beneficiaryTotal, indicatorsBehindCount,
          actionPlanOverdueCount, actionPlanOverdueHighPriorityCount, flags,
        })
        const out = await runAI({
          feature: 'project_dashboard',
          operation: 'insights',
          prompt: userPrompt,
          systemPrompt,
          orgId: req.user.orgId,
          userId: req.user.uid,
        }, { jsonMode: true, maxTokens: 1024, temperature: 0.3 })

        const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
        if (parsed?.narrative && Array.isArray(parsed?.flags)) {
          narrative = parsed.narrative
          rankedFlags = parsed.flags
        }
      } catch (e) {
        console.warn('[dashboard-insights] AI narrative unavailable, using fallback:', e.message)
      }
    }

    res.json({ narrative, flags: rankedFlags, progressPct, budgetPct })
  } catch (e) {
    console.error('[action-plans/:id/dashboard-insights POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Shared by template.xlsx and export.xlsx so Export → edit → re-Upload round-trips.
const ACTION_PLAN_MONTHS_AFTER_APR = ['May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']

function actionPlanMonthlyHeaderRows() {
  const h1 = ['S.N.', 'Budget Head/Activity', 'Unit', 'Times/Year',
    'Activity Description', 'Responsibility', 'Process', 'Category', 'Apr', '']
  for (const m of ACTION_PLAN_MONTHS_AFTER_APR) { h1.push(m, '') }
  const h2 = ['', '', '', '', '', '', '', '', 'Target', 'Location']
  for (let i = 0; i < ACTION_PLAN_MONTHS_AFTER_APR.length; i++) { h2.push('Target', 'Achieved') }
  return [h1, h2]
}

const ACTION_PLAN_MONTHLY_COLS = [
  { wch: 5 },  { wch: 28 }, { wch: 14 }, { wch: 8 },
  { wch: 30 }, { wch: 14 }, { wch: 35 }, { wch: 12 },
  { wch: 8 },  { wch: 16 },                                    // Apr-T, Location
  ...Array(22).fill({ wch: 8 }),                               // May-Mar pairs
]

const ACTION_PLAN_README_ROWS = [
  ['Action Plan Template — Based on Kosi Sahjivan 2026 Format'],
  [''],
  ['How to fill:'],
  [''],
  ['1. PLAN INFO sheet'],
  ['   • Name        — project name (e.g. "JJM Bihar 2026")'],
  ['   • Year        — plan year as integer'],
  ['   • Start Month — month number where the plan year begins (4 = April)'],
  ['   • Locations   — comma-separated list of locations'],
  [''],
  ['2. MONTHLY PLAN sheet (the main data)'],
  [''],
  ['   Columns A–H (one row per activity):'],
  ['     A — S.N. (sequential number: 1, 2, 3 ...)'],
  ['     B — Budget Head / Activity name'],
  ['     C — Unit: what you are counting, as a plain label — e.g. "people",'],
  ['         "trainings", "kits", "Online subscription". Do NOT put a number'],
  ['         in this cell — the actual counts belong in the monthly Target'],
  ['         columns (I onwards), not here.'],
  ['     D — Times/Year: how many times a year you will record progress for'],
  ['         this activity — e.g. 12 if you update it every month, 4 if'],
  ['         quarterly, 1 if it only happens once. Leave blank if unsure.'],
  ['     E — Activity Description'],
  ['     F — Responsibility (person or team)'],
  ['     G — Process / steps'],
  ['     H — Category (one of: capacity, livelihood, enterprise, community, technology)'],
  [''],
  ['   Column I — Apr Target (the first month is special; only Target, no Achieved)'],
  ['   Column J — Location name for THIS row'],
  ['   Columns K onwards — May Target | May Achieved | Jun Target | Jun Achieved | … | Mar Target | Mar Achieved'],
  [''],
  ['   STRUCTURE per activity:'],
  ['     • The FIRST row of each activity has full A–H metadata + col I (Apr Target) + col J (first Location) + monthly targets'],
  ['     • SUB-rows for the SAME activity leave A–H BLANK and just fill col J (next Location) + monthly targets for that location'],
  ['     • New S.N. number in col A = start of a new activity'],
  [''],
  ['   Empty cell = no target for that month/location. Achieved is filled in later via the UI.'],
  [''],
  ['3. CATEGORIES'],
  ['     • capacity     = training & awareness (e.g. trainings, content, exposure visits)'],
  ['     • livelihood   = direct inputs (e.g. fish seed, makhana, livestock)'],
  ['     • enterprise   = infra & business (e.g. cold storage, hatchery, vendor collective)'],
  ['     • community    = engagement (e.g. PG meetings, convergence camps)'],
  ['     • technology   = IT & innovation (e.g. chatbot, IT advisory)'],
]

// GET /api/action-plans/template.xlsx — blank template in the Kosi Sahjivan 2026 layout:
// wide "Monthly Plan" sheet (one row per activity × location) plus "Plan Info" and "README".
router.get('/action-plans/template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    // ─── Sheet 1 — Plan Info ─────────────────────────────────────────────────
    const planInfo = [
      ['Field', 'Value', 'Notes'],
      ['Name', 'My Project 2026', 'Project name shown in dropdowns'],
      ['Year', 2026, 'Plan year as integer'],
      ['Start Month', 4, 'Month number where the plan year begins (1=Jan, 4=Apr, 7=Jul)'],
      ['Locations', 'Khagaria, Alauli, Bhaptiyahi, Pipra, Kishanpur, Kusheshwar Sthan',
        'Comma-separated list — these become the Location sub-rows in Monthly Plan'],
    ]
    const ws1 = XLSX.utils.aoa_to_sheet(planInfo)
    ws1['!cols'] = [{ wch: 16 }, { wch: 60 }, { wch: 60 }]
    XLSX.utils.book_append_sheet(wb, ws1, 'Plan Info')

    // ─── Sheet 2 — Monthly Plan (Kosi-style wide format) ────────────────────
    // 32 cols: metadata(0-6) + optional Category(7) + Apr-T(8) + Location(9) + 11 × T/A pairs (10-31)
    const [h1, h2] = actionPlanMonthlyHeaderRows()

    // Sample activity 1 — Survey software (across 6 locations)
    const LOCS = ['Khagaria','Alauli','Bhaptiyahi','Pipra','Kishanpur','Kusheshwar Sthan']

    const rows = [h1, h2, []]   // 3rd row empty (matches Kosi)

    // Sample activity 1 — first row has full metadata + first location
    rows.push([
      1, 'Survey software/Tools subscription', 'Online subscription', 1,
      'Pond/chaur/maun listing in program areas', 'BM',
      'Hire local youth; give target to mobilisers',
      'technology',
      50,                                                // Apr Target
      LOCS[0],                                           // Location
      50, '', '', '', '', '', '', '', '', '', '', '',   // May-Mar T/A pairs (empty Achieved)
      '', '', '', '', '', '', '', '', '', '', '', '',
    ].slice(0, 32))
    // Sample sub-rows for activity 1 — locations 2..6
    for (let i = 1; i < LOCS.length; i++) {
      rows.push([
        '', '', '', '', '', '', '', '',
        50, LOCS[i],
        ...Array(22).fill(''),
      ].slice(0, 32))
    }

    // Sample activity 2 — Training, 4 quarterly trainings
    rows.push([
      2, '2-day training for farmers', 'people', 4,
      'Technology transfer training', 'Niraj',
      'Curriculum + farmer cards + monthly schedule',
      'capacity',
      '',                          // Apr Target empty
      LOCS[0],                     // Location
      30, '', 30, '', 30, '', 30, '', '', '', '', '',   // May-Aug have targets
      '', '', '', '', '', '', '', '', '', '', '', '',
    ].slice(0, 32))
    for (let i = 1; i < 4; i++) {
      rows.push([
        '', '', '', '', '', '', '', '',
        '', LOCS[i],
        30, '', 30, '', 30, '', 30, '', ...Array(14).fill(''),
      ].slice(0, 32))
    }

    const ws2 = XLSX.utils.aoa_to_sheet(rows)
    ws2['!cols'] = ACTION_PLAN_MONTHLY_COLS
    ws2['!freeze'] = { xSplit: 2, ySplit: 2 }
    XLSX.utils.book_append_sheet(wb, ws2, 'Monthly Plan')

    // ─── Sheet 3 — README ────────────────────────────────────────────────────
    const ws3 = XLSX.utils.aoa_to_sheet(ACTION_PLAN_README_ROWS)
    ws3['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, ws3, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="action-plan-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[action-plans template]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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

// GET /api/action-plan/export.xlsx?plan=key
// Same shape as template.xlsx (Plan Info + Monthly Plan + README) so it round-trips,
// with seed ∪ override values (untouched cells still show their seed target).
router.get('/action-plan/export.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const planKey = await resolvePlanKey(req)
    const pool = getPool()

    const { rows: planRows } = await pool.query(
      `SELECT name, year, start_month, locations, activities
       FROM action_plans WHERE org_id = $1 AND project_key = $2 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [req.user.orgId, planKey]
    )
    const plan = planRows[0] || { name: planKey, year: null, start_month: 4, locations: [], activities: [] }
    const activities = (Array.isArray(plan.activities) ? plan.activities : [])
      .slice().sort((a, b) => (a.sn ?? 0) - (b.sn ?? 0))

    // project_deliverables only holds touched cells; the rest come from the seed.
    const { rows: overrideRows } = await pool.query(
      `SELECT indicator, planned, achieved
       FROM project_deliverables
       WHERE org_id = $1 AND project = $2 AND data_type = 'action_plan'`,
      [req.user.orgId, planKey]
    )
    const overrides = new Map(overrideRows.map(r => [r.indicator, r]))
    const mergedCell = (sn, loc, month, base) => {
      const o = overrides.get(`${sn}|${loc}|${month}`)
      const target   = o?.planned  != null ? Number(o.planned)  : (base?.target  ?? null)
      const achieved = o?.achieved != null ? Number(o.achieved) : (base?.achieved ?? null)
      return { target, achieved }
    }

    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    // ─── Sheet 1 — Plan Info (same shape as template.xlsx) ──────────────────
    const planInfo = [
      ['Field', 'Value', 'Notes'],
      ['Name', plan.name, 'Project name shown in dropdowns'],
      ['Year', plan.year, 'Plan year as integer'],
      ['Start Month', plan.start_month, 'Month number where the plan year begins (1=Jan, 4=Apr, 7=Jul)'],
      ['Locations', (plan.locations || []).join(', '),
        'Comma-separated list — these become the Location sub-rows in Monthly Plan'],
    ]
    const ws1 = XLSX.utils.aoa_to_sheet(planInfo)
    ws1['!cols'] = [{ wch: 16 }, { wch: 60 }, { wch: 60 }]
    XLSX.utils.book_append_sheet(wb, ws1, 'Plan Info')

    // ─── Sheet 2 — Monthly Plan, same wide layout as template.xlsx, filled
    //     with this plan's real (seed ∪ override) target/achieved values ───
    const [h1, h2] = actionPlanMonthlyHeaderRows()
    const rows = [h1, h2, []]

    for (const a of activities) {
      const locs = Array.isArray(a.locations) ? a.locations : []
      const metaRow = [a.sn, a.activity, a.unit, a.times, a.description, a.responsibility, a.process, a.category || 'capacity']
      const blankMeta = ['', '', '', '', '', '', '', '']

      if (locs.length === 0) {
        // No locations at all — still emit one metadata-only row rather than dropping the activity
        rows.push([...metaRow, '', '', ...Array(22).fill('')])
        continue
      }

      locs.forEach((l, i) => {
        const apr = mergedCell(a.sn, l.location, 'Apr', l.monthly?.Apr)
        const monthCells = ACTION_PLAN_MONTHS_AFTER_APR.flatMap(m => {
          const c = mergedCell(a.sn, l.location, m, l.monthly?.[m])
          return [c.target ?? '', c.achieved ?? '']
        })
        rows.push([
          ...(i === 0 ? metaRow : blankMeta),
          apr.target ?? '', l.location,
          ...monthCells,
        ])
      })
    }

    const ws2 = XLSX.utils.aoa_to_sheet(rows)
    ws2['!cols'] = ACTION_PLAN_MONTHLY_COLS
    ws2['!freeze'] = { xSplit: 2, ySplit: 2 }
    XLSX.utils.book_append_sheet(wb, ws2, 'Monthly Plan')

    // ─── Sheet 3 — README (identical instructions as template.xlsx) ────────
    const ws3 = XLSX.utils.aoa_to_sheet(ACTION_PLAN_README_ROWS)
    ws3['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, ws3, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="action-plan-${planKey}-${new Date().toISOString().slice(0,10)}.xlsx"`)
    res.send(buf)
  } catch (e) {
    console.error('[action-plan/export]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
