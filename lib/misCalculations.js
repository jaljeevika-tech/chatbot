// MIS calculations (spec §9): pure functions shared by mis-entries (grid) and
// mis-dashboard (KPIs). `entries` are one (indicator, scope, scope_value)'s rows for
// one FY, each a single month's increment; cumulative figures are derived here and
// never stored (mixing the two double-counts — see 029_mis_entries.sql).

export const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']

export function monthIndex(month) {
  return MONTHS.indexOf(month)
}

const DEFAULT_THRESHOLDS = { onTrack: 90, needsAttention: 70, overachieve: 110 }

// Entries up to and including `uptoMonth`, sorted chronologically (Apr first).
function entriesUpTo(entries, uptoMonth) {
  const cutoff = monthIndex(uptoMonth)
  return entries
    .filter(e => monthIndex(e.month) <= cutoff)
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month))
}

// Aggregates 'plan' | 'actual' up to uptoMonth by aggregation_method; null (not 0)
// when there's no data, so a gap never looks like a real zero.
function aggregateField(entries, uptoMonth, aggregationMethod, field) {
  const rows = entriesUpTo(entries, uptoMonth).filter(e => e[field] !== null && e[field] !== undefined)
  if (!rows.length) return null

  switch (aggregationMethod) {
    case 'average': {
      const sum = rows.reduce((s, r) => s + Number(r[field]), 0)
      return sum / rows.length
    }
    case 'latest':
    case 'percentage':
      // Latest reported value as-is (spec's alternative to numerator/denominator tracking).
      return Number(rows[rows.length - 1][field])
    case 'sum':
    case 'cumulative':
    default:
      return rows.reduce((s, r) => s + Number(r[field]), 0)
  }
}

export function cumulativePlan(entries, uptoMonth, aggregationMethod = 'sum') {
  return aggregateField(entries, uptoMonth, aggregationMethod, 'plan')
}

export function cumulativeActual(entries, uptoMonth, aggregationMethod = 'sum') {
  return aggregateField(entries, uptoMonth, aggregationMethod, 'actual')
}

// % of cumulative plan achieved; null on a zero/missing denominator, never NaN or a fake 0%.
export function achievementPct(cumActual, cumPlan) {
  if (cumPlan === null || cumPlan === undefined || cumPlan === 0) return null
  if (cumActual === null || cumActual === undefined) return null
  return (cumActual / cumPlan) * 100
}

export function targetAchievementPct(cumActual, target) {
  if (target === null || target === undefined || target === 0) return null
  if (cumActual === null || cumActual === undefined) return null
  return (cumActual / target) * 100
}

export function variance(cumActual, cumPlan) {
  if (cumActual === null || cumActual === undefined || cumPlan === null || cumPlan === undefined) {
    return { absolute: null, percent: null }
  }
  const absolute = cumActual - cumPlan
  const percent = cumPlan === 0 ? null : (absolute / cumPlan) * 100
  return { absolute, percent }
}

// 'on_track' | 'needs_attention' | 'behind' | 'not_started' | 'data_pending' | 'overachieved'
// Overachievement is a data-quality flag, not automatically "good" (spec).
export function statusFor({ pct, hasPlan, hasActual, thresholds = DEFAULT_THRESHOLDS }) {
  if (!hasPlan && !hasActual) return 'not_started'
  if (hasPlan && !hasActual) return 'data_pending'
  if (pct === null || pct === undefined) {
    // Actual against a zero plan can't be a ratio, but is worth flagging.
    return hasActual ? 'overachieved' : 'not_started'
  }
  if (pct >= thresholds.overachieve) return 'overachieved'
  if (pct >= thresholds.onTrack) return 'on_track'
  if (pct >= thresholds.needsAttention) return 'needs_attention'
  return 'behind'
}

// Full metric bundle for one (indicator, scope, scope_value, FY, uptoMonth) slice.
// Quarterly/annual/baseline_endline indicators are never monthly-summed (spec):
// they use the latest value against the target, whatever their aggregation_method.
export function computeIndicatorMetrics({ frequency, aggregationMethod, entries, uptoMonth, target, thresholds }) {
  const rows = entriesUpTo(entries, uptoMonth)
  const hasPlan = rows.some(e => e.plan !== null && e.plan !== undefined)
  const hasActual = rows.some(e => e.actual !== null && e.actual !== undefined)

  const effectiveAggregation = ['quarterly', 'annual', 'baseline_endline'].includes(frequency) ? 'latest' : aggregationMethod

  const cumPlan = cumulativePlan(entries, uptoMonth, effectiveAggregation)
  const cumActual = cumulativeActual(entries, uptoMonth, effectiveAggregation)
  const pctVsPlan = achievementPct(cumActual, cumPlan)
  const pctVsTarget = targetAchievementPct(cumActual, target)
  const v = variance(cumActual, cumPlan)
  const status = statusFor({ pct: pctVsPlan, hasPlan, hasActual, thresholds })

  return {
    cumulativePlan: cumPlan,
    cumulativeActual: cumActual,
    achievementPct: pctVsPlan,
    targetAchievementPct: pctVsTarget,
    variance: v,
    status,
    hasPlan,
    hasActual,
  }
}
