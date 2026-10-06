// services/hr/actions.js — every attendance/leave write. Each runs inside the
// caller's transaction (sync.js) and throws HttpError for anything the user
// should be told about; sync.js turns that into a per-action rejection.
//
// `timing` describes when the action happened on the device:
//   createdAt — phone clock when the user tapped (may be hours old if offline)
//   skewMs    — server clock minus phone clock, measured when this batch was sent
//   serverNow — server clock now
//   offline   — the device queued it while it had no connection

import { HttpError } from './db.js'
import {
  addDays, countLeaveDays, dateInTz, isValidDate, leaveOverlaps, leaveYearOf,
} from './dates.js'
import {
  ATT_COLS, UUID_RE, canManage, fetchLeave, holidaySet, leaveBalances, loadEmployee, mapAttendance, shiftsFor,
} from './context.js'
import { earlyLeaveMinutes, hasTiming, lateMinutes, workedMinutes } from './shifts.js'
import { hrApproverIds } from './notify.js'

// ── Notification text ────────────────────────────────────────────────────────
// Actions push { event, userIds, title, body } onto ctx.notify; sync.js sends
// them after the transaction commits (services/hr/notify.js).
const fmtTime = (instant, tz) => new Date(instant).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
const fmtSpan = (a, b) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`)
const fmtHours = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
const ATT_WORD = { present: 'Present', on_field: 'On field', half_day: 'Half day', absent: 'Absent' }
const leaveLine = (r) => `${r.leaveTypeName}, ${fmtSpan(r.startDate, r.endDate)} (${r.days} day${r.days === 1 ? '' : 's'})`
const push = (ctx, msg) => { if (ctx.notify) ctx.notify.push(msg) }

const ATT_STATUSES = new Set(['present', 'on_field', 'half_day', 'absent'])
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000

function resolveTime(timing, settings) {
  const device = timing.createdAt
  let estimated = new Date(device.getTime() + timing.skewMs)
  const flags = []
  if (Math.abs(timing.skewMs) > settings.clockSkewMinutes * 60_000) flags.push('clock_mismatch')
  // Only possible if the phone clock moved between tapping and syncing.
  if (estimated > timing.serverNow) {
    estimated = timing.serverNow
    if (!flags.includes('clock_mismatch')) flags.push('clock_mismatch')
  }
  if (timing.serverNow - estimated > MAX_ENTRY_AGE_MS) {
    throw new HttpError(422, 'This entry is more than 7 days old. Ask your manager to mark attendance for that day instead.')
  }
  return {
    device, estimated, flags,
    offline: timing.offline || timing.serverNow - estimated > 5 * 60_000,
  }
}

function parseLocation(raw, gpsMode) {
  if (gpsMode === 'off') return { status: 'off', lat: null, lng: null, accuracy: null, flags: [] }
  let status = ['ok', 'denied', 'unavailable'].includes(raw?.status) ? raw.status : 'unavailable'
  let lat = null, lng = null, accuracy = null
  if (status === 'ok') {
    lat = Number(raw.lat); lng = Number(raw.lng)
    accuracy = raw.accuracy == null ? null : Number(raw.accuracy)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      status = 'unavailable'; lat = null; lng = null; accuracy = null
    }
  }
  // GPS never blocks a check-in — except a flat refusal when the org requires it.
  if (gpsMode === 'required' && status === 'denied') {
    throw new HttpError(422, 'Location access is required to check in. Allow location for this site and try again.')
  }
  const flags = gpsMode === 'required' && status !== 'ok' ? ['location_unavailable'] : []
  return { status, lat, lng, accuracy, flags }
}

// New flags re-open a row a manager already reviewed.
const MERGE_FLAGS = `
  flag_reasons = ARRAY(SELECT DISTINCT unnest(flag_reasons || $FLAGS::text[])),
  reviewed_by  = CASE WHEN cardinality($FLAGS::text[]) > 0 THEN NULL ELSE reviewed_by END,
  reviewed_at  = CASE WHEN cardinality($FLAGS::text[]) > 0 THEN NULL ELSE reviewed_at END`
const mergeFlags = (n) => MERGE_FLAGS.replaceAll('$FLAGS', `$${n}`)

// ── Attendance ───────────────────────────────────────────────────────────────

export async function checkIn(client, ctx, payload, timing) {
  const { orgId, me, settings } = ctx
  const t = resolveTime(timing, settings)
  const loc = parseLocation(payload.location, settings.gpsMode)
  const workDate = dateInTz(t.estimated, settings.timezone)
  let status = payload.mode === 'field' ? 'on_field' : 'present'
  const skewS = Math.round(timing.skewMs / 1000)
  let flags = [...t.flags, ...loc.flags]
  const shift = (await shiftsFor(client, orgId, [me.id])).get(me.id) ?? null
  // Late only means something for fixed-timing shifts; field shifts are hours-only.
  const late = hasTiming(shift) ? lateMinutes(t.estimated, shift, workDate, settings.timezone) : null

  const { rows } = await client.query(
    `SELECT id, status, check_in_at FROM hr_attendance
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3 FOR UPDATE`, [orgId, me.id, workDate])
  const existing = rows[0]
  if (existing?.check_in_at) throw new HttpError(409, `You have already checked in on ${workDate}.`)

  // Approved leave: a full day blocks check-in until the leave is cancelled;
  // a half day lets them work the other half, so the day counts as half_day.
  const { rows: [leave] } = await client.query(
    `SELECT day_portion FROM hr_leave_requests
      WHERE org_id = $1 AND user_id = $2 AND status = 'approved' AND $3 BETWEEN start_date AND end_date
      ORDER BY day_portion = 'full' DESC LIMIT 1`, [orgId, me.id, workDate])
  if (leave?.day_portion === 'full') {
    throw new HttpError(409, `You are on approved leave on ${fmtDay(workDate)}. Cancel the leave to mark attendance.`)
  }
  if (leave) status = 'half_day'

  const fields = [t.estimated, t.device, loc.lat, loc.lng, loc.accuracy, loc.status, t.offline, skewS]
  let row
  if (existing) {
    // A manager marked the day before the employee checked in. Keep their
    // status unless it says absent — the employee evidently turned up.
    const newStatus = existing.status === 'absent' ? status : existing.status
    if (existing.status === 'absent') flags = [...flags, 'checked_in_after_marked_absent']
    ;({ rows: [row] } = await client.query(
      `UPDATE hr_attendance a SET
         check_in_at = $1, check_in_device_at = $2, check_in_lat = $3, check_in_lng = $4,
         check_in_accuracy_m = $5, check_in_location_status = $6, check_in_offline = $7,
         check_in_clock_skew_s = $8, status = $9, ${mergeFlags(10)},
         shift_id = $12, late_minutes = $13, updated_at = now()
       WHERE id = $11 RETURNING ${ATT_COLS}`, [...fields, newStatus, flags, existing.id, shift?.id ?? null, late]))
  } else {
    ;({ rows: [row] } = await client.query(
      `INSERT INTO hr_attendance AS a (
         check_in_at, check_in_device_at, check_in_lat, check_in_lng, check_in_accuracy_m,
         check_in_location_status, check_in_offline, check_in_clock_skew_s,
         status, flag_reasons, org_id, user_id, work_date, source, shift_id, late_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'self', $14, $15)
       RETURNING ${ATT_COLS}`, [...fields, status, flags, orgId, me.id, workDate, shift?.id ?? null, late]))
  }
  push(ctx, {
    event: 'checkInOut', userIds: [me.id],
    title: `Checked in at ${fmtTime(t.estimated, settings.timezone)}`,
    body: [fmtDay(workDate), status === 'on_field' ? 'On field' : status === 'half_day' ? 'Half day (half-day leave)' : null,
      late ? `Late by ${late} min` : null, t.offline ? 'recorded offline' : null].filter(Boolean).join(' · '),
  })
  return mapAttendance(row)
}

export async function checkOut(client, ctx, payload, timing) {
  const { orgId, me, settings } = ctx
  const t = resolveTime(timing, settings)
  const loc = parseLocation(payload.location, settings.gpsMode)
  const day = dateInTz(t.estimated, settings.timezone)

  // The open check-in may be from yesterday (night shift, forgot to check out).
  const { rows } = await client.query(
    `SELECT id, check_in_at, work_date::text AS work_date, status, source, shift_id FROM hr_attendance
      WHERE org_id = $1 AND user_id = $2 AND check_in_at IS NOT NULL AND check_out_at IS NULL
        AND work_date BETWEEN $3 AND $4
      ORDER BY work_date DESC LIMIT 1 FOR UPDATE`, [orgId, me.id, addDays(day, -1), day])
  const open = rows[0]
  if (!open) throw new HttpError(409, 'There is no open check-in to check out from.')

  const flags = [...t.flags, ...loc.flags]
  if (t.estimated < open.check_in_at) flags.push('checkout_before_checkin')

  // Shift rules, against the employee's shift as configured now.
  const shift = (await shiftsFor(client, orgId, [me.id])).get(me.id) ?? null
  const worked = workedMinutes(open.check_in_at, t.estimated)
  const early = hasTiming(shift) ? earlyLeaveMinutes(t.estimated, shift, open.work_date, settings.timezone) : null
  // A short self-recorded day becomes a half day; a manager's mark is left alone.
  const short = shift && open.source === 'self' && ['present', 'on_field'].includes(open.status)
    && worked < shift.min_full_day_minutes
  const { rows: [row] } = await client.query(
    `UPDATE hr_attendance a SET
       check_out_at = $1, check_out_device_at = $2, check_out_lat = $3, check_out_lng = $4,
       check_out_accuracy_m = $5, check_out_location_status = $6, check_out_offline = $7,
       check_out_clock_skew_s = $8, ${mergeFlags(9)},
       worked_minutes = $11, early_leave_minutes = $12,
       status = CASE WHEN $13::boolean THEN 'half_day' ELSE status END,
       shift_id = COALESCE(shift_id, $14), updated_at = now()
     WHERE id = $10 RETURNING ${ATT_COLS}`,
    [t.estimated, t.device, loc.lat, loc.lng, loc.accuracy, loc.status, t.offline,
     Math.round(timing.skewMs / 1000), flags, open.id, worked, early, !!short, shift?.id ?? null])
  push(ctx, {
    event: 'checkInOut', userIds: [me.id],
    title: `Checked out at ${fmtTime(t.estimated, settings.timezone)}`,
    body: [`Worked ${fmtHours(worked)}`, early ? `left ${early} min early` : null,
      short ? 'counted as a half day (below the shift minimum)' : null,
      t.offline ? 'recorded offline' : null].filter(Boolean).join(' · '),
  })
  return mapAttendance(row)
}

/** Manager/HR/admin register entry. Changing an existing row is a correction
 *  and must carry a reason, which is kept in hr_attendance_corrections. */
export async function markAttendance(client, ctx, payload, timing) {
  const { orgId, me, settings } = ctx
  const { userId, date, status } = payload
  const note = payload.note == null ? null : String(payload.note).trim().slice(0, 500) || null
  const reason = String(payload.reason ?? '').trim().slice(0, 500)
  if (!isValidDate(date)) throw new HttpError(422, 'Pick a valid date.')
  if (!ATT_STATUSES.has(status)) throw new HttpError(422, 'Pick a valid attendance status.')
  if (date > dateInTz(timing.serverNow, settings.timezone)) {
    throw new HttpError(422, "You can't mark attendance for a future date.")
  }
  const emp = await loadEmployee(client, orgId, userId)
  if (!emp) throw new HttpError(404, 'Employee not found.')
  if (!canManage(me, emp)) throw new HttpError(403, 'You can only mark attendance for your own team.')
  if (emp.id === me.id && !me.isAdmin) throw new HttpError(403, "You can't mark your own attendance — use Check in instead.")

  const { rows } = await client.query(
    `SELECT ${ATT_COLS} FROM hr_attendance a
      WHERE a.org_id = $1 AND a.user_id = $2 AND a.work_date = $3 FOR UPDATE`, [orgId, emp.id, date])
  const existing = rows[0]

  if (!existing) {
    const { rows: [row] } = await client.query(
      `INSERT INTO hr_attendance AS a (org_id, user_id, work_date, status, source, marked_by, note)
       VALUES ($1, $2, $3, $4, 'manager', $5, $6) RETURNING ${ATT_COLS}`,
      [orgId, emp.id, date, status, me.id, note])
    push(ctx, {
      event: 'attendanceMarked', userIds: [emp.id],
      title: `Attendance marked: ${ATT_WORD[status]} on ${fmtDay(date)}`,
      body: `By ${me.name}${note ? `. Note: ${note}` : ''}`,
    })
    return mapAttendance(row)
  }

  const newNote = note ?? existing.note
  if (existing.status === status && newNote === existing.note) return mapAttendance(existing)
  if (reason.length < 3) throw new HttpError(422, 'Give a reason for changing this attendance record.')

  const { rows: [row] } = await client.query(
    `UPDATE hr_attendance a SET status = $1, note = $2, marked_by = $3, updated_at = now()
      WHERE id = $4 RETURNING ${ATT_COLS}`, [status, newNote, me.id, existing.id])
  await client.query(
    `INSERT INTO hr_attendance_corrections (org_id, attendance_id, changed_by, reason, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, existing.id, me.id, reason,
     { status: existing.status, note: existing.note }, { status, note: newNote }])
  push(ctx, {
    event: 'attendanceMarked', userIds: [emp.id],
    title: `Attendance changed: ${ATT_WORD[existing.status]} → ${ATT_WORD[status]} on ${fmtDay(date)}`,
    body: `By ${me.name}. Reason: ${reason}`,
  })
  return mapAttendance(row)
}

