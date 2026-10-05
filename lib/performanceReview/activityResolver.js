// lib/performanceReview/activityResolver.js — Activity Completion data
//
// Resolves the 6 activity buckets from spec §5 using existing tables:
//   Daily reporting · Team coordination · Field / operational work ·
//   MIS / data update · Problem resolution · Documentation
//
// Each returns { name, target, completed, completion_pct, quality, remark }

const SCALE_QUALITY = (pct) => Math.max(0, Math.min(5, 1 + (pct / 25)))   // 0% → 1.0, 100% → 5.0
const PCT = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)

async function _dailyReporting(pool, ctx) {
  const target = ctx.workingDays
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT report_date)::int AS days
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= $3 AND report_date < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ days: 0 }] }))
  const completed = rows[0]?.days || 0
  const pct = PCT(completed, target)
  return {
    name: 'Daily reporting',
    target, completed, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 90 ? 'Regular performance' : pct >= 70 ? 'Some gaps' : 'Frequent gaps',
  }
}

async function _teamCoordination(pool, ctx) {
  const { rows } = await pool.query(
    `WITH my_reports AS (
       SELECT location, report_date FROM daily_reports
        WHERE org_id = $1 AND submitted_by = $2
          AND report_date >= $3 AND report_date < $4
          AND location IS NOT NULL
     )
     SELECT
       (SELECT COUNT(DISTINCT submitted_by)::int
          FROM daily_reports d JOIN my_reports m
            ON d.location = m.location AND d.report_date = m.report_date
         WHERE d.org_id = $1 AND d.submitted_by IS NOT NULL
           AND d.submitted_by <> $2) AS collab_days,
       (SELECT COUNT(DISTINCT submitted_by)::int
          FROM daily_reports
         WHERE org_id = $1
           AND report_date >= $3 AND report_date < $4
           AND submitted_by IS NOT NULL
           AND submitted_by <> $2) AS team_size`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ collab_days: 0, team_size: 0 }] }))
  const r = rows[0]
  const target = Math.max(1, Math.round(r.team_size * 0.5))
  const completed = r.collab_days
  const pct = PCT(completed, target)
  return {
    name: 'Team coordination',
    target, completed, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 85 ? 'Good coordination' : 'Limited cross-team activity',
  }
}

async function _fieldWork(pool, ctx) {
  // Field activity from project_deliverables tied to this user (uploaded_by stores name)
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE achieved IS NOT NULL AND achieved > 0)::int AS done
       FROM project_deliverables pd
      WHERE pd.org_id = $1
        AND pd.uploaded_by = (SELECT name FROM users WHERE id = $2)
        AND pd.updated_at >= $3 AND pd.updated_at < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ total: 0, done: 0 }] }))
  const r = rows[0]
  const pct = PCT(r.done, Math.max(1, r.total))
  return {
    name: 'Field / operational work',
    target: r.total || 0, completed: r.done || 0, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 85 ? 'Good, documentation needed' : pct >= 60 ? 'Acceptable' : 'Below expectation',
  }
}

async function _misUpdate(pool, ctx) {
  // Edits to action_plan cells in the period
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS edits
       FROM audit_log
      WHERE org_id = $1
        AND actor_uid = (SELECT firebase_uid FROM users WHERE id = $2)
        AND action LIKE 'action_plan%'
        AND created_at >= $3 AND created_at < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ edits: 0 }] }))
  const completed = rows[0]?.edits || 0
  // Target: roughly 1 update per working day
  const target = Math.max(1, Math.round(ctx.workingDays * 0.5))
  const pct = Math.min(100, PCT(completed, target))
  return {
    name: 'MIS / data update',
    target, completed, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 80 ? 'Active updates' : 'Accuracy can improve',
  }
}

async function _problemResolution(pool, ctx) {
  // Overrides + grievance handling — proxied via audit_log.correctness.override
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS handled
       FROM audit_log
      WHERE org_id = $1
        AND actor_uid = (SELECT firebase_uid FROM users WHERE id = $2)
        AND action LIKE 'correctness.override%'
        AND created_at >= $3 AND created_at < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ handled: 0 }] }))
  const completed = rows[0]?.handled || 0
  const target = Math.max(1, Math.round(ctx.workingDays * 0.2))
  const pct = Math.min(100, PCT(completed, target))
  return {
    name: 'Problem resolution',
    target, completed, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 75 ? 'Engaged' : 'Response speed needs improvement',
  }
}

async function _documentation(pool, ctx) {
  // Reports with photo / attachment
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE attachment_url IS NOT NULL)::int AS with_photo
       FROM daily_reports
      WHERE org_id = $1 AND submitted_by = $2
        AND report_date >= $3 AND report_date < $4`,
    [ctx.orgId, ctx.employeeId, ctx.periodStart, ctx.periodEnd]
  ).catch(() => ({ rows: [{ total: 0, with_photo: 0 }] }))
  const r = rows[0]
  const pct = PCT(r.with_photo, Math.max(1, r.total))
  return {
    name: 'Documentation',
    target: r.total, completed: r.with_photo, completion_pct: pct,
    quality: SCALE_QUALITY(pct),
    remark: pct >= 80 ? 'Strong documentation' : 'Weak area',
  }
}

export async function resolveActivities(pool, ctx) {
  return await Promise.all([
    _dailyReporting(pool, ctx),
    _teamCoordination(pool, ctx),
    _fieldWork(pool, ctx),
    _misUpdate(pool, ctx),
    _problemResolution(pool, ctx),
    _documentation(pool, ctx),
  ])
}
