// Shared bits for the HR tab: card/button styles, labels and formatters.

import type { CSSProperties, ReactNode } from 'react'
import { FF, ffStatusColors } from '../../theme/colors'
import { StatusBadge } from '../ui/StatusBadge'
import type { AttendanceStatus, DayPortion, LeaveStatus } from '../../types/hr'

export const FONT = "'IBM Plex Sans',sans-serif"

export function Card({ title, action, children, style }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; style?: CSSProperties
}) {
  return (
    <section style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12, padding: 16, ...style }}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginBottom: 12 }}>
          {title && <h3 style={{ fontSize: 15, fontWeight: 600, color: FF.tealDark, margin: 0 }}>{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
const BTN: Record<BtnVariant, CSSProperties> = {
  primary:   { background: FF.purple, color: '#FFFFFF', border: `1px solid ${FF.purple}` },
  secondary: { background: '#FFFFFF', color: FF.tealDark, border: `1px solid ${FF.border}` },
  danger:    { background: '#FFFFFF', color: FF.red, border: `1px solid ${FF.red}` },
  ghost:     { background: 'transparent', color: FF.textMuted, border: '1px solid transparent' },
}

export function Btn({ variant = 'secondary', big, style, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant; big?: boolean
}) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        ...BTN[variant],
        borderRadius: 8,
        padding: big ? '14px 20px' : '8px 14px',
        fontSize: big ? 15 : 13,
        fontWeight: 600,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.55 : 1,
        minHeight: big ? 52 : 36,
        ...style,
      }}
    />
  )
}

export const inputStyle: CSSProperties = {
  width: '100%', border: `1px solid ${FF.border}`, borderRadius: 8, padding: '9px 11px',
  fontSize: 14, color: FF.tealText, background: '#FFFFFF', fontFamily: FONT,
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: FF.textMuted, fontWeight: 500 }}>
      {label}
      {children}
      {hint && <span style={{ fontSize: 11.5, color: FF.textFaint, fontWeight: 400 }}>{hint}</span>}
    </label>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, color: FF.textFaint, padding: '8px 0' }}>{children}</div>
}

export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'green'; children: ReactNode }) {
  const c = ffStatusColors(tone)
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} style={{
      background: c.bg, color: c.fg, borderRadius: 8, padding: '9px 12px', fontSize: 13, lineHeight: 1.45,
    }}>
      {children}
    </div>
  )
}

// ── Labels ───────────────────────────────────────────────────────────────────
export const ATT_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present', on_field: 'On field', half_day: 'Half day', absent: 'Absent',
}
const ATT_TONE: Record<AttendanceStatus, 'green' | 'amber' | 'red'> = {
  present: 'green', on_field: 'green', half_day: 'amber', absent: 'red',
}
export function AttendanceBadge({ status }: { status: AttendanceStatus }) {
  const c = ffStatusColors(ATT_TONE[status])
  return <StatusBadge bg={c.bg} fg={c.fg} label={ATT_LABEL[status]} shape="pill" />
}

export const LEAVE_LABEL: Record<LeaveStatus, string> = {
  pending_manager: 'Waiting for manager', pending_hr: 'Waiting for HR', approved: 'Approved',
  rejected: 'Rejected', cancelled: 'Cancelled',
}
export function LeaveBadge({ status }: { status: LeaveStatus }) {
  if (status === 'cancelled') return <StatusBadge bg={FF.bg} fg={FF.textMuted} label="Cancelled" shape="pill" />
  const tone = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : 'amber'
  const c = ffStatusColors(tone)
  return <StatusBadge bg={c.bg} fg={c.fg} label={LEAVE_LABEL[status]} shape="pill" />
}

export function SyncBadge() {
  return <StatusBadge bg="#EAE4F5" fg={FF.purple} label="Waiting to sync" shape="pill" />
}

export const FLAG_LABEL: Record<string, string> = {
  clock_mismatch: 'Phone clock was wrong',
  location_unavailable: 'No GPS fix',
  checkout_before_checkin: 'Check-out before check-in',
  checked_in_after_marked_absent: 'Checked in after marked absent',
}
export const flagText = (f: string) => FLAG_LABEL[f] ?? f.replace(/_/g, ' ')

export const PORTION_LABEL: Record<DayPortion, string> = {
  full: 'Full day', first_half: 'First half', second_half: 'Second half',
}

// ── Formatting ───────────────────────────────────────────────────────────────
/** 'YYYY-MM-DD' → 'Mon, 5 Oct' (calendar date, no timezone shift). */
export function fmtDate(d: string, withYear = false): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  })
}

export function fmtTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
}

export function fmtRange(start: string, end: string): string {
  return start === end ? fmtDate(start, true) : `${fmtDate(start)} – ${fmtDate(end, true)}`
}

export const fmtDays = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** 'HH:MM' shift time → '9:30 am'. */
export function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** 278 → '4h 38m'. */
export const fmtMinutes = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