export async function reviewFlag(client, { orgId, me }, payload) {
  if (!UUID_RE.test(String(payload.attendanceId || ''))) throw new HttpError(422, 'Invalid attendance record.')
  const { rows } = await client.query(
    `SELECT a.id, a.user_id, u.manager_id FROM hr_attendance a JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1 AND a.id = $2 FOR UPDATE OF a`, [orgId, payload.attendanceId])
  const att = rows[0]
  if (!att) throw new HttpError(404, 'Attendance record not found.')
  if (!canManage(me, att)) throw new HttpError(403, 'You can only review your own team.')
  if (att.user_id === me.id && !me.isAdmin) throw new HttpError(403, "You can't review your own attendance.")
  const note = String(payload.note ?? '').trim().slice(0, 500)
  const { rows: [row] } = await client.query(
    `UPDATE hr_attendance a SET reviewed_by = $1, reviewed_at = now(),
       note = CASE WHEN $2 = '' THEN note ELSE concat_ws(' · ', note, $2) END, updated_at = now()
      WHERE id = $3 RETURNING ${ATT_COLS}`, [me.id, note, att.id])
  return mapAttendance(row)
}

// ── Leave ────────────────────────────────────────────────────────────────────

export async function requestLeave(client, ctx, payload, timing) {
  const { orgId, me, settings } = ctx
  const { leaveTypeId, startDate, endDate } = payload
  const dayPortion = payload.dayPortion || 'full'
  const reason = String(payload.reason ?? '').trim().slice(0, 1000)

  if (!isValidDate(startDate) || !isValidDate(endDate)) throw new HttpError(422, 'Pick valid start and end dates.')
  if (endDate < startDate) throw new HttpError(422, 'The end date is before the start date.')
  if (!['full', 'first_half', 'second_half'].includes(dayPortion)) throw new HttpError(422, 'Invalid half-day option.')
  if (dayPortion !== 'full' && startDate !== endDate) throw new HttpError(422, 'A half-day leave must start and end on the same date.')
  if (addDays(startDate, 90) < endDate) throw new HttpError(422, 'A single request can cover at most 90 days.')
  const leaveYear = leaveYearOf(startDate)
  if (leaveYearOf(endDate) !== leaveYear) {
    throw new HttpError(422, "A leave request can't cross 31 March — split it into two requests.")
  }
  if (!UUID_RE.test(String(leaveTypeId || ''))) throw new HttpError(422, 'Pick a leave type.')
  const { rows: [type] } = await client.query(
    `SELECT id, name, allow_half_day, is_active FROM hr_leave_types WHERE org_id = $1 AND id = $2`, [orgId, leaveTypeId])
  if (!type || !type.is_active) throw new HttpError(422, 'That leave type is no longer available.')
  if (dayPortion !== 'full' && !type.allow_half_day) throw new HttpError(422, `${type.name} can't be taken as a half day.`)

  // One request at a time per employee, so two queued requests can't both
  // pass the balance check.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hr-leave:${me.id}`])

  const holidays = await holidaySet(client, orgId, me.locationId, startDate, endDate)
  const days = countLeaveDays(startDate, endDate, dayPortion, settings.weeklyOffs, holidays)
  if (days <= 0) throw new HttpError(422, 'Those dates are all weekly offs or holidays — no leave needed.')

  const { rows: mine } = await client.query(
    `SELECT start_date::text AS start_date, end_date::text AS end_date, day_portion FROM hr_leave_requests
      WHERE org_id = $1 AND user_id = $2 AND status IN ('pending_manager', 'pending_hr', 'approved')
        AND start_date <= $4 AND end_date >= $3`, [orgId, me.id, startDate, endDate])
  if (mine.some(r => leaveOverlaps(r, { start_date: startDate, end_date: endDate, day_portion: dayPortion }))) {
    throw new HttpError(409, 'You already have leave on some of these dates.')
  }

  const balance = (await leaveBalances(client, orgId, me.id, leaveYear)).find(b => b.leaveTypeId === type.id)
  const available = balance?.available ?? 0
  if (days > available) {
    throw new HttpError(422, `Not enough ${type.name} balance: ${available} day(s) left, ${days} requested.`)
  }

  // No reporting manager → straight to HR.
  const status = me.managerId ? 'pending_manager' : 'pending_hr'
  const { rows: [created] } = await client.query(
    `INSERT INTO hr_leave_requests (org_id, user_id, leave_type_id, start_date, end_date, day_portion,
       days, leave_year, reason, status, manager_id, submitted_offline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [orgId, me.id, type.id, startDate, endDate, dayPortion, days, leaveYear, reason, status,
     me.managerId, !!timing.offline])
  const leave = await fetchLeave(client, orgId, created.id)
  push(ctx, {
    event: 'leaveRequested',
    userIds: status === 'pending_manager' ? [me.managerId] : (await hrApproverIds(client, orgId)).filter(id => id !== me.id),
    title: `Leave request from ${me.name}`,
    body: `${leaveLine(leave)}${reason ? `. Reason: ${reason}` : ''}. Waiting for your approval.`,
  })
  push(ctx, {
    event: 'leaveDecided', userIds: [me.id],
    title: 'Leave request submitted',
    body: `${leaveLine(leave)}. Waiting for ${status === 'pending_manager' ? `${leave.managerName ?? 'your manager'}'s` : 'HR'} approval.`,
  })
  return leave
}

export async function cancelLeave(client, ctx, payload, timing) {
  const { orgId, me, settings } = ctx
  if (!UUID_RE.test(String(payload.requestId || ''))) throw new HttpError(422, 'Invalid leave request.')
  const { rows } = await client.query(
    `SELECT r.id, r.user_id, r.status, r.start_date::text AS start_date, COALESCE(u.manager_id, r.manager_id) AS manager_id
       FROM hr_leave_requests r JOIN users u ON u.id = r.user_id
      WHERE r.org_id = $1 AND r.id = $2 FOR UPDATE OF r`, [orgId, payload.requestId])
  const req = rows[0]
  if (!req) throw new HttpError(404, 'Leave request not found.')
  if (req.user_id !== me.id) throw new HttpError(403, 'You can only cancel your own leave.')
  const today = dateInTz(timing.serverNow, settings.timezone)
  const cancellable = req.status === 'pending_manager' || req.status === 'pending_hr'
    // An approved leave starting today can still be cancelled, so the employee can check in.
    || (req.status === 'approved' && req.start_date >= today)
  if (!cancellable) {
    throw new HttpError(409, req.status === 'approved'
      ? 'This leave has already started — ask HR to change it.'
      : 'This request has already been closed.')
  }
  await client.query(
    `UPDATE hr_leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [req.id])
  const leave = await fetchLeave(client, orgId, req.id)
  // Whoever it was waiting on (or, once approved, manager and HR) hears about it.
  const hr = req.status === 'pending_manager' ? [] : await hrApproverIds(client, orgId)
  const manager = req.status === 'pending_hr' || !req.manager_id ? [] : [req.manager_id]
  push(ctx, {
    event: 'leaveCancelled', userIds: [...manager, ...hr].filter(id => id !== me.id),
    title: `${me.name} cancelled ${req.status === 'approved' ? 'an approved' : 'a pending'} leave`,
    body: `${leaveLine(leave)}.`,
  })
  return leave
}

