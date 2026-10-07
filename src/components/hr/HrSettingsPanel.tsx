// "Settings" (admins) — attendance rules, shifts, notifications, leave
// types, work locations, holidays, and per-employee reporting manager / HR
// flag / location / shift / email. Online only.

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { FF } from '../../theme/colors'
import { leaveYearRange } from '../../../services/hr/dates'
import { useToast } from '../../context/ToastContext'
import { useReportContext } from '../../context/ReportContext'
import type { GpsMode, Holiday, HrBootstrap, LeaveType, NotifyEvent, NotifySettings, Shift, TeamMember } from '../../types/hr'
import { hrGet, hrSend } from './useHrData'
import { createApprovalTemplate } from '../../utils/waApprovalTemplate'
import { Btn, Card, Field, Muted, Notice, errorText, fmtClock, fmtDate, fmtMinutes, inputStyle } from './hrUi'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const OFF_PRESETS: { label: string; value: number[] }[] = [
  { label: 'Working day', value: [] },
  { label: 'Off every week', value: [1, 2, 3, 4, 5] },
  { label: 'Off 2nd & 4th', value: [2, 4] },
  { label: 'Off 1st & 3rd', value: [1, 3] },
  { label: 'Off 1st, 3rd & 5th', value: [1, 3, 5] },
]
const presetKey = (v: number[] | undefined) => (v ?? []).slice().sort().join(',')

const GPS_OPTIONS: { value: GpsMode; label: string; hint: string }[] = [
  { value: 'optional', label: 'Record if allowed', hint: 'Location is saved when the phone allows it; check-in never blocked.' },
  { value: 'required', label: 'Required', hint: 'Check-in is blocked if the person refuses location access. If GPS just fails, it goes through and is flagged.' },
  { value: 'off', label: 'Off', hint: 'No location is recorded.' },
]

export function HrSettingsPanel({ data, onChanged }: { data: HrBootstrap; onChanged: () => Promise<void> }) {
  const { toast } = useToast()
  const run = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn()
      await onChanged()
      if (done) toast(done, 'success')
      return true
    } catch (e) {
      toast(e instanceof TypeError ? 'You need an internet connection to change settings.' : errorText(e), 'error')
      return false
    }
  }, [onChanged, toast])

  return (
    <div className="flex flex-col gap-4">
      <AttendanceRules data={data} run={run} />
      <Shifts data={data} run={run} />
      <Employees data={data} run={run} />
      <Notifications data={data} run={run} />
      <LeaveTypes types={data.leaveTypes} run={run} />
      <Locations data={data} run={run} />
      <Holidays data={data} run={run} />
    </div>
  )
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>

