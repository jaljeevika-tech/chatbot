// HR reminders + auto check-out. Runs in the monolith (routes/hr.routes.js) every
// 10 minutes because a scale-to-zero Cloud Run service has no timer. Each reminder
// goes out once per person per day — recorded in hr_reminders_sent first so instances
// can't double-send — and only within REMINDER_WINDOW of its org-local time (so a late
// deploy doesn't send a morning reminder at night). Times live in HR Settings.
//
//   missedCheckIn     reminderTime          people on a shift with no attendance/leave/holiday
//   checkOutReminder  checkOutReminderTime  anyone still checked in today
//   autoCheckOut      autoCheckOutTime      still checked in → closed at that time, flagged for review
//   approvalReminder  approvalReminderTime  approvers with pending leave; HR for requests stuck
//                                           with a manager longer than escalateAfterDays
//   leaveTomorrow     approvalReminderTime  employee + manager, the day before approved leave

import { withClient, withOrg } from './db.js'
import { addDays, dateInTz, isWeeklyOff } from './dates.js'
import { loadSettings, shiftsFor } from './context.js'
import { workedMinutes, zonedDateTime } from './shifts.js'
import { dispatch, hrApproverIds } from './notify.js'

const REMINDER_WINDOW_MS = 4 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const fmtClock = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
const fmtHours = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** When an open check-in should be closed automatically, or null if not (yet).
 *  A check-in made after that day's cut-off is left for a manager to fix. */
export function autoCheckOutAt(workDate, checkInAt, time, tz, now) {
  const cutoff = zonedDateTime(workDate, time, tz)
  return now >= cutoff && checkInAt < cutoff ? cutoff : null
}

export async function runHrReminders(now = new Date()) {
  const { rows: orgs } = await withClient(c => c.query(
    `SELECT org_id FROM hr_settings UNION SELECT org_id FROM hr_shifts
      UNION SELECT org_id FROM hr_leave_requests WHERE status IN ('pending_manager', 'pending_hr', 'approved')
      UNION SELECT org_id FROM hr_attendance WHERE check_in_at IS NOT NULL AND check_out_at IS NULL`))
  let sent = 0
  for (const { org_id: orgId } of orgs) {
    const queued = await withOrg(orgId, async (client) => {
      const settings = await loadSettings(client, orgId)
      const n = settings.notifications
      const tz = settings.timezone
      const today = dateInTz(now, tz)
      const due = (time) => {
        const at = zonedDateTime(today, time, tz)
        return now >= at && now - at <= REMINDER_WINDOW_MS
      }
      // true the first time today for this person + kind
      const once = async (userId, kind) => (await client.query(
        `INSERT INTO hr_reminders_sent (org_id, user_id, work_date, kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING user_id`, [orgId, userId, today, kind])).rows.length > 0
      const ctx = { client, orgId, settings, n, tz, today, now, once }

      const out = []
      if (n.events.missedCheckIn && due(n.reminderTime) && !isWeeklyOff(today, settings.weeklyOffs)) out.push(...await missedCheckIn(ctx))
      if (n.events.checkOutReminder && due(n.checkOutReminderTime)) out.push(...await checkOutReminder(ctx))
      if (n.events.autoCheckOut) out.push(...await autoCheckOut(ctx))
      if (n.events.approvalReminder && due(n.approvalReminderTime)) out.push(...await approvalReminders(ctx))
      if (n.events.leaveTomorrow && due(n.approvalReminderTime)) out.push(...await leaveTomorrow(ctx))
      return out
    })
    sent += queued.length
    await dispatch(orgId, queued)
  }
  return sent
}

