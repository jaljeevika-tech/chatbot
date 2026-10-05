// Aggregate AI Theory of Change analysis + quantitative evidence.
import { useState, useMemo } from 'react'
import {
  Layers, Sparkles, Loader2, ChevronDown, AlertTriangle,
  Languages, ArrowRight, RefreshCw, Info, Calendar, TrendingUp,
  BarChart3, Lightbulb, ShieldAlert,
} from 'lucide-react'
import type { DailyReport } from '../../types/report'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'

interface Props { baseReports: DailyReport[] }
type Scope = 'org' | 'project' | 'region'

interface BreakdownRow { name: string; count: number; benef: number }
interface TocResult {
  toc_distribution:      { Activity: number; Output: number; Outcome: number; Impact: number }
  quantitative_insights: string[]
  change_pathway:        string[]
  key_themes:            string[]
  top_barriers:          { barrier: string; note: string; suggestion?: string }[]
  key_issues:            { issue: string; evidence: string; severity: 'high' | 'medium' | 'low'; suggestion: string }[]
  common_idioms:         { original: string; meaning: string }[]
  toc_narrative:         string
  breakdowns: {
    by_area:    BreakdownRow[]
    by_project: BreakdownRow[]
    by_state:   BreakdownRow[]
    by_month:   { month: string; count: number; benef: number }[]
  }
  meta: { total_reports: number; total_benef: number; avg_benef: number; scope_label: string; date_range: string }
}

const TOC_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  Activity: { bg: 'bg-blue-50',   text: 'text-blue-700',   bar: 'bg-blue-500'   },
  Output:   { bg: 'bg-green-50',  text: 'text-green-700',  bar: 'bg-green-500'  },
  Outcome:  { bg: 'bg-purple-50', text: 'text-purple-700', bar: 'bg-purple-500' },
  Impact:   { bg: 'bg-rose-50',   text: 'text-rose-700',   bar: 'bg-rose-500'   },
}
const TOC_DESC: Record<string, string> = {
  Activity: 'Actions taken — trainings, meetings, distributions',
  Output:   'Countable direct results — people trained, households reached',
  Outcome:  'Behavioural change — communities adopting new practices',
  Impact:   'Systemic change — policy shifts, long-term transformation',
}

