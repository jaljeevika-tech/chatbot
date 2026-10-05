// Admin view of the data-correctness layer: recent flags, reconciliation history and
// override audit (GET /api/correctness/{flags,reconciliation,overrides}). Those endpoints
// aren't built yet, so this shows skeleton states.

import { useEffect, useState } from 'react'
import { AlertTriangle, AlertCircle, CheckCircle, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

interface FlagSummary {
  total: number
  needs_review: number
  low_confidence: number
  photo_mismatch: number
}

interface ReconRow {
  metric: string
  source_a: string
  value_a: number
  source_b: string
  value_b: number
  drift_pct: number
  drift_pass: boolean
  period_label: string
  checked_at: string
}

export function CorrectnessDashboard() {
  const [summary, setSummary] = useState<FlagSummary | null>(null)
  const [recon, setRecon] = useState<ReconRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [sumRes, reconRes] = await Promise.all([
        apiFetch('/api/correctness/flags?period=14d').then(r => r.ok ? r.json() : null).catch(() => null),
        apiFetch('/api/correctness/reconciliation?limit=20').then(r => r.ok ? r.json() : null).catch(() => null),
      ])
      setSummary(sumRes?.summary || { total: 0, needs_review: 0, low_confidence: 0, photo_mismatch: 0 })
      setRecon(Array.isArray(reconRes?.checks) ? reconRes.checks : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Data correctness</h2>
          <p className="text-xs text-gray-500">Anomaly detection · hallucination guard · reconciliation · photo-text consistency</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
        <Tile label="Total flagged (14d)" value={summary?.total ?? '—'} icon={AlertCircle} tone="purple" />
        <Tile label="Needs review"        value={summary?.needs_review ?? '—'}    icon={AlertTriangle} tone="red" />
        <Tile label="Low confidence"      value={summary?.low_confidence ?? '—'}  icon={AlertCircle}   tone="amber" />
        <Tile label="Photo mismatch"      value={summary?.photo_mismatch ?? '—'}  icon={AlertCircle}   tone="purple" />
      </div>

      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Reconciliation history</h3>
        {recon.length === 0
          ? <div className="text-xs text-gray-500 p-4 border border-dashed border-gray-200 rounded">No reconciliation runs yet. The nightly job will populate this within 24 hours.</div>
          : (
            <>
              <div className="hidden md:block" style={{ overflowX: 'auto' }}>
                <table className="w-full text-xs">
                  <thead className="text-gray-500 border-b border-gray-200">
                    <tr>
                      <th className="text-left p-2">Metric</th>
                      <th className="text-left p-2">Period</th>
                      <th className="text-right p-2">{recon[0]?.source_a || 'Source A'}</th>
                      <th className="text-right p-2">{recon[0]?.source_b || 'Source B'}</th>
                      <th className="text-right p-2">Drift</th>
                      <th className="text-center p-2">Status</th>
                      <th className="text-left p-2">Checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recon.map((r, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="p-2 font-medium text-gray-900">{r.metric}</td>
                        <td className="p-2 text-gray-600">{r.period_label}</td>
                        <td className="p-2 text-right tabular-nums">{Number(r.value_a).toLocaleString('en-IN')}</td>
                        <td className="p-2 text-right tabular-nums">{Number(r.value_b).toLocaleString('en-IN')}</td>
                        <td className="p-2 text-right tabular-nums">{(Number(r.drift_pct) * 100).toFixed(2)}%</td>
                        <td className="p-2 text-center">
                          {r.drift_pass
                            ? <CheckCircle className="w-4 h-4 text-green-600 inline" />
                            : <AlertTriangle className="w-4 h-4 text-red-600 inline" />}
                        </td>
                        <td className="p-2 text-gray-500">{new Date(r.checked_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="md:hidden divide-y divide-gray-100 border border-gray-200 rounded">
                {recon.map((r, i) => (
                  <div key={i} className="p-2.5" style={{ fontSize: 12 }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">{r.metric}</span>
                      {r.drift_pass
                        ? <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                        : <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />}
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-gray-600" style={{ fontSize: 11 }}>
                      <div>Period: <span className="text-gray-900">{r.period_label}</span></div>
                      <div>Checked: <span className="text-gray-900">{new Date(r.checked_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span></div>
                      <div>{r.source_a || 'Source A'}: <span className="text-gray-900 tabular-nums">{Number(r.value_a).toLocaleString('en-IN')}</span></div>
                      <div>{r.source_b || 'Source B'}: <span className="text-gray-900 tabular-nums">{Number(r.value_b).toLocaleString('en-IN')}</span></div>
                      <div>Drift: <span className="text-gray-900 tabular-nums">{(Number(r.drift_pct) * 100).toFixed(2)}%</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
      </section>

      {error && <div className="text-xs text-red-600">Error loading dashboard: {error}</div>}
    </div>
  )
}

function Tile({ label, value, icon: Icon, tone }: {
  label: string
  value: number | string
  icon: typeof AlertCircle
  tone: 'purple' | 'red' | 'amber' | 'green'
}) {
  const toneClass = {
    purple: 'bg-purple-50 text-purple-700',
    red:    'bg-red-50 text-red-700',
    amber:  'bg-amber-50 text-amber-700',
    green:  'bg-green-50 text-green-700',
  }[tone]
  return (
    <div className="rounded border border-gray-200 p-3 bg-white">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className={`inline-flex w-5 h-5 rounded items-center justify-center ${toneClass}`}>
          <Icon className="w-3 h-3" />
        </span>
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{value}</div>
    </div>
  )
}
