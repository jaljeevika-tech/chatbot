// services/hr/context.js — who is calling, org settings, permissions, and the
// row → JSON mappers shared by reads (router.js) and writes (actions.js).
//
// Dates leave Postgres as `col::text` ('YYYY-MM-DD'), never through pg's
// default DATE parser — that builds a local-midnight Date and shifts the day
// when serialised. NUMERIC arrives as a string and is Number()-ed here.

import { HttpError } from './db.js'
import { notifySettings } from './notify.js'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ADMIN_ROLES = new Set(['admin', 'superadmin'])

const ME_SQL = `
  SELECT u.id, u.name, u.manager_id, COALESCE(p.is_hr, false) AS is_hr, p.location_id,
         EXISTS (SELECT 1 FROM users r WHERE r.org_id = u.org_id AND r.manager_id = u.id) AS has_reports
    FROM users u
    LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
   WHERE u.org_id = $1`

/** Resolve the caller's users row. `role` comes from the verified Firebase
 *  token (the same source every monolith permission check uses). */
export async function loadMe(client, { orgId, uid, role, phone }) {
  let { rows } = await client.query(`${ME_SQL} AND u.firebase_uid = $2`, [orgId, uid])
  // Same fallback as POST /auth/login for rows whose firebase_uid isn't linked yet.
  const digits = String(phone || '').replace(/\D/g, '').slice(-10)
  if (!rows.length && digits.length === 10) {
    ({ rows } = await client.query(
      `${ME_SQL} AND right(regexp_replace(u.phone, '\\D', '', 'g'), 10) = $2 ORDER BY u.id LIMIT 1`,
      [orgId, digits]))
  }
  const u = rows[0]
  if (!u) return null
  return {
    id:         u.id,
    name:       u.name,
    role,
    managerId:  u.manager_id,
    locationId: u.location_id,
    isAdmin:    ADMIN_ROLES.has(role),
    isHr:       u.is_hr,
    isManager:  u.has_reports,
  }
}

export async function loadSettings(client, orgId) {
  const { rows } = await client.query(
    `SELECT gps_mode, weekly_offs, clock_skew_minutes, timezone, notifications FROM hr_settings WHERE org_id = $1`, [orgId])
  const r = rows[0]
  return {
    gpsMode:          r?.gps_mode ?? 'optional',
    weeklyOffs:       r?.weekly_offs ?? { 0: [1, 2, 3, 4, 5] },
    clockSkewMinutes: r?.clock_skew_minutes ?? 10,
    timezone:         r?.timezone ?? 'Asia/Kolkata',
    notifications:    notifySettings(r?.notifications),
  }
}

export const SHIFT_COLS = `s.id, s.name, s.start_time::text AS start_time, s.end_time::text AS end_time,
  s.required_minutes, s.grace_minutes, s.min_full_day_minutes, s.is_default`

export const mapShift = (s) => s && ({
  id: s.id, name: s.name, requiredMinutes: s.required_minutes,
  startTime: s.start_time?.slice(0, 5) ?? null, endTime: s.end_time?.slice(0, 5) ?? null,
  graceMinutes: s.grace_minutes, minFullDayMinutes: s.min_full_day_minutes, isDefault: s.is_default,
})

/** Shift in force for each user: their own → their location's → org default. */
export async function shiftsFor(client, orgId, userIds) {
  if (!userIds.length) return new Map()
  const { rows } = await client.query(
    `SELECT u.id AS user_id, ${SHIFT_COLS}
       FROM users u
       LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
       LEFT JOIN hr_locations l ON l.id = p.location_id
       JOIN hr_shifts s ON s.org_id = u.org_id
        AND s.id = COALESCE(p.shift_id, l.shift_id,
                            (SELECT d.id FROM hr_shifts d WHERE d.org_id = u.org_id AND d.is_default))
      WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])`, [orgId, userIds])
  return new Map(rows.map(r => [r.user_id, r]))
}