function AttendanceRules({ data, run }: { data: HrBootstrap; run: Run }) {
  const [gpsMode, setGpsMode] = useState(data.settings.gpsMode)
  const [skew, setSkew] = useState(String(data.settings.clockSkewMinutes))
  const [offs, setOffs] = useState(data.settings.weeklyOffs)
  const save = () => run(() => hrSend('/api/hr/settings', 'PUT', {
    gpsMode, clockSkewMinutes: Number(skew), weeklyOffs: offs,
  }), 'Attendance rules saved')

  return (
    <Card title="Attendance rules">
      <div className="flex flex-col gap-4">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12.5, color: FF.textMuted, fontWeight: 500, marginBottom: 6 }}>GPS at check-in</legend>
          <div className="flex flex-col gap-2">
            {GPS_OPTIONS.map(o => (
              <label key={o.value} className="flex gap-2 items-start" style={{ fontSize: 13.5, color: FF.tealText, cursor: 'pointer' }}>
                <input type="radio" name="gps" checked={gpsMode === o.value} onChange={() => setGpsMode(o.value)} style={{ marginTop: 3 }} />
                <span><b style={{ fontWeight: 600 }}>{o.label}</b> — <span style={{ color: FF.textMuted }}>{o.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div style={{ maxWidth: 260 }}>
          <Field label="Flag check-ins when the phone clock is off by more than (minutes)">
            <input type="number" min={1} max={240} value={skew} onChange={e => setSkew(e.target.value)} style={inputStyle} />
          </Field>
        </div>
        <div>
          <div style={{ fontSize: 12.5, color: FF.textMuted, fontWeight: 500, marginBottom: 6 }}>Weekly offs</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {WEEKDAYS.map((name, i) => {
              const current = presetKey(offs[String(i)])
              const known = OFF_PRESETS.some(p => presetKey(p.value) === current)
              return (
                <Field key={name} label={name}>
                  <select value={current} style={inputStyle} onChange={e => {
                    const value = e.target.value ? e.target.value.split(',').map(Number) : []
                    const next = { ...offs }
                    if (value.length) next[String(i)] = value
                    else delete next[String(i)]
                    setOffs(next)
                  }}>
                    {OFF_PRESETS.map(p => <option key={p.label} value={presetKey(p.value)}>{p.label}</option>)}
                    {!known && <option value={current}>Custom ({current})</option>}
                  </select>
                </Field>
              )
            })}
          </div>
        </div>
        <div><Btn variant="primary" onClick={() => void save()}>Save rules</Btn></div>
      </div>
    </Card>
  )
}

function LeaveTypes({ types, run }: { types: LeaveType[]; run: Run }) {
  const [name, setName] = useState('')
  const [quota, setQuota] = useState('12')
  const [halfDay, setHalfDay] = useState(true)

  async function add() {
    const ok = await run(() => hrSend('/api/hr/leave-types', 'POST', {
      name: name.trim(), annualQuota: Number(quota), allowHalfDay: halfDay,
    }), `Added ${name.trim()}`)
    if (ok) { setName(''); setQuota('12') }
  }

  return (
    <Card title="Leave types">
      <div style={{ fontSize: 12.5, color: FF.textFaint, marginBottom: 10 }}>
        Yearly quota per person, April to March. Unused days don't carry forward.
      </div>
      {types.length === 0 ? <Muted>No leave types yet — add Casual, Sick, Earned etc. below.</Muted> : (
        <div className="flex flex-col">
          {types.map(t => <LeaveTypeRow key={t.id} t={t} run={run} />)}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto_auto] gap-2 items-end" style={{ marginTop: 12 }}>
        <Field label="New leave type"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Casual Leave" style={inputStyle} /></Field>
        <Field label="Days per year"><input type="number" min={0} max={365} step={0.5} value={quota} onChange={e => setQuota(e.target.value)} style={inputStyle} /></Field>
        <label className="flex items-center gap-2" style={{ fontSize: 13, color: FF.tealText, paddingBottom: 9 }}>
          <input type="checkbox" checked={halfDay} onChange={e => setHalfDay(e.target.checked)} /> Half days
        </label>
        <Btn variant="primary" onClick={() => void add()} disabled={!name.trim()}>Add</Btn>
      </div>
    </Card>
  )
}

function LeaveTypeRow({ t, run }: { t: LeaveType; run: Run }) {
  const [quota, setQuota] = useState(String(t.annualQuota))
  const update = (patch: Partial<LeaveType>) => run(() => hrSend(`/api/hr/leave-types/${t.id}`, 'PUT', patch), 'Saved')
  return (
    <div className="flex items-center gap-3 flex-wrap" style={{ padding: '8px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
      <span style={{ flex: '1 1 160px', fontSize: 14, color: t.isActive ? FF.tealDark : FF.textFaint }}>
        {t.name}{!t.isActive && ' (switched off)'}
      </span>
      <input type="number" min={0} max={365} step={0.5} value={quota} aria-label={`${t.name} days per year`}
        onChange={e => setQuota(e.target.value)}
        onBlur={() => { if (Number(quota) !== t.annualQuota) void update({ annualQuota: Number(quota) }) }}
        style={{ ...inputStyle, width: 90 }} />
      <label className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: FF.textMuted }}>
        <input type="checkbox" checked={t.allowHalfDay} onChange={e => void update({ allowHalfDay: e.target.checked })} /> Half days
      </label>
      <Btn variant="ghost" onClick={() => void update({ isActive: !t.isActive })}>{t.isActive ? 'Switch off' : 'Switch on'}</Btn>
    </div>
  )
}

function Shifts({ data, run }: { data: HrBootstrap; run: Run }) {
  const shifts = data.shifts ?? []
  const [editing, setEditing] = useState<Shift | 'new' | null>(null)
  return (
    <Card title="Shifts" action={!editing && <Btn variant="primary" onClick={() => setEditing('new')}>Add shift</Btn>}>
      <div style={{ fontSize: 12.5, color: FF.textFaint, marginBottom: 10 }}>
        A shift is the hours a person should work each day — no fixed time needed for field staff.
        Each person follows their own shift if set, otherwise their location's, otherwise the default.
        A day shorter than the full-day minimum becomes a half day; time beyond the daily hours is overtime.
        Add start/end times only for office shifts — they also mark late arrival and early leaving.
      </div>
      {shifts.length === 0 && !editing && <Muted>No shifts yet — without one, nobody is marked late and no reminders are sent.</Muted>}
      {shifts.map(s => editing !== 'new' && editing?.id === s.id
        ? <ShiftForm key={s.id} shift={s} run={run} onDone={() => setEditing(null)} />
        : (
          <div key={s.id} className="flex items-center justify-between gap-3 flex-wrap"
            style={{ padding: '9px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>
                {s.name}{s.isDefault && <span style={{ marginLeft: 8, fontSize: 11, color: FF.purple, fontWeight: 600 }}>DEFAULT</span>}
              </div>
              <div style={{ fontSize: 12.5, color: FF.textMuted }}>
                {fmtMinutes(s.requiredMinutes)} a day · full day from {fmtMinutes(s.minFullDayMinutes)}
                {s.startTime && s.endTime
                  ? <> · {fmtClock(s.startTime)} – {fmtClock(s.endTime)}{s.endTime < s.startTime ? ' (next day)' : ''}, {s.graceMinutes} min grace</>
                  : ' · any time of day'}
              </div>
            </div>
            <div className="flex gap-1">
              <Btn variant="ghost" onClick={() => setEditing(s)}>Edit</Btn>
              <Btn variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => {
                if (window.confirm(`Delete the ${s.name} shift? People on it fall back to their location's shift or the default.`)) {
                  void run(() => hrSend(`/api/hr/shifts/${s.id}`, 'DELETE'), 'Shift deleted')
                }
              }}><Trash2 className="w-4 h-4" /></Btn>
            </div>
          </div>
        ))}
      {editing === 'new' && <ShiftForm run={run} onDone={() => setEditing(null)} />}
    </Card>
  )
}

function ShiftForm({ shift, run, onDone }: { shift?: Shift; run: Run; onDone: () => void }) {
  const [name, setName] = useState(shift?.name ?? '')
  const [hours, setHours] = useState(String((shift?.requiredMinutes ?? 480) / 60))
  const [minHours, setMinHours] = useState(String((shift?.minFullDayMinutes ?? 360) / 60))
  const [timed, setTimed] = useState(!!shift?.startTime)
  const [start, setStart] = useState(shift?.startTime ?? '09:30')
  const [end, setEnd] = useState(shift?.endTime ?? '18:00')
  const [grace, setGrace] = useState(String(shift?.graceMinutes ?? 15))
  const [isDefault, setIsDefault] = useState(shift?.isDefault ?? false)
  async function save() {
    const body = {
      name: name.trim(), requiredMinutes: Math.round(Number(hours) * 60), minFullDayMinutes: Math.round(Number(minHours) * 60),
      startTime: timed ? start : null, endTime: timed ? end : null, graceMinutes: Number(grace), isDefault,
    }
    const ok = await run(() => shift ? hrSend(`/api/hr/shifts/${shift.id}`, 'PUT', body) : hrSend('/api/hr/shifts', 'POST', body),
      shift ? 'Shift saved' : 'Shift added')
    if (ok) onDone()
  }
  return (
    <div className="flex flex-col gap-2" style={{ padding: '10px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
        <div className="col-span-2 sm:col-span-1"><Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="Field staff" style={inputStyle} /></Field></div>
        <Field label="Hours a day"><input type="number" min={0.5} max={24} step={0.5} value={hours} onChange={e => setHours(e.target.value)} style={inputStyle} /></Field>
        <Field label="Full day from (h)" hint="Less = half day"><input type="number" min={0} max={24} step={0.5} value={minHours} onChange={e => setMinHours(e.target.value)} style={inputStyle} /></Field>
        <label className="flex items-center gap-2" style={{ fontSize: 13, color: FF.tealText, paddingBottom: 9 }}>
          <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} /> Default shift
        </label>
      </div>
      <label className="flex items-center gap-2" style={{ fontSize: 13, color: FF.tealText }}>
        <input type="checkbox" checked={timed} onChange={e => setTimed(e.target.checked)} />
        Fixed timing (office shifts only — marks late arrival and early leaving)
      </label>
      {timed && (
        <div className="grid grid-cols-3 gap-2 items-end" style={{ maxWidth: 480 }}>
          <Field label="Starts"><input type="time" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} /></Field>
          <Field label="Ends"><input type="time" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} /></Field>
          <Field label="Grace (min)"><input type="number" min={0} max={240} value={grace} onChange={e => setGrace(e.target.value)} style={inputStyle} /></Field>
        </div>
      )}
      <div className="flex gap-2">
        <Btn variant="primary" disabled={!name.trim()} onClick={() => void save()}>{shift ? 'Save' : 'Add'}</Btn>
        <Btn variant="ghost" onClick={onDone}>Cancel</Btn>
      </div>
    </div>
  )
}

const EVENT_LABEL: Record<NotifyEvent, string> = {
  leaveRequested:   'Leave requested → the approver (manager, then HR)',
  leaveDecided:     'Leave submitted / manager approved / final decision → the employee (final decision → their manager too)',
  leaveCancelled:   'Leave cancelled by the employee → the manager / HR',
  attendanceMarked: 'Attendance marked or corrected by a manager → the employee',
  checkInOut:       'Check-in / check-out receipt → the employee',
  missedCheckIn:    'No check-in yet → the employee (people with a shift)',
  checkOutReminder: 'Still checked in → reminder to the employee',
  autoCheckOut:     'Not checked out → check out automatically (flagged for review) and tell the employee',
  approvalReminder: 'Leave waiting → daily reminder to the approver; HR when stuck with a manager',
  leaveTomorrow:    'Leave starts tomorrow → the employee and their manager',
}

// Events with a time setting (org-local HH:MM).
const EVENT_TIME: Partial<Record<NotifyEvent, keyof NotifySettings>> = {
  missedCheckIn: 'reminderTime', checkOutReminder: 'checkOutReminderTime', autoCheckOut: 'autoCheckOutTime',
  approvalReminder: 'approvalReminderTime', leaveTomorrow: 'approvalReminderTime',
}

function Notifications({ data, run }: { data: HrBootstrap; run: Run }) {
  const { toast } = useToast()
  const saved = data.settings.notifications
  const [n, setN] = useState<NotifySettings | undefined>(saved)
  const [testing, setTesting] = useState(false)
  const [testOut, setTestOut] = useState<{ hints: string[]; results: { channel: string; ok: boolean; error?: string }[] } | null>(null)
  useEffect(() => { setN(saved) }, [saved])
  if (!n) return null
  const set = (patch: Partial<NotifySettings>) => setN({ ...n, ...patch })

  async function test() {
    setTesting(true); setTestOut(null)
    try { setTestOut(await hrSend('/api/hr/notifications/test', 'POST')) }
    catch (e) { toast(errorText(e), 'error') }
    finally { setTesting(false) }
  }

  return (
    <Card title="Notifications (WhatsApp & email)">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2" style={{ fontSize: 14, color: FF.tealDark, fontWeight: 500 }}>
              <input type="checkbox" checked={n.emailEnabled} onChange={e => set({ emailEnabled: e.target.checked })} /> Email
            </label>
            <div style={{ fontSize: 12.5, color: data.settings.emailConfigured ? FF.textMuted : FF.amber }}>
              {data.settings.emailConfigured
                ? 'Sent from the organisation’s Gmail/Workspace account to each person’s email under Employees.'
                : 'The server has no email account set up yet (SMTP_USER / SMTP_PASS) — nothing will be emailed until it is.'}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2" style={{ fontSize: 14, color: FF.tealDark, fontWeight: 500 }}>
              <input type="checkbox" checked={n.whatsappEnabled} onChange={e => set({ whatsappEnabled: e.target.checked })} /> WhatsApp
            </label>
            <div className="grid grid-cols-[2fr_1fr] gap-2">
              <Field label="Approved template name" hint="One utility template with a single {{1}} in the body — the same kind Finance uses.">
                <input value={n.whatsappTemplate} onChange={e => set({ whatsappTemplate: e.target.value.trim() })}
                  placeholder="fieldflow_update" style={inputStyle} />
              </Field>
              <Field label="Language"><input value={n.whatsappLang} onChange={e => set({ whatsappLang: e.target.value.trim() })} style={inputStyle} /></Field>
            </div>
            <Field label="Approval template (optional)" hint="Same {{1}} body plus one Quick reply button “Approve”. Leave requests then get an Approve button on WhatsApp.">
              <input value={n.whatsappApprovalTemplate ?? ''} onChange={e => set({ whatsappApprovalTemplate: e.target.value.trim() })}
                placeholder="fieldflow_approval" style={inputStyle} />
            </Field>
            <div>
              <Btn onClick={() => void createApprovalTemplate(n.whatsappLang)
                .then(r => { set({ whatsappApprovalTemplate: r.name }); toast(r.message, 'success') })
                .catch(e => toast(errorText(e), 'error'))}>Create it in Meta for me</Btn>
            </div>
          </div>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12.5, color: FF.textMuted, fontWeight: 500, marginBottom: 6 }}>Send when</legend>
          <div className="flex flex-col gap-1.5">
            {(Object.keys(EVENT_LABEL) as NotifyEvent[]).map(ev => (
              <label key={ev} className="flex items-center gap-2" style={{ fontSize: 13.5, color: FF.tealText }}>
                <input type="checkbox" checked={n.events[ev]} onChange={e => set({ events: { ...n.events, [ev]: e.target.checked } })} />
                {EVENT_LABEL[ev]}
                {EVENT_TIME[ev] && (
                  <span className="inline-flex items-center gap-1">
                    {' '}— at <input type="time" value={String(n[EVENT_TIME[ev]!] ?? '')} aria-label={`${EVENT_LABEL[ev]} time`}
                      onChange={e => set({ [EVENT_TIME[ev]!]: e.target.value })} style={{ ...inputStyle, width: 110, padding: '3px 6px' }} />
                  </span>
                )}
                {ev === 'approvalReminder' && (
                  <span className="inline-flex items-center gap-1">
                    , escalate after <input type="number" min={1} max={30} value={n.escalateAfterDays ?? 2} aria-label="Escalate after days"
                      onChange={e => set({ escalateAfterDays: Number(e.target.value) })} style={{ ...inputStyle, width: 64, padding: '3px 6px' }} /> days
                  </span>
                )}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, color: FF.textFaint, marginTop: 6 }}>
            Receipts and reminders can mean several messages per person per day — on WhatsApp each one is billed by Meta.
          </div>
        </fieldset>
        <div className="flex gap-2 flex-wrap">
          <Btn variant="primary" onClick={() => void run(() => hrSend('/api/hr/settings', 'PUT', { notifications: n }), 'Notification settings saved')}>Save</Btn>
          <Btn onClick={() => void test()} disabled={testing}>{testing ? 'Sending…' : 'Send me a test'}</Btn>
        </div>
        {testOut && (
          <div className="flex flex-col gap-1.5">
            {testOut.results.map((r, i) => (
              <Notice key={i} tone={r.ok ? 'green' : 'red'}>{r.channel === 'email' ? 'Email' : 'WhatsApp'}: {r.ok ? 'sent' : r.error}</Notice>
            ))}
            {testOut.hints.map(h => <Notice key={h}>{h}</Notice>)}
            {!testOut.results.length && !testOut.hints.length && <Notice>Nothing was sent.</Notice>}
          </div>
        )}
      </div>
    </Card>
  )
}

function Locations({ data, run }: { data: HrBootstrap; run: Run }) {
  const [name, setName] = useState('')
  const shifts = data.shifts ?? []
  return (
    <Card title="Work locations">
      <div style={{ fontSize: 12.5, color: FF.textFaint, marginBottom: 10 }}>
        Used for location-specific holidays (e.g. Chhath for the Bihar team) and, optionally, a location-wide shift.
      </div>
      {data.locations.length === 0 ? <Muted>No locations yet.</Muted> : (
        <div className="flex flex-col">
          {data.locations.map(l => (
            <div key={l.id} className="flex items-center gap-3 flex-wrap" style={{ padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
              <span style={{ flex: '1 1 140px', fontSize: 14, color: FF.tealDark }}>{l.name}</span>
              <select value={l.shiftId ?? ''} aria-label={`${l.name} shift`} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}
                onChange={e => void run(() => hrSend(`/api/hr/locations/${l.id}`, 'PUT', { shiftId: e.target.value || null }), 'Saved')}>
                <option value="">Default shift</option>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" aria-label={`Delete ${l.name}`} style={{ color: FF.textFaint, padding: 4, cursor: 'pointer' }}
                onClick={() => {
                  if (window.confirm(`Delete ${l.name}? Its holidays are deleted too, and its people lose their location.`)) {
                    void run(() => hrSend(`/api/hr/locations/${l.id}`, 'DELETE'), 'Location deleted')
                  }
                }}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end" style={{ marginTop: 12, maxWidth: 420 }}>
        <div style={{ flex: 1 }}><Field label="New location"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bihar" style={inputStyle} /></Field></div>
        <Btn variant="primary" disabled={!name.trim()} onClick={async () => {
          if (await run(() => hrSend('/api/hr/locations', 'POST', { name: name.trim() }), 'Location added')) setName('')
        }}>Add</Btn>
      </div>
    </Card>
  )
}

function Holidays({ data, run }: { data: HrBootstrap; run: Run }) {
  const [year, setYear] = useState(data.leaveYear)
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [locationIds, setLocationIds] = useState<string[]>([])
  const fy = leaveYearRange(year)
  const locName = (id: string | null) => (id ? data.locations.find(l => l.id === id)?.name ?? '—' : 'Everyone')
  // One row per location on the server; show one line per date + name.
  const groups = new Map<string, Holiday[]>()
  for (const h of data.holidays.filter(h => h.date >= fy.from && h.date <= fy.to)) {
    const k = `${h.date}|${h.name}`
    groups.set(k, [...(groups.get(k) || []), h])
  }

  async function add() {
    const ok = await run(() => hrSend('/api/hr/holidays', 'POST', { date, name: name.trim(), locationIds }), 'Holiday added')
    if (ok) { setDate(''); setName('') }
  }
  const toggleLoc = (id: string) => setLocationIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])

  return (
    <Card title="Holidays" action={
      <select value={year} onChange={e => setYear(Number(e.target.value))} style={{ ...inputStyle, width: 'auto' }} aria-label="Leave year">
        {[data.leaveYear - 1, data.leaveYear, data.leaveYear + 1].map(y => <option key={y} value={y}>Apr {y} – Mar {y + 1}</option>)}
      </select>
    }>
      {groups.size === 0 ? <Muted>No holidays in this year.</Muted> : (
        <div className="flex flex-col">
          {[...groups.values()].map(hs => (
            <div key={hs[0].id} className="flex items-center justify-between gap-3"
              style={{ padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}`, fontSize: 13.5, color: FF.tealText }}>
              <span>{fmtDate(hs[0].date, true)} · {hs[0].name}</span>
              <span className="flex items-center gap-2">
                <span style={{ fontSize: 12, color: FF.textMuted, textAlign: 'right' }}>{hs.map(h => locName(h.locationId)).join(', ')}</span>
                <button type="button" aria-label={`Delete ${hs[0].name}`} style={{ color: FF.textFaint, cursor: 'pointer' }}
                  onClick={() => void run(async () => {
                    for (const h of hs) await hrSend(`/api/hr/holidays/${h.id}`, 'DELETE')
                  }, 'Holiday deleted')}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
        <div className="grid grid-cols-1 sm:grid-cols-[auto_2fr_auto] gap-2 items-end">
          <Field label="Date"><input type="date" value={date} min={fy.from} max={fy.to} onChange={e => setDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Holiday"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Diwali" style={inputStyle} /></Field>
          <Btn variant="primary" disabled={!date || !name.trim()} onClick={() => void add()}>Add</Btn>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12.5, color: FF.textMuted, fontWeight: 500, marginBottom: 4 }}>Applies to</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <label className="flex items-center gap-1.5" style={{ fontSize: 13, color: FF.tealText }}>
              <input type="checkbox" checked={locationIds.length === 0} onChange={() => setLocationIds([])} /> Everyone
            </label>
            {data.locations.map(l => (
              <label key={l.id} className="flex items-center gap-1.5" style={{ fontSize: 13, color: FF.tealText }}>
                <input type="checkbox" checked={locationIds.includes(l.id)} onChange={() => toggleLoc(l.id)} /> {l.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Card>
  )
}

/** Normalise a name for matching sheet rows to employees. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const last10 = (p: string) => String(p || '').replace(/\D/g, '').slice(-10)

function Employees({ data, run }: { data: HrBootstrap; run: Run }) {
  const { toast } = useToast()
  const [employees, setEmployees] = useState<TeamMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // Sheet rows carry each person's manager by name. Read defensively: these panels are
  // also used outside the dashboard.
  let sheetUsers: { name: string; phone: string; manager: string }[] = []
  try { sheetUsers = useReportContext().users } catch { /* no ReportProvider */ }
  const shifts = data.shifts ?? []

  const load = useCallback(() => {
    hrGet<{ employees: TeamMember[] }>('/api/hr/employees')
      .then(out => { setEmployees(out.employees); setError(null) })
      .catch(e => setError(e instanceof TypeError ? 'Connect to the internet to manage employees.' : errorText(e)))
  }, [])
  useEffect(load, [load])

  const update = async (e: TeamMember, patch: Record<string, unknown>) => {
    if (await run(() => hrSend(`/api/hr/employees/${e.id}`, 'PUT', patch))) load()
  }

  // Match "Manager" (a name, sometimes a phone) in the sheet to employees.
  const plan = (() => {
    if (!employees || !sheetUsers.length) return []
    const byName = new Map(employees.map(e => [norm(e.name), e]))
    const byPhone = new Map(employees.filter(e => e.phone).map(e => [last10(e.phone!), e]))
    const out: { emp: TeamMember; mgr: TeamMember }[] = []
    for (const s of sheetUsers) {
      const emp = byPhone.get(last10(s.phone)) ?? byName.get(norm(s.name))
      const ref = String(s.manager || '').trim()
      if (!emp || !ref) continue
      const mgr = byPhone.get(last10(ref)) ?? byName.get(norm(ref))
      if (mgr && mgr.id !== emp.id && emp.managerId !== mgr.id) out.push({ emp, mgr })
    }
    return out
  })()

  async function importManagers() {
    if (!window.confirm(`Set ${plan.length} reporting line${plan.length === 1 ? '' : 's'} from the User Management sheet?\n\n`
      + plan.slice(0, 12).map(p => `${p.emp.name} → ${p.mgr.name}`).join('\n') + (plan.length > 12 ? '\n…' : ''))) return
    try {
      const out = await hrSend<{ updated: number; skipped: { name?: string; reason: string }[] }>('/api/hr/employees/managers', 'PUT',
        { assignments: plan.map(p => ({ userId: p.emp.id, managerId: p.mgr.id })) })
      toast(`Set ${out.updated} reporting line${out.updated === 1 ? '' : 's'}${out.skipped.length ? `, skipped ${out.skipped.length}` : ''}`, 'success')
      for (const s of out.skipped.slice(0, 3)) toast(`${s.name ?? 'One person'}: ${s.reason}`, 'error')
      load()
      await run(async () => {})
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const shown = (employees ?? []).filter(e => !filter || norm(e.name).includes(norm(filter)))
  const td = { padding: '6px 8px', borderBottom: `1px solid ${FF.borderFaint}` }
  const sel = { ...inputStyle, padding: '5px 8px', minWidth: 120 }

  return (
    <Card title="Employees" action={
      <div className="flex items-center gap-2 flex-wrap">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter employees"
          style={{ ...inputStyle, width: 180, padding: '6px 10px' }} />
        {plan.length > 0 && <Btn onClick={() => void importManagers()}>Import {plan.length} managers from User Management</Btn>}
      </div>
    }>
      <div style={{ fontSize: 12.5, color: FF.textFaint, marginBottom: 10 }}>
        <b style={{ fontWeight: 600 }}>Reports to</b> drives leave approval, the Team register and the org chart.
        HR users give the final leave approval and see everyone. Email is used for notifications.
      </div>
      {error ? <Notice tone="red">{error}</Notice> : !employees ? <Muted>Loading…</Muted> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: FF.textMuted, textAlign: 'left' }}>
                {['Name', 'Reports to', 'HR', 'Location', 'Shift', 'Email'].map(h => (
                  <th key={h} scope="col" style={{ padding: '7px 8px', fontWeight: 600, borderBottom: `1px solid ${FF.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(e => (
                <tr key={e.id} style={{ color: FF.tealText }}>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{e.name}</div>
                    <div style={{ fontSize: 11.5, color: FF.textFaint }}>{e.designation || e.role}</div>
                  </td>
                  <td style={td}>
                    <select value={e.managerId ?? ''} aria-label={`${e.name} reports to`} style={sel}
                      onChange={ev => void update(e, { managerId: ev.target.value || null })}>
                      <option value="">— nobody —</option>
                      {employees.filter(m => m.id !== e.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </td>
                  <td style={td}>
                    <input type="checkbox" checked={e.isHr} aria-label={`${e.name} is HR`}
                      onChange={ev => void update(e, { isHr: ev.target.checked })} />
                  </td>
                  <td style={td}>
                    <select value={e.locationId ?? ''} aria-label={`${e.name} location`} style={sel}
                      onChange={ev => void update(e, { locationId: ev.target.value || null })}>
                      <option value="">—</option>
                      {data.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  <td style={td}>
                    <select value={e.shiftId ?? ''} aria-label={`${e.name} shift`} style={sel}
                      onChange={ev => void update(e, { shiftId: ev.target.value || null })}>
                      <option value="">Location / default</option>
                      {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td style={td}>
                    <input type="email" defaultValue={e.email ?? ''} aria-label={`${e.name} email`} placeholder="name@org.org"
                      style={{ ...inputStyle, padding: '5px 8px', minWidth: 170 }}
                      onBlur={ev => { if (ev.target.value.trim() !== (e.email ?? '')) void update(e, { email: ev.target.value.trim() }) }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
