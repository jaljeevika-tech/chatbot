// Typed fetch wrappers for the performance review API.

import { apiFetch } from './apiFetch'
import type { DailyReport } from '../types/report'

export interface KpiRow {
  area: string
  score: number
  observation?: string
}
export interface ActivityRow {
  name: string
  target: number
  completed: number
  completion_pct: number
  quality: number
  remark?: string
}
export interface LearningRow {
  area: string
  score: number
  observation?: string
}
export interface TrendPoint {
  month: string
  score: number
}
export interface StrengthRow {
  area: string
  reason: string
}
export interface RiskBlock {
  performance: string
  growth: string
  promotion: string
  training_need: string
  retention: string
}
export interface ActionItem {
  id?: string
  action: string
  timeline_days: number
  expected_result: string
  status?: 'open' | 'in_progress' | 'done'
}
export interface ReviewWeighted {
  kpi_score: number
  activity_score: number
  learning_score: number
  discipline_score: number
  final: number
  rating: string
}
export interface ReviewDraft {
  employee: { id: string; name: string; designation?: string; department?: string; manager_name?: string }
  period: { label: string; start: string; end: string }
  weighted: ReviewWeighted
  kpis: KpiRow[]
  activities: ActivityRow[]
  learning: LearningRow[]
  trend: TrendPoint[]
  strengths: StrengthRow[]
  improvements: StrengthRow[]
  risk: RiskBlock
  risk_notes?: Record<string, string>
  recommendation: string
  action_plan: ActionItem[]
}
export interface ReviewSummary {
  id: string
  employee_id: string
  employee_name: string
  employee_role: string
  reviewer_id: string | null
  reviewer_name: string | null
  period_label: string
  period_start: string
  period_end: string
  status: 'draft' | 'finalised' | 'acknowledged'
  final_rating: string | null
  final_score: number | null
  ai_score: number | null
  employee_ack: boolean
  created_at: string
  finalised_at: string | null
}

export interface ReviewDetail {
  review: ReviewSummary & {
    ai_draft: ReviewDraft
    final_scores: ReviewWeighted | null
    final_decision: string | null
    reviewer_notes: string | null
    employee_custom?: Record<string, unknown>
    manager_name?: string | null
  }
  action_items: Required<ActionItem>[]
}

export async function draftReview(
  employeeIdOrPhone: { id?: string; phone?: string; name?: string },
  period: string = 'currentQuarter'
): Promise<{ id: string; ai_draft: ReviewDraft }> {
  const body: Record<string, unknown> = { period }
  if (employeeIdOrPhone.id)    body.employee_id    = employeeIdOrPhone.id
  if (employeeIdOrPhone.phone) body.employee_phone = employeeIdOrPhone.phone
  if (employeeIdOrPhone.name)  body.employee_name  = employeeIdOrPhone.name
  const r = await apiFetch('/api/performance/reviews/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    throw new Error(err.error || `HTTP ${r.status}`)
  }
  return await r.json()
}

export async function getReview(id: string): Promise<ReviewDetail> {
  const r = await apiFetch(`/api/performance/reviews/${id}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export async function patchReview(id: string, body: Partial<ReviewDraft & { reviewer_notes: string }>): Promise<{ weighted: ReviewWeighted }> {
  const r = await apiFetch(`/api/performance/reviews/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    throw new Error(err.error || `HTTP ${r.status}`)
  }
  return await r.json()
}

export async function finaliseReview(id: string, finalDecision?: string): Promise<void> {
  const r = await apiFetch(`/api/performance/reviews/${id}/finalise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ final_decision: finalDecision || null }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    throw new Error(err.error || `HTTP ${r.status}`)
  }
}

export async function acknowledgeReview(id: string): Promise<void> {
  const r = await apiFetch(`/api/performance/reviews/${id}/acknowledge`, { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    throw new Error(err.error || `HTTP ${r.status}`)
  }
}

export async function streamWorkerAnalysis(
  workerName: string,
  reports: DailyReport[],
  viewerRole: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const controller = new AbortController()
  // Abort if nothing starts within 30 s
  const timeout = setTimeout(() => controller.abort(), 30_000)

  let res: Response
  try {
    const capped = reports.slice(-200)
    res = await apiFetch('/api/analytics/worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerName, reports: capped, viewerRole }),
      signal: controller.signal,
    })
  } catch (e: any) {
    clearTimeout(timeout)
    throw new Error(e?.name === 'AbortError' ? 'Analysis timed out — please try again.' : (e.message || 'Request failed'))
  }

  if (!res.ok) {
    clearTimeout(timeout)
    throw new Error(`Server error (${res.status}) — please try again.`)
  }

  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let receivedText = false

  const resetTimeout = () => {
    if (!receivedText) {
      receivedText = true
      clearTimeout(timeout)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetTimeout()
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
        try {
          const p = JSON.parse(t.slice(6))
          if (p.error) throw new Error(p.error)
          if (p.text) onChunk(p.text)
        } catch (e: any) {
          if (e?.name !== 'SyntaxError') throw e
        }
      }
    }
  } finally {
    clearTimeout(timeout)
    reader.cancel().catch(() => {})
  }
}

export function ratingColor(rating: string | null): string {
  switch (rating) {
    case 'Excellent':         return '#15803D'
    case 'Good':              return '#16a34a'
    case 'Satisfactory':      return '#D97706'
    case 'Needs Improvement': return '#DC2626'
    case 'Poor':              return '#7f1d1d'
    default:                  return '#6B7280'
  }
}
