// Every /api/hr/* route. Mounted by the Cloud Run service (services/hr/index.js,
// identity from monolith-set headers) or in-process by routes/hr.routes.js when
// HR_SERVICE_URL is unset or down; both set req.hrIdent = { orgId, uid, role, phone }.
//
// GET  /hr/bootstrap                everything the HR tab caches for offline use
// POST /hr/sync                     apply queued attendance/leave actions (sync.js)
// GET  /hr/attendance               ?userId&from&to — one person's history
// GET  /hr/attendance/flagged       unreviewed flagged entries for my team
// GET  /hr/attendance/:id/corrections
// GET  /hr/register                 ?date&scope — team register for one day
// GET  /hr/leave/requests           ?scope=mine|team&status&year
// GET  /hr/leave/balances           ?userId&year
// GET  /hr/reports/monthly          ?month=YYYY-MM&scope&userId
// GET  /hr/timesheet                ?from&to&scope=me|reports|all&userId — daily hours from check-in/out
// GET  /hr/org-chart                everyone; today's status only for managers/HR/admins
// GET  /hr/employees                (HR/admin) users + HR profile
// PUT  /hr/employees/:userId        (admin) { isHr, locationId, managerId, shiftId, email }
// PUT  /hr/employees/managers       (admin) { assignments: [{ userId, managerId }] } — bulk import
// PUT  /hr/settings                 (admin) { gpsMode, weeklyOffs, clockSkewMinutes, notifications }
// POST /hr/notifications/test       (admin) send a test message to yourself
// POST /hr/shifts, PUT|DELETE /hr/shifts/:id             (admin)
// POST /hr/leave-types, PUT /hr/leave-types/:id          (admin)
// POST /hr/locations, PUT|DELETE /hr/locations/:id       (admin) { name, shiftId }
// POST /hr/holidays,    DELETE /hr/holidays/:id          (admin) { date, name, locationIds[] }

import { Router } from 'express'
import { HttpError, withOrg } from './db.js'
import {
  addDays, dateInTz, eachDate, isValidDate, isWeeklyOff, leaveYearOf, leaveYearRange, validateWeeklyOffs,
} from './dates.js'
import {
  ATT_COLS, LEAVE_SELECT, SHIFT_COLS, UUID_RE, canManage, leaveBalances, loadEmployee, loadMe, loadSettings,
  loadTeam, mapAttendance, mapLeave, mapShift, mapTeamMember, pendingForMe, requireAdmin, seesWholeOrg, shiftsFor,
} from './context.js'
import { processSync } from './sync.js'
import { EVENTS, dispatch, emailConfigured, notifySettings } from './notify.js'
import { TIME_RE, requiredMinutes, shiftLengthMinutes } from './shifts.js'

const handle = (fn) => async (req, res) => {
  try {
    res.json(await withOrg(req.hr.orgId, (client) => fn(client, req)))
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message })
    if (e?.code === '23505') return res.status(409).json({ error: 'That already exists.' })
    if (isMissingTable(e)) {
      console.error(`[hr] not set up — ${req.method} ${req.originalUrl}: ${e.code} ${e.message}`)
      return res.status(503).json({ error: NOT_SET_UP })
    }
    console.error(`[hr] ${req.method} ${req.originalUrl}:`, e)
    res.status(500).json({ error: 'HR service error' })
  }
}

// 42P01 undefined_table / 42703 undefined_column: code deployed ahead of its
// migration (078 / 080).
const NOT_SET_UP = "HR Management isn't fully set up on the server yet (an HR database migration hasn't been run). Ask your admin."
const isMissingTable = (e) => e?.code === '42P01' || e?.code === '42703'

const LEAVE_STATUSES = new Set(['pending_manager', 'pending_hr', 'approved', 'rejected', 'cancelled'])

const requireUuid = (v, what) => {
  if (!UUID_RE.test(String(v || ''))) throw new HttpError(422, `Invalid ${what}.`)
  return v
}

/** Narrow a team list to one person (?userId) — only someone already in it. */
function filterTo(team, userId) {
  if (!userId) return team
  requireUuid(userId, 'employee')
  const one = team.filter(u => u.id === userId)
  if (!one.length) throw new HttpError(403, "You can't view this employee.")
  return one
}

/** Resolve a ?from/?to window, capped so one call can't scan years of rows. */
function dateWindow(q, defaultDays, maxDays, today) {
  const to = isValidDate(q.to) ? q.to : today
  const from = isValidDate(q.from) ? q.from : addDays(to, -defaultDays)
  if (from > to) throw new HttpError(422, '"from" is after "to".')
  if (addDays(from, maxDays) < to) throw new HttpError(422, `Pick a range of at most ${maxDays} days.`)
  return { from, to }
}

async function holidaysByLocation(client, orgId, from, to) {
  const { rows } = await client.query(
    `SELECT holiday_date::text AS d, name, location_id FROM hr_holidays
      WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3`, [orgId, from, to])
  return (locationId) => {
    const map = new Map()
    for (const r of rows) if (!r.location_id || r.location_id === locationId) map.set(r.d, r.name)
    return map
  }
}

