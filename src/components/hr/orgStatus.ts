// Today's-status colours for the org chart — kept apart from OrgChart.tsx so
// the legend can render without loading React Flow.

import { FF } from '../../theme/colors'
import type { OrgStatus } from '../../types/hr'

export const STATUS: Record<OrgStatus, { label: string; color: string }> = {
  in:     { label: 'Checked in',     color: FF.green },
  out:    { label: 'Checked out',    color: '#7FA88F' },
  marked: { label: 'Marked present', color: '#2F6F9F' },
  absent: { label: 'Absent',         color: FF.red },
  leave:  { label: 'On leave',       color: FF.purple },
  off:    { label: 'Day off',        color: FF.textFaint },
  none:   { label: 'Not checked in', color: FF.amber },
}

export const STATUS_LEGEND = Object.values(STATUS)