function BreakdownTable({ title, rows, valueKey = 'benef', color = '#341272' }: {
  title: string; rows: BreakdownRow[]; valueKey?: 'benef' | 'count'; color?: string
}) {
  const max = Math.max(...rows.map(r => r[valueKey]), 1)
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">{title}</p>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.name} className="flex items-center gap-2">
            <span className="text-xs text-gray-600 w-28 shrink-0 truncate" title={r.name}>{r.name}</span>
            <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full transition-all"
                style={{ width: `${(r[valueKey] / max) * 100}%`, background: color }}
              />
            </div>
            <span className="text-xs font-semibold text-gray-700 w-16 text-right shrink-0">
              {valueKey === 'benef'
                ? r.benef.toLocaleString('en-IN')
                : r.count.toLocaleString('en-IN')}
            </span>
            <span className="text-[10px] text-gray-400 w-14 shrink-0">
              {valueKey === 'benef' ? `${r.count} rpts` : 'reports'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MonthlyChart({ data }: { data: { month: string; count: number; benef: number }[] }) {
  if (!data.length) return null
  const maxCount = Math.max(...data.map(d => d.count), 1)
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Monthly Activity Trend</p>
      <div className="flex items-end gap-1 h-14">
        {data.map(d => (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.month}: ${d.count} reports, ${d.benef.toLocaleString('en-IN')} beneficiaries`}>
            <div
              className="w-full rounded-t-sm transition-all"
              style={{ height: `${Math.max((d.count / maxCount) * 48, 4)}px`, background: '#341272' }}
            />
            <span className="text-[8px] text-gray-400 rotate-45 origin-left whitespace-nowrap hidden sm:block">
              {d.month.slice(5)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 mt-1">
        <span>{data[0]?.month}</span>
        <span>{data[data.length - 1]?.month}</span>
      </div>
    </div>
  )
}

export function TocAnalysisPage({ baseReports }: Props) {
  const [scope,    setScope]    = useState<Scope>('org')
  const [subValue, setSubValue] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')
  const [result,   setResult]   = useState<TocResult | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [quantTab, setQuantTab] = useState<'area' | 'project' | 'state' | 'month'>('area')

  const projects = useMemo(() =>
    [...new Set(baseReports.map(r => r.project).filter(Boolean))].sort(), [baseReports])
  const regions = useMemo(() =>
    [...new Set(baseReports.map(r => r.state).filter(Boolean))].sort(), [baseReports])

  const scopedReports = useMemo(() => {
    let r = baseReports
    if (scope === 'project' && subValue) r = r.filter(x => x.project === subValue)
    if (scope === 'region'  && subValue) r = r.filter(x => x.state   === subValue)
    if (dateFrom) r = r.filter(x => String(x.timestamp).slice(0, 10) >= dateFrom)
    if (dateTo)   r = r.filter(x => String(x.timestamp).slice(0, 10) <= dateTo)
    return r
  }, [baseReports, scope, subValue, dateFrom, dateTo])

  const scopeLabel = useMemo(() => {
    const parts: string[] = []
    if (scope === 'project' && subValue) parts.push(`Project: ${subValue}`)
    else if (scope === 'region' && subValue) parts.push(`Region: ${subValue}`)
    else parts.push('Organisation (all reports)')
    if (dateFrom || dateTo) {
      const fmt = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      parts.push(`${dateFrom ? fmt(dateFrom) : 'Start'} – ${dateTo ? fmt(dateTo) : 'Now'}`)
    }
    return parts.join(' · ')
  }, [scope, subValue, dateFrom, dateTo])

  function resetFilters() { setScope('org'); setSubValue(''); setDateFrom(''); setDateTo(''); setResult(null) }

  async function runAnalysis() {
    if (scopedReports.length === 0) return
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await apiFetch('/api/analyze-toc-aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports: scopedReports, scopeLabel }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Server error ${res.status}`)
      }
      setResult(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const distSegments = result
    ? (['Activity', 'Output', 'Outcome', 'Impact'] as const)
        .map(k => ({ key: k, value: result.toc_distribution[k] || 0, ...TOC_COLORS[k] }))
        .filter(s => s.value > 0)
    : []

  return (
    <div className="space-y-5 pb-10">

      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-2xl flex items-center justify-center shrink-0" style={{ background: '#EDE9FE' }}>
          <Layers className="w-[18px] h-[18px] text-violet-600" />
        </div>
        <div>
          <h1 className="font-black text-gray-900 text-lg leading-tight">Theory of Change Analysis</h1>
          <p className="text-xs text-gray-400 mt-0.5">AI ToC attribution backed by quantitative field data</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-4 space-y-4 border border-gray-100">
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Scope</p>
          <div className="flex gap-2 flex-wrap">
            {([['org','Organisation'],['project','By Project'],['region','By Region']] as [Scope,string][]).map(([k,l]) => (
              <button key={k} onClick={() => { setScope(k); setSubValue(''); setResult(null) }}
                className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
                style={{ background: scope===k ? FF.tealDark:'transparent', color: scope===k ? '#fff':FF.textMuted, border: scope===k ? 'none':'1.5px solid #D5D8D2' }}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {(scope === 'project' || scope === 'region') && (
          <div className="relative">
            <select value={subValue} onChange={e => { setSubValue(e.target.value); setResult(null) }}
              className="w-full appearance-none bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-800 pr-9 focus:outline-none focus:ring-2 focus:ring-violet-300">
              <option value="">{scope === 'project' ? 'Select a project…' : 'Select a region / state…'}</option>
              {(scope === 'project' ? projects : regions).map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" /> Date Range (optional)
          </p>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] text-gray-400 font-medium mb-1 block">From</label>
              <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setResult(null) }}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-violet-300" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-gray-400 font-medium mb-1 block">To</label>
              <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setResult(null) }}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-violet-300" />
            </div>
            {(dateFrom || dateTo) && (
              <div className="flex items-end pb-0.5">
                <button onClick={() => { setDateFrom(''); setDateTo(''); setResult(null) }}
                  className="text-xs text-gray-400 hover:text-gray-600 px-2 py-2 rounded-lg hover:bg-gray-100 transition">Clear</button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-400">
            <span className="font-bold text-gray-700">{scopedReports.length.toLocaleString('en-IN')}</span> reports
          </span>
          {scopedReports.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-violet-600 bg-violet-50 border border-violet-100 px-2 py-0.5 rounded-full">
              <Info className="w-3 h-3" /> All {scopedReports.length} will be analysed
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={runAnalysis}
            disabled={loading || scopedReports.length === 0 || (scope !== 'org' && !subValue)}
            className="flex-1 py-2.5 rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2 transition disabled:opacity-50"
            style={{ background: '#341272' }}>
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" />Analysing {scopedReports.length.toLocaleString('en-IN')} reports…</>
              : result
                ? <><RefreshCw className="w-4 h-4" />Re-run Analysis</>
                : <><Sparkles className="w-4 h-4" />Run AI Analysis</>}
          </button>
          {(scope !== 'org' || subValue || dateFrom || dateTo) && (
            <button onClick={resetFilters}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-500 border border-gray-200 hover:bg-gray-50 transition">
              Reset
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-500 text-center">{error}</p>}
      </div>

      {/* Results */}
      {result && (
        <>
          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-400 px-1">
            <span><strong className="text-gray-700">{result.meta.total_reports.toLocaleString('en-IN')}</strong> reports analysed</span>
            <span className="text-gray-200">·</span>
            <span><strong className="text-gray-700">{result.meta.total_benef.toLocaleString('en-IN')}</strong> beneficiaries</span>
            <span className="text-gray-200">·</span>
            <span>avg <strong className="text-gray-700">{result.meta.avg_benef}</strong>/report</span>
            <span className="text-gray-200">·</span>
            <span>{result.meta.date_range}</span>
          </div>

          {/* Quantitative evidence (server-computed) */}
          <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-gray-500" />
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Quantitative Evidence</p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Total Reports',   value: result.meta.total_reports.toLocaleString('en-IN') },
                { label: 'Beneficiaries',   value: result.meta.total_benef.toLocaleString('en-IN')   },
                { label: 'Avg / Report',    value: result.meta.avg_benef.toLocaleString('en-IN')      },
              ].map(s => (
                <div key={s.label} className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2.5 text-center">
                  <p className="text-lg font-black text-gray-900">{s.value}</p>
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {([['area','By Area'],['project','By Project'],['state','By State'],['month','Monthly']] as [typeof quantTab, string][]).map(([k, l]) => (
                <button key={k} onClick={() => setQuantTab(k)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{ background: quantTab===k ? '#fff':'transparent', color: quantTab===k ? FF.tealDark:'#86A0A5',
                    boxShadow: quantTab===k ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  {l}
                </button>
              ))}
            </div>

            {quantTab === 'area'    && <BreakdownTable title="Beneficiaries by Area of Intervention" rows={result.breakdowns.by_area}    color="#341272" />}
            {quantTab === 'project' && <BreakdownTable title="Beneficiaries by Project"              rows={result.breakdowns.by_project} color="#16A34A" />}
            {quantTab === 'state'   && <BreakdownTable title="Beneficiaries by State"                rows={result.breakdowns.by_state}   color="#7C3AED" />}
            {quantTab === 'month'   && <MonthlyChart data={result.breakdowns.by_month} />}
          </div>

          <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Theory of Change Tier Distribution</p>
            <div className="flex rounded-full overflow-hidden h-5 gap-0.5">
              {distSegments.map(s => (
                <div key={s.key} className={`${s.bar} first:rounded-l-full last:rounded-r-full flex items-center justify-center`}
                  style={{ width: `${s.value}%` }} title={`${s.key}: ${s.value}%`}>
                  {s.value >= 12 && <span className="text-white text-[9px] font-black">{s.value}%</span>}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['Activity','Output','Outcome','Impact'] as const).map(k => {
                const c = TOC_COLORS[k]; const v = result.toc_distribution[k] || 0
                return (
                  <div key={k} className={`rounded-xl p-3 ${c.bg}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-bold ${c.text}`}>{k}</span>
                      <span className={`text-xl font-black ${c.text}`}>{v}%</span>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-snug">{TOC_DESC[k]}</p>
                  </div>
                )
              })}
            </div>
          </div>

          {result.quantitative_insights.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-violet-500" />
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Data-Backed ToC Insights</p>
              </div>
              <div className="space-y-2">
                {result.quantitative_insights.map((insight, i) => (
                  <div key={i} className="flex gap-3 rounded-xl bg-violet-50 border border-violet-100 px-3 py-2.5">
                    <span className="w-5 h-5 rounded-full bg-violet-200 text-violet-800 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                    <p className="text-sm text-violet-900 leading-snug">{insight}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.toc_narrative && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-500" />
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Theory of Change Narrative</p>
              </div>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{result.toc_narrative}</p>
            </div>
          )}

          {result.change_pathway.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Change Pathway</p>
              <div className="flex flex-wrap items-center gap-2">
                {result.change_pathway.map((step, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 bg-violet-50 border border-violet-100 rounded-xl px-3 py-2">
                      <span className="w-4 h-4 rounded-full bg-violet-600 text-white text-[9px] font-black flex items-center justify-center shrink-0">{i+1}</span>
                      <span className="text-xs font-medium text-violet-800">{step}</span>
                    </div>
                    {i < result.change_pathway.length-1 && <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.key_themes.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Key Thematic Areas</p>
              <div className="flex flex-wrap gap-2">
                {result.key_themes.map((t, i) => (
                  <span key={i} className="px-3 py-1.5 rounded-full text-xs font-semibold"
                    style={{ background: '#F3F0FF', color: '#5B21B6' }}>{t}</span>
                ))}
              </div>
            </div>
          )}

          {result.top_barriers.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Systemic Barriers &amp; How to Overcome Them</p>
              </div>
              <div className="space-y-2.5">
                {result.top_barriers.map((b, i) => (
                  <div key={i} className="rounded-xl border border-amber-100 overflow-hidden">
                    <div className="flex gap-3 bg-amber-50 px-3 py-2.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-amber-800">{b.barrier}</p>
                        {b.note && <p className="text-xs text-amber-700 mt-0.5 leading-snug">{b.note}</p>}
                      </div>
                    </div>
                    {b.suggestion && (
                      <div className="flex gap-2 bg-green-50 border-t border-green-100 px-3 py-2">
                        <Lightbulb className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                        <p className="text-xs text-green-800 leading-snug">{b.suggestion}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.key_issues.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-500" />
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Key Issues &amp; Recommendations</p>
              </div>
              <div className="space-y-2.5">
                {result.key_issues.map((item, i) => {
                  const sev = item.severity
                  const sevStyle = sev === 'high'
                    ? { bg: 'bg-rose-100',   text: 'text-rose-700',   label: 'High'   }
                    : sev === 'medium'
                    ? { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Medium' }
                    : { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Low'    }
                  return (
                    <div key={i} className="rounded-xl border border-gray-100 overflow-hidden">
                      <div className="flex gap-3 items-start bg-gray-50 px-3 py-2.5">
                        <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-700 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-bold text-gray-800">{item.issue}</p>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${sevStyle.bg} ${sevStyle.text}`}>
                              {sevStyle.label}
                            </span>
                          </div>
                          {item.evidence && (
                            <p className="text-xs text-gray-500 mt-0.5 leading-snug">{item.evidence}</p>
                          )}
                        </div>
                      </div>
                      {item.suggestion && (
                        <div className="flex gap-2 bg-blue-50 border-t border-blue-100 px-3 py-2">
                          <Lightbulb className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                          <p className="text-xs text-blue-800 leading-snug">{item.suggestion}</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {result.common_idioms.length > 0 && (
            <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
              <div className="flex items-center gap-2">
                <Languages className="w-4 h-4 text-gray-400" />
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Vernacular Expressions Decoded</p>
              </div>
              <div className="rounded-xl border border-gray-100 overflow-hidden">
                <table className="w-full text-[11px] sm:text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="text-left px-2 py-1.5 sm:px-3 sm:py-2 text-gray-500 font-semibold w-1/2">Original Expression</th>
                      <th className="text-left px-2 py-1.5 sm:px-3 sm:py-2 text-gray-500 font-semibold w-1/2">Professional Meaning</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {result.common_idioms.map((idiom, i) => (
                      <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                        <td className="px-2 py-2 sm:px-3 sm:py-2.5 text-gray-700 italic align-top">{idiom.original}</td>
                        <td className="px-2 py-2 sm:px-3 sm:py-2.5 text-gray-600 align-top">{idiom.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!loading && !result && !error && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: '#EDE9FE' }}>
            <Layers className="w-6 h-6 text-violet-500" />
          </div>
          <p className="text-sm font-semibold text-gray-700">Select a scope and run the analysis</p>
          <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
            The AI classifies every field report by ToC tier, decodes vernacular idioms, and
            identifies systemic barriers — then backs every claim with exact numbers from your data.
          </p>
        </div>
      )}
    </div>
  )
}
