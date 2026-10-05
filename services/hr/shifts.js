// services/hr/shifts.js — shift maths (pure, no I/O). A shift is "N hours a
// day" (required_minutes); fixed-timing shifts additionally have org-local
// wall-clock start/end 'HH:MM[:SS]' (end before start = past midnight), and
// only those get late / early-leave marking.

import { addDays } from './dates.js'

const MIN = 60_000

function tzOffsetMs(instant, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return Math.round((asUtc - instant.getTime()) / MIN) * MIN
}

/** The instant at which the wall clock in `tz` reads `dateStr timeStr`. */
export function zonedDateTime(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = String(timeStr).split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let t = guess - tzOffsetMs(new Date(guess), tz)
  const second = guess - tzOffsetMs(new Date(t), tz)   // settles DST edges
  if (second !== t) t = second
  return new Date(t)
}

const toMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number)
  return h * 60 + m
}

/** Clock length of a fixed-timing shift (night shifts wrap past midnight). */
export function shiftLengthMinutes(shift) {
  const len = toMinutes(shift.end_time) - toMinutes(shift.start_time)
  return len > 0 ? len : len + 24 * 60
}

/** Most field shifts are just "N hours a day"; only office shifts carry times. */
export const hasTiming = (shift) => !!(shift?.start_time && shift?.end_time)

/** Hours a day the person is expected to work. */
export const requiredMinutes = (shift) =>
  shift.required_minutes ?? (hasTiming(shift) ? shiftLengthMinutes(shift) : 480)

/** Start and end instants of `shift` on the work day `workDate`. */
export function shiftWindow(shift, workDate, tz) {
  const start = zonedDateTime(workDate, shift.start_time, tz)
  const endDate = toMinutes(shift.end_time) > toMinutes(shift.start_time) ? workDate : addDays(workDate, 1)
  return { start, end: zonedDateTime(endDate, shift.end_time, tz) }
}

/** Minutes after shift start — counted only once past the grace period. */
export function lateMinutes(checkInAt, shift, workDate, tz) {
  const { start } = shiftWindow(shift, workDate, tz)
  const late = Math.round((checkInAt - start) / MIN)
  return late > shift.grace_minutes ? late : 0
}

/** Minutes left before shift end — counted only beyond the grace period. */
export function earlyLeaveMinutes(checkOutAt, shift, workDate, tz) {
  const { end } = shiftWindow(shift, workDate, tz)
  const early = Math.round((end - checkOutAt) / MIN)
  return early > shift.grace_minutes ? early : 0
}

export function workedMinutes(checkInAt, checkOutAt) {
  return Math.max(0, Math.round((checkOutAt - checkInAt) / MIN))
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
