// lib/dataCorrectness/periodMath.js — fiscal-year-aware period helpers, so
// "this year" means one thing everywhere. Fiscal start comes from
// organizations.metadata.fiscal_year_start (month name or 1-12; default April).

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December']

function _fyStartMonth(orgMeta) {
  const raw = orgMeta?.fiscal_year_start
  if (typeof raw === 'number' && raw >= 1 && raw <= 12) return raw
  if (typeof raw === 'string') {
    const i = MONTH_NAMES.findIndex(m => m.toLowerCase() === raw.toLowerCase())
    if (i >= 0) return i + 1
  }
  return 4 // default April
}

/**
 * Current fiscal year boundaries for the given org.
 * @returns {{ start: Date, end: Date, label: string }}
 */
export function currentFY(orgMeta, now = new Date()) {
  const fyStart = _fyStartMonth(orgMeta)
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  // If we're before the fiscal start month, FY started last calendar year
  const startYear = m >= fyStart ? y : y - 1
  const start = new Date(startYear, fyStart - 1, 1)
  const end   = new Date(startYear + 1, fyStart - 1, 1) // exclusive
  // Label: 'FY2026-27' style if cross-year, else 'FY2026'
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0')
  const label = fyStart === 1 ? `FY${startYear}` : `FY${startYear}-${endYearShort}`
  return { start, end, label }
}

/** Previous fiscal year. */
export function previousFY(orgMeta, now = new Date()) {
  const cur = currentFY(orgMeta, now)
  const yearBack = new Date(cur.start.getFullYear() - 1, cur.start.getMonth(), 1)
  return currentFY(orgMeta, yearBack)
}

/** Quarter within the org's fiscal year (Q1 = first three months from FY start). */
export function currentQuarter(orgMeta, now = new Date()) {
  const fy = currentFY(orgMeta, now)
  const monthsIn = (now.getFullYear() - fy.start.getFullYear()) * 12 +
                   (now.getMonth() - fy.start.getMonth())
  const qIdx = Math.floor(monthsIn / 3) // 0..3
  const qStart = new Date(fy.start.getFullYear(), fy.start.getMonth() + qIdx * 3, 1)
  const qEnd   = new Date(fy.start.getFullYear(), fy.start.getMonth() + (qIdx + 1) * 3, 1)
  return { start: qStart, end: qEnd, label: `${fy.label}Q${qIdx + 1}` }
}

/** Calendar month boundaries. */
export function currentMonth(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return { start, end, label }
}

/** Rolling-N-day window ending now. */
export function rollingDays(days, now = new Date()) {
  const end = new Date(now)
  const start = new Date(now.getTime() - days * 86400000)
  const label = `rolling_${days}d`
  return { start, end, label }
}

/**
 * Format a Date as a naive Postgres timestamp from local getters. Boundaries
 * are local midnight; toISOString() would shift them by the UTC offset.
 */
export function toSqlDate(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Resolve a named period to boundaries: 'currentFY' | 'previousFY' | 'currentQuarter' |
 * 'currentMonth' | 'rolling_30d' | 'rolling_90d' | 'rolling_180d' | 'rolling_365d'
 */
export function resolvePeriod(name, orgMeta, now = new Date()) {
  switch (name) {
    case 'currentFY':       return currentFY(orgMeta, now)
    case 'previousFY':      return previousFY(orgMeta, now)
    case 'currentQuarter':  return currentQuarter(orgMeta, now)
    case 'currentMonth':    return currentMonth(now)
    case 'rolling_30d':     return rollingDays(30, now)
    case 'rolling_90d':     return rollingDays(90, now)
    case 'rolling_180d':    return rollingDays(180, now)
    case 'rolling_365d':    return rollingDays(365, now)
    default:                return rollingDays(365, now)
  }
}
