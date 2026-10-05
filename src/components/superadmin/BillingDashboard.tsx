// Superadmin AI cost & usage dashboard: daily/weekly/monthly breakdowns per org and service.

import { useState, useEffect, useCallback } from 'react'
import {
  TrendingUp, TrendingDown, Minus,
  ChevronDown, ChevronRight,
  Download, RefreshCw, Loader2,
  Zap, Cpu, BarChart2, IndianRupee,
  AlertTriangle, History, Check,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'

// Approximate mid-2025 rate; update periodically.
const USD_TO_INR = 84

interface ServiceRow {
  org_id:     string
  service:    string
  model_tier: string
  calls:      number
  cost_usd:   number
}
interface DaySeries {
  day:      string
  cost_usd: number
  calls:    number
}
interface OrgBilling {
  org_id:              string
  org_name:            string
  org_slug:            string
  total_cost_usd:      number
  total_calls:         number
  total_input_tokens:  number
  total_output_tokens: number
  downgraded_calls:    number
  backfill_calls:      number
  by_service:          ServiceRow[]
  daily_series:        DaySeries[]
}
interface Summary {
  period:             string
  from:               string
  to:                 string
  grand_total_usd:    number
  grand_total_calls:  number
  orgs:               OrgBilling[]
}

type Period = 'daily' | 'weekly' | 'monthly' | 'all'

const SVC: Record<string, { label: string; color: string; emoji: string; category: string }> = {
  report_ai:        { label: 'AI Report',        color: '#7C3AED', emoji: '📊', category: 'Reports'       },
  social_post:      { label: 'Social Post',      color: '#2563EB', emoji: '📱', category: 'Reports'       },
  notebook_chat:    { label: 'Notebook Chat',    color: '#059669', emoji: '💬', category: 'Notebook'      },
  notebook_audio:   { label: 'Podcast Script',   color: '#D97706', emoji: '🎙️', category: 'Notebook'      },
  notebook_study:   { label: 'Study Guide',      color: '#0891B2', emoji: '📚', category: 'Notebook'      },
  notebook_slides:  { label: 'Slide Deck',       color: '#BE185D', emoji: '🎨', category: 'Notebook'      },
  notebook_revise:  { label: 'Slide Revision',   color: '#9333EA', emoji: '✏️', category: 'Notebook'      },
  notebook_tts:     { label: 'Text to Speech',   color: '#F59E0B', emoji: '🔊', category: 'Notebook'      },
  notebook_imagen:  { label: 'Image Generate',   color: '#EF4444', emoji: '🖼️', category: 'Notebook'      },
  rw_learn:         { label: 'Voice Learn',      color: '#06B6D4', emoji: '🧠', category: 'Report Writer' },
  rw_draft:         { label: 'Report Draft',     color: '#84CC16', emoji: '📝', category: 'Report Writer' },
  rw_refine:        { label: 'Report Refine',    color: '#F97316', emoji: '🔧', category: 'Report Writer' },
  rw_reflect:       { label: 'Reflection',       color: '#8B5CF6', emoji: '🔄', category: 'Report Writer' },
  rw_polish:        { label: 'Auto-Polish',      color: '#EC4899', emoji: '✨', category: 'Report Writer' },
  worker_analytics: { label: 'Worker Analytics', color: '#14B8A6', emoji: '👤', category: 'Analytics'     },
}
const svcMeta = (id: string) =>
  SVC[id] ?? { label: id, color: '#6B7280', emoji: '⚙️', category: 'Other' }

const toInr   = (usd: number) => usd * USD_TO_INR
const fmtInr  = (usd: number) => {
  const inr = toInr(usd)
  if (inr < 0.01)   return '<₹0.01'
  if (inr < 1)      return `₹${inr.toFixed(2)}`
  if (inr < 1_000)  return `₹${inr.toFixed(2)}`
  if (inr < 1_00_000)  return `₹${(inr / 1_000).toFixed(2)}K`
  return `₹${(inr / 1_00_000).toFixed(2)}L`
}
const fmtBig  = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n)
const fmtDate = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function Sparkline({ data, color = '#7C3AED' }: { data: DaySeries[]; color?: string }) {
  if (!data.length) return <span className="text-[10px] text-gray-300">no data</span>
  const W = 80, H = 24, pad = 2
  const vals = data.map(d => d.cost_usd)
  const min  = Math.min(...vals)
  const max  = Math.max(...vals)
  const rng  = max - min || 1
  const pts  = vals.map((v, i) => {
    const x = pad + (i / Math.max(vals.length - 1, 1)) * (W - 2 * pad)
    const y = pad + (1 - (v - min) / rng) * (H - 2 * pad)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ServiceBar({ row, maxCost }: { row: ServiceRow; maxCost: number }) {
  const meta = svcMeta(row.service)
  const pct  = maxCost > 0 ? (row.cost_usd / maxCost) * 100 : 0
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-sm w-5 text-center">{meta.emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[11px] font-medium text-gray-700 truncate">{meta.label}</span>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="text-[10px] text-gray-400">{fmtBig(row.calls)} calls</span>
            <span className="text-[11px] font-semibold text-gray-800">{fmtInr(row.cost_usd)}</span>
          </div>
        </div>
        <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, 1)}%`, background: meta.color }} />
        </div>
      </div>
      <span
        className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
        style={{ background: row.model_tier === 'pro' ? '#FEF3C7' : '#F0FDF4',
                 color:      row.model_tier === 'pro' ? '#92400E' : '#166534' }}
      >
        {row.model_tier.toUpperCase()}
      </span>
    </div>
  )
}

function OrgCard({ org, rank }: { org: OrgBilling; rank: number }) {
  const [open, setOpen] = useState(false)
  const maxSvcCost = Math.max(...(org.by_service.map(s => s.cost_usd)), 0)

  const categories = Array.from(new Set(org.by_service.map(s => svcMeta(s.service).category)))

  const rankColors = ['#F59E0B', '#94A3B8', '#CD7C3E']
  const rankBg     = ['#FFFBEB', '#F8FAFC', '#FFF7F3']

  return (
    <div className="border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition text-left"
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0"
          style={{ background: rankBg[rank] ?? '#F9FAFB', color: rankColors[rank] ?? '#374151' }}
        >
          {rank + 1}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{org.org_name}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{org.org_slug} &nbsp;·&nbsp; {org.total_calls} calls</p>
        </div>

        <Sparkline data={org.daily_series} color="#7C3AED" />

        <div className="text-right shrink-0 ml-2">
          <p className="text-base font-black text-gray-900">{fmtInr(org.total_cost_usd)}</p>
          <div className="flex items-center gap-1.5 justify-end mt-0.5 flex-wrap">
            {org.downgraded_calls > 0 && (
              <p className="text-[10px] text-amber-600 flex items-center gap-0.5">
                <AlertTriangle className="w-2.5 h-2.5" /> {org.downgraded_calls} downgraded
              </p>
            )}
            {(org.backfill_calls ?? 0) > 0 && (
              <p className="text-[10px] text-violet-500 flex items-center gap-0.5">
                <History className="w-2.5 h-2.5" /> {org.backfill_calls} historical
              </p>
            )}
          </div>
        </div>

        <div className="ml-1 shrink-0 text-gray-300">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
          <div className="flex flex-wrap gap-3 mb-4 text-[11px] text-gray-500">
            <span>Est. input tokens: <strong className="text-gray-700">{fmtBig(org.total_input_tokens ?? 0)}</strong></span>
            <span>Est. output budget: <strong className="text-gray-700">{fmtBig(org.total_output_tokens ?? 0)}</strong></span>
            {(org.backfill_calls ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-violet-500">
                <History className="w-3 h-3" />
                {org.backfill_calls} from saved reports (historical)
              </span>
            )}
          </div>

          {categories.map(cat => {
            const rows = org.by_service.filter(s => svcMeta(s.service).category === cat)
            if (!rows.length) return null
            return (
              <div key={cat} className="mb-4">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{cat}</p>
                <div className="space-y-0.5">
                  {rows.map((row, i) => (
                    <ServiceBar key={i} row={row} maxCost={maxSvcCost} />
                  ))}
                </div>
              </div>
            )
          })}

          {org.daily_series.length > 1 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Daily Trend</p>
              <div className="flex gap-1 flex-wrap">
                {org.daily_series.map((d, i) => (
                  <div key={i} className="flex flex-col items-center gap-0.5 min-w-[40px]">
                    <div
                      className="w-7 rounded text-[9px] font-semibold text-white text-center py-0.5"
                      style={{ background: '#7C3AED', opacity: 0.3 + 0.7 * (d.cost_usd / Math.max(...org.daily_series.map(x => x.cost_usd), 1)) }}
                    >
                      {d.calls}
                    </div>
                    <span className="text-[9px] text-gray-400">{fmtDate(d.day)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SummaryStrip({ data, prev }: { data: Summary; prev: Summary | null }) {
  const change = prev && prev.grand_total_usd > 0
    ? ((data.grand_total_usd - prev.grand_total_usd) / prev.grand_total_usd) * 100
    : null

  const avgPerOrg = data.orgs.length > 0 ? data.grand_total_usd / data.orgs.length : 0
  const proCallPct = data.orgs.length > 0
    ? data.orgs.reduce((s, o) => s + o.by_service.filter(r => r.model_tier === 'pro').reduce((a, b) => a + b.calls, 0), 0) /
      Math.max(data.grand_total_calls, 1) * 100
    : 0

  const cards = [
    {
      label: 'Total AI Cost',
      value: fmtInr(data.grand_total_usd),
      sub:   change !== null
        ? <span className={change > 0 ? 'text-red-500' : 'text-green-600'}>
            {change > 0 ? <TrendingUp className="w-3 h-3 inline" /> : change < 0 ? <TrendingDown className="w-3 h-3 inline" /> : <Minus className="w-3 h-3 inline" />}
            {' '}{Math.abs(change).toFixed(0)}% vs prev
          </span>
        : <span className="text-gray-400">across all orgs · @₹{USD_TO_INR}/$</span>,
      icon: IndianRupee, iconBg: '#EDE9FE', iconColor: '#7C3AED',
    },
    {
      label: 'Total AI Calls',
      value: fmtBig(data.grand_total_calls),
      sub:   <span className="text-gray-400">{data.orgs.length} active org{data.orgs.length !== 1 ? 's' : ''}</span>,
      icon: BarChart2, iconBg: '#DBEAFE', iconColor: '#2563EB',
    },
    {
      label: 'Avg Cost / Org',
      value: fmtInr(avgPerOrg),
      sub:   <span className="text-gray-400">this period</span>,
      icon: TrendingUp, iconBg: '#D1FAE5', iconColor: '#059669',
    },
    {
      label: 'Pro Model Usage',
      value: `${proCallPct.toFixed(0)}%`,
      sub:   <span className="text-gray-400">of calls use Pro tier</span>,
      icon: Cpu, iconBg: '#FEF3C7', iconColor: '#D97706',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map(({ label, value, sub, icon: Icon, iconBg, iconColor }) => (
        <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0" style={{ background: iconBg }}>
              <Icon className="w-3.5 h-3.5" style={{ color: iconColor }} />
            </div>
            <p className="text-[11px] text-gray-500 font-medium">{label}</p>
          </div>
          <p className="text-xl font-black text-gray-900">{value}</p>
          <p className="text-[11px] mt-0.5">{sub}</p>
        </div>
      ))}
    </div>
  )
}

function PlatformServices({ orgs }: { orgs: OrgBilling[] }) {
  const agg: Record<string, { calls: number; cost: number }> = {}
  for (const org of orgs) {
    for (const svc of org.by_service) {
      if (!agg[svc.service]) agg[svc.service] = { calls: 0, cost: 0 }
      agg[svc.service].calls += svc.calls
      agg[svc.service].cost  += svc.cost_usd
    }
  }
  const rows = Object.entries(agg)
    .map(([k, v]) => ({ service: k, ...v }))
    .sort((a, b) => b.cost - a.cost)
  const maxCost = Math.max(...rows.map(r => r.cost), 0)
  if (!rows.length) return null

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <p className="text-sm font-bold text-gray-900 mb-4">Platform-wide service breakdown</p>
      <div className="space-y-1">
        {rows.map((row, i) => {
          const meta = svcMeta(row.service)
          const pct  = maxCost > 0 ? (row.cost / maxCost) * 100 : 0
          return (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <span className="text-base w-6 text-center">{meta.emoji}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-medium text-gray-700">{meta.label}</span>
                  <span className="text-xs text-gray-800 font-semibold shrink-0 ml-2">{fmtInr(row.cost)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 1)}%`, background: meta.color }} />
                </div>
              </div>
              <span className="text-[10px] text-gray-400 shrink-0 w-12 text-right">{fmtBig(row.calls)} calls</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function BillingDashboard() {
  const [period,        setPeriod]        = useState<Period>('monthly')
  const [data,          setData]          = useState<Summary | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [lastFetch,     setLastFetch]     = useState<Date | null>(null)
  const [backfilling,   setBackfilling]   = useState(false)
  const [backfillMsg,   setBackfillMsg]   = useState<string | null>(null)

  const PERIOD_LABELS: Record<Period, string> = {
    daily: 'Today', weekly: 'Last 7 Days', monthly: 'Last 30 Days', all: 'All Time',
  }

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const res  = await apiFetch(`/api/superadmin/billing/summary?period=${p}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json)
      setLastFetch(new Date())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }, [])

  async function handleBackfill() {
    if (backfilling) return
    setBackfilling(true); setBackfillMsg(null)
    try {
      const res  = await apiFetch('/api/superadmin/billing/backfill', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setBackfillMsg(json.message ?? 'Done')
      await load(period)
    } catch (e: any) {
      setBackfillMsg(`Error: ${e?.message ?? 'Failed'}`)
    } finally {
      setBackfilling(false)
    }
  }

  useEffect(() => { load(period) }, [period, load])

  function handleExport() {
    authedDownload(`/api/superadmin/billing/export.csv?period=${encodeURIComponent(period)}`, `billing-${period}.csv`)
      .catch(e => setError(e?.message ?? 'Export failed'))
  }

  return (
    <div className="flex flex-col gap-5 p-5">

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-gray-400 mt-0.5">
            {data
              ? (data.from ? `${data.from} → ${data.to}` : 'All time')
              : 'Loading...'}
            {lastFetch && (
              <span className="ml-2 text-gray-300">
                · refreshed {lastFetch.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 flex-wrap">
            {(['daily', 'weekly', 'monthly', 'all'] as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition"
                style={period === p
                  ? { background: '#7C3AED', color: '#fff' }
                  : { color: '#6B7280' }
                }
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(period)}
            disabled={loading}
            className="p-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-500 transition disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {/* Import historical saved reports */}
          <button
            onClick={handleBackfill}
            disabled={backfilling}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition border"
            style={{ borderColor: '#7C3AED', color: '#7C3AED', background: '#F5F3FF' }}
            title="Import all saved reports as historical cost data"
          >
            {backfilling
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <History className="w-3.5 h-3.5" />}
            Import Past Data
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white transition"
            style={{ background: '#7C3AED' }}
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {backfillMsg && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${
          backfillMsg.startsWith('Error')
            ? 'bg-red-50 border-red-100 text-red-600'
            : 'bg-violet-50 border-violet-100 text-violet-700'
        }`}>
          {backfillMsg.startsWith('Error')
            ? <AlertTriangle className="w-4 h-4 shrink-0" />
            : <Check className="w-4 h-4 shrink-0" />}
          {backfillMsg}
          <button onClick={() => setBackfillMsg(null)} className="ml-auto text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-3 p-4 bg-red-50 rounded-xl border border-red-100 text-sm text-red-600">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {data && !loading && data.orgs.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📊</div>
          <p className="font-semibold text-gray-500">No AI usage recorded yet</p>
          <p className="text-sm mt-1 text-gray-400">
            Usage data appears here once any org generates an AI report, social post, or uses Notebook.
          </p>
        </div>
      )}

      {data && !loading && data.orgs.length > 0 && (
        <>
          <SummaryStrip data={data} prev={null} />

          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-3">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">
                {data.orgs.length} organisation{data.orgs.length !== 1 ? 's' : ''} · sorted by cost
              </p>
              {data.orgs.map((org, i) => (
                <OrgCard key={org.org_id} org={org} rank={i} />
              ))}
            </div>

            <div className="flex flex-col gap-4">
              <PlatformServices orgs={data.orgs} />

              <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-xs text-amber-700 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" /> Cost Estimates (INR)
                </p>
                <p>Converted at <strong>1 USD = ₹{USD_TO_INR}</strong>. Input tokens estimated at 4 chars = 1 token. Output assumes full token budget — actual spend is typically 20–60% lower.</p>
                <p className="pt-1 font-medium">Gemini pricing used:</p>
                <p>Pro: ₹{(1.25*USD_TO_INR).toFixed(0)}/M in · ₹{(10*USD_TO_INR).toFixed(0)}/M out</p>
                <p>Flash: ₹{(0.15*USD_TO_INR).toFixed(0)}/M in · ₹{(0.60*USD_TO_INR).toFixed(0)}/M out</p>
                <p>Imagen: ₹{(0.03*USD_TO_INR).toFixed(2)}/image · TTS: ₹{(0.10*USD_TO_INR).toFixed(2)}/M chars</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
