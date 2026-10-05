// "Reports" — monthly attendance + leave summary per employee, with CSV
// export. Needs a connection (it's computed on the server).

import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { FF } from '../../theme/colors'
import { dateInTz } from '../../../services/hr/dates'
import { TabPill } from '../ui/TabPill'
import type { HrBootstrap, MonthlyRow } from '../../types/hr'
import { hrGet } from './useHrData'
import { Btn, Card, Muted, errorText, inputStyle } from './hrUi'

const COLUMNS: { key: keyof MonthlyRow; label: string }[] = [
  { key: 'name', label: 'Employee' },
  { key: 'workingDays', label: 'Working days' },
  { key: 'present', label: 'Present' },
  { key: 'onField', label: 'On field' },
  { key: 'halfDay', label: 'Half day' },
  { key: 'absent', label: 'Absent' },
  { key: 'leave', label: 'Leave' },
  { key: 'unmarked', label: 'Not marked' },
  { key: 'flagged', label: 'Flagged' },
]

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  // Quote, and neutralise spreadsheet formula injection from names.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
}

export function ReportsPanel({ data }: { data: HrBootstrap }) {
  const { me, settings } = data
  const seesAll = me.isAdmin || me.isHr
  const [month, setMonth] = useState(dateInTz(new Date(), settings.timezone).slice(0, 7))
  const [scope, setScope] = useState<'reports' | 'all'>(seesAll ? 'all' : 'reports')
  const [userId, setUserId] = useState('')
  // Whoever this viewer can report on (team list from the saved bootstrap).
  const people = data.team.filter(p => scope === 'all' || p.managerId === me.id)
  const [rows, setRows] = useState<MonthlyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRows(null); setError(null)
    try {
      const out = await hrGet<{ rows: MonthlyRow[] }>(`/api/hr/reports/monthly?month=${month}&scope=${scope}${userId ? `&userId=${userId}` : ''}`)
      setRows(out.rows)
    } catch (e) {
      setError(e instanceof TypeError ? 'Reports need an internet connection.' : errorText(e))
    }
  }, [month, scope, userId])
  useEffect(() => { void load() }, [load])

  function download() {
    if (!rows) return
    const csv = [COLUMNS.map(c => csvCell(c.label)).join(','),
      ...rows.map(r => COLUMNS.map(c => csvCell(r[c.key])).join(','))].join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `attendance_${month}${userId && rows[0] ? '_' + rows[0].name.replace(/W+/g, '_') : ''}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card
      title="Monthly attendance"
      action={
        <div className="flex items-center gap-2 flex-wrap">
          {seesAll && (
            <TabPill size="xs" active={scope} onChange={s => { setScope(s); setUserId('') }}
              tabs={[{ key: 'reports', label: 'My reports' }, { key: 'all', label: 'Everyone' }]} />
          )}
          <select value={userId} onChange={e => setUserId(e.target.value)} aria-label="Employee"
            style={{ ...inputStyle, width: 'auto', maxWidth: 220 }}>
            <option value="">All employees</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)}
            style={{ ...inputStyle, width: 'auto' }} aria-label="Month" />
          <Btn onClick={download} disabled={!rows?.length}>
            <span className="inline-flex items-center gap-1.5"><Download className="w-4 h-4" /> CSV</span>
          </Btn>
        </div>
      }
    >
      {error ? <Muted>{error}</Muted> : !rows ? <Muted>Loading…</Muted> : rows.length === 0 ? <Muted>No data for this month.</Muted> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} scope="col" style={{
                    textAlign: c.key === 'name' ? 'left' : 'right', padding: '8px 10px', color: FF.textMuted,
                    fontWeight: 600, borderBottom: `1px solid ${FF.border}`, whiteSpace: 'nowrap',
                  }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.userId}>
                  {COLUMNS.map(c => (
                    <td key={c.key} style={{
                      textAlign: c.key === 'name' ? 'left' : 'right', padding: '8px 10px', whiteSpace: 'nowrap',
                      borderBottom: `1px solid ${FF.borderFaint}`,
                      color: c.key === 'flagged' && r.flagged ? FF.amber : c.key === 'unmarked' && r.unmarked ? FF.red : FF.tealText,
                    }}>{r[c.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
