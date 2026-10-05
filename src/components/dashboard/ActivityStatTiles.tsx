// Total / Completed / In Progress / Overdue tiles for the Action Plan tab, computed over
// all activities (not the search-filtered list), like ActionPlanTab's yearStats.

import { alertFor, C, type Activity } from './actionPlanShared'

interface Props {
  activities: Activity[]
}

export function ActivityStatTiles({ activities }: Props) {
  const total      = activities.length
  const completed  = activities.filter(a => a.status === 'Completed').length
  const inProgress = activities.filter(a => a.status === 'In Progress').length
  const overdue    = activities.filter(a => alertFor(a) === 'Overdue').length

  const stats = [
    { label: 'Total Activities', value: total,      color: C.purple },
    { label: 'Completed',        value: completed,  color: C.green },
    { label: 'In Progress',      value: inProgress, color: '#2563EB' },
    { label: 'Overdue',          value: overdue,     color: overdue > 0 ? C.red : C.green },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
      {stats.map(s => (
        <div key={s.label} className="bg-white rounded-xl p-3 text-center border" style={{ borderColor: C.border }}>
          <div className="text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
          <div className="text-[11px] text-gray-500 mt-0.5 leading-tight">{s.label}</div>
        </div>
      ))}
    </div>
  )
}
