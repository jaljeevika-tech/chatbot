// "My attendance" — check in / check out with GPS, plus recent history.
// Works offline: the tap is saved to the outbox with the phone's time and
// synced later; the server corrects for a wrong phone clock and flags it.

import { Suspense, lazy, useEffect, useState } from 'react'
import { LogIn, LogOut, MapPin, Loader2, Map as MapIcon, Timer } from 'lucide-react'
import { FF } from '../../theme/colors'
import { addDays, dateInTz } from '../../../services/hr/dates'
import { getLocationFix, mapsLink } from '../../utils/hr/geo'
import { useToast } from '../../context/ToastContext'
import type { AttendanceRecord, HrBootstrap, LocationFix, OutboxItem, Shift } from '../../types/hr'
import type { HrData } from './useHrData'
import type { MapPoint } from './HrMap'
import {
  AttendanceBadge, Btn, Card, Muted, Notice, PORTION_LABEL, SyncBadge, errorText, flagText, fmtClock, fmtDate, fmtMinutes, fmtTime,
} from './hrUi'

const HrMap = lazy(() => import('./HrMap'))

/** Live "worked so far" since check-in, against the shift length if there is one. */
function WorkTimer({ since, shift }: { since: string; shift: Shift | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const secs = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60
  const target = shift?.requiredMinutes ?? null   // missing in data saved before hours-based shifts
  const pct = target ? Math.min(100, (secs / 60 / target) * 100) : null
  return (
    <div role="timer" aria-label="Time since check-in" style={{ background: FF.bg, borderRadius: 10, padding: '12px 14px' }}>
      <div className="flex items-center gap-2" style={{ color: FF.tealDark }}>
        <Timer className="w-5 h-5" />
        <span style={{ fontSize: 28, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: 0.5 }}>
          {String(hh).padStart(2, '0')}:{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
        </span>
        <span style={{ fontSize: 12.5, color: FF.textMuted }}>worked so far</span>
      </div>
      {target != null && pct != null && (
        <>
          <div style={{ height: 6, background: FF.borderSoft, borderRadius: 4, marginTop: 8, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? FF.green : FF.purple }} />
          </div>
          <div style={{ fontSize: 12, color: FF.textMuted, marginTop: 4 }}>
            {pct >= 100 ? `Shift complete (${fmtMinutes(target)})`
              : `${fmtMinutes(Math.max(0, target - Math.floor(secs / 60)))} to go of ${fmtMinutes(target)} today`}
          </div>
        </>
      )}
    </div>
  )
}



interface DayView {
  date: string
  record: AttendanceRecord | null
  pendingIn: OutboxItem<'check_in'> | null
  pendingOut: OutboxItem<'check_out'> | null
}

export function AttendancePanel({ hr, data }: { hr: HrData; data: HrBootstrap }) {
  const { sync, queue } = hr
  const { toast } = useToast()
  const [busy, setBusy] = useState<null | 'locating' | 'saving'>(null)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [showMap, setShowMap] = useState(false)
  const { settings } = data
  const myShift = data.myShift ?? null   // absent in data saved before shifts existed
  const tz = settings.timezone
  const today = dateInTz(new Date(), tz)

  const pendingIns = sync.pending.filter((p): p is OutboxItem<'check_in'> => p.kind === 'check_in')
  const pendingOuts = sync.pending.filter((p): p is OutboxItem<'check_out'> => p.kind === 'check_out')

  const days = ((): DayView[] => {
    const byDate = new Map<string, DayView>()
    const get = (date: string) => {
      if (!byDate.has(date)) byDate.set(date, { date, record: null, pendingIn: null, pendingOut: null })
      return byDate.get(date)!
    }
    for (const r of data.attendance) get(r.workDate).record = r
    for (const p of pendingIns) get(dateInTz(new Date(p.createdAt), tz)).pendingIn = p
    // A check-out belongs to the most recent open day at or before it.
    for (const p of pendingOuts) {
      const d = dateInTz(new Date(p.createdAt), tz)
      const open = [d, addDays(d, -1)].map(x => byDate.get(x))
        .find(v => v && (v.pendingIn || v.record?.checkInAt) && !v.record?.checkOutAt && !v.pendingOut)
      ;(open ?? get(d)).pendingOut = p
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
  })()

  const isCheckedIn = (v?: DayView) => !!(v && (v.pendingIn || v.record?.checkInAt))
  const isCheckedOut = (v?: DayView) => !!(v && (v.pendingOut || v.record?.checkOutAt))
  const todayView = days.find(v => v.date === today)
  const yesterdayView = days.find(v => v.date === addDays(today, -1))
  const openView = isCheckedIn(todayView) && !isCheckedOut(todayView) ? todayView
    : !isCheckedIn(todayView) && isCheckedIn(yesterdayView) && !isCheckedOut(yesterdayView) ? yesterdayView
    : undefined
  // Approved leave today (the server enforces the same rule). Queued cancels unblock it.
  const pendingCancels = new Set(sync.pending
    .filter((p): p is OutboxItem<'leave_cancel'> => p.kind === 'leave_cancel').map(p => p.payload.requestId))
  const todayLeave = data.leaveRequests
    .filter(r => r.status === 'approved' && r.startDate <= today && r.endDate >= today && !pendingCancels.has(r.id))
    .sort((a, b) => Number(b.dayPortion === 'full') - Number(a.dayPortion === 'full'))[0]

  async function locate(): Promise<LocationFix | null | undefined> {
    setGpsError(null)
    if (settings.gpsMode === 'off') return null
    setBusy('locating')
    const fix = await getLocationFix()
    if (fix.status === 'denied' && settings.gpsMode === 'required') {
      setGpsError('Location access is required to check in. Allow location for this site in your browser settings, then try again.')
      setBusy(null)
      return undefined
    }
    return fix
  }

  async function doCheckIn(mode: 'office' | 'field') {
    const location = await locate()
    if (location === undefined) return
    setBusy('saving')
    try {
      await queue('check_in', { mode, location })
      toast(navigator.onLine ? 'Checked in' : 'Checked in — saved on this device, will sync when online', 'success')
    } catch (e) {
      toast(`Could not save your check-in: ${errorText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function doCheckOut() {
    const location = await locate()
    if (location === undefined) return
    setBusy('saving')
    try {
      await queue('check_out', { location })
      toast(navigator.onLine ? 'Checked out' : 'Checked out — saved on this device, will sync when online', 'success')
    } catch (e) {
      toast(`Could not save your check-out: ${errorText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const inTime = (v: DayView) => v.record?.checkInAt ?? v.pendingIn?.createdAt ?? null
  const outTime = (v: DayView) => v.record?.checkOutAt ?? v.pendingOut?.createdAt ?? null

  // Map pins: green = check-in, purple = check-out.
  const points: MapPoint[] = days.flatMap(v => {
    const r = v.record
    const out: MapPoint[] = []
    const inLat = r?.checkInLat ?? v.pendingIn?.payload.location?.lat
    const inLng = r?.checkInLng ?? v.pendingIn?.payload.location?.lng
    if (inLat != null && inLng != null) {
      out.push({ key: `${v.date}-in`, lat: inLat, lng: inLng, color: FF.green, title: `${fmtDate(v.date)} · in ${fmtTime(inTime(v), tz)}` })
    }
    const outLat = r?.checkOutLat ?? v.pendingOut?.payload.location?.lat
    const outLng = r?.checkOutLng ?? v.pendingOut?.payload.location?.lng
    if (outLat != null && outLng != null) {
      out.push({ key: `${v.date}-out`, lat: outLat, lng: outLng, color: FF.purple, title: `${fmtDate(v.date)} · out ${fmtTime(outTime(v), tz)}` })
    }
    return out
  })

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Today · ${fmtDate(today)}`}>
        <div className="flex flex-col gap-3">
          {openView ? (
            <>
              <div style={{ fontSize: 14, color: FF.tealText }}>
                {openView.date === today ? 'Checked in' : `Still checked in from ${fmtDate(openView.date)}`} at{' '}
                <b>{fmtTime(inTime(openView), tz)}</b>
                {openView.pendingIn && <span style={{ marginLeft: 8 }}><SyncBadge /></span>}
                {!!openView.record?.lateMinutes && <span style={{ marginLeft: 8, color: FF.amber }}>Late by {openView.record.lateMinutes} min</span>}
              </div>
              <WorkTimer since={inTime(openView)!} shift={myShift} />
              <Btn variant="primary" big onClick={doCheckOut} disabled={!!busy}>
                <span className="inline-flex items-center gap-2"><LogOut className="w-4 h-4" /> Check out</span>
              </Btn>
            </>
          ) : isCheckedOut(todayView) ? (
            <div style={{ fontSize: 14, color: FF.tealText }}>
              Done for today: in at <b>{fmtTime(inTime(todayView!), tz)}</b>, out at <b>{fmtTime(outTime(todayView!), tz)}</b>
              {(todayView!.pendingIn || todayView!.pendingOut) && <span style={{ marginLeft: 8 }}><SyncBadge /></span>}
            </div>
          ) : todayView?.record && !todayView.record.checkInAt ? (
            <div className="flex flex-col gap-3">
              <div style={{ fontSize: 14, color: FF.tealText }}>
                Your manager marked you <AttendanceBadge status={todayView.record.status} /> today.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Btn variant="primary" big onClick={() => doCheckIn('office')} disabled={!!busy}>Check in anyway</Btn>
              </div>
            </div>
          ) : todayLeave?.dayPortion === 'full' ? (
            <Notice tone="amber">
              You are on approved {todayLeave.leaveTypeName} today. Cancel the leave in the Leave tab to mark attendance.
            </Notice>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {todayLeave && (
                <div className="sm:col-span-2"><Notice tone="amber">
                  Half-day leave today ({PORTION_LABEL[todayLeave.dayPortion]}) — today counts as a half day.
                </Notice></div>
              )}
              <Btn variant="primary" big onClick={() => doCheckIn('office')} disabled={!!busy}>
                <span className="inline-flex items-center gap-2"><LogIn className="w-4 h-4" /> Check in · Office</span>
              </Btn>
              <Btn big onClick={() => doCheckIn('field')} disabled={!!busy}>
                <span className="inline-flex items-center gap-2"><MapPin className="w-4 h-4" /> Check in · On field</span>
              </Btn>
            </div>
          )}
          {busy && (
            <div className="inline-flex items-center gap-2" style={{ fontSize: 13, color: FF.textMuted }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              {busy === 'locating' ? 'Getting your location…' : 'Saving…'}
            </div>
          )}
          {gpsError && <Notice tone="red">{gpsError}</Notice>}
          {myShift && (
            <div style={{ fontSize: 12.5, color: FF.textMuted }}>
              Shift: <b style={{ fontWeight: 600 }}>{myShift.name}</b>{myShift.requiredMinutes != null && <> · {fmtMinutes(myShift.requiredMinutes)} a day</>}
              {myShift.startTime && myShift.endTime && <> · {fmtClock(myShift.startTime)} – {fmtClock(myShift.endTime)}, {myShift.graceMinutes} min grace</>}
            </div>
          )}
          <div style={{ fontSize: 12, color: FF.textFaint }}>
            {settings.gpsMode === 'off' ? 'Location is not recorded.'
              : settings.gpsMode === 'required' ? 'Your location is recorded at check-in and check-out (required).'
              : 'Your location is recorded at check-in and check-out if you allow it.'}
          </div>
        </div>
      </Card>

      <Card title="Last 60 days" action={points.length > 0 && (
        <Btn variant="ghost" onClick={() => setShowMap(s => !s)}>
          <span className="inline-flex items-center gap-1.5"><MapIcon className="w-4 h-4" /> {showMap ? 'Hide map' : 'Show map'}</span>
        </Btn>
      )}>
        {showMap && (
          <div style={{ marginBottom: 12 }}>
            <Suspense fallback={<Muted>Loading map…</Muted>}><HrMap points={points} height={260} /></Suspense>
          </div>
        )}
        {days.length === 0 ? <Muted>No attendance recorded yet.</Muted> : (
          <div className="flex flex-col">
            {days.map(v => {
              const r = v.record
              const lat = r?.checkInLat ?? v.pendingIn?.payload.location?.lat
              const lng = r?.checkInLng ?? v.pendingIn?.payload.location?.lng
              return (
                <div key={v.date} className="flex items-start justify-between gap-3 flex-wrap"
                  style={{ padding: '10px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
                  <div className="min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>{fmtDate(v.date)}</div>
                    <div style={{ fontSize: 12.5, color: FF.textMuted, marginTop: 2 }}>
                      In {fmtTime(inTime(v), tz)} · Out {fmtTime(outTime(v), tz)}
                      {r?.workedMinutes != null && ` · ${fmtMinutes(r.workedMinutes)}`}
                      {!!r?.lateMinutes && <span style={{ color: FF.amber }}> · late {r.lateMinutes}m</span>}
                      {!!r?.earlyLeaveMinutes && <span style={{ color: FF.amber }}> · left {r.earlyLeaveMinutes}m early</span>}
                      {lat != null && lng != null && (
                        <> · <a href={mapsLink(lat, lng)} target="_blank" rel="noreferrer" style={{ color: FF.purple }}>map</a></>
                      )}
                      {r?.source === 'manager' && ' · marked by manager'}
                    </div>
                    {r?.flagReasons.length ? (
                      <div style={{ fontSize: 12, color: FF.amber, marginTop: 2 }}>
                        {r.flagReasons.map(flagText).join(' · ')}{r.reviewedAt ? ' (reviewed)' : ''}
                      </div>
                    ) : null}
                    {r?.note && <div style={{ fontSize: 12, color: FF.textFaint, marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {(v.pendingIn || v.pendingOut) && <SyncBadge />}
                    {r ? <AttendanceBadge status={r.status} />
                      : v.pendingIn ? <AttendanceBadge status={v.pendingIn.payload.mode === 'field' ? 'on_field' : 'present'} />
                      : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
