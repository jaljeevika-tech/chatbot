// Period presets shared by the Content Hub report pickers. Leaf module: imports
// nothing from the dashboard, so any picker can use it without an import cycle.

import { CalendarDays, CalendarRange, CalendarClock, History, Layers } from 'lucide-react'

export type Period = 'monthly' | 'previousMonth' | 'quarterly' | 'halfYearly' | 'annual'

export const PERIODS: { key: Period; icon: typeof CalendarDays }[] = [
  { key: 'monthly',      icon: CalendarDays  },
  { key: 'previousMonth', icon: History       },
  { key: 'quarterly',    icon: CalendarRange },
  { key: 'halfYearly',   icon: Layers        },
  { key: 'annual',       icon: CalendarClock },
]

// Formats from LOCAL calendar fields. Never use .toISOString() on a local Date: it
// converts to UTC and shifts the day back in IST.
function localISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Except "this/previous month", periods follow the Indian FY (Apr 1 – Mar 31), so
// quarters are Apr-Jun.. and "this year" starts on the latest April 1.
export function periodRange(p: Period, now: Date): { from: string; to: string } {
  const year  = now.getFullYear()
  const month = now.getMonth() // 0=Jan .. 11=Dec
  const fyStartYear  = month >= 3 ? year : year - 1 // FY runs Apr(fyStartYear) -> Mar(fyStartYear+1)
  const fiscalMonth  = (month - 3 + 12) % 12         // 0=Apr .. 11=Mar, relative to FY start

  let start: Date
  let end: Date = now

  if (p === 'monthly') {
    start = new Date(year, month, 1)
  } else if (p === 'previousMonth') {
    start = new Date(year, month - 1, 1)
    end   = new Date(year, month, 0) // last day of the previous (completed) month
  } else if (p === 'quarterly') {
    const quarterIdx      = Math.floor(fiscalMonth / 3) // 0..3
    const quarterStartMon = (3 + quarterIdx * 3) % 12
    const quarterStartYr  = quarterIdx === 3 ? fyStartYear + 1 : fyStartYear // Jan-Mar quarter falls in the next calendar year
    start = new Date(quarterStartYr, quarterStartMon, 1)
  } else if (p === 'halfYearly') {
    const halfIdx      = Math.floor(fiscalMonth / 6) // 0 = Apr-Sep, 1 = Oct-Mar
    const halfStartMon = halfIdx === 0 ? 3 : 9
    start = new Date(fyStartYear, halfStartMon, 1)
  } else {
    start = new Date(fyStartYear, 3, 1) // annual: April 1 of the current financial year
  }
  return { from: localISODate(start), to: localISODate(end) }
}
