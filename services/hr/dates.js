// services/hr/dates.js — calendar maths for attendance + leave (pure, no I/O).
//
// Dates travel as 'YYYY-MM-DD' strings throughout. They're org-local
// calendar days, not instants, so all arithmetic is done in UTC on those
// strings to stay clear of the server's own timezone.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Calendar date of an instant in the given IANA timezone. */
export function dateInTz(instant, tz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function eachDate(start, end) {
  const out = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** Leave year = Indian financial year, April–March. Returns its start year. */
export function leaveYearOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  return m >= 4 ? y : y - 1
}

export function leaveYearRange(startYear) {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` }
}

/** weeklyOffs: { "<weekday 0-6>": [<nth occurrence in month 1-5>, …] } —
 *  {"0":[1,2,3,4,5]} is every Sunday, {"6":[2,4]} the 2nd and 4th Saturday. */
export function isWeeklyOff(dateStr, weeklyOffs) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const nth = Math.ceil(d.getUTCDate() / 7)
  const offs = weeklyOffs?.[String(d.getUTCDay())]
  return Array.isArray(offs) && offs.includes(nth)
}

/** Working days a leave request consumes: weekly offs and holidays are free;
 *  a half-day portion (single-date requests only) counts 0.5. */
export function countLeaveDays(start, end, dayPortion, weeklyOffs, holidaySet) {
  let days = 0
  for (const d of eachDate(start, end)) {
    if (isWeeklyOff(d, weeklyOffs) || holidaySet.has(d)) continue
    days += 1
  }
  if (dayPortion && dayPortion !== 'full') days = days > 0 ? 0.5 : 0
  return days
}

/** Two leave ranges clash unless they're opposite halves of the same single day. */
export function leaveOverlaps(a, b) {
  if (a.start_date > b.end_date || b.start_date > a.end_date) return false
  const singleSameDay = a.start_date === a.end_date && b.start_date === b.end_date && a.start_date === b.start_date
  if (singleSameDay && a.day_portion !== 'full' && b.day_portion !== 'full' && a.day_portion !== b.day_portion) return false
  return true
}

export function validateWeeklyOffs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([k, v]) =>
    /^[0-6]$/.test(k) && Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 1 && n <= 5))
}