export async function decideLeave(client, ctx, payload) {
  const { orgId, me } = ctx
  const { requestId, decision } = payload
  const comment = String(payload.comment ?? '').trim().slice(0, 1000) || null
  if (!UUID_RE.test(String(requestId || ''))) throw new HttpError(422, 'Invalid leave request.')
  if (decision !== 'approve' && decision !== 'reject') throw new HttpError(422, 'Decision must be approve or reject.')

  const { rows } = await client.query(
    `SELECT r.id, r.user_id, r.status, r.manager_id, r.manager_action_by, u.manager_id AS current_manager_id
       FROM hr_leave_requests r JOIN users u ON u.id = r.user_id
      WHERE r.org_id = $1 AND r.id = $2 FOR UPDATE OF r`, [orgId, requestId])
  const req = rows[0]
  if (!req) throw new HttpError(404, 'Leave request not found.')
  if (req.user_id === me.id) throw new HttpError(403, "You can't decide on your own leave.")

  if (req.status === 'pending_manager') {
    // The employee's current manager decides; the one stored on the request is
    // only a fallback for when no manager is assigned any more.
    const isTheirManager = me.id === (req.current_manager_id ?? req.manager_id)
    if (isTheirManager) {
      await client.query(
        `UPDATE hr_leave_requests SET status = $1, manager_action_by = $2, manager_action_at = now(),
           manager_comment = $3, updated_at = now() WHERE id = $4`,
        [decision === 'approve' ? 'pending_hr' : 'rejected', me.id, comment, req.id])
    } else if (me.isAdmin) {
      // Admin override closes the request at either level in one step.
      await client.query(
        `UPDATE hr_leave_requests SET status = $1, manager_action_by = $2, manager_action_at = now(),
           hr_action_by = $2, hr_action_at = now(), hr_comment = $3, updated_at = now() WHERE id = $4`,
        [decision === 'approve' ? 'approved' : 'rejected', me.id, comment ?? 'Admin override', req.id])
    } else {
      throw new HttpError(403, "This request is waiting for the employee's reporting manager.")
    }
  } else if (req.status === 'pending_hr') {
    if (!me.isHr && !me.isAdmin) throw new HttpError(403, 'This request is waiting for HR approval.')
    if (req.manager_action_by === me.id && !me.isAdmin) {
      throw new HttpError(403, 'You already approved this as the manager — a different HR approver must give final approval.')
    }
    await client.query(
      `UPDATE hr_leave_requests SET status = $1, hr_action_by = $2, hr_action_at = now(),
         hr_comment = $3, updated_at = now() WHERE id = $4`,
      [decision === 'approve' ? 'approved' : 'rejected', me.id, comment, req.id])
  } else {
    throw new HttpError(409, 'This request has already been decided or cancelled.')
  }
  const leave = await fetchLeave(client, orgId, req.id)
  if (leave.status === 'pending_hr') {
    // Manager said yes — now it's HR's turn.
    push(ctx, {
      event: 'leaveRequested',
      userIds: (await hrApproverIds(client, orgId)).filter(id => id !== leave.userId),
      title: `Leave waiting for HR approval: ${leave.userName}`,
      body: `${leaveLine(leave)}. Approved by ${me.name}${comment ? ` ("${comment}")` : ''}.`,
    })
    push(ctx, {
      event: 'leaveDecided', userIds: [leave.userId],
      title: 'Your manager approved your leave — now waiting for HR',
      body: `${leaveLine(leave)}. Approved by ${me.name}${comment ? `: "${comment}"` : ''}.`,
    })
  } else {
    push(ctx, {
      event: 'leaveDecided', userIds: [leave.userId],
      title: `Your leave was ${leave.status === 'approved' ? 'approved' : 'rejected'}`,
      body: `${leaveLine(leave)}. By ${me.name}${comment ? `: "${comment}"` : ''}.`,
    })
    // The manager who forwarded it to HR hears the final word too.
    if (req.status === 'pending_hr' && req.manager_action_by && req.manager_action_by !== me.id) {
      push(ctx, {
        event: 'leaveDecided', userIds: [req.manager_action_by],
        title: `HR ${leave.status === 'approved' ? 'approved' : 'rejected'} ${leave.userName}'s leave`,
        body: `${leaveLine(leave)}. By ${me.name}${comment ? `: "${comment}"` : ''}.`,
      })
    }
  }
  return leave
}
