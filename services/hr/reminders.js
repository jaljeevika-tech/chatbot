// "You haven't checked in" reminders. Runs in the monolith (routes/hr.routes.js)
// because a scale-to-zero Cloud Run service has no timer. After each org's local
// reminder time, everyone on a shift with no attendance, leave, holiday or weekly off
// gets ONE reminder, recorded in hr_reminders_sent first so instances can't
// double-send; nothing goes out later than REMINDER_WINDOW (e.g. after a late deploy).

import { withClient, withOrg } from './db.js'
import { dateInTz, isWeeklyOff } from './dates.js'
import { loadSettings, shiftsFor } from './context.js'
import { zonedDateTime } from './shifts.js'
import { dispatch } from './notify.js'

const REMINDER_WINDOW_MS = 4 * 60 * 60_000
const fmtClock = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

export async function runMissedCheckinReminders(now = new Date()) {
  const { rows: orgs } = await withClient(c => c.query(`SELECT DISTINCT org_id FROM hr_shifts`))
  let sent = 0
  for (const { org_id: orgId } of orgs) {
    const queued = await withOrg(orgId, async (client) => {
      const settings = await loadSettings(client, orgId)
      const n = settings.notifications
      if (!n.events.missedCheckIn) return []
      const tz = settings.timezone
      const today = dateInTz(now, tz)
      if (isWeeklyOff(today, settings.weeklyOffs)) return []
      const due = zonedDateTime(today, n.reminderTime, tz)
      if (now < due || now - due > REMINDER_WINDOW_MS) return []

      const { rows: people } = await client.query(
        `SELECT u.id, p.location_id FROM users u LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
          WHERE u.org_id = $1 AND u.role <> 'superadmin' AND (COALESCE((to_jsonb(u) ->> 'active')::boolean, true) AND COALESCE((to_jsonb(u) ->> 'exit_date')::date > CURRENT_DATE, true))`, [orgId])
      const shifts = await shiftsFor(client, orgId, people.map(p => p.id))
      const { rows: present } = await client.query(
        `SELECT user_id FROM hr_attendance WHERE org_id = $1 AND work_date = $2`, [orgId, today])
      const { rows: onLeave } = await client.query(
        `SELECT user_id FROM hr_leave_requests WHERE org_id = $1 AND status = 'approved'
            AND $2 BETWEEN start_date AND end_date`, [orgId, today])
      const { rows: holidays } = await client.query(
        `SELECT location_id FROM hr_holidays WHERE org_id = $1 AND holiday_date = $2`, [orgId, today])
      const skip = new Set([...present, ...onLeave].map(r => r.user_id))
      if (holidays.some(h => !h.location_id)) return []
      const holidayAt = new Set(holidays.map(h => h.location_id).filter(Boolean))

      const out = []
      for (const p of people) {
        if (!shifts.has(p.id) || skip.has(p.id) || holidayAt.has(p.location_id)) continue
        const { rows: [fresh] } = await client.query(
          `INSERT INTO hr_reminders_sent (org_id, user_id, work_date, kind) VALUES ($1, $2, $3, 'missed_check_in')
           ON CONFLICT DO NOTHING RETURNING user_id`, [orgId, p.id, today])
        if (fresh) {
          out.push({
            event: 'missedCheckIn', userIds: [p.id],
            title: 'You have not checked in today',
            body: `It's past ${fmtClock(n.reminderTime)}. Open HR Management to check in, or apply for leave if you're off.`,
          })
        }
      }
      return out
    })
    sent += queued.length
    await dispatch(orgId, queued)
  }
  return sent
}
