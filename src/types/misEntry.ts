// src/types/misEntry.ts — shared types for MIS phase 2 (Monthly Entry,
// Calculations, Dashboard). Mirrors db/migrations/029_mis_entries.sql,
// lib/misCalculations.js, routes/mis-entries.routes.js, routes/mis-dashboard.routes.js.

export type EntryStatus = 'draft' | 'submitted' | 'verified' | 'approved' | 'rejected'
export type IndicatorStatus = 'on_track' | 'needs_attention' | 'behind' | 'not_started' | 'data_pending' | 'overachieved'

export interface EntryMetrics {
  cumulativePlan: number | null
  cumulativeActual: number | null
  achievementPct: number | null
  targetAchievementPct: number | null
  variance: { absolute: number | null; percent: number | null }
  status: IndicatorStatus
  hasPlan: boolean
  hasActual: boolean
}

export interface GridIndicator {
  id: string
  code: string
  name: string
  level: 'activity' | 'output' | 'outcome' | 'impact'
  unit: string | null
  frequency: string
  aggregation_method?: string
  responsible_person: string | null
  updated_at?: string
}

export interface GridEntry {
  id: string
  plan: number | null
  actual: number | null
  remarks: string | null
  status: EntryStatus
  submitted_at: string | null
  verified_at: string | null
  approved_at: string | null
  rejected_at: string | null
  rejected_reason: string | null
  evidenceCount: number
}

export interface MisGridRow {
  indicator: GridIndicator
  entry: GridEntry | null
  target: number | null
  metrics: EntryMetrics
}

export interface DashboardKpis {
  overallAchievementPct: number | null
  targetAchievementPct: number | null
  activityAchievementPct: number | null
  outputAchievementPct: number | null
  outcomeAchievementPct: number | null
  impactAchievementPct: number | null
  onTrackCount: number
  needsAttentionCount: number
  behindCount: number
  noDataCount: number
  overachievedCount: number
  verifiedDataPct: number | null
  beneficiariesReached: number
  uniqueBeneficiariesReached: number
  womenBeneficiaries: number
  geographyCoverage: number
}

export interface DashboardCharts {
  monthlyPlanVsActual: { month: string; plan: number | null; actual: number | null }[]
  focusIndicatorId: string | null
  achievementByLevel: { level: string; achievementPct: number | null }[]
  statusDistribution: { status: string; count: number }[]
  topPerforming: { code: string; name: string; achievementPct: number | null }[]
  lagging: { code: string; name: string; achievementPct: number | null }[]
  geographyWiseAchievement: { geography: string; achievementPct: number | null }[]
  genderDisaggregation: { value: string; count: number; totalActual: number }[]
  categoryDisaggregation: { value: string; count: number; totalActual: number }[]
  cumulativeProgressTrend: { month: string; achievementPct: number | null }[]
  beneficiaryReachTrend: { month: string; count: number }[]
  submissionStatus: { status: string; count: number }[]
}

export interface DashboardResponse {
  kpis: DashboardKpis
  charts: DashboardCharts
  table: MisGridRow[]
}