export async function loadEmployee(client, orgId, userId) {
  if (!UUID_RE.test(String(userId || ''))) return null
  const { rows } = await client.query(
    `SELECT u.id, u.name, u.role, u.manager_id, COALESCE(p.is_hr, false) AS is_hr, p.location_id
       FROM users u LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
      WHERE u.org_id = $1 AND u.id = $2`, [orgId, userId])
  return rows[0] ?? null
}

/** Managers act on their direct reports; HR and admins on everyone. */
export function canManage(me, employee) {
  return me.isAdmin || me.isHr || employee.manager_id === me.id
}

export function seesWholeOrg(me) {
  return me.isAdmin || me.isHr
}

export function requireAdmin(me) {
  if (!me.isAdmin) throw new HttpError(403, 'Only admins can change HR settings.')
}

/** People the caller can see on Team/Register/Reports. HR and admins can
 *  narrow to their own reports with scope='reports'. */
export async function loadTeam(client, orgId, me, scope = 'auto') {
  const all = seesWholeOrg(me) && scope !== 'reports'
  const { rows } = await client.query(
    `SELECT u.id, u.name, u.role, u.manager_id, COALESCE(p.is_hr, false) AS is_hr, p.location_id
       FROM users u LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
      WHERE u.org_id = $1 AND u.role <> 'superadmin'
        AND ($2::boolean OR u.manager_id = $3)
      ORDER BY u.name`, [orgId, all, me.id])
  return rows
}

export const mapTeamMember = (r) => ({
  id: r.id, name: r.name, role: r.role, managerId: r.manager_id, isHr: r.is_hr, locationId: r.location_id,
})

/** Holiday dates that apply to someone at `locationId` (org-wide + their location). */
export async function holidaySet(client, orgId, locationId, from, to) {
  const { rows } = await client.query(
    `SELECT holiday_date::text AS d FROM hr_holidays
      WHERE org_id = $1 AND holiday_date BETWEEN $2 AND $3
        AND (location_id IS NULL OR location_id = $4)`, [orgId, from, to, locationId ?? null])
  return new Set(rows.map(r => r.d))
}

export async function leaveBalances(client, orgId, userId, leaveYear) {
  const { rows } = await client.query(
    `SELECT t.id, t.name, t.annual_quota, t.allow_half_day, t.is_active,
            COALESCE(SUM(r.days) FILTER (WHERE r.status = 'approved'), 0) AS used,
            COALESCE(SUM(r.days) FILTER (WHERE r.status IN ('pending_manager', 'pending_hr')), 0) AS pending
       FROM hr_leave_types t
       LEFT JOIN hr_leave_requests r
              ON r.leave_type_id = t.id AND r.user_id = $2 AND r.leave_year = $3
      WHERE t.org_id = $1
      GROUP BY t.id
      ORDER BY t.name`, [orgId, userId, leaveYear])
  return rows
    // A deactivated type still shows while it has days booked this year.
    .filter(r => r.is_active || Number(r.used) + Number(r.pending) > 0)
    .map(r => {
      const quota = Number(r.annual_quota), used = Number(r.used), pending = Number(r.pending)
      return {
        leaveTypeId: r.id, name: r.name, quota, used, pending,
        available: quota - used - pending, allowHalfDay: r.allow_half_day, isActive: r.is_active,
      }
    })
}

// ── Attendance rows ──────────────────────────────────────────────────────────
export const ATT_COLS = `
  a.id, a.user_id, a.work_date::text AS work_date, a.status, a.source,
  a.check_in_at, a.check_in_device_at, a.check_in_lat, a.check_in_lng, a.check_in_accuracy_m,
  a.check_in_location_status, a.check_in_offline, a.check_in_clock_skew_s,
  a.check_out_at, a.check_out_device_at, a.check_out_lat, a.check_out_lng, a.check_out_accuracy_m,
  a.check_out_location_status, a.check_out_offline, a.check_out_clock_skew_s,
  a.flag_reasons, a.reviewed_by, a.reviewed_at, a.marked_by, a.note, a.updated_at,
  a.shift_id, a.late_minutes, a.early_leave_minutes, a.worked_minutes`

