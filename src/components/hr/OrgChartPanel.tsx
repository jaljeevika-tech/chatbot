// "Org chart" tab: everyone sees names, roles and locations; managers see
// today's status for their reporting tree, HR/admins for everyone.

import { Suspense, lazy, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { FF } from '../../theme/colors'
import type { HrBootstrap, OrgPerson } from '../../types/hr'
import { hrGet } from './useHrData'
import { Card, Muted, errorText, inputStyle } from './hrUi'
import { STATUS_LEGEND } from './orgStatus'

const OrgChart = lazy(() => import('./OrgChart'))

export function OrgChartPanel({ data }: { data: HrBootstrap }) {
  const [people, setPeople] = useState<OrgPerson[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    hrGet<{ people: OrgPerson[] }>('/api/hr/org-chart')
      .then(out => setPeople(out.people))
      .catch(e => setError(e instanceof TypeError ? 'The organisation chart needs an internet connection.' : errorText(e)))
  }, [])

  const withLine = people?.filter(p => p.managerId).length ?? 0
  const showsStatus = people?.some(p => p.status !== null) ?? false
  const { me } = data

  return (
    <Card
      title={people ? `Organisation · ${people.length} people` : 'Organisation'}
      action={
        <label className="flex items-center gap-2" style={{ ...inputStyle, width: 240, padding: '6px 10px' }}>
          <Search className="w-4 h-4" style={{ color: FF.textFaint }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a person"
            aria-label="Find a person" style={{ border: 0, outline: 'none', width: '100%', fontSize: 13.5, background: 'transparent' }} />
        </label>
      }
    >
      {error ? <Muted>{error}</Muted> : !people ? <Muted>Loading…</Muted> : (
        <div className="flex flex-col gap-3">
          {withLine === 0 && (
            <div style={{ fontSize: 13, color: FF.amber }}>
              No reporting lines are set yet{me.isAdmin ? ' — set them in Settings → Employees (or import them from User Management).' : '.'}
            </div>
          )}
          {showsStatus && (
            <div className="flex gap-4 flex-wrap" style={{ fontSize: 12, color: FF.textMuted }}>
              {STATUS_LEGEND.map(s => (
                <span key={s.label} className="inline-flex items-center gap-1.5">
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: s.color }} />{s.label}
                </span>
              ))}
              <span>· today</span>
            </div>
          )}
          <Suspense fallback={<Muted>Loading chart…</Muted>}>
            <OrgChart people={people} search={search} />
          </Suspense>
        </div>
      )}
    </Card>
  )
}
