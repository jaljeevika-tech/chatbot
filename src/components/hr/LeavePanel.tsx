// "My leave" — balances, apply for leave, my requests, holiday list.
// Applying and cancelling work offline; the day count and balance shown
// here use the same calendar maths as the server (services/hr/dates.js),
// which re-checks everything when the request syncs.

import { useState } from 'react'
import { FF } from '../../theme/colors'
import {
  countLeaveDays, dateInTz, eachDate, isWeeklyOff, leaveOverlaps, leaveYearOf, leaveYearRange,
} from '../../../services/hr/dates'
import { discardPending } from '../../utils/hr/hrSync'
import { useToast } from '../../context/ToastContext'
import type { DayPortion, HrBootstrap, LeaveBalance, OutboxItem } from '../../types/hr'
import type { HrData } from './useHrData'
import {
  Btn, Card, Field, LeaveBadge, Muted, Notice, PORTION_LABEL, SyncBadge, errorText, fmtDate, fmtDays,
  fmtRange, inputStyle,
} from './hrUi'

const ACTIVE = new Set(['pending_manager', 'pending_hr', 'approved'])

export function LeavePanel({ hr, data }: { hr: HrData; data: HrBootstrap }) {
  const { sync, queue } = hr
  const { toast } = useToast()
  const { settings, me } = data
  const today = dateInTz(new Date(), settings.timezone)
  const myHolidays = data.holidays.filter(h => !h.locationId || h.locationId === me.locationId)
  const holidaySet = new Set(myHolidays.map(h => h.date))
  const activeTypes = data.leaveTypes.filter(t => t.isActive)

  const pendingRequests = sync.pending.filter((p): p is OutboxItem<'leave_request'> => p.kind === 'leave_request')
  const pendingCancels = new Set(sync.pending
    .filter((p): p is OutboxItem<'leave_cancel'> => p.kind === 'leave_cancel').map(p => p.payload.requestId))
  const daysOf = (p: OutboxItem<'leave_request'>) =>
    countLeaveDays(p.payload.startDate, p.payload.endDate, p.payload.dayPortion, settings.weeklyOffs, holidaySet)

  // Server balances, minus requests still waiting on this device.
  const balances: LeaveBalance[] = data.balances.map(b => {
    const queued = pendingRequests
      .filter(p => p.payload.leaveTypeId === b.leaveTypeId && leaveYearOf(p.payload.startDate) === data.leaveYear)
      .reduce((sum, p) => sum + daysOf(p), 0)
    return { ...b, pending: b.pending + queued, available: b.available - queued }
  })

  // Apply form
  const [typeId, setTypeId] = useState('')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [portion, setPortion] = useState<DayPortion>('full')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const type = activeTypes.find(t => t.id === typeId)
  const singleDay = start === end
  const effectivePortion: DayPortion = singleDay && type?.allowHalfDay ? portion : 'full'
  let problem: string | null = null
  let days = 0
  let skipped: string[] = []
  if (!type) problem = 'Pick a leave type.'
  else if (!start || !end) problem = 'Pick the dates.'
  else if (end < start) problem = 'The end date is before the start date.'
  else if (leaveYearOf(start) !== leaveYearOf(end)) problem = "A request can't cross 31 March — split it into two."
  else {
    days = countLeaveDays(start, end, effectivePortion, settings.weeklyOffs, holidaySet)
    const range = eachDate(start, end)
    const offs = range.filter(d => isWeeklyOff(d, settings.weeklyOffs)).length
    skipped = [
      ...(offs ? [`${offs} weekly off${offs > 1 ? 's' : ''}`] : []),
      ...myHolidays.filter(h => h.date >= start && h.date <= end).map(h => `${h.name} (${fmtDate(h.date)})`),
    ]
    const bal = balances.find(b => b.leaveTypeId === type.id)
    const mine = [
      ...data.leaveRequests.filter(r => ACTIVE.has(r.status) && !pendingCancels.has(r.id))
        .map(r => ({ start_date: r.startDate, end_date: r.endDate, day_portion: r.dayPortion })),
      ...pendingRequests.map(p => ({ start_date: p.payload.startDate, end_date: p.payload.endDate, day_portion: p.payload.dayPortion })),
    ]
    if (days <= 0) problem = 'Those dates are all weekly offs or holidays — no leave needed.'
    else if (mine.some(m => leaveOverlaps(m, { start_date: start, end_date: end, day_portion: effectivePortion }))) {
      problem = 'You already have leave on some of these dates.'
    } else if (leaveYearOf(start) === data.leaveYear && bal && days > bal.available) {
      problem = `Not enough ${type.name} balance: ${bal.available} day(s) left.`
    }
  }

  async function submit() {
    if (problem || !type) return
    setSaving(true)
    try {
      await queue('leave_request', {
        leaveTypeId: type.id, startDate: start, endDate: end, dayPortion: effectivePortion, reason: reason.trim(),
      })
      toast(navigator.onLine ? 'Leave request sent' : 'Leave request saved — it will be sent when you are online', 'success')
      setReason(''); setPortion('full')
    } catch (e) {
      toast(`Could not save the request: ${errorText(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function cancel(requestId: string) {
    if (!window.confirm('Cancel this leave request?')) return
    try {
      await queue('leave_cancel', { requestId })
    } catch (e) {
      toast(`Could not cancel: ${errorText(e)}`, 'error')
    }
  }

  async function discard(clientId: string) {
    if (!(await discardPending(clientId))) toast('Syncing right now — try again in a moment.', 'info')
  }

  const typeName = (id: string) => data.leaveTypes.find(t => t.id === id)?.name ?? 'Leave'
  const fy = leaveYearRange(data.leaveYear)

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Leave balance · Apr ${data.leaveYear} – Mar ${data.leaveYear + 1}`}>
        {balances.length === 0 ? <Muted>No leave types have been set up yet. Ask an admin to add them under Settings.</Muted> : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {balances.map(b => (
              <div key={b.leaveTypeId} style={{ border: `1px solid ${FF.borderSoft}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 12.5, color: FF.textMuted }}>{b.name}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: b.available < 0 ? FF.red : FF.tealDark }}>
                  {b.available}<span style={{ fontSize: 13, color: FF.textFaint, fontWeight: 400 }}> / {b.quota}</span>
                </div>
                <div style={{ fontSize: 11.5, color: FF.textFaint }}>
                  {b.used} used{b.pending ? ` · ${b.pending} pending` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {activeTypes.length > 0 && (
        <Card title="Apply for leave">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Leave type">
              <select value={typeId} onChange={e => setTypeId(e.target.value)} style={inputStyle}>
                <option value="">Choose…</option>
                {activeTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <input type="date" value={start} onChange={e => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value) }} style={inputStyle} />
              </Field>
              <Field label="To">
                <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} style={inputStyle} />
              </Field>
            </div>
            {singleDay && type?.allowHalfDay && (
              <Field label="Day">
                <select value={portion} onChange={e => setPortion(e.target.value as DayPortion)} style={inputStyle}>
                  {(Object.keys(PORTION_LABEL) as DayPortion[]).map(p => <option key={p} value={p}>{PORTION_LABEL[p]}</option>)}
                </select>
              </Field>
            )}
            <div className="sm:col-span-2">
              <Field label="Reason (optional)">
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={1000} style={inputStyle} />
              </Field>
            </div>
          </div>
          <div className="flex flex-col gap-3" style={{ marginTop: 12 }}>
            {problem && type ? <Notice tone="red">{problem}</Notice> : type && (
              <div style={{ fontSize: 13, color: FF.tealText }}>
                This uses <b>{fmtDays(days)}</b> of {type.name}
                {skipped.length > 0 && <span style={{ color: FF.textMuted }}> — not counted: {skipped.join(', ')}</span>}
              </div>
            )}
            <div>
              <Btn variant="primary" onClick={submit} disabled={!!problem || saving}>
                {saving ? 'Saving…' : 'Send request'}
              </Btn>
            </div>
            <div style={{ fontSize: 12, color: FF.textFaint }}>
              Goes to {me.managerId ? 'your reporting manager, then HR' : 'HR'} for approval.
            </div>
          </div>
        </Card>
      )}

      <Card title="My requests">
        {pendingRequests.length === 0 && data.leaveRequests.length === 0 ? <Muted>No leave requests yet.</Muted> : (
          <div className="flex flex-col">
            {pendingRequests.map(p => (
              <div key={p.clientId} className="flex items-start justify-between gap-3 flex-wrap"
                style={{ padding: '10px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>
                    {typeName(p.payload.leaveTypeId)} · {fmtDays(daysOf(p))}
                  </div>
                  <div style={{ fontSize: 12.5, color: FF.textMuted }}>
                    {fmtRange(p.payload.startDate, p.payload.endDate)}
                    {p.payload.dayPortion !== 'full' && ` · ${PORTION_LABEL[p.payload.dayPortion]}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <SyncBadge />
                  <Btn variant="ghost" onClick={() => discard(p.clientId)}>Discard</Btn>
                </div>
              </div>
            ))}
            {data.leaveRequests.map(r => {
              const cancellable = !pendingCancels.has(r.id)
                && (r.status === 'pending_manager' || r.status === 'pending_hr' || (r.status === 'approved' && r.startDate >= today))
              return (
                <div key={r.id} className="flex items-start justify-between gap-3 flex-wrap"
                  style={{ padding: '10px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
                  <div className="min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>
                      {r.leaveTypeName} · {fmtDays(r.days)}
                    </div>
                    <div style={{ fontSize: 12.5, color: FF.textMuted }}>
                      {fmtRange(r.startDate, r.endDate)}
                      {r.dayPortion !== 'full' && ` · ${PORTION_LABEL[r.dayPortion]}`}
                      {r.reason && ` · ${r.reason}`}
                    </div>
                    {r.managerComment && <div style={{ fontSize: 12, color: FF.textFaint }}>Manager: {r.managerComment}</div>}
                    {r.hrComment && <div style={{ fontSize: 12, color: FF.textFaint }}>HR: {r.hrComment}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {pendingCancels.has(r.id) ? <><SyncBadge /><span style={{ fontSize: 12, color: FF.textMuted }}>Cancelling</span></>
                      : <LeaveBadge status={r.status} />}
                    {cancellable && <Btn variant="ghost" onClick={() => cancel(r.id)}>Cancel</Btn>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Holidays this year">
        {myHolidays.filter(h => h.date >= fy.from && h.date <= fy.to).length === 0 ? <Muted>No holidays listed.</Muted> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            {myHolidays.filter(h => h.date >= fy.from && h.date <= fy.to).map(h => (
              <div key={h.id} className="flex justify-between gap-3"
                style={{ padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}`, fontSize: 13.5, color: h.date < today ? FF.textFaint : FF.tealText }}>
                <span>{h.name}</span><span>{fmtDate(h.date)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
