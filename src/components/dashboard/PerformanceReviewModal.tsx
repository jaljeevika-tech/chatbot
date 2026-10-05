// 11-section AI Performance Review. Reviewer + draft is editable and can finalise;
// employee + finalised can acknowledge; otherwise read-only. Mutations go through performanceReviewClient.ts.

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, FileText, CheckCircle, Save, Download, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import {
  draftReview, getReview, patchReview, finaliseReview, acknowledgeReview,
  ratingColor,
  type ReviewDetail, type ReviewDraft, type KpiRow, type ActivityRow,
  type LearningRow, type ActionItem,
} from '../../utils/performanceReviewClient'
import { apiFetch } from '../../utils/apiFetch'
import type { DailyReport } from '../../types/report'
import { CategoryScoreChart } from '../charts/CategoryScoreChart'
import { KpiRadarChart } from '../charts/KpiRadarChart'
import { ActivityCompletionChart } from '../charts/ActivityCompletionChart'

export interface WorkerStats {
  reportCount: number
  recentCount: number
  totalBenef: number
  quality: { overall: number; description: number; beneficiaries: number; photo: number; location: number }
  areaBreakdown: { area: string; reports: number; benef: number; photosPct: number; locatedPct: number }[]
}

interface Props {
  employeeId?: string
  employeePhone?: string
  reviewId?: string
  period?: string
  viewerRole: 'admin' | 'superadmin' | 'manager' | 'employee'
  viewerUid: string
  onClose: () => void
  onReviewDrafted?: (id: string) => void
  reports?: DailyReport[]
  workerName?: string
  panelAiText?: string
  panelAiStatus?: 'idle' | 'loading' | 'done' | 'error'
  workerStats?: WorkerStats
}

