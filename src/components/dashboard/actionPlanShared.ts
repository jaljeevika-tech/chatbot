// Palette, types and pure helpers shared by ActionPlanTab and the components it renders.
// Must never import from ActionPlanTab: ActivityTrackingPanel reads `C` at module load,
// and a cycle crashes the production build with "Cannot access 'C' before initialization".

export const C = { purple: '#341272', light: '#FBF9F4', border: '#D9E6E8', green: '#3F7D5C', amber: '#B8862E', red: '#B0473C' }

export type MonthData = { target: number | null; achieved: number | null }

// Optional tracking keys stored on the activity object in action_plans.activities (JSONB),
// set via ActivityTrackingPanel.
export type ActivityStatus   = 'Not Started' | 'In Progress' | 'Completed' | 'On Hold' | 'Cancelled'
export type ActivityPriority = 'High' | 'Medium' | 'Low'
export const ACTIVITY_STATUSES: ActivityStatus[]     = ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Cancelled']
export const ACTIVITY_PRIORITIES: ActivityPriority[] = ['High', 'Medium', 'Low']

export interface ActivityTrackingFields {
  status?:        ActivityStatus
  priority?:       ActivityPriority
  due_date?:       string | null
  evidence_link?:  string | null
  challenges?:     string | null
  next_action?:    string | null
}

export interface Activity extends ActivityTrackingFields {
  sn:             number
  activity:       string
  unit:           string
  times:          string
  description:    string
  responsibility: string
  process:        string
  category:       string
  locations: Array<{
    location: string
    monthly:  Record<string, MonthData>
  }>
}

// Order is display order; also used by ProjectDashboardPage's Action Plan Progress.
export const CATEGORIES = [
  { id: 'capacity',   label: 'Capacity Building',       icon: '🎓', color: '#7c3aed' },
  { id: 'livelihood', label: 'Livelihood Inputs',       icon: '🐟', color: '#0891b2' },
  { id: 'enterprise', label: 'Enterprise & Infra',      icon: '🏭', color: '#d97706' },
  { id: 'community',  label: 'Community Engagement',    icon: '🤝', color: '#16a34a' },
  { id: 'technology', label: 'Technology & Innovation', icon: '💡', color: '#db2777' },
] as const
export type CategoryId = typeof CATEGORIES[number]['id']

export type CellState = { target: number | null; achieved: number | null; notes?: string; updatedBy?: string | null; updatedAt?: string | null }
export type ProgressMap = Record<string, CellState>

// node-pg serialises NUMERIC as a string. NaN → 0.
export function toNum(v: unknown): number {
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

// Sums target/achieved with the same resolution order as ProgressCell
// (override ?? seed). `loc`/`month` null means "all".
export function activityTotal(act: Activity, progress: ProgressMap, loc: string | null, month: string | null) {
  const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']
  const locs = loc ? act.locations.filter(l => l.location === loc) : act.locations
  let target = 0, achieved = 0
  for (const l of locs) {
    const months = month ? [month] : MONTHS
    for (const m of months) {
      const key = `${act.sn}|${l.location}|${m}`
      const override = progress[key]
      const d = l.monthly[m as keyof typeof l.monthly] as MonthData | undefined
      const t = toNum(override?.target  ?? d?.target  ?? null)
      const a = toNum(override?.achieved ?? d?.achieved ?? null)
      target   += t
      achieved += a
    }
  }
  return { target, achieved }
}

// Silent for "on track" on purpose — the grid is dense, so only flag what needs attention.
export function alertFor(a: Pick<Activity, 'status' | 'due_date'>): 'Overdue' | 'Due Soon' | null {
  if (a.status === 'Completed' || a.status === 'Cancelled') return null
  if (!a.due_date) return null
  const days = Math.ceil((new Date(a.due_date).getTime() - Date.now()) / 86_400_000)
  if (days < 0) return 'Overdue'
  if (days <= 7) return 'Due Soon'
  return null
}
