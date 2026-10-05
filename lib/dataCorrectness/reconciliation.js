// Layer 3: cross-system drift detection, written to reconciliation_checks (010).
//   • runDailyReconciliation(pool)       — nightly job (server.js); iterates every org
//   • runReconciliationForOrg(pool,id)   — on-demand (admin button / pre-save)

import { getPool } from '../../db/pool.js'
import { resolvePeriod, toSqlDate } from './periodMath.js'
import { getTolerances } from './policy.js'

const DEFAULT_TOLERANCES = {
  beneficiaries: 0.02,    // 2%
  activities:    0,        // exact match required
  projects:      0,
  locations:     0,
}

async function _logCheck(pool, row) {
  try {
    await pool.query(
      `INSERT INTO reconciliation_checks
         (org_id, metric, source_a, value_a, source_b, value_b,
          drift_pct, drift_pass, period_label, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.orgId, row.metric, row.sourceA, row.valueA, row.sourceB, row.valueB,
       row.driftPct, row.driftPass, row.periodLabel, row.notes || null]
    )
  } catch (e) {
    console.warn('[reconciliation] log insert failed:', e.message)
  }
}

function _drift(a, b) {
  const max = Math.max(Math.abs(a), Math.abs(b))
  if (max === 0) return 0
  return Math.abs(a - b) / max
}

// ── Metric pairs ────────────────────────────────────────────────────────────

async function _checkBeneficiaries(pool, orgId, period, tolerances) {
  // Source A: SUM(beneficiaries) from daily_reports in period
  const { rows: aRows } = await pool.query(
    `SELECT COALESCE(SUM(beneficiaries), 0) AS v
       FROM daily_reports
      WHERE org_id = $1
        AND report_date >= $2::date
        AND report_date <  $3::date`,
    [orgId, toSqlDate(period.start), toSqlDate(period.end)]
  )
  const valueA = Number(aRows[0]?.v) || 0

  // Source B: SUM(achieved) from project_deliverables where indicator looks
  // like "sn|location|month" within the period months
  const { rows: bRows } = await pool.query(
    `SELECT COALESCE(SUM(achieved), 0) AS v
       FROM project_deliverables
      WHERE org_id = $1
        AND data_type = 'action_plan'
        AND updated_at >= $2::date
        AND updated_at <  $3::date`,
    [orgId, toSqlDate(period.start), toSqlDate(period.end)]
  )
  const valueB = Number(bRows[0]?.v) || 0

  const driftPct = _drift(valueA, valueB)
  const driftPass = driftPct <= (tolerances.beneficiaries ?? DEFAULT_TOLERANCES.beneficiaries)

  await _logCheck(pool, {
    orgId,
    metric: 'beneficiaries',
    sourceA: 'daily_reports.beneficiaries SUM',
    valueA,
    sourceB: 'project_deliverables.achieved SUM',
    valueB,
    driftPct,
    driftPass,
    periodLabel: period.label,
  })

  return { metric: 'beneficiaries', valueA, valueB, driftPct, driftPass }
}

async function _checkProjects(pool, orgId, period, tolerances) {
  const { rows: aRows } = await pool.query(
    `SELECT COUNT(DISTINCT project) AS v FROM daily_reports
      WHERE org_id = $1
        AND report_date >= $2::date AND report_date < $3::date
        AND project IS NOT NULL`,
    [orgId, toSqlDate(period.start), toSqlDate(period.end)]
  )
  const valueA = Number(aRows[0]?.v) || 0

  const { rows: bRows } = await pool.query(
    `SELECT COUNT(DISTINCT project_key) AS v FROM action_plans
      WHERE org_id = $1 AND active = true`,
    [orgId]
  )
  const valueB = Number(bRows[0]?.v) || 0

  const driftPct = _drift(valueA, valueB)
  const driftPass = driftPct <= (tolerances.projects ?? DEFAULT_TOLERANCES.projects)

  await _logCheck(pool, {
    orgId,
    metric: 'projects',
    sourceA: 'daily_reports DISTINCT project',
    valueA,
    sourceB: 'action_plans DISTINCT project_key',
    valueB,
    driftPct,
    driftPass,
    periodLabel: period.label,
  })

  return { metric: 'projects', valueA, valueB, driftPct, driftPass }
}

async function _checkLocations(pool, orgId, period, tolerances) {
  const { rows: aRows } = await pool.query(
    `SELECT COUNT(DISTINCT location) AS v FROM daily_reports
      WHERE org_id = $1
        AND report_date >= $2::date AND report_date < $3::date
        AND location IS NOT NULL AND location <> ''`,
    [orgId, toSqlDate(period.start), toSqlDate(period.end)]
  )
  const valueA = Number(aRows[0]?.v) || 0

  const { rows: bRows } = await pool.query(
    `SELECT COUNT(DISTINCT loc) AS v
       FROM action_plans, unnest(locations) AS loc
      WHERE org_id = $1 AND active = true`,
    [orgId]
  )
  const valueB = Number(bRows[0]?.v) || 0

  const driftPct = _drift(valueA, valueB)
  const driftPass = driftPct <= (tolerances.locations ?? DEFAULT_TOLERANCES.locations)

  await _logCheck(pool, {
    orgId,
    metric: 'locations',
    sourceA: 'daily_reports DISTINCT location',
    valueA,
    sourceB: 'action_plans DISTINCT unnested locations',
    valueB,
    driftPct,
    driftPass,
    periodLabel: period.label,
  })

  return { metric: 'locations', valueA, valueB, driftPct, driftPass }
}

// ── Public ──────────────────────────────────────────────────────────────────

/** Run all metric reconciliations for one org (opts: period='currentFY', orgMeta, tolerances). */
export async function runReconciliationForOrg(pool, orgId, opts = {}) {
  const period = resolvePeriod(opts.period || 'currentFY', opts.orgMeta || {})
  const tol = opts.tolerances || DEFAULT_TOLERANCES

  const results = []
  try { results.push(await _checkBeneficiaries(pool, orgId, period, tol)) }
  catch (e) { console.warn('[reconciliation] beneficiaries failed:', e.message) }

  try { results.push(await _checkProjects(pool, orgId, period, tol)) }
  catch (e) { console.warn('[reconciliation] projects failed:', e.message) }

  try { results.push(await _checkLocations(pool, orgId, period, tol)) }
  catch (e) { console.warn('[reconciliation] locations failed:', e.message) }

  return results
}

/** Reconcile every org; each run inserts a fresh row per metric. */
export async function runDailyReconciliation(pool = getPool()) {
  const { rows: orgs } = await pool.query(
    `SELECT id, metadata FROM organizations`
  )
  let totalFail = 0
  for (const org of orgs) {
    try {
      const tolerances = await getTolerances(org.id)
      const results = await runReconciliationForOrg(pool, org.id, {
        orgMeta: org.metadata || {},
        tolerances,
      })
      totalFail += results.filter(r => !r.driftPass).length
    } catch (e) {
      console.warn(`[reconciliation] org ${org.id} failed:`, e.message)
    }
  }
  if (totalFail > 0) {
    console.log(`[reconciliation] complete — ${totalFail} drift failures across all orgs`)
  }
  return { orgsChecked: orgs.length, driftFailures: totalFail }
}