export function PerformanceReviewModal(props: Props) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(props.reviewId || null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingError, setSavingError] = useState<string | null>(null)
  const hasLoadedRef = useRef(false)  // prevent reload when reviewId prop arrives after mount

  // Prefer the AI text the parent panel already computed
  const aiText   = props.panelAiText   ?? ''
  const aiStatus = props.panelAiStatus ?? 'idle'
  const [aiOpen, setAiOpen] = useState(true)

  // Load the existing review or draft a new one, once (the ref guards against a late reviewId prop)
  useEffect(() => {
    if (hasLoadedRef.current) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        if (props.reviewId) {
          const d = await getReview(props.reviewId)
          if (!cancelled) { setDetail(d); setDraft(d.review.ai_draft); setReviewId(d.review.id) }
        } else if (props.employeeId || props.employeePhone) {
          const out = await draftReview(
            { id: props.employeeId, phone: props.employeePhone, name: props.workerName },
            props.period || 'currentQuarter'
          )
          if (cancelled) return
          props.onReviewDrafted?.(out.id)
          const full = await getReview(out.id)
          if (cancelled) return
          setDetail(full); setDraft(full.review.ai_draft); setReviewId(out.id)
        }
        // No identifier: the modal still opens with just the AI analysis
      } catch (e: any) {
        console.warn('[PerformanceReviewModal] load failed:', e?.message)
        // Structured review is optional; the AI analysis section still shows
      } finally {
        if (!cancelled) { hasLoadedRef.current = true; setLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [props.employeeId, props.employeePhone, props.reviewId, props.period])

  const isReviewer = useMemo(() => {
    if (!detail) return false
    const status = detail.review.status
    if (status !== 'draft') return false
    return ['admin', 'superadmin', 'manager'].includes(props.viewerRole)
  }, [detail, props.viewerRole])

  const isEmployeeSelf = useMemo(() => {
    return detail?.review.status === 'finalised'
        && detail.review.employee_id  // crude — backend gates strictly
        && props.viewerRole === 'employee'
  }, [detail, props.viewerRole])

  if (loading) {
    return <Shell onClose={props.onClose}>
      <div className="p-8 text-sm text-gray-500 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Drafting performance review…
      </div>
    </Shell>
  }

  // Structured review unavailable: show the AI-only modal
  if (!detail || !draft) {
    return (
      <Shell onClose={props.onClose} title="Performance Review">
        <div className="overflow-y-auto p-5 flex-1 space-y-6">
          {props.reports && props.reports.length > 0 ? (
            <section>
              <div className="flex items-center justify-between mb-2">
                <H>
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                    AI-Powered Performance Analysis
                    {aiStatus === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-purple-500" />}
                  </span>
                </H>
                {aiText && (
                  <button onClick={() => setAiOpen(o => !o)} className="flex items-center gap-1 text-xs text-purple-700 hover:text-purple-900">
                    {aiOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {aiOpen ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
              {aiStatus === 'loading' && !aiText && (
                <div className="text-xs text-gray-500 flex items-center gap-2 py-2">
                  <Loader2 className="w-3 h-3 animate-spin text-purple-500" /> Generating AI analysis…
                </div>
              )}
              {aiOpen && aiText && (
                <div className="rounded-lg border border-purple-100 bg-purple-50/20 overflow-hidden">
                  <AiAnalysisRenderer text={aiText} streaming={aiStatus === 'loading'} />
                </div>
              )}
              {aiStatus === 'error' && <p className="text-xs text-red-500">AI analysis unavailable.</p>}
            </section>
          ) : (
            <div className="py-8 text-sm text-gray-400 text-center">No review data available.</div>
          )}
        </div>
      </Shell>
    )
  }

  const r = detail.review
  const w = draft.weighted

  async function persistEdits(patch: Partial<ReviewDraft>) {
    if (!reviewId) return
    setSaving(true)
    try {
      const out = await patchReview(reviewId, patch)
      setDraft(d => d ? { ...d, ...patch, weighted: out.weighted } as ReviewDraft : d)
    } catch (e) {
      setSavingError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  function updateKpi(idx: number, score: number) {
    if (!draft) return
    const kpis = draft.kpis.map((k, i) => i === idx ? { ...k, score } : k)
    setDraft({ ...draft, kpis })
  }
  function updateActivity(idx: number, patch: Partial<ActivityRow>) {
    if (!draft) return
    const activities = draft.activities.map((a, i) => i === idx ? { ...a, ...patch } : a)
    setDraft({ ...draft, activities })
  }
  function updateLearning(idx: number, score: number) {
    if (!draft) return
    const learning = draft.learning.map((l, i) => i === idx ? { ...l, score } : l)
    setDraft({ ...draft, learning })
  }

  async function onFinalise() {
    if (!reviewId || !draft) return
    if (!confirm('Finalise this review? After this, scores are locked and the employee will be notified to acknowledge.')) return
    setSaving(true)
    try {
      await persistEdits({
        kpis: draft.kpis, activities: draft.activities, learning: draft.learning,
        strengths: draft.strengths, improvements: draft.improvements,
        recommendation: draft.recommendation, action_plan: draft.action_plan,
      })
      await finaliseReview(reviewId)
      const refreshed = await getReview(reviewId)
      setDetail(refreshed); setDraft(refreshed.review.ai_draft)
    } catch (e) {
      setSavingError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  async function onAcknowledge() {
    if (!reviewId) return
    setSaving(true)
    try {
      await acknowledgeReview(reviewId)
      const refreshed = await getReview(reviewId)
      setDetail(refreshed)
    } catch (e) {
      setSavingError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  function _triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  function downloadDocx() {
    if (!reviewId) return
    const empName = draft?.employee.name || 'review'
    const periodLabel = draft?.period.label || 'period'
    apiFetch(`/api/performance/reviews/${reviewId}/export.docx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_stats: props.workerStats || null, ai_analysis: props.panelAiText || '' }),
    })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        _triggerDownload(await res.blob(), `${empName}_${periodLabel}.docx`)
      })
      .catch(e => setSavingError(e.message))
  }

  function downloadPdf() {
    if (!reviewId) return
    const empName = draft?.employee.name || 'review'
    const periodLabel = draft?.period.label || 'period'
    apiFetch(`/api/performance/reviews/${reviewId}/export.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_stats: props.workerStats || null, ai_analysis: props.panelAiText || '' }),
    })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        _triggerDownload(await res.blob(), `${empName}_${periodLabel}.pdf`)
      })
      .catch(e => setSavingError(e.message))
  }

  return <Shell onClose={props.onClose} title="Performance Review">
    <div className="overflow-y-auto p-5 flex-1 space-y-6">
      {/* §1 Employee header */}
      <header className="border border-gray-200 rounded-lg p-4 bg-gray-50/50">
        <h2 className="text-lg font-semibold text-gray-900">{draft.employee.name}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs mt-2">
          <Field label="Designation"      value={draft.employee.designation || '—'} />
          <Field label="Department"       value={draft.employee.department || '—'} />
          <Field label="Review Period"    value={draft.period.label} />
          <Field label="Reporting Manager" value={r.manager_name || '—'} />
          <Field label="Reviewer"         value={r.reviewer_name || '—'} />
          <Field label="Status"           value={r.status} />
        </div>
      </header>

      {/* §2 Activity Overview */}
      {props.workerStats && (
        <section>
          <H>2. Activity Overview</H>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {[
              { label: 'Total Reports',  value: props.workerStats.reportCount },
              { label: 'Last 30 Days',   value: props.workerStats.recentCount },
              { label: 'Beneficiaries',  value: props.workerStats.totalBenef.toLocaleString('en-IN') },
            ].map(s => (
              <div key={s.label} className="rounded-lg border border-gray-200 p-3 text-center">
                <div className="text-xl font-bold text-gray-900 tabular-nums">{s.value}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wide mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {[
              { label: 'Description quality', value: props.workerStats.quality.description },
              { label: 'Beneficiary data',    value: props.workerStats.quality.beneficiaries },
              { label: 'Photo attached',       value: props.workerStats.quality.photo },
              { label: 'Location tagged',      value: props.workerStats.quality.location },
            ].map(q => (
              <div key={q.label} className="flex items-center gap-3 text-xs">
                <span className="w-36 text-gray-500 shrink-0">{q.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{
                    width: `${q.value}%`,
                    background: q.value >= 75 ? '#3F7D5C' : q.value >= 50 ? '#B8862E' : '#B0473C',
                  }} />
                </div>
                <span className="w-10 text-right font-semibold tabular-nums"
                      style={{ color: q.value >= 75 ? '#3F7D5C' : q.value >= 50 ? '#B8862E' : '#B0473C' }}>
                  {q.value}%
                </span>
              </div>
            ))}
          </div>

          {/* Area Breakdown table */}
          {props.workerStats.areaBreakdown.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-700 mb-2">Area Breakdown</p>
              <div className="overflow-x-auto">
              <table className="w-full text-[11px] sm:text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-200">
                    {['Area', 'Reports', 'Beneficiaries', 'Photos', 'Located'].map(h => (
                      <th key={h} className="text-left py-1 sm:py-1.5 pr-2 sm:pr-3 font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {props.workerStats.areaBreakdown.map(row => (
                    <tr key={row.area} className="border-b border-gray-100">
                      <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 font-medium text-gray-900 max-w-[100px] sm:max-w-[130px] truncate">{row.area}</td>
                      <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center">{row.reports}</td>
                      <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center text-green-700">{row.benef.toLocaleString('en-IN')}</td>
                      <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center">{row.photosPct > 0 ? `${row.photosPct}%` : '—'}</td>
                      <td className="py-1 sm:py-1.5 tabular-nums text-center">{row.locatedPct > 0 ? `${row.locatedPct}%` : '—'}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 font-semibold">
                    <td className="py-1 sm:py-1.5 pr-2 sm:pr-3">Total</td>
                    <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center">{props.workerStats.reportCount}</td>
                    <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center text-green-700">{props.workerStats.totalBenef.toLocaleString('en-IN')}</td>
                    <td className="py-1 sm:py-1.5 pr-2 sm:pr-3 tabular-nums text-center">{props.workerStats.quality.photo}%</td>
                    <td className="py-1 sm:py-1.5 tabular-nums text-center">{props.workerStats.quality.location}%</td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* §3 AI Analysis */}
      {(aiText || aiStatus === 'loading') && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <H>
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                3. AI-Powered Performance Analysis
                {aiStatus === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-purple-500" />}
              </span>
            </H>
            {aiStatus !== 'idle' && aiText && (
              <button
                onClick={() => setAiOpen(o => !o)}
                className="flex items-center gap-1 text-xs text-purple-700 hover:text-purple-900"
              >
                {aiOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {aiOpen ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
          {aiStatus === 'error' && (
            <p className="text-xs text-red-500">AI analysis unavailable.</p>
          )}
          {aiOpen && aiText && (
            <div className="rounded-lg border border-purple-100 bg-purple-50/20 overflow-hidden">
              <AiAnalysisRenderer text={aiText} streaming={aiStatus === 'loading'} />
            </div>
          )}
          {aiStatus === 'loading' && !aiText && (
            <div className="text-xs text-gray-500 flex items-center gap-2 py-2">
              <Loader2 className="w-3 h-3 animate-spin text-purple-500" /> Generating AI analysis…
            </div>
          )}
          {aiStatus === 'done' && !aiText && (
            <p className="text-xs text-gray-400 py-2">No analysis generated — please try again.</p>
          )}
        </section>
      )}

      {/* §3 Final score hero */}
      <section className="rounded-lg border-2 p-4" style={{ borderColor: ratingColor(w.rating) }}>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="text-xs uppercase tracking-wide text-gray-500">Final AI Score</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-4xl font-semibold font-serif tabular-nums" style={{ color: ratingColor(w.rating) }}>
                {w.final}
              </span>
              <span className="text-gray-500 text-sm">/ 100</span>
              <span className="ml-3 inline-block px-3 py-1 rounded-full text-xs font-semibold"
                    style={{ background: ratingColor(w.rating) + '22', color: ratingColor(w.rating) }}>
                {w.rating}
              </span>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <CategoryScoreChart
            categories={[
              { label: 'Performance KPIs',     score: w.kpi_score,        weight: 0.4 },
              { label: 'Activity Completion',  score: w.activity_score,   weight: 0.3 },
              { label: 'Key Learning',         score: w.learning_score,   weight: 0.2 },
              { label: 'Discipline',           score: w.discipline_score, weight: 0.1 },
            ]}
          />
        </div>
      </section>

      {/* §4 KPI Review with radar */}
      <section>
        <H>5. Performance KPI Review</H>
        <div className="grid md:grid-cols-2 gap-4 items-center">
          <KpiTable kpis={draft.kpis} editable={isReviewer} onChange={updateKpi} />
          <KpiRadarChart kpis={draft.kpis} />
        </div>
      </section>

      {/* §5 Activity completion */}
      <section>
        <H>6. Activity-Based Review</H>
        <ActivityCompletionChart activities={draft.activities} />
        <ActivityTable
          activities={draft.activities}
          editable={isReviewer}
          onChange={updateActivity}
        />
      </section>

      {/* §6 Key Learning */}
      <section>
        <H>7. Key Learning Review</H>
        <LearningTable learning={draft.learning} editable={isReviewer} onChange={updateLearning} />
      </section>

      {/* §7 Monthly trend */}
      <section>
        <H>8. Monthly Performance Trend</H>
        <MonthlyTrend trend={draft.trend} />
      </section>

      {/* §8 Strengths + Improvements */}
      <section className="grid md:grid-cols-2 gap-4">
        <div>
          <H>Strengths</H>
          <BulletList items={draft.strengths} />
        </div>
        <div>
          <H>Improvements</H>
          <BulletList items={draft.improvements} />
        </div>
      </section>

      {/* §9 Risk & Potential */}
      <section>
        <H>9. AI Risk & Potential Analysis</H>
        <RiskPills risk={draft.risk} notes={draft.risk_notes} />
      </section>

      {/* §10 Recommendation + Action Plan */}
      <section>
        <H>10. AI Recommendation</H>
        <p className="text-sm text-gray-700 leading-relaxed mb-3">{draft.recommendation}</p>
        <ActionPlanTable items={draft.action_plan} />
      </section>

      {/* §11 Rating scale */}
      <section>
        <H>11. Rating Scale Reference</H>
        <RatingScale highlight={w.rating} />
      </section>
    </div>

    <footer className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-gray-200 p-3 bg-gray-50 shrink-0">
      <div className="text-xs text-gray-500 flex flex-wrap items-center gap-x-3 gap-y-1">
        {savingError && <span className="text-red-600 mr-2">{savingError}</span>}
        {r.status === 'draft' && 'Draft — scores can be edited.'}
        {r.status === 'finalised' && `Finalised ${r.finalised_at ? new Date(r.finalised_at).toLocaleDateString('en-IN') : ''}`}
        {r.status === 'acknowledged' && '✓ Acknowledged by employee'}
        <SubjectReportsLink subjectName={draft.employee.name} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={downloadDocx} className="px-3 py-1.5 rounded text-xs font-medium border border-gray-300 hover:bg-white inline-flex items-center gap-1.5">
          <Download className="w-3 h-3" /> Download DOCX
        </button>
        <button onClick={downloadPdf} className="px-3 py-1.5 rounded text-xs font-medium border border-gray-300 hover:bg-white inline-flex items-center gap-1.5">
          <Download className="w-3 h-3" /> Download PDF
        </button>
        {isReviewer && (
          <>
            <button
              onClick={() => persistEdits({
                kpis: draft.kpis, activities: draft.activities, learning: draft.learning,
              })}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs font-medium border border-purple-300 text-purple-700 hover:bg-purple-50 inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Save className="w-3 h-3" /> Save draft
            </button>
            <button
              onClick={onFinalise}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-purple-700 hover:bg-purple-800 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <FileText className="w-3 h-3" /> Finalise
            </button>
          </>
        )}
        {isEmployeeSelf && r.status === 'finalised' && (
          <button
            onClick={onAcknowledge}
            disabled={saving}
            className="px-3 py-1.5 rounded text-xs font-medium bg-green-600 hover:bg-green-700 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <CheckCircle className="w-3 h-3" /> Acknowledge
          </button>
        )}
      </div>
    </footer>
  </Shell>
}


function Shell({ onClose, title = '', children }: { onClose: () => void; title?: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-lg shadow-2xl flex flex-col sm:max-w-5xl w-full" style={{ maxHeight: '92vh' }}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200 shrink-0">
          <h1 className="text-sm font-semibold text-gray-900">{title || 'Performance Review'}</h1>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
            <X className="w-4 h-4 text-gray-600" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-gray-900 mb-2 mt-2">{children}</h3>
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}: </span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  )
}

function KpiTable({ kpis, editable, onChange }: { kpis: KpiRow[]; editable: boolean; onChange: (i: number, score: number) => void }) {
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1.5">Area</th>
          <th className="text-right py-1.5 w-16">Score</th>
          <th className="text-left py-1.5">Observation</th>
        </tr>
      </thead>
      <tbody>
        {kpis.map((k, i) => (
          <tr key={k.area} className="border-b border-gray-100">
            <td className="py-1.5 font-medium text-gray-900">{k.area}</td>
            <td className="py-1.5 text-right tabular-nums">
              {editable
                ? <input
                    type="number" min={0} max={5} step={0.1}
                    value={k.score}
                    onChange={e => onChange(i, parseFloat(e.target.value) || 0)}
                    className="w-14 border border-gray-300 rounded px-1 py-0.5 text-right text-xs"
                  />
                : k.score.toFixed(1)}
              <span className="text-gray-400 text-[10px] ml-1">/5</span>
            </td>
            <td className="py-1.5 text-gray-600">{k.observation || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function ActivityTable({ activities, editable, onChange }: {
  activities: ActivityRow[]; editable: boolean; onChange: (i: number, patch: Partial<ActivityRow>) => void
}) {
  return (
    <div className="overflow-x-auto mt-3">
    <table className="w-full text-[11px] sm:text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1 sm:py-1.5 pr-2 whitespace-nowrap">Activity</th>
          <th className="text-right py-1 sm:py-1.5 pr-2 w-14 sm:w-16 whitespace-nowrap">Target</th>
          <th className="text-right py-1 sm:py-1.5 pr-2 w-14 sm:w-16 whitespace-nowrap">Done</th>
          <th className="text-right py-1 sm:py-1.5 pr-2 w-12 sm:w-16 whitespace-nowrap">%</th>
          <th className="text-right py-1 sm:py-1.5 pr-2 w-14 sm:w-16 whitespace-nowrap">Quality</th>
          <th className="text-left py-1 sm:py-1.5 whitespace-nowrap">Remark</th>
        </tr>
      </thead>
      <tbody>
        {activities.map((a, i) => (
          <tr key={a.name} className="border-b border-gray-100">
            <td className="py-1 sm:py-1.5 pr-2 font-medium text-gray-900">{a.name}</td>
            <td className="py-1 sm:py-1.5 pr-2 text-right tabular-nums">
              {editable
                ? <input
                    type="number" min={0}
                    value={a.target}
                    onChange={e => {
                      const target = parseInt(e.target.value) || 0
                      const pct = target > 0 ? Math.round((a.completed / target) * 100) : 0
                      onChange(i, { target, completion_pct: pct })
                    }}
                    className="w-14 border border-gray-300 rounded px-1 py-0.5 text-right text-xs"
                  />
                : a.target}
            </td>
            <td className="py-1 sm:py-1.5 pr-2 text-right tabular-nums">
              {editable
                ? <input
                    type="number" min={0}
                    value={a.completed}
                    onChange={e => {
                      const completed = parseInt(e.target.value) || 0
                      const pct = a.target > 0 ? Math.round((completed / a.target) * 100) : 0
                      onChange(i, { completed, completion_pct: pct })
                    }}
                    className="w-14 border border-gray-300 rounded px-1 py-0.5 text-right text-xs"
                  />
                : a.completed}
            </td>
            <td className="py-1 sm:py-1.5 pr-2 text-right tabular-nums">{a.completion_pct}%</td>
            <td className="py-1 sm:py-1.5 pr-2 text-right tabular-nums">{a.quality.toFixed(1)}</td>
            <td className="py-1 sm:py-1.5 text-gray-600">{a.remark || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function LearningTable({ learning, editable, onChange }: {
  learning: LearningRow[]; editable: boolean; onChange: (i: number, score: number) => void
}) {
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1.5">Learning Area</th>
          <th className="text-right py-1.5 w-16">Score</th>
          <th className="text-left py-1.5">AI Analysis</th>
        </tr>
      </thead>
      <tbody>
        {learning.map((l, i) => (
          <tr key={l.area} className="border-b border-gray-100">
            <td className="py-1.5 font-medium text-gray-900">{l.area}</td>
            <td className="py-1.5 text-right tabular-nums">
              {editable
                ? <input
                    type="number" min={0} max={5} step={0.1}
                    value={l.score}
                    onChange={e => onChange(i, parseFloat(e.target.value) || 0)}
                    className="w-14 border border-gray-300 rounded px-1 py-0.5 text-right text-xs"
                  />
                : l.score.toFixed(1)}
              <span className="text-gray-400 text-[10px] ml-1">/5</span>
            </td>
            <td className="py-1.5 text-gray-600">{l.observation || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function MonthlyTrend({ trend }: { trend: { month: string; score: number }[] }) {
  if (!trend.length) return <div className="text-xs text-gray-400">No data</div>
  const max = Math.max(100, ...trend.map(t => t.score))
  return (
    <div className="flex items-end gap-2 h-32">
      {trend.map(t => {
        const h = Math.max(8, (t.score / max) * 100)
        return (
          <div key={t.month} className="flex-1 flex flex-col items-center gap-1">
            <div className="text-[10px] font-semibold tabular-nums text-gray-700">{t.score}%</div>
            <div className="w-full" style={{ height: `${h}%` }}>
              <div className="w-full h-full rounded-t bg-purple-600" />
            </div>
            <div className="text-[10px] text-gray-500">{t.month}</div>
          </div>
        )
      })}
    </div>
  )
}

function BulletList({ items }: { items: { area: string; reason: string }[] }) {
  if (!items.length) return <div className="text-xs text-gray-400">—</div>
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span className="font-semibold text-gray-900 min-w-[120px]">{it.area}</span>
          <span className="text-gray-600 flex-1">{it.reason}</span>
        </li>
      ))}
    </ul>
  )
}

function RiskPills({ risk, notes }: { risk: any; notes?: Record<string, string> }) {
  const rows = [
    { key: 'performance',   label: 'Performance Risk' },
    { key: 'growth',        label: 'Growth Potential' },
    { key: 'promotion',     label: 'Promotion Readiness' },
    { key: 'training_need', label: 'Training Need' },
    { key: 'retention',     label: 'Retention Value' },
  ]
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1.5">Parameter</th>
          <th className="text-left py-1.5 w-32">Status</th>
          <th className="text-left py-1.5">AI Interpretation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.key} className="border-b border-gray-100">
            <td className="py-1.5 font-medium text-gray-900">{r.label}</td>
            <td className="py-1.5">
              <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: '#F3F4F6', color: '#1F2937' }}>
                {risk[r.key] || '—'}
              </span>
            </td>
            <td className="py-1.5 text-gray-600">{notes?.[r.key] || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function ActionPlanTable({ items }: { items: ActionItem[] }) {
  if (!items.length) return <div className="text-xs text-gray-400">No action items</div>
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1.5">Action</th>
          <th className="text-left py-1.5 w-20">Timeline</th>
          <th className="text-left py-1.5">Expected Result</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a, i) => (
          <tr key={i} className="border-b border-gray-100">
            <td className="py-1.5 font-medium text-gray-900">{a.action}</td>
            <td className="py-1.5 text-gray-600">{a.timeline_days} days</td>
            <td className="py-1.5 text-gray-600">{a.expected_result}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function AiAnalysisRenderer({ text, streaming }: { text: string; streaming: boolean }) {
  const EMOJI_RE = /^[📊💪📉⚠️🔍🧠🔄📝✅]/u
  const lines = text.split('\n')
  return (
    <div className="p-4 space-y-0.5 text-xs text-gray-700 leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-2" />
        if (EMOJI_RE.test(line)) {
          return (
            <p key={i} className="font-semibold text-purple-800 mt-4 first:mt-0 border-l-2 border-purple-400 pl-2 pb-0.5">
              {line}
            </p>
          )
        }
        if (line.trimStart().startsWith('→')) {
          return (
            <p key={i} className="ml-4 text-gray-700 mt-1">
              <span className="font-bold text-purple-600 mr-1">→</span>
              {line.trimStart().slice(1).trim()}
            </p>
          )
        }
        if (/^\d+\./.test(line.trim())) {
          const num = line.match(/^(\d+)\.\s*/)?.[1] ?? ''
          const body = line.replace(/^\d+\.\s*/, '')
          return (
            <div key={i} className="flex gap-2 mt-1 ml-2">
              <span className="text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-purple-600 text-white">{num}</span>
              <span>{body}</span>
            </div>
          )
        }
        if (line.trim().startsWith('- ')) {
          return (
            <p key={i} className="ml-4 mt-0.5 before:content-['•'] before:text-purple-500 before:mr-1.5">
              {line.replace(/^[\s-]+/, '')}
            </p>
          )
        }
        return <p key={i} className="mt-0.5">{line}</p>
      })}
      {streaming && (
        <span className="inline-block w-1.5 h-3 ml-0.5 align-middle animate-pulse rounded-sm bg-purple-600" />
      )}
    </div>
  )
}

function RatingScale({ highlight }: { highlight: string }) {
  const rows = [
    { range: '90–100',    rating: 'Excellent',         decision: 'Promotion / high increment' },
    { range: '80–89',     rating: 'Good',              decision: 'Continue / increment recommended' },
    { range: '70–79',     rating: 'Satisfactory',      decision: 'Training required' },
    { range: '60–69',     rating: 'Needs Improvement', decision: 'Improvement plan required' },
    { range: 'Below 60',  rating: 'Poor',              decision: 'Performance improvement plan' },
  ]
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="text-left py-1.5">Score</th>
          <th className="text-left py-1.5">Rating</th>
          <th className="text-left py-1.5">Decision</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.rating}
              className={`border-b border-gray-100 ${r.rating === highlight ? 'bg-purple-50/60' : ''}`}>
            <td className="py-1.5 font-medium text-gray-900">{r.range}</td>
            <td className="py-1.5">
              <span className="font-semibold" style={{ color: ratingColor(r.rating) }}>{r.rating}</span>
            </td>
            <td className="py-1.5 text-gray-600">{r.decision}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

// Link to saved AI reports about this employee; opens Settings → Saved Reports with the
// "On you" filter pre-applied via sessionStorage.
function SubjectReportsLink({ subjectName }: { subjectName: string }) {
  const [count, setCount] = useState<number | null>(null)
  const [open,  setOpen]  = useState(false)
  const [items, setItems] = useState<{ id: string; title: string; created_at: string; generated_by_name?: string | null }[]>([])

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/saved-reports').then(r => r.json()).then(d => {
      if (cancelled) return
      const matches = ((d.reports || []) as Array<{
        id: string; title: string; created_at: string;
        subject_employee_names?: string[] | null;
        generated_by_name?: string | null;
      }>).filter(r => Array.isArray(r.subject_employee_names)
        && r.subject_employee_names.some(n => n.toLowerCase().trim() === subjectName.toLowerCase().trim()))
      setCount(matches.length)
      setItems(matches.slice(0, 5).map(m => ({
        id: m.id, title: m.title, created_at: m.created_at, generated_by_name: m.generated_by_name,
      })))
    }).catch(() => { if (!cancelled) setCount(0) })
    return () => { cancelled = true }
  }, [subjectName])

  if (count === null) return null
  if (count === 0) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 text-purple-700 hover:underline"
      >
        <Sparkles className="w-3 h-3" />
        {count} AI report{count === 1 ? '' : 's'} about this employee
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold px-2 mb-1">Recent</div>
          <ul className="space-y-1">
            {items.map(it => (
              <li key={it.id} className="px-2 py-1.5 rounded hover:bg-gray-50">
                <div className="text-xs font-medium text-gray-900 truncate">{it.title}</div>
                <div className="text-[10px] text-gray-500">
                  {new Date(it.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {it.generated_by_name && ` · by ${it.generated_by_name}`}
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t border-gray-100 mt-2 pt-2 px-2">
            <button
              onClick={() => {
                try {
                  sessionStorage.setItem('ff_saved_reports_filter_subject', subjectName)
                } catch { /* ignore */ }
                setOpen(false)
                window.location.hash = '#settings/saved-reports'
              }}
              className="text-[11px] font-semibold text-purple-700 hover:underline"
            >
              Open all in Saved Reports →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
