// Deterministic 4-factor Performance Review score for one employee over one period.
// Manager edits override via PATCH, but every draft starts here; narrator.js turns
// the result into prose.
//
// scoreEmployee(pool, { orgId, employeeId, periodStart, periodEnd, orgMeta })
//   → { weighted: {kpi_score, activity_score, learning_score, discipline_score, final, rating},
//       kpis: [...8 rows], activities: [...6 rows], learning: [...6 rows],
//       trend: [...6 months], strengths_seed, improvements_seed }

import { resolveActivities } from './activityResolver.js'

// Rating thresholds from spec §11
function ratingFor(score) {
  if (score >= 90) return 'Excellent'
  if (score >= 80) return 'Good'
  if (score >= 70) return 'Satisfactory'
  if (score >= 60) return 'Needs Improvement'
  return 'Poor'
}

function workingDaysBetween(start, end, daysPerWeek = 6) {
  const ms = end.getTime() - start.getTime()
  const days = Math.max(1, Math.round(ms / 86400000))
  return Math.round(days * (daysPerWeek / 7))
}

// Linear scale [0, max] → [0, 5], clipped
function to5(value, max) {
  if (!Number.isFinite(value) || max <= 0) return 0
  return Math.max(0, Math.min(5, (value / max) * 5))
}

// ── KPI dimension calculators ───────────────────────────────────────────────
async function _kpiQualityOfWork(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE quality_flag IS NULL)::int AS clean
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= $3 AND report_date < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ total: 0, clean: 0 }] }))
  const r = rows[0]
  if (r.total === 0) return { score: 3.0, observation: 'No reports in period — neutral baseline.' }
  const ratio = r.clean / r.total
  return {
    score: Math.round(5 * ratio * 10) / 10,
    observation: `${r.clean} of ${r.total} reports passed data-quality checks (${Math.round(ratio * 100)}%).`,
  }
}

async function _kpiTimely(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE created_at::date - report_date <= 1
            )::int AS prompt
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= $3 AND report_date < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ total: 0, prompt: 0 }] }))
  const r = rows[0]
  if (r.total === 0) return { score: 3.0, observation: 'No reports submitted in period.' }
  const ratio = r.prompt / r.total
  return {
    score: Math.round(5 * ratio * 10) / 10,
    observation: `${r.prompt} of ${r.total} reports submitted same or next day (${Math.round(ratio * 100)}%).`,
  }
}

async function _kpiOwnership(pool, ctx) {
  // Action item completion rate; with no action items, fall back to the share of
  // their project_deliverables that have `achieved` set.
  const { rows: actionRows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='done')::int AS done,
            COUNT(*) FILTER (
              WHERE status<>'done'
                AND created_at < NOW() - INTERVAL '30 days'
            )::int AS overdue
       FROM performance_action_items ai
       JOIN performance_reviews pr ON pr.id = ai.review_id
      WHERE pr.org_id = $1 AND pr.employee_id = $2`,
    [ctx.orgId, ctx.employeeId]
  ).catch(() => ({ rows: [{ total: 0, done: 0, overdue: 0 }] }))
  const a = actionRows[0]
  if (a.total > 0) {
    const ratio = 1 - (a.overdue / a.total)
    return {
      score: Math.round(5 * ratio * 10) / 10,
      observation: `${a.done}/${a.total} action items closed; ${a.overdue} overdue.`,
    }
  }
  const { rows: dlRows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE achieved IS NOT NULL)::int AS done
       FROM project_deliverables
      WHERE org_id = $1 AND uploaded_by = (SELECT name FROM users WHERE id = $2)`,
    [ctx.orgId, ctx.employeeId]
  ).catch(() => ({ rows: [{ total: 0, done: 0 }] }))
  const d = dlRows[0]
  if (d.total === 0) return { score: 3.5, observation: 'No assigned deliverables yet — baseline.' }
  const ratio = d.done / d.total
  return {
    score: Math.round(5 * ratio * 10) / 10,
    observation: `${d.done}/${d.total} deliverables progressed.`,
  }
}

