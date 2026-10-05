// Shared action-plan helpers: plan-year health maths, org-wide target/achieved roll-up,
// plan/project key resolution, and the Excel layout shared by template.xlsx and export.xlsx.

import { getPool } from '../../db/pool.js'

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

export {
  DEFAULT_PROJECT_KEY,
  PLAN_YEAR_START_MONTH,
  monthsElapsedInPlanYear,
  healthFromTargets,
  complianceStatusForItem,
  aggregateActionPlans,
  resolvePlanKey,
  AP_MONTHS,
  resolveProjectKey,
  ACTION_PLAN_MONTHS_AFTER_APR,
  actionPlanMonthlyHeaderRows,
  ACTION_PLAN_MONTHLY_COLS,
  ACTION_PLAN_README_ROWS,
}