const num = (v) => (v == null ? null : Number(v))

export const mapAttendance = (r) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? undefined,
  workDate: r.work_date, status: r.status, source: r.source,
  checkInAt: r.check_in_at, checkInDeviceAt: r.check_in_device_at,
  checkInLat: num(r.check_in_lat), checkInLng: num(r.check_in_lng), checkInAccuracyM: num(r.check_in_accuracy_m),
  checkInLocationStatus: r.check_in_location_status, checkInOffline: r.check_in_offline,
  checkInClockSkewS: r.check_in_clock_skew_s,
  checkOutAt: r.check_out_at, checkOutDeviceAt: r.check_out_device_at,
  checkOutLat: num(r.check_out_lat), checkOutLng: num(r.check_out_lng), checkOutAccuracyM: num(r.check_out_accuracy_m),
  checkOutLocationStatus: r.check_out_location_status, checkOutOffline: r.check_out_offline,
  checkOutClockSkewS: r.check_out_clock_skew_s,
  flagReasons: r.flag_reasons ?? [], reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
  markedBy: r.marked_by, note: r.note, updatedAt: r.updated_at,
  shiftId: r.shift_id ?? null, lateMinutes: r.late_minutes ?? null,
  earlyLeaveMinutes: r.early_leave_minutes ?? null, workedMinutes: r.worked_minutes ?? null,
})

// ── Leave requests ───────────────────────────────────────────────────────────
export const LEAVE_SELECT = `
  SELECT r.id, r.user_id, u.name AS user_name, r.leave_type_id, t.name AS leave_type_name,
         r.start_date::text AS start_date, r.end_date::text AS end_date, r.day_portion, r.days,
         r.leave_year, r.reason, r.status, r.manager_id, m.name AS manager_name,
         r.manager_action_at, r.manager_comment, r.hr_action_at, r.hr_comment,
         r.submitted_offline, r.created_at
    FROM hr_leave_requests r
    JOIN users u          ON u.id = r.user_id
    JOIN hr_leave_types t ON t.id = r.leave_type_id
    LEFT JOIN users m     ON m.id = r.manager_id`

export const mapLeave = (r) => ({
  id: r.id, userId: r.user_id, userName: r.user_name, leaveTypeId: r.leave_type_id,
  leaveTypeName: r.leave_type_name, startDate: r.start_date, endDate: r.end_date,
  dayPortion: r.day_portion, days: Number(r.days), leaveYear: r.leave_year, reason: r.reason,
  status: r.status, managerId: r.manager_id, managerName: r.manager_name,
  managerActionAt: r.manager_action_at, managerComment: r.manager_comment,
  hrActionAt: r.hr_action_at, hrComment: r.hr_comment,
  submittedOffline: r.submitted_offline, createdAt: r.created_at,
})

export async function fetchLeave(client, orgId, id) {
  const { rows } = await client.query(`${LEAVE_SELECT} WHERE r.org_id = $1 AND r.id = $2`, [orgId, id])
  return rows[0] ? mapLeave(rows[0]) : null
}

/** Requests waiting on the caller: first level for their reports (or any,
 *  for admins — who can override), second level for HR users and admins. */
export async function pendingForMe(client, orgId, me) {
  const { rows } = await client.query(
    `${LEAVE_SELECT}
      WHERE r.org_id = $1 AND r.user_id <> $2
        AND (   (r.status = 'pending_manager' AND (u.manager_id = $2 OR r.manager_id = $2 OR $3::boolean))
             OR (r.status = 'pending_hr' AND $4::boolean))
      ORDER BY r.created_at`, [orgId, me.id, me.isAdmin, me.isHr || me.isAdmin])
  return rows.map(mapLeave)
}