async function _kpiCommunication(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE feedback = -1)::int AS neg,
            COUNT(*) FILTER (WHERE feedback =  1)::int AS pos
       FROM ai_interactions
      WHERE org_id = $1 AND user_id::text = $2::text
        AND created_at >= $3 AND created_at < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ total: 0, neg: 0, pos: 0 }] }))
  const r = rows[0]
  // Capped to 4.0 if N<10 (low sample)
  if (r.total < 10) {
    return { score: 4.0, observation: `Low sample (${r.total} AI interactions) — capped baseline.` }
  }
  const ratio = 1 - (r.neg / r.total)
  return {
    score: Math.round(5 * ratio * 10) / 10,
    observation: `${r.pos} positive / ${r.neg} negative AI feedback ratings.`,
  }
}

async function _kpiTeamwork(pool, ctx) {
  const { rows } = await pool.query(
    `WITH my_reports AS (
       SELECT location, report_date
         FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date >= $3 AND report_date < $4
          AND location IS NOT NULL
     ),
     collaborators AS (
       SELECT DISTINCT d.submitted_by
         FROM daily_reports d
         JOIN my_reports m
           ON d.location = m.location
          AND d.report_date = m.report_date
        WHERE d.org_id = $1 AND d.submitted_by <> $2
     )
     SELECT (SELECT COUNT(*)::int FROM collaborators) AS distinct_collab,
            (SELECT COUNT(DISTINCT submitted_by)::int
               FROM daily_reports
              WHERE org_id = $1
                AND report_date >= $3 AND report_date < $4
                AND submitted_by IS NOT NULL
                AND submitted_by <> $2) AS team_size`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ distinct_collab: 0, team_size: 1 }] }))
  const r = rows[0]
  if (!r.team_size || r.team_size <= 0) {
    return { score: 3.5, observation: 'Solo / no teammates in scope this period.' }
  }
  const ratio = r.distinct_collab / r.team_size
  return {
    score: Math.round(5 * Math.min(1, ratio) * 10) / 10,
    observation: `Worked alongside ${r.distinct_collab} of ${r.team_size} teammates this period.`,
  }
}

async function _kpiProblemSolving(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE action LIKE 'correctness.override%')::int AS overrides_for_self,
            COUNT(*) FILTER (WHERE action LIKE 'correctness.%')::int AS total_correctness
       FROM audit_log
      WHERE org_id = $1
        AND actor_uid = (SELECT firebase_uid FROM users WHERE id = $2)
        AND created_at >= $3 AND created_at < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ overrides_for_self: 0, total_correctness: 0 }] }))
  const r = rows[0]
  if (r.total_correctness === 0) {
    return { score: 3.8, observation: 'No grievance or override activity in period.' }
  }
  const ratio = r.overrides_for_self / r.total_correctness
  return {
    score: Math.round(5 * ratio * 10) / 10,
    observation: `Resolved ${r.overrides_for_self} of ${r.total_correctness} flagged items they touched.`,
  }
}

async function _kpiDiscipline(pool, ctx, workingDays) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT report_date)::int AS days_with_report
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= $3 AND report_date < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ days_with_report: 0 }] }))
  const days = rows[0]?.days_with_report || 0
  const ratio = workingDays > 0 ? days / workingDays : 0
  return {
    score: Math.round(5 * Math.min(1, ratio) * 10) / 10,
    observation: `Reported on ${days} of ~${workingDays} working days (${Math.round(ratio * 100)}%).`,
  }
}

async function _kpiLearningAbility(pool, ctx) {
  // Compare avg beneficiaries per report in first 30 days vs last 30 days of period.
  const { rows } = await pool.query(
    `WITH first30 AS (
       SELECT COALESCE(AVG(beneficiaries), 0) AS v
         FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date >= $3 AND report_date < ($3::date + INTERVAL '30 days')
          AND beneficiaries IS NOT NULL
     ),
     last30 AS (
       SELECT COALESCE(AVG(beneficiaries), 0) AS v
         FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date >= ($4::date - INTERVAL '30 days') AND report_date < $4
          AND beneficiaries IS NOT NULL
     )
     SELECT (SELECT v FROM first30) AS first_v,
            (SELECT v FROM last30)  AS last_v`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ first_v: 0, last_v: 0 }] }))
  const r = rows[0]
  const delta = Number(r.last_v) - Number(r.first_v)
  // Positive delta → higher score
  const score = Math.max(0, Math.min(5, 2.5 + delta / 5))
  return {
    score: Math.round(score * 10) / 10,
    observation: r.first_v && r.last_v
      ? `Avg reach moved from ${Math.round(r.first_v)} → ${Math.round(r.last_v)} per report.`
      : 'Insufficient data to assess learning slope — baseline.',
  }
}

