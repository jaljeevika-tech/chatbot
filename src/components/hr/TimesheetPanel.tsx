// "Timesheet" — hours straight from check-in/out (no extra data entry):
// in/out, worked, late, early leave, overtime against the shift, leave and
// days off. Week or month; own sheet for everyone, team/everyone for
// managers/HR. Excel export. Needs a connection (computed on the server).

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { FF } from '../../theme/colors'
import { addDays, dateInTz } from '../../../services/hr/dates'
import { TabPill } from '../ui/TabPill'
import type { HrBootstrap, TimesheetDay, TimesheetRow } from '../../types/hr'
import { hrGet } from './useHrData'
import { ATT_LABEL, Btn, Card, Muted, errorText, fmtDate, fmtMinutes, fmtTime, inputStyle } from './hrUi'

type Period = 'week' | 'month'
type Scope = 'me' | 'reports' | 'all'

function range(period: Period, anchor: string) {
  if (period === 'month') {
    const from = `${anchor.slice(0, 7)}-01`
    const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1)
    return { from, to, label: new Date(`${from}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' }) }
  }
  const dow = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7   // Monday = 0
  const from = addDays(anchor, -dow)
  const to = addDays(from, 6)
  return { from, to, label: `${fmtDate(from)} – ${fmtDate(to, true)}` }
}

const cellText = (d: TimesheetDay, tz: string) => {
  if (d.checkInAt) return `${fmtTime(d.checkInAt, tz)}–${d.checkOutAt ? fmtTime(d.checkOutAt, tz) : '…'}`
  if (d.status) return ATT_LABEL[d.status]
  if (d.leave) return `Leave${d.leave.dayPortion !== 'full' ? ' ½' : ''}`
  return d.dayOff ? 'Off' : ''
}

const cellColor = (d: TimesheetDay) =>
  d.status === 'absent' ? FF.red : d.leave ? FF.purple : d.lateMinutes || d.status === 'half_day' ? FF.amber
    : d.dayOff && !d.status ? FF.textFaint : FF.tealText

export function TimesheetPanel({ data }: { data: HrBootstrap }) {
  const { me, settings } = data
  const tz = settings.timezone
  const leads = me.isManager || me.isHr || me.isAdmin
  const today = dateInTz(new Date(), tz)
  const [period, setPeriod] = useState<Period>('week')
  const [anchor, setAnchor] = useState(today)
  const [scope, setScope] = useState<Scope>('me')
  const [userId, setUserId] = useState('')
  const [rows, setRows] = useState<TimesheetRow[] | null>(null)
  const [dates, setDates] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const { from, to, label } = range(period, anchor)

  const load = useCallback(async () => {
    setRows(null); setError(null)
    try {
      const q = `from=${from}&to=${to}&scope=${scope}${userId && scope !== 'me' ? `&userId=${userId}` : ''}`
      const out = await hrGet<{ dates: string[]; rows: TimesheetRow[] }>(`/api/hr/timesheet?${q}`)
      setRows(out.rows); setDates(out.dates)
    } catch (e) {
      setError(e instanceof TypeError ? 'The timesheet needs an internet connection.' : errorText(e))
    }
  }, [from, to, scope, userId])
  useEffect(() => { void load() }, [load])

  const step = (dir: 1 | -1) => setAnchor(period === 'week' ? addDays(from, dir * 7) : addDays(dir === 1 ? to : from, dir))

  async function exportExcel() {
    if (!rows) return
    const XLSX = await import('xlsx')
    const detail = rows.flatMap(r => r.days.map(d => ({
      Employee: r.name, Date: d.date, Shift: r.shift?.name ?? '',
      Status: d.status ? ATT_LABEL[d.status] : d.leave ? `Leave (${d.leave.leaveTypeName})` : d.dayOff ?? '',
      In: d.checkInAt ? fmtTime(d.checkInAt, tz) : '', Out: d.checkOutAt ? fmtTime(d.checkOutAt, tz) : '',
      'Worked (h)': d.workedMinutes != null ? +(d.workedMinutes / 60).toFixed(2) : '',
      'Late (min)': d.lateMinutes || '', 'Left early (min)': d.earlyLeaveMinutes || '', 'Overtime (min)': d.overtimeMinutes || '',
    })))
    const totals = rows.map(r => ({
      Employee: r.name, Shift: r.shift?.name ?? '', 'Worked (h)': +(r.totals.workedMinutes / 60).toFixed(2),
      'Overtime (h)': +(r.totals.overtimeMinutes / 60).toFixed(2), Present: r.totals.present, 'Half day': r.totals.halfDay,
      Absent: r.totals.absent, Leave: r.totals.leave, 'Not marked': r.totals.unmarked,
      'Late days': r.totals.lateDays, 'Late (min)': r.totals.lateMinutes, 'Left early days': r.totals.earlyDays,
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totals), 'Summary')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), 'Daily')
    XLSX.writeFile(wb, `timesheet_${from}_to_${to}.xlsx`)
  }

  const people = data.team.filter(p => scope === 'all' || p.managerId === me.id)
  const scopes: { key: Scope; label: string }[] = [
    { key: 'me', label: 'Me' },
    ...(me.isManager ? [{ key: 'reports' as Scope, label: 'My reports' }] : []),
    ...(me.isHr || me.isAdmin ? [{ key: 'all' as Scope, label: 'Everyone' }] : []),
  ]

  return (
    <Card
      title="Timesheet"
      action={
        <div className="flex items-center gap-2 flex-wrap">
          <TabPill size="xs" active={period} onChange={setPeriod}
            tabs={[{ key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }]} />
          <div className="flex items-center gap-1">
            <Btn variant="ghost" onClick={() => step(-1)} aria-label="Previous period"><ChevronLeft className="w-4 h-4" /></Btn>
            <span style={{ fontSize: 13, color: FF.tealDark, fontWeight: 500, minWidth: 150, textAlign: 'center' }}>{label}</span>
            <Btn variant="ghost" onClick={() => step(1)} aria-label="Next period" disabled={to >= today}><ChevronRight className="w-4 h-4" /></Btn>
          </div>
          <Btn onClick={() => void exportExcel()} disabled={!rows?.length}>
            <span className="inline-flex items-center gap-1.5"><Download className="w-4 h-4" /> Excel</span>
          </Btn>
        </div>
      }
    >
      {leads && scopes.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
          <TabPill size="xs" active={scope} onChange={s => { setScope(s); setUserId('') }} tabs={scopes} />
          {scope !== 'me' && (
            <select value={userId} onChange={e => setUserId(e.target.value)} aria-label="Employee"
              style={{ ...inputStyle, width: 'auto', maxWidth: 220 }}>
              <option value="">All in view</option>
              {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      )}
      {error ? <Muted>{error}</Muted> : !rows ? <Muted>Loading…</Muted> : rows.length === 0 ? <Muted>No one to show.</Muted>
        : rows.length === 1 ? <OnePerson row={rows[0]} tz={tz} today={today} />
        : <Grid rows={rows} dates={dates} tz={tz} />}
    </Card>
  )
}

/** One person: a day-by-day list that works on a phone. */
function OnePerson({ row, tz, today }: { row: TimesheetRow; tz: string; today: string }) {
  const t = row.totals
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['Worked', fmtMinutes(t.workedMinutes)], ['Overtime', fmtMinutes(t.overtimeMinutes)],
          ['Late days', `${t.lateDays}${t.lateMinutes ? ` (${t.lateMinutes}m)` : ''}`],
          ['Present / ½ / absent', `${t.present} / ${t.halfDay} / ${t.absent}`],
        ].map(([k, v]) => (
          <div key={k} style={{ border: `1px solid ${FF.borderSoft}`, borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ fontSize: 11.5, color: FF.textMuted }}>{k}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: FF.tealDark }}>{v}</div>
          </div>
        ))}
      </div>
      {row.shift && <div style={{ fontSize: 12.5, color: FF.textMuted }}>{row.name} · shift {row.shift.name} ({fmtMinutes(row.shift.requiredMinutes)} a day{row.shift.startTime ? `, ${row.shift.startTime}–${row.shift.endTime}` : ''})</div>}
      <div className="flex flex-col">
        {row.days.filter(d => d.date <= today).reverse().map(d => (
          <div key={d.date} className="flex items-center justify-between gap-3 flex-wrap"
            style={{ padding: '8px 0', borderTop: `1px solid ${FF.borderFaint}`, fontSize: 13.5 }}>
            <span style={{ color: FF.tealDark, minWidth: 110 }}>{fmtDate(d.date)}</span>
            <span style={{ color: cellColor(d), flex: 1 }}>
              {cellText(d, tz) || <span style={{ color: FF.textFaint }}>Not marked</span>}
              {d.dayOff && d.status && <span style={{ color: FF.textFaint }}> · {d.dayOff}</span>}
              {!!d.lateMinutes && <span style={{ color: FF.amber }}> · late {d.lateMinutes}m</span>}
              {!!d.earlyLeaveMinutes && <span style={{ color: FF.amber }}> · left {d.earlyLeaveMinutes}m early</span>}
            </span>
            <span style={{ color: FF.tealText, fontVariantNumeric: 'tabular-nums' }}>
              {d.workedMinutes != null ? fmtMinutes(d.workedMinutes) : ''}
              {d.overtimeMinutes > 0 && <span style={{ color: FF.green }}> +{fmtMinutes(d.overtimeMinutes)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Several people: employees × days, with totals; first column stays put. */
function Grid({ rows, dates, tz }: { rows: TimesheetRow[]; dates: string[]; tz: string }) {
  const th = { padding: '6px 8px', fontWeight: 600, color: FF.textMuted, borderBottom: `1px solid ${FF.border}`, whiteSpace: 'nowrap' as const, fontSize: 11.5 }
  const td = { padding: '6px 8px', borderBottom: `1px solid ${FF.borderFaint}`, whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const }
  const sticky = { position: 'sticky' as const, left: 0, background: '#FFFFFF', zIndex: 1 }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th scope="col" style={{ ...th, ...sticky, textAlign: 'left' }}>Employee</th>
            {dates.map(d => <th key={d} scope="col" style={th}>{fmtDate(d)}</th>)}
            <th scope="col" style={th}>Worked</th>
            <th scope="col" style={th}>Overtime</th>
            <th scope="col" style={th}>Late</th>
            <th scope="col" style={th}>Absent</th>
            <th scope="col" style={th}>Leave</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.userId}>
              <th scope="row" style={{ ...td, ...sticky, textAlign: 'left', fontWeight: 500, color: FF.tealDark }}>
                {r.name}{r.shift && <div style={{ fontSize: 10.5, color: FF.textFaint, fontWeight: 400 }}>{r.shift.name}</div>}
              </th>
              {r.days.map(d => (
                <td key={d.date} style={{ ...td, color: cellColor(d), background: d.dayOff && !d.status ? FF.bg : undefined }}>
                  <div>{cellText(d, tz)}</div>
                  {d.workedMinutes != null && <div style={{ fontSize: 10.5, color: FF.textMuted }}>{fmtMinutes(d.workedMinutes)}</div>}
                </td>
              ))}
              <td style={{ ...td, fontWeight: 600, color: FF.tealDark }}>{fmtMinutes(r.totals.workedMinutes)}</td>
              <td style={{ ...td, color: r.totals.overtimeMinutes ? FF.green : FF.textFaint }}>{fmtMinutes(r.totals.overtimeMinutes)}</td>
              <td style={{ ...td, color: r.totals.lateDays ? FF.amber : FF.textFaint }}>{r.totals.lateDays}</td>
              <td style={{ ...td, color: r.totals.absent ? FF.red : FF.textFaint }}>{r.totals.absent}</td>
              <td style={td}>{r.totals.leave}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
