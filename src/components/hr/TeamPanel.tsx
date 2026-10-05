// "Team" — the daily register for managers (direct reports) and HR/admins
// (everyone), plus check-ins flagged for review. Marking works offline:
// without a connection the register lists the team saved on this device and
// queues each mark; existing entries need a reason to change.

import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Map as MapIcon } from 'lucide-react'
import type { MapPoint } from './HrMap'
import { FF } from '../../theme/colors'
import { dateInTz } from '../../../services/hr/dates'
import { mapsLink } from '../../utils/hr/geo'
import { useToast } from '../../context/ToastContext'
import { TabPill } from '../ui/TabPill'
import type {
  AttendanceRecord, AttendanceStatus, HrBootstrap, OutboxItem, RegisterRow,
} from '../../types/hr'
import { hrGet, type HrData } from './useHrData'
import {
  ATT_LABEL, AttendanceBadge, Btn, Card, Muted, Notice, SyncBadge, errorText, flagText, fmtDate, fmtTime, inputStyle,
} from './hrUi'

const STATUSES: AttendanceStatus[] = ['present', 'on_field', 'half_day', 'absent']

const HrMap = lazy(() => import('./HrMap'))
const Dot = ({ c }: { c: string }) => (
  <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, background: c, marginRight: 4 }} />
)

/** One pin per check-in (coloured by status) and per check-out. */
function teamPoints(rows: RegisterRow[], tz: string): MapPoint[] {
  return rows.flatMap(({ employee, attendance: a }) => {
    if (!a) return []
    const pts: MapPoint[] = []
    if (a.checkInLat != null && a.checkInLng != null) {
      const color = (a.flagReasons.length > 0 && !a.reviewedAt) || a.status === 'half_day' ? FF.amber
        : a.status === 'on_field' ? '#2F6F9F' : FF.green
      pts.push({ key: `${a.id}-in`, lat: a.checkInLat, lng: a.checkInLng, color,
        title: employee.name,
        detail: `In ${fmtTime(a.checkInAt, tz)}${a.lateMinutes ? ` (late ${a.lateMinutes}m)` : ''} · ±${Math.round(a.checkInAccuracyM ?? 0)} m` })
    }
    if (a.checkOutLat != null && a.checkOutLng != null) {
      pts.push({ key: `${a.id}-out`, lat: a.checkOutLat, lng: a.checkOutLng, color: FF.purple,
        title: employee.name, detail: `Out ${fmtTime(a.checkOutAt, tz)}` })
    }
    return pts
  })
}

export function TeamPanel({ hr, data }: { hr: HrData; data: HrBootstrap }) {
  const { me, settings } = data
  const tz = settings.timezone
  const today = dateInTz(new Date(), tz)
  const seesAll = me.isAdmin || me.isHr
  const [date, setDate] = useState(today)
  const [scope, setScope] = useState<'reports' | 'all'>(seesAll ? 'all' : 'reports')

  return (
    <div className="flex flex-col gap-4">
      <Register hr={hr} data={data} date={date} setDate={setDate} scope={scope} setScope={seesAll ? setScope : undefined} today={today} />
      <Flagged hr={hr} tz={tz} />
    </div>
  )
}