async function missedCheckIn({ client, orgId, n, today, once }) {
  const { rows: people } = await client.query(
    `SELECT u.id, p.location_id FROM users u LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
      WHERE u.org_id = $1 AND u.role <> 'superadmin'`, [orgId])
  const shifts = await shiftsFor(client, orgId, people.map(p => p.id))
  const { rows: present } = await client.query(
    `SELECT user_id FROM hr_attendance WHERE org_id = $1 AND work_date = $2`, [orgId, today])
  const { rows: onLeave } = await client.query(
    `SELECT user_id FROM hr_leave_requests WHERE org_id = $1 AND status = 'approved'
        AND $2 BETWEEN start_date AND end_date`, [orgId, today])
  const { rows: holidays } = await client.query(
    `SELECT location_id FROM hr_holidays WHERE org_id = $1 AND holiday_date = $2`, [orgId, today])
  if (holidays.some(h => !h.location_id)) return []
  const skip = new Set([...present, ...onLeave].map(r => r.user_id))
  const holidayAt = new Set(holidays.map(h => h.location_id).filter(Boolean))

  const out = []
  for (const p of people) {
    if (!shifts.has(p.id) || skip.has(p.id) || holidayAt.has(p.location_id)) continue
    if (await once(p.id, 'missed_check_in')) {
      out.push({
        event: 'missedCheckIn', userIds: [p.id],
        title: 'You have not checked in today', attendance: 'checkin',
        body: `It's past ${fmtClock(n.reminderTime)}. Open HR Management to check in, or apply for leave if you're off.`,
      })
    }
  }
  return out
}

async function checkOutReminder({ client, orgId, n, today, once }) {
  const { rows } = await client.query(
    `SELECT user_id FROM hr_attendance
      WHERE org_id = $1 AND work_date = $2 AND check_in_at IS NOT NULL AND check_out_at IS NULL`, [orgId, today])
  const out = []
  for (const r of rows) {
    if (await once(r.user_id, 'check_out')) {
      out.push({
        event: 'checkOutReminder', userIds: [r.user_id],
        title: 'You are still checked in', attendance: 'checkout',
        body: `Remember to check out when you finish. If you don't, you'll be checked out automatically at ${fmtClock(n.autoCheckOutTime)} and your manager will review the day.`,
      })
    }
  }
  return out
}

async function autoCheckOut({ client, orgId, n, tz, today, now }) {
  // A week back covers a server that was down overnight; older rows are a manager's job.
  const { rows } = await client.query(
    `SELECT id, user_id, work_date::text AS work_date, check_in_at, status, source FROM hr_attendance
      WHERE org_id = $1 AND check_in_at IS NOT NULL AND check_out_at IS NULL AND work_date BETWEEN $2 AND $3
      FOR UPDATE SKIP LOCKED`, [orgId, addDays(today, -7), today])
  const closing = rows.map(r => ({ ...r, at: autoCheckOutAt(r.work_date, r.check_in_at, n.autoCheckOutTime, tz, now) })).filter(r => r.at)
  if (!closing.length) return []
  const shifts = await shiftsFor(client, orgId, closing.map(r => r.user_id))
  const out = []
  for (const r of closing) {
    const shift = shifts.get(r.user_id) ?? null
    const worked = workedMinutes(r.check_in_at, r.at)
    // Same rule as a normal check-out: a short self-recorded day becomes a half day.
    const short = !!shift && r.source === 'self' && ['present', 'on_field'].includes(r.status) && worked < shift.min_full_day_minutes
    const { rowCount } = await client.query(
      `UPDATE hr_attendance SET check_out_at = $1, worked_minutes = $2,
         status = CASE WHEN $3::boolean THEN 'half_day' ELSE status END,
         flag_reasons = ARRAY(SELECT DISTINCT unnest(flag_reasons || ARRAY['auto_check_out'])),
         reviewed_by = NULL, reviewed_at = NULL, shift_id = COALESCE(shift_id, $4), updated_at = now()
       WHERE id = $5 AND check_out_at IS NULL`, [r.at, worked, short, shift?.id ?? null, r.id])
    if (!rowCount) continue
    out.push({
      event: 'autoCheckOut', userIds: [r.user_id],
      title: `Checked out automatically at ${fmtClock(n.autoCheckOutTime)}`,
      body: `You didn't check out on ${fmtDay(r.work_date)}. Recorded ${fmtHours(worked)}${short ? ' (a half day)' : ''}; `
        + 'your manager will review it — ask them to correct the time if it is wrong.',
    })
  }
  return out
}