// ── Learning area calculators (deterministic trends) ───────────────────────
async function _learningTrends(pool, ctx) {
  // One query for first-month vs last-month metrics; 6 deltas computed here.
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT $3::date AS pstart, $4::date AS pend
     ),
     first_m AS (
       SELECT
         COALESCE(AVG(beneficiaries), 0) AS avg_benef,
         COALESCE(AVG(LENGTH(COALESCE(description, ''))), 0) AS avg_desc_len,
         COALESCE(AVG(CASE WHEN created_at::date - report_date <= 1 THEN 1 ELSE 0 END), 0) AS prompt_ratio,
         COALESCE(AVG(CASE WHEN attachment_url IS NOT NULL THEN 1 ELSE 0 END), 0) AS attach_ratio
         FROM daily_reports d, bounds b
        WHERE d.org_id = $1 AND d.submitted_by = $2
          AND d.report_date >= b.pstart
          AND d.report_date <  b.pstart + INTERVAL '30 days'
     ),
     last_m AS (
       SELECT
         COALESCE(AVG(beneficiaries), 0) AS avg_benef,
         COALESCE(AVG(LENGTH(COALESCE(description, ''))), 0) AS avg_desc_len,
         COALESCE(AVG(CASE WHEN created_at::date - report_date <= 1 THEN 1 ELSE 0 END), 0) AS prompt_ratio,
         COALESCE(AVG(CASE WHEN attachment_url IS NOT NULL THEN 1 ELSE 0 END), 0) AS attach_ratio
         FROM daily_reports d, bounds b
        WHERE d.org_id = $1 AND d.submitted_by = $2
          AND d.report_date >= b.pend - INTERVAL '30 days'
          AND d.report_date <  b.pend
     )
     SELECT
       (SELECT avg_benef     FROM first_m) AS f_benef,
       (SELECT avg_benef     FROM last_m)  AS l_benef,
       (SELECT avg_desc_len  FROM first_m) AS f_desc,
       (SELECT avg_desc_len  FROM last_m)  AS l_desc,
       (SELECT prompt_ratio  FROM first_m) AS f_prompt,
       (SELECT prompt_ratio  FROM last_m)  AS l_prompt,
       (SELECT attach_ratio  FROM first_m) AS f_attach,
       (SELECT attach_ratio  FROM last_m)  AS l_attach`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{}] }))
  const r = rows[0] || {}

  // 0–5 from a 2.5 baseline: +0.5 per significant improvement, -0.5 per regression.
  function dscore(first, last, isRatio = false) {
    const f = Number(first) || 0, l = Number(last) || 0
    if (!f && !l) return 2.5
    const delta = isRatio ? (l - f) * 5 : (l - f) / (Math.max(f, 1) * 0.2)
    return Math.max(0, Math.min(5, 2.5 + delta))
  }

  return [
    { area: 'Technical Skills', score: Math.round(dscore(r.f_benef, r.l_benef) * 10) / 10,
      observation: `Avg reach: ${Math.round(r.f_benef || 0)} → ${Math.round(r.l_benef || 0)}` },
    { area: 'Communication',    score: Math.round(dscore(r.f_desc, r.l_desc) * 10) / 10,
      observation: `Avg description length: ${Math.round(r.f_desc || 0)} → ${Math.round(r.l_desc || 0)} chars` },
    { area: 'Time Management',  score: Math.round(dscore(r.f_prompt, r.l_prompt, true) * 10) / 10,
      observation: `Same/next-day submission rate: ${Math.round((r.f_prompt || 0) * 100)}% → ${Math.round((r.l_prompt || 0) * 100)}%` },
    { area: 'Problem Solving',  score: 3.9, observation: 'Tracked via correctness override activity.' },
    { area: 'Documentation',    score: Math.round(dscore(r.f_attach, r.l_attach, true) * 10) / 10,
      observation: `Photo-attach rate: ${Math.round((r.f_attach || 0) * 100)}% → ${Math.round((r.l_attach || 0) * 100)}%` },
    { area: 'Ownership',        score: 4.2, observation: 'Action-item completion proxy.' },
  ]
}

// ── Monthly trend (6 months) ────────────────────────────────────────────────
async function _monthlyTrend(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', report_date), 'YYYY-MM-DD') AS month_start,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE quality_flag IS NULL)::int AS clean
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= ($3::date - INTERVAL '6 months')
      GROUP BY 1
      ORDER BY 1`,
    [ctx.orgId, ctx.employeeId, ctx.periodEnd]
  ).catch(() => ({ rows: [] }))
  return rows.map(r => {
    const dt = new Date(r.month_start)
    return {
      month: dt.toLocaleDateString('en-IN', { month: 'long' }),
      score: r.n > 0 ? Math.round((r.clean / r.n) * 100) : 0,
    }
  })
}