export function createHrRouter() {
  const router = Router()

  // Resolve the caller once per request; route handlers read req.hr.
  router.use('/hr', async (req, res, next) => {
    const ident = req.hrIdent
    if (!ident?.orgId || !ident?.uid) return res.status(401).json({ error: 'Missing caller identity' })
    try {
      const { me, settings } = await withOrg(ident.orgId, async (client) => ({
        me: await loadMe(client, ident),
        settings: await loadSettings(client, ident.orgId),
      }))
      if (!me) {
        return res.status(403).json({ error: "Your login isn't linked to an employee record in this organisation." })
      }
      req.hr = { orgId: ident.orgId, me, settings, today: dateInTz(new Date(), settings.timezone) }
      next()
    } catch (e) {
      console.error('[hr] identity lookup failed:', e)
      if (isMissingTable(e)) return res.status(503).json({ error: NOT_SET_UP })
      res.status(500).json({ error: 'HR service error' })
    }
  })

  // ── Bootstrap: the offline cache ───────────────────────────────────────────
  router.get('/hr/bootstrap', handle(async (client, req) => {
    const { orgId, me, settings, today } = req.hr
    const year = leaveYearOf(today)
    const [leaveTypes, locations, holidays, balances, attendance, leaveRequests, team, approvals, shifts, myShift] = await Promise.all([
      client.query(`SELECT id, name, annual_quota, allow_half_day, is_active FROM hr_leave_types
                     WHERE org_id = $1 ORDER BY name`, [orgId]),
      client.query(`SELECT id, name, shift_id FROM hr_locations WHERE org_id = $1 ORDER BY name`, [orgId]),
      client.query(`SELECT id, holiday_date::text AS date, name, location_id FROM hr_holidays
                     WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3 ORDER BY holiday_date`,
                   [orgId, leaveYearRange(year - 1).from, leaveYearRange(year + 1).to]),
      leaveBalances(client, orgId, me.id, year),
      client.query(`SELECT ${ATT_COLS} FROM hr_attendance a WHERE a.org_id = $1 AND a.user_id = $2
                     AND a.work_date >= $3 ORDER BY a.work_date DESC`, [orgId, me.id, addDays(today, -62)]),
      client.query(`${LEAVE_SELECT} WHERE r.org_id = $1 AND r.user_id = $2 AND r.leave_year >= $3
                     ORDER BY r.start_date DESC LIMIT 200`, [orgId, me.id, year - 1]),
      me.isManager || seesWholeOrg(me) ? loadTeam(client, orgId, me) : [],
      pendingForMe(client, orgId, me),
      client.query(`SELECT ${SHIFT_COLS} FROM hr_shifts s WHERE s.org_id = $1 ORDER BY s.start_time, s.name`, [orgId]),
      shiftsFor(client, orgId, [me.id]),
    ])
    // Notification setup (template name etc.) is admin business.
    const { notifications, ...publicSettings } = settings
    return {
      serverTime: new Date().toISOString(),
      today,
      leaveYear: year,
      me,
      settings: me.isAdmin ? { ...settings, emailConfigured: emailConfigured() } : publicSettings,
      shifts: shifts.rows.map(mapShift),
      myShift: mapShift(myShift.get(me.id)) ?? null,
      leaveTypes: leaveTypes.rows.map(t => ({
        id: t.id, name: t.name, annualQuota: Number(t.annual_quota), allowHalfDay: t.allow_half_day, isActive: t.is_active,
      })),
      locations: locations.rows.map(l => ({ id: l.id, name: l.name, shiftId: l.shift_id })),
      holidays: holidays.rows.map(h => ({ id: h.id, date: h.date, name: h.name, locationId: h.location_id })),
      balances,
      attendance: attendance.rows.map(mapAttendance),
      leaveRequests: leaveRequests.rows.map(mapLeave),
      team: team.map(mapTeamMember),
      approvals,
    }
  }))

  // Not wrapped in handle(): each action opens its own transaction.
  router.post('/hr/sync', async (req, res) => {
    try {
      res.json(await processSync(req.hr.orgId, req.hr.me, req.body))
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message })
      console.error('[hr] sync failed:', e)
      res.status(500).json({ error: 'HR service error' })
    }
  })

  // ── Attendance reads ───────────────────────────────────────────────────────
  router.get('/hr/attendance', handle(async (client, req) => {
    const { orgId, me, today } = req.hr
    const userId = req.query.userId ? requireUuid(req.query.userId, 'employee') : me.id
    if (userId !== me.id) {
      const emp = await loadEmployee(client, orgId, userId)
      if (!emp || !canManage(me, emp)) throw new HttpError(403, "You can't view this employee's attendance.")
    }
    const { from, to } = dateWindow(req.query, 31, 366, today)
    const { rows } = await client.query(
      `SELECT ${ATT_COLS} FROM hr_attendance a WHERE a.org_id = $1 AND a.user_id = $2
         AND a.work_date BETWEEN $3 AND $4 ORDER BY a.work_date DESC`, [orgId, userId, from, to])
    return { from, to, attendance: rows.map(mapAttendance) }
  }))

  router.get('/hr/attendance/flagged', handle(async (client, req) => {
    const { orgId, me, today } = req.hr
    const team = (await loadTeam(client, orgId, me)).filter(u => u.id !== me.id || me.isAdmin)
    if (!team.length) return { attendance: [] }
    const { rows } = await client.query(
      `SELECT ${ATT_COLS}, u.name AS user_name FROM hr_attendance a JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1 AND a.user_id = ANY($2::uuid[]) AND cardinality(a.flag_reasons) > 0
          AND a.reviewed_at IS NULL AND a.work_date >= $3
        ORDER BY a.work_date DESC LIMIT 300`, [orgId, team.map(u => u.id), addDays(today, -60)])
    return { attendance: rows.map(mapAttendance) }
  }))

  router.get('/hr/attendance/:id/corrections', handle(async (client, req) => {
    const { orgId, me } = req.hr
    const id = requireUuid(req.params.id, 'attendance record')
    const { rows: [att] } = await client.query(
      `SELECT a.user_id, u.manager_id FROM hr_attendance a JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1 AND a.id = $2`, [orgId, id])
    if (!att) throw new HttpError(404, 'Attendance record not found.')
    if (att.user_id !== me.id && !canManage(me, att)) throw new HttpError(403, "You can't view this record.")
    const { rows } = await client.query(
      `SELECT c.id, c.reason, c.before, c.after, c.created_at, u.name AS changed_by_name
         FROM hr_attendance_corrections c LEFT JOIN users u ON u.id = c.changed_by
        WHERE c.org_id = $1 AND c.attendance_id = $2 ORDER BY c.created_at DESC`, [orgId, id])
    return {
      corrections: rows.map(r => ({
        id: r.id, reason: r.reason, before: r.before, after: r.after, createdAt: r.created_at, changedByName: r.changed_by_name,
      })),
    }
  }))

  router.get('/hr/register', handle(async (client, req) => {
    const { orgId, me, settings, today } = req.hr
    const date = isValidDate(req.query.date) ? req.query.date : today
    const team = (await loadTeam(client, orgId, me, req.query.scope)).filter(u => u.id !== me.id || me.isAdmin)
    if (!team.length) return { date, rows: [] }
    const ids = team.map(u => u.id)
    const [att, leave, holidaysFor] = await Promise.all([
      client.query(`SELECT ${ATT_COLS} FROM hr_attendance a WHERE a.org_id = $1 AND a.work_date = $2
                     AND a.user_id = ANY($3::uuid[])`, [orgId, date, ids]),
      client.query(`SELECT r.user_id, r.day_portion, t.name FROM hr_leave_requests r
                      JOIN hr_leave_types t ON t.id = r.leave_type_id
                     WHERE r.org_id = $1 AND r.status = 'approved' AND $2 BETWEEN r.start_date AND r.end_date
                       AND r.user_id = ANY($3::uuid[])`, [orgId, date, ids]),
      holidaysByLocation(client, orgId, date, date),
    ])
    const attBy = new Map(att.rows.map(r => [r.user_id, mapAttendance(r)]))
    const leaveBy = new Map(leave.rows.map(r => [r.user_id, { leaveTypeName: r.name, dayPortion: r.day_portion }]))
    const weeklyOff = isWeeklyOff(date, settings.weeklyOffs)
    return {
      date,
      rows: team.map(u => ({
        employee: mapTeamMember(u),
        attendance: attBy.get(u.id) ?? null,
        leave: leaveBy.get(u.id) ?? null,
        dayOff: weeklyOff ? 'Weekly off' : (holidaysFor(u.location_id).get(date) ?? null),
      })),
    }
  }))

  // ── Leave reads ────────────────────────────────────────────────────────────
  router.get('/hr/leave/requests', handle(async (client, req) => {
    const { orgId, me, today } = req.hr
    const scope = req.query.scope === 'team' ? 'team' : 'mine'
    const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : leaveYearOf(today)
    const status = LEAVE_STATUSES.has(req.query.status) ? req.query.status : null
    let userIds = [me.id]
    if (scope === 'team') userIds = (await loadTeam(client, orgId, me)).map(u => u.id)
    if (!userIds.length) return { leaveYear: year, requests: [] }
    const { rows } = await client.query(
      `${LEAVE_SELECT} WHERE r.org_id = $1 AND r.user_id = ANY($2::uuid[]) AND r.leave_year = $3
         AND ($4::text IS NULL OR r.status = $4) ORDER BY r.start_date DESC LIMIT 500`,
      [orgId, userIds, year, status])
    return { leaveYear: year, requests: rows.map(mapLeave) }
  }))

  router.get('/hr/leave/balances', handle(async (client, req) => {
    const { orgId, me, today } = req.hr
    const userId = req.query.userId ? requireUuid(req.query.userId, 'employee') : me.id
    if (userId !== me.id) {
      const emp = await loadEmployee(client, orgId, userId)
      if (!emp || !canManage(me, emp)) throw new HttpError(403, "You can't view this employee's balance.")
    }
    const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : leaveYearOf(today)
    return { leaveYear: year, balances: await leaveBalances(client, orgId, userId, year) }
  }))

  // ── Monthly summary (Reports sub-tab + CSV export) ──────────────────────────
  router.get('/hr/reports/monthly', handle(async (client, req) => {
    const { orgId, me, settings, today } = req.hr
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7)
    const first = `${month}-01`
    if (!isValidDate(first)) throw new HttpError(422, 'Invalid month.')
    const monthEnd = addDays(addDays(first, 32).slice(0, 8) + '01', -1)
    const last = monthEnd < today ? monthEnd : today
    const team = filterTo(await loadTeam(client, orgId, me, req.query.scope), req.query.userId)
    if (!team.length || first > today) return { month, rows: [] }
    const ids = team.map(u => u.id)
    const [att, leave, holidaysFor] = await Promise.all([
      client.query(`SELECT a.user_id, a.work_date::text AS work_date, a.status, a.flag_reasons, a.reviewed_at
                      FROM hr_attendance a WHERE a.org_id = $1 AND a.user_id = ANY($2::uuid[])
                       AND a.work_date BETWEEN $3 AND $4`, [orgId, ids, first, last]),
      client.query(`SELECT user_id, start_date::text AS start_date, end_date::text AS end_date, day_portion
                      FROM hr_leave_requests WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'approved'
                       AND start_date <= $4 AND end_date >= $3`, [orgId, ids, first, last]),
      holidaysByLocation(client, orgId, first, last),
    ])
    const attBy = new Map(att.rows.map(r => [`${r.user_id}|${r.work_date}`, r]))
    const dates = eachDate(first, last)
    const rows = team.map(u => {
      const holidays = holidaysFor(u.location_id)
      const leaves = leave.rows.filter(l => l.user_id === u.id)
      const s = { workingDays: 0, present: 0, onField: 0, halfDay: 0, absent: 0, leave: 0, unmarked: 0, flagged: 0 }
      for (const d of dates) {
        const a = attBy.get(`${u.id}|${d}`)
        if (a?.flag_reasons?.length && !a.reviewed_at) s.flagged++
        if (isWeeklyOff(d, settings.weeklyOffs) || holidays.has(d)) continue
        s.workingDays++
        const onLeave = leaves.find(l => d >= l.start_date && d <= l.end_date)
        if (a) {
          if (a.status === 'present') s.present++
          else if (a.status === 'on_field') s.onField++
          else if (a.status === 'half_day') s.halfDay++
          else s.absent++
          if (onLeave && onLeave.day_portion !== 'full') s.leave += 0.5
        } else if (onLeave) {
          s.leave += onLeave.day_portion === 'full' ? 1 : 0.5
        } else {
          s.unmarked++
        }
      }
      return { userId: u.id, name: u.name, ...s }
    })
    return { month, from: first, to: last, rows }
  }))

  // ── Admin: employees, settings, leave types, locations, holidays ────────────
  router.get('/hr/employees', handle(async (client, req) => {
    const { orgId, me } = req.hr
    if (!seesWholeOrg(me)) throw new HttpError(403, 'Only HR and admins can view all employees.')
    const { rows } = await client.query(
      `SELECT u.id, u.name, u.role, u.phone, u.designation, u.manager_id, m.name AS manager_name,
              COALESCE(p.is_hr, false) AS is_hr, p.location_id, p.shift_id, p.email
         FROM users u
         LEFT JOIN users m ON m.id = u.manager_id
         LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
        WHERE u.org_id = $1
        ORDER BY u.name`, [orgId])
    return {
      employees: rows.map(r => ({
        ...mapTeamMember(r), managerName: r.manager_name, phone: r.phone, designation: r.designation,
        shiftId: r.shift_id, email: r.email,
      })),
    }
  }))

  /** Point users.manager_id at someone in the same org, refusing loops. */
  async function setManager(client, orgId, emp, managerId) {
    if (managerId) {
      requireUuid(managerId, 'manager')
      if (managerId === emp.id) throw new HttpError(422, `${emp.name} can't report to themselves.`)
      const mgr = await loadEmployee(client, orgId, managerId)
      if (!mgr) throw new HttpError(422, 'Unknown manager.')
      const { rows } = await client.query(
        `WITH RECURSIVE chain AS (
           SELECT id, manager_id FROM users WHERE org_id = $1 AND id = $2
           UNION
           SELECT u.id, u.manager_id FROM users u JOIN chain c ON u.id = c.manager_id WHERE u.org_id = $1)
         SELECT 1 FROM chain WHERE id = $3 LIMIT 1`, [orgId, managerId, emp.id])
      if (rows.length) {
        throw new HttpError(422, `${mgr.name} already reports (directly or through others) to ${emp.name} — that would make a loop.`)
      }
    }
    await client.query(`UPDATE users SET manager_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, emp.id, managerId || null])
  }

  async function requireOwn(client, table, orgId, id, what) {
    if (id === null) return null
    requireUuid(id, what)
    const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE org_id = $1 AND id = $2`, [orgId, id])
    if (!rows.length) throw new HttpError(422, `Unknown ${what}.`)
    return id
  }

  // Bulk reporting lines, e.g. imported from the User Management sheet.
  // Declared before /:userId so 'managers' isn't read as an id.
  router.put('/hr/employees/managers', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const list = Array.isArray(req.body?.assignments) ? req.body.assignments.slice(0, 2000) : []
    let updated = 0
    const skipped = []
    for (const a of list) {
      const emp = await loadEmployee(client, orgId, a?.userId)
      if (!emp) { skipped.push({ userId: a?.userId, reason: 'Employee not found.' }); continue }
      if ((a.managerId || null) === emp.manager_id) continue
      try {
        await client.query('SAVEPOINT one')
        await setManager(client, orgId, emp, a.managerId || null)
        await client.query('RELEASE SAVEPOINT one')
        updated++
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT one')
        if (!(e instanceof HttpError)) throw e
        skipped.push({ userId: emp.id, name: emp.name, reason: e.message })
      }
    }
    return { updated, skipped }
  }))

  router.put('/hr/employees/:userId', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const emp = await loadEmployee(client, orgId, requireUuid(req.params.userId, 'employee'))
    if (!emp) throw new HttpError(404, 'Employee not found.')
    const b = req.body ?? {}
    const { rows: [cur] } = await client.query(
      `SELECT shift_id, email FROM hr_employee_profiles WHERE user_id = $1`, [emp.id])
    const isHr = typeof b.isHr === 'boolean' ? b.isHr : emp.is_hr
    const locationId = b.locationId === undefined ? emp.location_id
      : await requireOwn(client, 'hr_locations', orgId, b.locationId || null, 'location')
    const shiftId = b.shiftId === undefined ? (cur?.shift_id ?? null)
      : await requireOwn(client, 'hr_shifts', orgId, b.shiftId || null, 'shift')
    let email = b.email === undefined ? (cur?.email ?? null) : String(b.email ?? '').trim().toLowerCase() || null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, 'That email address looks wrong.')
    if (email) email = email.slice(0, 200)
    if (b.managerId !== undefined && (b.managerId || null) !== emp.manager_id) {
      await setManager(client, orgId, emp, b.managerId || null)
    }
    await client.query(
      `INSERT INTO hr_employee_profiles (user_id, org_id, is_hr, location_id, shift_id, email)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET is_hr = $3, location_id = $4, shift_id = $5, email = $6, updated_at = now()`,
      [emp.id, orgId, isHr, locationId, shiftId, email])
    return { ok: true, employee: { id: emp.id, isHr, locationId, shiftId, email } }
  }))

  router.put('/hr/settings', handle(async (client, req) => {
    const { orgId, me, settings } = req.hr
    requireAdmin(me)
    const b = req.body ?? {}
    const gpsMode = b.gpsMode ?? settings.gpsMode
    const weeklyOffs = b.weeklyOffs ?? settings.weeklyOffs
    const clockSkewMinutes = b.clockSkewMinutes ?? settings.clockSkewMinutes
    if (!['required', 'optional', 'off'].includes(gpsMode)) throw new HttpError(422, 'Invalid GPS setting.')
    if (!validateWeeklyOffs(weeklyOffs)) throw new HttpError(422, 'Invalid weekly-off setting.')
    if (!Number.isInteger(clockSkewMinutes) || clockSkewMinutes < 1 || clockSkewMinutes > 240) {
      throw new HttpError(422, 'Clock tolerance must be between 1 and 240 minutes.')
    }
    const notifications = b.notifications === undefined ? settings.notifications : parseNotify(b.notifications, settings.notifications)
    await client.query(
      `INSERT INTO hr_settings (org_id, gps_mode, weekly_offs, clock_skew_minutes, notifications) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET gps_mode = $2, weekly_offs = $3, clock_skew_minutes = $4,
         notifications = $5, updated_at = now()`,
      [orgId, gpsMode, JSON.stringify(weeklyOffs), clockSkewMinutes, JSON.stringify(notifications)])
    return { settings: { ...settings, gpsMode, weeklyOffs, clockSkewMinutes, notifications, emailConfigured: emailConfigured() } }
  }))

  function parseNotify(raw, current) {
    const n = notifySettings({ ...current, ...raw, events: { ...current.events, ...(raw?.events || {}) } })
    for (const k of ['emailEnabled', 'whatsappEnabled']) {
      if (typeof n[k] !== 'boolean') throw new HttpError(422, `Invalid ${k}.`)
    }
    n.whatsappTemplate = String(n.whatsappTemplate ?? '').trim()
    if (!/^[a-z0-9_]{0,512}$/.test(n.whatsappTemplate)) {
      throw new HttpError(422, 'WhatsApp template names use lowercase letters, numbers and underscores only.')
    }
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(n.whatsappLang)) throw new HttpError(422, 'WhatsApp language looks like en or en_US.')
    for (const k of ['reminderTime', 'checkOutReminderTime', 'autoCheckOutTime', 'approvalReminderTime']) {
      if (!TIME_RE.test(n[k] || '')) throw new HttpError(422, 'Reminder times look like 11:00.')
    }
    n.escalateAfterDays = Number(n.escalateAfterDays)
    if (!Number.isInteger(n.escalateAfterDays) || n.escalateAfterDays < 1 || n.escalateAfterDays > 30) {
      throw new HttpError(422, 'Escalate after 1–30 days.')
    }
    delete n.reminderAfterMinutes
    n.events = Object.fromEntries(EVENTS.map(e => [e, n.events[e] !== false]))
    return n
  }

  // Not wrapped in handle(): the send happens after the lookup transaction closes.
  router.post('/hr/notifications/test', async (req, res) => {
    try {
      const { orgId, me } = req.hr
      requireAdmin(me)
      const hints = await withOrg(orgId, (client) => testHints(client, req.hr))
      const results = await dispatch(orgId, [{
        event: 'test', userIds: [me.id],
        title: 'Test message from HR Management', body: 'If you received this, HR notifications are working.',
      }], { force: true })
      res.json({ hints, results })
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message })
      console.error('[hr] notification test failed:', e)
      res.status(500).json({ error: 'HR service error' })
    }
  })

  async function testHints(client, { orgId, me, settings }) {
    const n = settings.notifications
    const { rows: [mine] } = await client.query(
      `SELECT u.phone, p.email FROM users u LEFT JOIN hr_employee_profiles p ON p.user_id = u.id WHERE u.id = $1`, [me.id])
    await client.query('SAVEPOINT wa')
    const wa = await client.query(`SELECT 1 FROM wa_config WHERE org_id = $1 AND enabled = true`, [orgId])
      .then(r => r.rows, async () => { await client.query('ROLLBACK TO SAVEPOINT wa'); return [] })
    const hints = []
    if (!n.emailEnabled) hints.push('Email is switched off in these settings.')
    else if (!emailConfigured()) hints.push('Email: the server has no SMTP_USER / SMTP_PASS — ask your developer to add them (same as Finance).')
    else if (!mine?.email) hints.push('Email: add your own email address under Employees first.')
    if (!n.whatsappEnabled) hints.push('WhatsApp is switched off in these settings.')
    else if (!n.whatsappTemplate) hints.push('WhatsApp: enter the approved template name.')
    else if (!wa.length) hints.push('WhatsApp: this organisation has no connected WhatsApp number (WhatsApp tab → settings).')
    if (n.whatsappEnabled && !mine?.phone) hints.push('WhatsApp: your user has no phone number.')
    return hints
  }

  const parseLeaveType = (b, current = {}) => {
    const name = b.name === undefined ? current.name : String(b.name).trim().slice(0, 60)
    const annualQuota = b.annualQuota === undefined ? Number(current.annual_quota) : Number(b.annualQuota)
    if (!name) throw new HttpError(422, 'Give the leave type a name.')
    if (!Number.isFinite(annualQuota) || annualQuota < 0 || annualQuota > 365 || (annualQuota * 2) % 1 !== 0) {
      throw new HttpError(422, 'Yearly quota must be between 0 and 365, in half days.')
    }
    return {
      name, annualQuota,
      allowHalfDay: typeof b.allowHalfDay === 'boolean' ? b.allowHalfDay : (current.allow_half_day ?? true),
      isActive: typeof b.isActive === 'boolean' ? b.isActive : (current.is_active ?? true),
    }
  }

  router.post('/hr/leave-types', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const t = parseLeaveType(req.body ?? {})
    const { rows: [row] } = await client.query(
      `INSERT INTO hr_leave_types (org_id, name, annual_quota, allow_half_day, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, t.name, t.annualQuota, t.allowHalfDay, t.isActive])
    return { leaveType: { id: row.id, ...t } }
  }))

  router.put('/hr/leave-types/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const id = requireUuid(req.params.id, 'leave type')
    const { rows: [current] } = await client.query(`SELECT * FROM hr_leave_types WHERE org_id = $1 AND id = $2`, [orgId, id])
    if (!current) throw new HttpError(404, 'Leave type not found.')
    const t = parseLeaveType(req.body ?? {}, current)
    await client.query(
      `UPDATE hr_leave_types SET name = $1, annual_quota = $2, allow_half_day = $3, is_active = $4 WHERE id = $5`,
      [t.name, t.annualQuota, t.allowHalfDay, t.isActive, id])
    return { leaveType: { id, ...t } }
  }))

  router.post('/hr/locations', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const name = String(req.body?.name ?? '').trim().slice(0, 80)
    if (!name) throw new HttpError(422, 'Give the location a name.')
    const shiftId = await requireOwn(client, 'hr_shifts', orgId, req.body?.shiftId || null, 'shift')
    const { rows: [row] } = await client.query(
      `INSERT INTO hr_locations (org_id, name, shift_id) VALUES ($1, $2, $3) RETURNING id, name, shift_id`, [orgId, name, shiftId])
    return { location: { id: row.id, name: row.name, shiftId: row.shift_id } }
  }))

  router.put('/hr/locations/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const id = requireUuid(req.params.id, 'location')
    const { rows: [cur] } = await client.query(`SELECT name, shift_id FROM hr_locations WHERE org_id = $1 AND id = $2`, [orgId, id])
    if (!cur) throw new HttpError(404, 'Location not found.')
    const name = req.body?.name === undefined ? cur.name : String(req.body.name).trim().slice(0, 80)
    if (!name) throw new HttpError(422, 'Give the location a name.')
    const shiftId = req.body?.shiftId === undefined ? cur.shift_id
      : await requireOwn(client, 'hr_shifts', orgId, req.body.shiftId || null, 'shift')
    await client.query(`UPDATE hr_locations SET name = $1, shift_id = $2 WHERE id = $3`, [name, shiftId, id])
    return { location: { id, name, shiftId } }
  }))

  router.delete('/hr/locations/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    await client.query(`DELETE FROM hr_locations WHERE org_id = $1 AND id = $2`,
      [orgId, requireUuid(req.params.id, 'location')])
    return { ok: true }
  }))

  router.post('/hr/holidays', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const { date } = req.body ?? {}
    const name = String(req.body?.name ?? '').trim().slice(0, 80)
    if (!isValidDate(date)) throw new HttpError(422, 'Pick a valid date.')
    if (!name) throw new HttpError(422, 'Give the holiday a name.')
    // One row per location (none = everyone), so per-location lookups stay simple.
    const raw = Array.isArray(req.body?.locationIds) ? req.body.locationIds : [req.body?.locationId]
    const locationIds = [...new Set(raw.filter(Boolean))]
    for (const id of locationIds) await requireOwn(client, 'hr_locations', orgId, id, 'location')
    const holidays = []
    for (const locationId of locationIds.length ? locationIds : [null]) {
      const { rows: [row] } = await client.query(
        `INSERT INTO hr_holidays (org_id, holiday_date, name, location_id) VALUES ($1, $2, $3, $4)
         RETURNING id, holiday_date::text AS date, name, location_id`, [orgId, date, name, locationId])
      holidays.push({ id: row.id, date: row.date, name: row.name, locationId: row.location_id })
    }
    return { holidays }
  }))

  router.delete('/hr/holidays/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    await client.query(`DELETE FROM hr_holidays WHERE org_id = $1 AND id = $2`,
      [orgId, requireUuid(req.params.id, 'holiday')])
    return { ok: true }
  }))

  // ── Shifts ─────────────────────────────────────────────────────────────────
  // A shift is "N hours a day"; start/end times are optional (office shifts),
  // set together, and only they enable late / early-leave marking.
  const parseShift = (b, cur = {}) => {
    const pick = (k, curVal) => (b[k] === undefined ? curVal : b[k] || null)
    const s = {
      name:              b.name === undefined ? cur.name : String(b.name).trim().slice(0, 60),
      requiredMinutes:   b.requiredMinutes ?? cur.required_minutes ?? 480,
      startTime:         pick('startTime', cur.start_time?.slice(0, 5) ?? null),
      endTime:           pick('endTime', cur.end_time?.slice(0, 5) ?? null),
      graceMinutes:      b.graceMinutes ?? cur.grace_minutes ?? 15,
      minFullDayMinutes: b.minFullDayMinutes ?? cur.min_full_day_minutes ?? 360,
      isDefault:         typeof b.isDefault === 'boolean' ? b.isDefault : (cur.is_default ?? false),
    }
    if (!s.name) throw new HttpError(422, 'Give the shift a name.')
    if (!Number.isInteger(s.requiredMinutes) || s.requiredMinutes < 30 || s.requiredMinutes > 1440) {
      throw new HttpError(422, 'Hours per day must be between 0.5 and 24.')
    }
    if (!s.startTime !== !s.endTime) throw new HttpError(422, 'Set both a start and an end time, or neither.')
    if (s.startTime) {
      if (!TIME_RE.test(s.startTime) || !TIME_RE.test(s.endTime)) throw new HttpError(422, 'Times look like 09:30.')
      if (s.startTime === s.endTime) throw new HttpError(422, 'Start and end time are the same.')
      const len = shiftLengthMinutes({ start_time: s.startTime, end_time: s.endTime })
      if (s.requiredMinutes > len) {
        throw new HttpError(422, `Hours per day can't be more than the ${Math.floor(len / 60)}h ${len % 60}m between start and end.`)
      }
    }
    if (!Number.isInteger(s.graceMinutes) || s.graceMinutes < 0 || s.graceMinutes > 240) {
      throw new HttpError(422, 'Grace period must be 0–240 minutes.')
    }
    if (!Number.isInteger(s.minFullDayMinutes) || s.minFullDayMinutes < 0 || s.minFullDayMinutes > s.requiredMinutes) {
      throw new HttpError(422, 'The full-day minimum must be between 0 and the hours per day.')
    }
    return s
  }

  async function saveShift(client, orgId, id, s) {
    if (s.isDefault) await client.query(`UPDATE hr_shifts SET is_default = false WHERE org_id = $1 AND id IS DISTINCT FROM $2`, [orgId, id])
    const vals = [s.name, s.startTime, s.endTime, s.graceMinutes, s.minFullDayMinutes, s.isDefault, s.requiredMinutes]
    const { rows: [row] } = id
      ? await client.query(
          `UPDATE hr_shifts s SET name = $1, start_time = $2, end_time = $3, grace_minutes = $4,
             min_full_day_minutes = $5, is_default = $6, required_minutes = $7
           WHERE s.org_id = $8 AND s.id = $9 RETURNING ${SHIFT_COLS}`,
          [...vals, orgId, id])
      : await client.query(
          `INSERT INTO hr_shifts AS s (name, start_time, end_time, grace_minutes, min_full_day_minutes, is_default,
             required_minutes, org_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SHIFT_COLS}`, [...vals, orgId])
    return { shift: mapShift(row) }
  }

  router.post('/hr/shifts', handle(async (client, req) => {
    requireAdmin(req.hr.me)
    return saveShift(client, req.hr.orgId, null, parseShift(req.body ?? {}))
  }))

  router.put('/hr/shifts/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    const id = requireUuid(req.params.id, 'shift')
    const { rows: [cur] } = await client.query(
      `SELECT name, start_time::text, end_time::text, required_minutes, grace_minutes, min_full_day_minutes, is_default
         FROM hr_shifts WHERE org_id = $1 AND id = $2`, [orgId, id])
    if (!cur) throw new HttpError(404, 'Shift not found.')
    return saveShift(client, orgId, id, parseShift(req.body ?? {}, cur))
  }))

  router.delete('/hr/shifts/:id', handle(async (client, req) => {
    const { orgId, me } = req.hr
    requireAdmin(me)
    await client.query(`DELETE FROM hr_shifts WHERE org_id = $1 AND id = $2`, [orgId, requireUuid(req.params.id, 'shift')])
    return { ok: true }
  }))

  // ── Timesheet: daily hours straight from check-in/out ───────────────────────
  router.get('/hr/timesheet', handle(async (client, req) => {
    const { orgId, me, settings, today } = req.hr
    const { from, to } = dateWindow(req.query, 6, 31, today)
    const leads = me.isManager || seesWholeOrg(me)
    const scope = req.query.scope === 'all' || req.query.scope === 'reports' ? req.query.scope : 'me'
    let people
    if (scope === 'me' || !leads) {
      const self = await loadEmployee(client, orgId, me.id)
      people = [self]
    } else {
      people = filterTo(await loadTeam(client, orgId, me, scope === 'all' ? 'auto' : 'reports'), req.query.userId)
    }
    const ids = people.map(p => p.id)
    const [att, leave, holidaysFor, shifts] = await Promise.all([
      client.query(`SELECT a.user_id, a.work_date::text AS work_date, a.status, a.check_in_at, a.check_out_at,
                           a.late_minutes, a.early_leave_minutes, a.worked_minutes
                      FROM hr_attendance a WHERE a.org_id = $1 AND a.user_id = ANY($2::uuid[])
                       AND a.work_date BETWEEN $3 AND $4`, [orgId, ids, from, to]),
      client.query(`SELECT r.user_id, r.start_date::text AS start_date, r.end_date::text AS end_date, r.day_portion, t.name
                      FROM hr_leave_requests r JOIN hr_leave_types t ON t.id = r.leave_type_id
                     WHERE r.org_id = $1 AND r.user_id = ANY($2::uuid[]) AND r.status = 'approved'
                       AND r.start_date <= $4 AND r.end_date >= $3`, [orgId, ids, from, to]),
      holidaysByLocation(client, orgId, from, to),
      shiftsFor(client, orgId, ids),
    ])
    const attBy = new Map(att.rows.map(r => [`${r.user_id}|${r.work_date}`, r]))
    const dates = eachDate(from, to)
    const rows = people.map(p => {
      const shift = shifts.get(p.id)
      const holidays = holidaysFor(p.location_id)
      const totals = { workedMinutes: 0, overtimeMinutes: 0, lateDays: 0, lateMinutes: 0, earlyDays: 0,
        present: 0, halfDay: 0, absent: 0, leave: 0, unmarked: 0 }
      const days = dates.map(d => {
        const a = attBy.get(`${p.id}|${d}`)
        const lv = leave.rows.find(l => l.user_id === p.id && d >= l.start_date && d <= l.end_date)
        const dayOff = isWeeklyOff(d, settings.weeklyOffs) ? 'Weekly off' : holidays.get(d) ?? null
        const worked = a?.worked_minutes ?? (a?.check_in_at && a?.check_out_at
          ? Math.max(0, Math.round((a.check_out_at - a.check_in_at) / 60_000)) : null)
        const overtime = shift && worked != null ? Math.max(0, worked - requiredMinutes(shift)) : 0
        if (worked) totals.workedMinutes += worked
        totals.overtimeMinutes += overtime
        if (a?.late_minutes) { totals.lateDays++; totals.lateMinutes += a.late_minutes }
        if (a?.early_leave_minutes) totals.earlyDays++
        if (a) {
          if (a.status === 'absent') totals.absent++
          else if (a.status === 'half_day') totals.halfDay++
          else totals.present++
        } else if (lv && !dayOff) totals.leave += lv.day_portion === 'full' ? 1 : 0.5
        else if (!dayOff && d <= today) totals.unmarked++
        return {
          date: d, status: a?.status ?? null, checkInAt: a?.check_in_at ?? null, checkOutAt: a?.check_out_at ?? null,
          workedMinutes: worked, lateMinutes: a?.late_minutes ?? null, earlyLeaveMinutes: a?.early_leave_minutes ?? null,
          overtimeMinutes: overtime,
          leave: lv ? { leaveTypeName: lv.name, dayPortion: lv.day_portion } : null,
          dayOff,
        }
      })
      return { userId: p.id, name: p.name, shift: mapShift(shift) ?? null, days, totals }
    })
    return { from, to, dates, rows }
  }))

  // ── Organisation chart ─────────────────────────────────────────────────────
  router.get('/hr/org-chart', handle(async (client, req) => {
    const { orgId, me, settings, today } = req.hr
    const { rows } = await client.query(
      `SELECT u.id, u.name, u.role, u.designation, u.manager_id, l.name AS location_name, COALESCE(p.is_hr, false) AS is_hr
         FROM users u
         LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
         LEFT JOIN hr_locations l ON l.id = p.location_id
        WHERE u.org_id = $1
        ORDER BY u.name`, [orgId])
    // Status dots: HR/admins for everyone, managers for their whole reporting tree.
    let visible = new Set()
    if (seesWholeOrg(me)) visible = new Set(rows.map(r => r.id))
    else if (me.isManager) {
      const kids = new Map()
      for (const r of rows) if (r.manager_id) kids.set(r.manager_id, [...(kids.get(r.manager_id) || []), r.id])
      const stack = [...(kids.get(me.id) || [])]
      while (stack.length) {
        const id = stack.pop()
        if (visible.has(id)) continue
        visible.add(id)
        stack.push(...(kids.get(id) || []))
      }
    }
    const status = new Map()
    if (visible.size) {
      const ids = [...visible]
      const [att, lv] = await Promise.all([
        client.query(`SELECT user_id, status, check_in_at, check_out_at FROM hr_attendance
                       WHERE org_id = $1 AND work_date = $2 AND user_id = ANY($3::uuid[])`, [orgId, today, ids]),
        client.query(`SELECT user_id FROM hr_leave_requests WHERE org_id = $1 AND status = 'approved'
                       AND $2 BETWEEN start_date AND end_date AND user_id = ANY($3::uuid[])`, [orgId, today, ids]),
      ])
      const off = isWeeklyOff(today, settings.weeklyOffs)
      for (const id of ids) status.set(id, off ? 'off' : 'none')
      for (const r of lv.rows) status.set(r.user_id, 'leave')
      for (const a of att.rows) {
        status.set(a.user_id, a.status === 'absent' ? 'absent' : a.check_out_at ? 'out' : a.check_in_at ? 'in' : 'marked')
      }
    }
    return {
      today,
      people: rows.map(r => ({
        id: r.id, name: r.name, role: r.role, designation: r.designation, managerId: r.manager_id,
        location: r.location_name, isHr: r.is_hr, status: status.get(r.id) ?? null,
      })),
    }
  }))

  return router
}
