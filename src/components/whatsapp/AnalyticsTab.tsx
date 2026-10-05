// WhatsApp analytics: message volume (30 days), flow performance, NLU bot health
// (audit_log nlp.hit / nlp.miss) and broadcast deliverability.

import { useEffect, useState, useMemo } from 'react'
import {
  Loader2, MessageSquare, TrendingUp, Brain, Send, RefreshCw,
  ChevronRight, AlertCircle,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

const C = {
  purple: '#341272',
  purpleLight: '#9333ea',
  green: '#3F7D5C',
  red: '#B0473C',
  amber: '#B8862E',
  border: '#D9E6E8',
  surface: '#FBF9F4',
}

type VolumeRow = { day: string; inbound: number; outbound: number }
type FlowRow   = { id: string; name: string; starts: number; completes: number; handoffs: number; avg_sec: number }
type MissRow   = { created_at: string; input: string; wa_id: string }
type BcastRow  = { id: string; name: string; total_sent: number; total_failed: number; status: string; sent_at: string | null; created_at: string }
type Analytics = {
  messageVolume:   VolumeRow[]
  flowPerformance: FlowRow[]
  nluHealth:       { hits: number; misses: number; missesRecent: MissRow[] }
  broadcasts:      BcastRow[]
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
function fmtDuration(sec: number) {
  if (!sec || sec < 1) return '—'
  if (sec < 60)   return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}
function fmtDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function AnalyticsTab() {
  const [data, setData]       = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  async function fetchData() {
    setLoading(true); setError('')
    try {
      const r = await apiFetch('/api/wa/analytics')
      if (!r.ok) throw new Error('Failed to load analytics')
      const d = await r.json()
      setData(d)
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setLoading(false)
  }
  useEffect(() => { fetchData() }, [])

  const totals = useMemo(() => {
    if (!data) return { inbound: 0, outbound: 0, responseRate: 0 }
    const inbound  = data.messageVolume.reduce((s, r) => s + r.inbound, 0)
    const outbound = data.messageVolume.reduce((s, r) => s + r.outbound, 0)
    const responseRate = inbound > 0 ? Math.round((outbound / inbound) * 100) : 0
    return { inbound, outbound, responseRate }
  }, [data])

  const nluPct = useMemo(() => {
    if (!data) return { hitPct: 0, missPct: 0, total: 0 }
    const total = data.nluHealth.hits + data.nluHealth.misses
    return {
      total,
      hitPct:  total ? Math.round((data.nluHealth.hits   / total) * 100) : 0,
      missPct: total ? Math.round((data.nluHealth.misses / total) * 100) : 0,
    }
  }, [data])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading analytics…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-xl px-4 py-3">
        <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        <button onClick={fetchData} className="ml-auto text-xs underline">Retry</button>
      </div>
    )
  }

  if (!data) return null

  const maxBar = Math.max(1, ...data.messageVolume.map(r => Math.max(r.inbound, r.outbound)))

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-bold text-gray-900">WhatsApp Analytics</h3>
          <p className="text-xs text-gray-500 mt-0.5">Last 30 days · auto-refresh on tab open</p>
        </div>
        <button
          onClick={fetchData}
          className="w-9 h-9 rounded-xl border border-[#D9E6E8] flex items-center justify-center hover:bg-gray-50 transition"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 1. Message volume */}
      <div className="bg-white rounded-xl border p-5" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.surface }}>
              <MessageSquare className="w-4 h-4" style={{ color: C.purple }} />
            </div>
            <div>
              <h4 className="font-semibold text-gray-800">Message Volume</h4>
              <p className="text-[10px] text-gray-400">Inbound vs outbound, daily</p>
            </div>
          </div>
          <div className="flex gap-4 flex-wrap">
            <Stat label="Inbound"  value={totals.inbound}  color={C.purple} />
            <Stat label="Outbound" value={totals.outbound} color={C.green} />
            <Stat label="Response" value={`${totals.responseRate}%`} color={totals.responseRate >= 80 ? C.green : C.amber} />
          </div>
        </div>

        {data.messageVolume.length === 0 ? (
          <EmptyChart label="No messages in the last 30 days yet" />
        ) : (
          <div className="flex items-end gap-1 h-32 mt-2">
            {data.messageVolume.map(r => (
              <div key={r.day} className="flex-1 flex flex-col items-center gap-0.5 group" title={`${r.day}\n↓ ${r.inbound} in · ↑ ${r.outbound} out`}>
                <div className="w-full flex items-end justify-center gap-0.5 h-28">
                  <div
                    className="w-1/2 rounded-t-sm transition-all group-hover:opacity-80"
                    style={{ height: `${(r.inbound / maxBar) * 100}%`, background: C.purple, minHeight: r.inbound > 0 ? 2 : 0 }}
                  />
                  <div
                    className="w-1/2 rounded-t-sm transition-all group-hover:opacity-80"
                    style={{ height: `${(r.outbound / maxBar) * 100}%`, background: C.green, minHeight: r.outbound > 0 ? 2 : 0 }}
                  />
                </div>
                <span className="text-[8px] text-gray-400">{new Date(r.day).getDate()}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: C.purple }} /> Inbound</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: C.green }} /> Outbound</span>
        </div>
      </div>

      {/* 2. Flow performance */}
      <div className="bg-white rounded-xl border p-5" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.surface }}>
            <TrendingUp className="w-4 h-4" style={{ color: C.purple }} />
          </div>
          <div>
            <h4 className="font-semibold text-gray-800">Flow Performance</h4>
            <p className="text-[10px] text-gray-400">Completion + handoff rates per active flow</p>
          </div>
        </div>

        {data.flowPerformance.length === 0 ? (
          <EmptyChart label="No active flows yet" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.flowPerformance.map(f => {
              const completePct = f.starts > 0 ? Math.round((f.completes / f.starts) * 100) : 0
              const handoffPct  = f.starts > 0 ? Math.round((f.handoffs  / f.starts) * 100) : 0
              const color = completePct >= 80 ? C.green : completePct >= 50 ? C.amber : C.red
              return (
                <div key={f.id} className="rounded-xl border p-3" style={{ borderColor: C.border }}>
                  <div className="text-xs font-semibold text-gray-800 truncate" title={f.name}>{f.name}</div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
                    <span>{f.starts} starts</span>
                    <span>avg {fmtDuration(f.avg_sec)}</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${completePct}%`, background: color }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px]">
                    <span style={{ color }}>{completePct}% completed</span>
                    {handoffPct > 0 && <span className="text-red-600">🙋 {handoffPct}% escalated</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 3. NLU bot health */}
      <div className="bg-white rounded-xl border p-5" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.surface }}>
              <Brain className="w-4 h-4" style={{ color: C.purpleLight }} />
            </div>
            <div>
              <h4 className="font-semibold text-gray-800">AI Routing Health</h4>
              <p className="text-[10px] text-gray-400">How often NLU rescues messages that don't match a keyword</p>
            </div>
          </div>
          <Stat label="Total NLU calls" value={nluPct.total} color={C.purpleLight} />
        </div>

        {nluPct.total === 0 ? (
          <EmptyChart label="No NLU calls yet. Inbound messages that don't match a keyword will appear here." />
        ) : (
          <>
            <div className="flex h-4 rounded-full overflow-hidden mb-1.5">
              <div className="flex items-center justify-center text-[9px] font-bold text-white" style={{ width: `${nluPct.hitPct}%`, background: C.green }}>
                {nluPct.hitPct > 8 && `${nluPct.hitPct}% rescued`}
              </div>
              <div className="flex items-center justify-center text-[9px] font-bold text-white" style={{ width: `${nluPct.missPct}%`, background: C.red }}>
                {nluPct.missPct > 8 && `${nluPct.missPct}% missed`}
              </div>
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mb-3">
              <span><span className="text-green-700 font-semibold">{data.nluHealth.hits}</span> rescued by AI</span>
              <span><span className="text-red-600 font-semibold">{data.nluHealth.misses}</span> still missed</span>
            </div>
          </>
        )}

        {data.nluHealth.missesRecent.length > 0 && (
          <div className="mt-2">
            <p className="text-[11px] font-semibold text-gray-700 mb-1.5">
              Recent unmatched messages
              <span className="text-[10px] text-gray-400 font-normal ml-1">— consider creating flows for these</span>
            </p>
            <div className="max-h-48 overflow-y-auto overflow-x-auto rounded-lg border" style={{ borderColor: C.border }}>
              <table className="w-full text-xs">
                <tbody>
                  {data.nluHealth.missesRecent.map((m, i) => (
                    <tr key={i} className="border-b last:border-b-0" style={{ borderColor: C.border }}>
                      <td className="px-3 py-2 text-gray-400 w-20 whitespace-nowrap">{timeAgo(m.created_at)}</td>
                      <td className="px-3 py-2 text-gray-700 italic">"{m.input || '(empty)'}"</td>
                      <td className="px-3 py-2 text-gray-400 w-24 text-right font-mono text-[10px]">+{m.wa_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 4. Broadcast deliverability */}
      <div className="bg-white rounded-xl border p-5" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.surface }}>
            <Send className="w-4 h-4" style={{ color: C.purple }} />
          </div>
          <div>
            <h4 className="font-semibold text-gray-800">Recent Broadcasts</h4>
            <p className="text-[10px] text-gray-400">Last 10 broadcast deliveries</p>
          </div>
        </div>

        {data.broadcasts.length === 0 ? (
          <EmptyChart label="No broadcasts sent yet" />
        ) : (
          <div className="space-y-2">
            {data.broadcasts.map(b => {
              const total = b.total_sent + b.total_failed
              const deliveryPct = total > 0 ? Math.round((b.total_sent / total) * 100) : 0
              const color = deliveryPct >= 95 ? C.green : deliveryPct >= 80 ? C.amber : C.red
              return (
                <div key={b.id} className="rounded-lg border px-3 py-2.5 flex items-center gap-3 flex-wrap" style={{ borderColor: C.border }}>
                  <ChevronRight className="w-3 h-3 text-gray-300 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-800 truncate">{b.name}</div>
                    <div className="text-[10px] text-gray-400">{fmtDate(b.sent_at || b.created_at)} · {b.status}</div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] shrink-0">
                    <span className="text-green-700 font-semibold">✓ {b.total_sent}</span>
                    {b.total_failed > 0 && <span className="text-red-600 font-semibold">✗ {b.total_failed}</span>}
                    <span className="font-bold w-12 text-right" style={{ color }}>{deliveryPct}%</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="text-right">
      <div className="text-base font-bold leading-tight" style={{ color }}>{value}</div>
      <div className="text-[9px] text-gray-400 uppercase tracking-widest">{label}</div>
    </div>
  )
}
function EmptyChart({ label }: { label: string }) {
  return (
    <div className="text-center py-8 text-[11px] text-gray-400">{label}</div>
  )
}