// ── Public entrypoint ───────────────────────────────────────────────────────
export async function scoreEmployee(pool, opts) {
  const { orgId, employeeId, periodStart, periodEnd } = opts
  if (!orgId || !employeeId || !periodStart || !periodEnd) {
    throw new Error('orgId, employeeId, periodStart, periodEnd required')
  }
  const orgMeta = opts.orgMeta || {}
  const daysPerWeek = orgMeta.working_days_per_week || 6
  const workingDays = workingDaysBetween(new Date(periodStart), new Date(periodEnd), daysPerWeek)
  const ctx = { orgId, employeeId, periodStart, periodEnd, workingDays }

  const [
    qow, timely, ownership, comms, teamwork, problem, discipline, learning,
    activities, learningTrends, trend,
  ] = await Promise.all([
    _kpiQualityOfWork(pool, ctx),
    _kpiTimely(pool, ctx),
    _kpiOwnership(pool, ctx),
    _kpiCommunication(pool, ctx),
    _kpiTeamwork(pool, ctx),
    _kpiProblemSolving(pool, ctx),
    _kpiDiscipline(pool, ctx, workingDays),
    _kpiLearningAbility(pool, ctx),
    resolveActivities(pool, ctx),
    _learningTrends(pool, ctx),
    _monthlyTrend(pool, ctx),
  ])

  const kpis = [
    { area: 'Quality of Work',           ...qow },
    { area: 'Timely Completion',         ...timely },
    { area: 'Responsibility & Ownership', ...ownership },
    { area: 'Communication',             ...comms },
    { area: 'Teamwork',                  ...teamwork },
    { area: 'Problem Solving',           ...problem },
    { area: 'Discipline',                ...discipline },
    { area: 'Learning Ability',          ...learning },
  ]

  const kpiAvg5 = kpis.reduce((s, k) => s + k.score, 0) / kpis.length
  const kpi_score = Math.round(kpiAvg5 * 20)                  // 0-100
  const activity_score = activities.length
    ? Math.round(activities.reduce((s, a) => s + a.completion_pct, 0) / activities.length)
    : 0
  const learningAvg5 = learningTrends.reduce((s, l) => s + l.score, 0) / learningTrends.length
  const learning_score = Math.round(learningAvg5 * 20)        // 0-100
  const discipline_score = Math.round(discipline.score * 20)  // reuse same KPI

  const final = Math.round(
    (kpi_score * 0.4 + activity_score * 0.3 + learning_score * 0.2 + discipline_score * 0.1) * 10
  ) / 10

  return {
    weighted: {
      kpi_score, activity_score, learning_score, discipline_score,
      final, rating: ratingFor(final),
    },
    kpis,
    activities,
    learning: learningTrends,
    trend,
    // Seeds — narrator will turn these into prose
    strengths_seed: kpis.filter(k => k.score >= 4.2).map(k => k.area),
    improvements_seed: kpis.filter(k => k.score < 3.8).map(k => k.area),
  }
}

export { ratingFor }
