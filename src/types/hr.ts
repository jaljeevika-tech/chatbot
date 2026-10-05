// HR Management (attendance + leave) — shapes returned by services/hr.

import type { WeeklyOffs } from '../../services/hr/dates'

export type GpsMode = 'required' | 'optional' | 'off'
export type AttendanceStatus = 'present' | 'on_field' | 'half_day' | 'absent'
export type LocationStatus = 'ok' | 'denied' | 'unavailable' | 'off'
export type DayPortion = 'full' | 'first_half' | 'second_half'
export type LeaveStatus = 'pending_manager' | 'pending_hr' | 'approved' | 'rejected' | 'cancelled'

export interface HrMe {
  id: string
  name: string
  role: string
  managerId: string | null
  locationId: string | null
  isAdmin: boolean
  isHr: boolean
  isManager: boolean
}

export type NotifyEvent = 'leaveRequested' | 'leaveDecided' | 'attendanceMarked' | 'checkInOut' | 'missedCheckIn'

export interface NotifySettings {
  emailEnabled: boolean
  whatsappEnabled: boolean
  whatsappTemplate: string
  whatsappLang: string
  events: Record<NotifyEvent, boolean>
  /** Org-local 'HH:MM' — missed check-in reminders go out after this. */
  reminderTime: string
}

export interface HrSettings {
  gpsMode: GpsMode
  weeklyOffs: WeeklyOffs
  clockSkewMinutes: number
  timezone: string
  /** Admins only. */
  notifications?: NotifySettings
  /** Admins only: the server has SMTP credentials. */
  emailConfigured?: boolean
}

export interface Shift {
  id: string
  name: string
  /** Hours a day expected — what field shifts are about. */
  requiredMinutes: number
  /** Optional fixed timing ('HH:MM', end before start = next day); only
   *  shifts with timing get late / early-leave marking. */
  startTime: string | null
  endTime: string | null
  graceMinutes: number
  minFullDayMinutes: number
  isDefault: boolean
}

export interface LeaveType {
  id: string
  name: string
  annualQuota: number
  allowHalfDay: boolean
  isActive: boolean
}

export interface HrLocation { id: string; name: string; shiftId: string | null }

export interface Holiday { id: string; date: string; name: string; locationId: string | null }

export interface LeaveBalance {
  leaveTypeId: string
  name: string
  quota: number
  used: number
  pending: number
  available: number
  allowHalfDay: boolean
  isActive: boolean
}

export interface AttendanceRecord {
  id: string
  userId: string
  userName?: string
  workDate: string
  status: AttendanceStatus
  source: 'self' | 'manager'
  checkInAt: string | null
  checkInDeviceAt: string | null
  checkInLat: number | null
  checkInLng: number | null
  checkInAccuracyM: number | null
  checkInLocationStatus: LocationStatus | null
  checkInOffline: boolean
  checkInClockSkewS: number | null
  checkOutAt: string | null
  checkOutDeviceAt: string | null
  checkOutLat: number | null
  checkOutLng: number | null
  checkOutAccuracyM: number | null
  checkOutLocationStatus: LocationStatus | null
  checkOutOffline: boolean
  checkOutClockSkewS: number | null
  flagReasons: string[]
  reviewedBy: string | null
  reviewedAt: string | null
  markedBy: string | null
  note: string | null
  updatedAt: string
  shiftId: string | null
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
  workedMinutes: number | null
}

export interface LeaveRequest {
  id: string
  userId: string
  userName: string
  leaveTypeId: string
  leaveTypeName: string
  startDate: string
  endDate: string
  dayPortion: DayPortion
  days: number
  leaveYear: number
  reason: string
  status: LeaveStatus
  managerId: string | null
  managerName: string | null
  managerActionAt: string | null
  managerComment: string | null
  hrActionAt: string | null
  hrComment: string | null
  submittedOffline: boolean
  createdAt: string
}

export interface TeamMember {
  id: string
  name: string
  role: string
  managerId: string | null
  isHr: boolean
  locationId: string | null
  managerName?: string | null
  /** /hr/employees (HR/admin) only. */
  phone?: string
  designation?: string | null
  shiftId?: string | null
  email?: string | null
}

export interface HrBootstrap {
  serverTime: string
  today: string
  leaveYear: number
  me: HrMe
  settings: HrSettings
  leaveTypes: LeaveType[]
  locations: HrLocation[]
  holidays: Holiday[]
  balances: LeaveBalance[]
  attendance: AttendanceRecord[]
  leaveRequests: LeaveRequest[]
  team: TeamMember[]
  approvals: LeaveRequest[]
  shifts: Shift[]
  myShift: Shift | null
  /** Set on the copy saved to this device. */
  cachedAt?: string
}

export interface RegisterRow {
  employee: TeamMember
  attendance: AttendanceRecord | null
  leave: { leaveTypeName: string; dayPortion: DayPortion } | null
  dayOff: string | null
}

export interface MonthlyRow {
  userId: string
  name: string
  workingDays: number
  present: number
  onField: number
  halfDay: number
  absent: number
  leave: number
  unmarked: number
  flagged: number
}

export interface TimesheetDay {
  date: string
  status: AttendanceStatus | null
  checkInAt: string | null
  checkOutAt: string | null
  workedMinutes: number | null
  lateMinutes: number | null
  earlyLeaveMinutes: number | null
  overtimeMinutes: number
  leave: { leaveTypeName: string; dayPortion: DayPortion } | null
  dayOff: string | null
}

export interface TimesheetRow {
  userId: string
  name: string
  shift: Shift | null
  days: TimesheetDay[]
  totals: {
    workedMinutes: number; overtimeMinutes: number; lateDays: number; lateMinutes: number; earlyDays: number
    present: number; halfDay: number; absent: number; leave: number; unmarked: number
  }
}

export type OrgStatus = 'in' | 'out' | 'marked' | 'absent' | 'leave' | 'off' | 'none'

export interface OrgPerson {
  id: string
  name: string
  role: string
  designation: string | null
  managerId: string | null
  location: string | null
  isHr: boolean
  /** Only for people the viewer manages (or everyone, for HR/admins). */
  status: OrgStatus | null
}

export interface LocationFix {
  status: Exclude<LocationStatus, 'off'>
  lat?: number
  lng?: number
  accuracy?: number
}

// ── Offline queue ────────────────────────────────────────────────────────────
export type HrActionPayloads = {
  check_in:        { mode: 'office' | 'field'; location: LocationFix | null }
  check_out:       { location: LocationFix | null }
  mark_attendance: { userId: string; date: string; status: AttendanceStatus; note?: string; reason?: string }
  review_flag:     { attendanceId: string; note?: string }
  leave_request:   { leaveTypeId: string; startDate: string; endDate: string; dayPortion: DayPortion; reason: string }
  leave_cancel:    { requestId: string }
  leave_decision:  { requestId: string; decision: 'approve' | 'reject'; comment?: string }
}
export type HrActionKind = keyof HrActionPayloads

export interface OutboxItem<K extends HrActionKind = HrActionKind> {
  clientId: string
  userKey: string
  kind: K
  payload: HrActionPayloads[K]
  /** Phone clock when the user acted. */
  createdAt: string
  /** Queued while the device had no connection. */
  offline: boolean
  seq: number
  attempts: number
  lastError?: string
}

export interface SyncProblem {
  clientId: string
  kind: HrActionKind
  payload: HrActionPayloads[HrActionKind]
  createdAt: string
  error: string
}