function Register({ hr, data, date, setDate, scope, setScope, today }: {
  hr: HrData; data: HrBootstrap; date: string; setDate: (d: string) => void
  scope: 'reports' | 'all'; setScope?: (s: 'reports' | 'all') => void; today: string
}) {
  const { sync, queue } = hr
  const { toast } = useToast()
  const { me, settings } = data
  const [rows, setRows] = useState<RegisterRow[] | null>(null)
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ userId: string; status: AttendanceStatus } | null>(null)
  const [reason, setReason] = useState('')
  const [showMap, setShowMap] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const out = await hrGet<{ rows: RegisterRow[] }>(`/api/hr/register?date=${date}&scope=${scope}`)
      setRows(out.rows); setOffline(false); setError(null)
    } catch (e) {
      if (e instanceof TypeError) {
        // Offline: the team saved on this device, statuses unknown.
        const team = data.team.filter(u => (u.id !== me.id || me.isAdmin) && (scope === 'all' || u.managerId === me.id))
        setRows(team.map(employee => ({ employee, attendance: null, leave: null, dayOff: null })))
        setOffline(true); setError(null)
      } else {
        setError(errorText(e))
      }
    } finally {
      setLoading(false)
    }
  }, [date, scope, data.team, me.id, me.isAdmin])

  // Also reloads after each sync, so confirmed marks replace the queued ones.
  useEffect(() => { void load() }, [load, sync.lastSyncAt])

  const queuedMark = (userId: string) => sync.pending
    .filter((p): p is OutboxItem<'mark_attendance'> => p.kind === 'mark_attendance')
    .reverse()
    .find(p => p.payload.userId === userId && p.payload.date === date)

  async function mark(row: RegisterRow, status: AttendanceStatus, why?: string) {
    const current = queuedMark(row.employee.id)?.payload.status ?? row.attendance?.status
    if (current === status) return
    // Changing an existing entry (or one we can't see while offline) needs a reason.
    if ((row.attendance || queuedMark(row.employee.id) || offline) && !why) {
      setEditing({ userId: row.employee.id, status }); setReason('')
      return
    }
    try {
      await queue('mark_attendance', { userId: row.employee.id, date, status, ...(why ? { reason: why } : {}) })
      setEditing(null)
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error')
    }
  }

  return (
    <Card
      title="Daily register"
      action={
        <div className="flex items-center gap-2 flex-wrap">
          {setScope && (
            <TabPill size="xs" active={scope} onChange={setScope}
              tabs={[{ key: 'reports', label: 'My reports' }, { key: 'all', label: 'Everyone' }]} />
          )}
          <input type="date" value={date} max={today} onChange={e => e.target.value && setDate(e.target.value)}
            style={{ ...inputStyle, width: 'auto' }} aria-label="Register date" />
          <Btn variant={showMap ? 'secondary' : 'ghost'} onClick={() => setShowMap(s => !s)} aria-pressed={showMap}>
            <span className="inline-flex items-center gap-1.5"><MapIcon className="w-4 h-4" /> Map</span>
          </Btn>
          <Btn variant="ghost" onClick={() => void load()} aria-label="Reload register" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Btn>
        </div>
      }
    >
      {showMap && rows && (
        <div style={{ marginBottom: 12 }}>
          <Suspense fallback={<Muted>Loading map…</Muted>}>
            <HrMap points={teamPoints(rows, settings.timezone)} />
          </Suspense>
          <div className="flex gap-4 flex-wrap" style={{ fontSize: 12, color: FF.textMuted, marginTop: 6 }}>
            <span><Dot c={FF.green} /> Checked in · office</span>
            <span><Dot c="#2F6F9F" /> On field</span>
            <span><Dot c={FF.amber} /> Half day / flagged</span>
            <span><Dot c={FF.purple} /> Check-out point</span>
          </div>
        </div>
      )}
      {offline && <div style={{ marginBottom: 10 }}><Notice>You're offline — today's check-ins can't be shown, but marks you make are saved and sent later.</Notice></div>}
      {error && <Notice tone="red">{error}</Notice>}
      {!rows && loading && <div className="flex justify-center py-6" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>}
      {rows && rows.length === 0 && (
        <Muted>{scope === 'all' ? 'No employees found.'
          : `No one reports to you${setScope ? ' — switch to Everyone to see the whole organisation' : ''}.`}</Muted>
      )}
      {rows && rows.length > 0 && (
        <div className="flex flex-col">
          {rows.map(row => {
            const queued = queuedMark(row.employee.id)
            const att: AttendanceRecord | null = row.attendance
            const shown = queued?.payload.status ?? att?.status
            const isEditing = editing?.userId === row.employee.id
            return (
              <div key={row.employee.id} style={{ padding: '11px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>{row.employee.name}</div>
                    <div style={{ fontSize: 12.5, color: FF.textMuted, marginTop: 2 }}>
                      {row.dayOff ? row.dayOff
                        : row.leave ? `On leave · ${row.leave.leaveTypeName}${row.leave.dayPortion !== 'full' ? ' (half day)' : ''}`
                        : att?.checkInAt ? <>In {fmtTime(att.checkInAt, settings.timezone)} · Out {fmtTime(att.checkOutAt, settings.timezone)}
                            {att.checkInLat != null && att.checkInLng != null && (
                              <> · <a href={mapsLink(att.checkInLat, att.checkInLng)} target="_blank" rel="noreferrer" style={{ color: FF.purple }}>map</a></>
                            )}</>
                        : offline ? '' : 'Not checked in'}
                    </div>
                    {att?.flagReasons.length && !att.reviewedAt
                      ? <div style={{ fontSize: 12, color: FF.amber }}>{att.flagReasons.map(flagText).join(' · ')}</div> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {queued && <SyncBadge />}
                    {shown && <AttendanceBadge status={shown} />}
                  </div>
                </div>
                <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 8 }}>
                  {STATUSES.map(s => (
                    <button key={s} type="button" onClick={() => void mark(row, s)} aria-pressed={shown === s}
                      style={{
                        fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                        border: `1px solid ${shown === s ? FF.tealDark : FF.border}`,
                        background: shown === s ? FF.tealDark : '#FFFFFF', color: shown === s ? '#FFFFFF' : FF.tealText,
                      }}>
                      {ATT_LABEL[s]}
                    </button>
                  ))}
                </div>
                {isEditing && (
                  <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 8 }}>
                    <input autoFocus value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
                      placeholder={`Reason for changing to ${ATT_LABEL[editing.status]}`}
                      style={{ ...inputStyle, flex: '1 1 220px' }} aria-label="Reason for change" />
                    <Btn variant="primary" disabled={reason.trim().length < 3}
                      onClick={() => void mark(row, editing.status, reason.trim())}>Save</Btn>
                    <Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div style={{ fontSize: 12, color: FF.textFaint, marginTop: 10 }}>{fmtDate(date, true)}</div>
    </Card>
  )
}

function Flagged({ hr, tz }: { hr: HrData; tz: string }) {
  const { sync, queue } = hr
  const { toast } = useToast()
  const [rows, setRows] = useState<AttendanceRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const out = await hrGet<{ attendance: AttendanceRecord[] }>('/api/hr/attendance/flagged')
      setRows(out.attendance); setError(null)
    } catch (e) {
      setError(e instanceof TypeError ? 'Connect to the internet to see flagged check-ins.' : errorText(e))
    }
  }, [])
  useEffect(() => { void load() }, [load, sync.lastSyncAt])

  const reviewing = new Set(sync.pending
    .filter((p): p is OutboxItem<'review_flag'> => p.kind === 'review_flag').map(p => p.payload.attendanceId))
  const visible = (rows ?? []).filter(r => !reviewing.has(r.id))

  const skewText = (s: number | null) => s == null || Math.abs(s) < 60 ? ''
    : ` (phone ${Math.round(Math.abs(s) / 60)} min ${s > 0 ? 'behind' : 'ahead'})`

  return (
    <Card title={`Flagged for review${visible.length ? ` · ${visible.length}` : ''}`}>
      {error ? <Muted>{error}</Muted> : !rows ? <Muted>Loading…</Muted> : visible.length === 0 ? <Muted>Nothing to review.</Muted> : (
        <div className="flex flex-col">
          {visible.map(r => (
            <div key={r.id} className="flex items-start justify-between gap-3 flex-wrap"
              style={{ padding: '10px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
              <div className="min-w-0">
                <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>{r.userName} · {fmtDate(r.workDate)}</div>
                <div style={{ fontSize: 12.5, color: FF.amber }}>
                  {r.flagReasons.map(f => f === 'clock_mismatch'
                    ? flagText(f) + skewText(r.checkInClockSkewS ?? r.checkOutClockSkewS) : flagText(f)).join(' · ')}
                </div>
                <div style={{ fontSize: 12.5, color: FF.textMuted }}>
                  In {fmtTime(r.checkInAt, tz)} · Out {fmtTime(r.checkOutAt, tz)}
                  {(r.checkInOffline || r.checkOutOffline) && ' · recorded offline'}
                  {r.checkInLat != null && r.checkInLng != null && (
                    <> · <a href={mapsLink(r.checkInLat, r.checkInLng)} target="_blank" rel="noreferrer" style={{ color: FF.purple }}>map</a></>
                  )}
                </div>
              </div>
              <Btn onClick={() => queue('review_flag', { attendanceId: r.id }).catch(e => toast(errorText(e), 'error'))}>
                Mark reviewed
              </Btn>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