async function approvalReminders({ client, orgId, n, now, once }) {
  const { rows: pending } = await client.query(
    `SELECT r.user_id, r.status, r.created_at, u.name AS user_name,
            COALESCE(u.manager_id, r.manager_id) AS manager_id, m.name AS manager_name
       FROM hr_leave_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users m ON m.id = COALESCE(u.manager_id, r.manager_id)
      WHERE r.org_id = $1 AND r.status IN ('pending_manager', 'pending_hr')
      ORDER BY r.created_at`, [orgId])
  if (!pending.length) return []
  const hr = await hrApproverIds(client, orgId)

  const waiting = new Map()   // approver → names
  for (const r of pending) {
    // No manager any more → HR (or an admin) has to pick it up.
    const approvers = r.status === 'pending_manager' && r.manager_id ? [r.manager_id] : hr
    for (const id of approvers) if (id !== r.user_id) waiting.set(id, [...(waiting.get(id) || []), r.user_name])
  }
  const out = []
  for (const [id, names] of waiting) {
    if (await once(id, 'approval_reminder')) {
      out.push({
        event: 'approvalReminder', userIds: [id],
        title: `${plural(names.length, 'leave request')} waiting for your approval`,
        body: `${names.join(', ')}. Open HR Management → Approvals.`,
      })
    }
  }

  const stale = pending.filter(r => r.status === 'pending_manager' && r.manager_id && now - r.created_at > n.escalateAfterDays * DAY_MS)
  if (stale.length) {
    for (const id of hr) {
      if (await once(id, 'approval_escalation')) {
        out.push({
          event: 'approvalReminder', userIds: [id],
          title: `${plural(stale.length, 'leave request')} waiting on a manager for over ${plural(n.escalateAfterDays, 'day')}`,
          body: `${stale.map(r => `${r.user_name} (with ${r.manager_name})`).join(', ')}. You can follow up, or an admin can decide it in Approvals.`,
        })
      }
    }
  }
  return out
}

async function leaveTomorrow({ client, orgId, today, once }) {
  const tomorrow = addDays(today, 1)
  const { rows } = await client.query(
    `SELECT r.user_id, u.name AS user_name, u.manager_id, t.name AS type_name,
            r.end_date::text AS end_date, r.day_portion
       FROM hr_leave_requests r
       JOIN users u ON u.id = r.user_id
       JOIN hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.org_id = $1 AND r.status = 'approved' AND r.start_date = $2`, [orgId, tomorrow])
  const out = []
  const team = new Map()   // manager → names
  for (const r of rows) {
    const span = r.end_date === tomorrow ? fmtDay(tomorrow) : `${fmtDay(tomorrow)} – ${fmtDay(r.end_date)}`
    const half = r.day_portion === 'full' ? '' : ` (${r.day_portion === 'first_half' ? 'first' : 'second'} half)`
    if (await once(r.user_id, 'leave_tomorrow')) {
      out.push({ event: 'leaveTomorrow', userIds: [r.user_id], title: 'Your leave starts tomorrow', body: `${r.type_name}, ${span}${half}.` })
    }
    if (r.manager_id) team.set(r.manager_id, [...(team.get(r.manager_id) || []), `${r.user_name}${half}`])
  }
  for (const [id, names] of team) {
    if (await once(id, 'team_leave_tomorrow')) {
      out.push({ event: 'leaveTomorrow', userIds: [id], title: `On leave tomorrow: ${names.length === 1 ? '1 person' : `${names.length} people`}`, body: `${names.join(', ')}.` })
    }
  }
  return out
}
