// Custom dashboards built by the super admin (services/dashboard/src/custom.js).
// WidgetView is shared with the super admin builder's live preview.

import { useEffect, useState } from 'react'
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'

export type ChartType = 'kpi' | 'bar' | 'line' | 'pie' | 'table'
export interface Widget {
  id: string; title: string; metric: string; chart: ChartType; groupBy: string
  projectKey: string; from: string; to: string; wide: boolean
}
export interface WidgetData { value?: number; rows?: { label: string; value: number }[]; error?: string }
export interface CustomDashboard { id: string; title: string; visible_to: 'all' | 'admin'; sort_order: number; widgets: Widget[]; updated_at?: string }

const PALETTE = [FF.purple, FF.tealDark, FF.green, FF.amber, FF.red, '#5B8DB8', '#8E6BBF', FF.textFaint]
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 1 })

export function WidgetView({ widget, data }: { widget: Widget; data?: WidgetData }) {
  let body
  if (!data) body = <div className="h-full min-h-[120px] rounded-lg animate-pulse" style={{ background: FF.borderFaint }} />
  else if (data.error) body = <p className="text-sm" style={{ color: FF.red }}>{data.error}</p>
  else if (widget.chart === 'kpi') body = <div className="text-4xl font-semibold tabular-nums" style={{ color: FF.tealDark }}>{fmt(data.value ?? 0)}</div>
  else if (!data.rows?.length) body = <p className="text-sm" style={{ color: FF.textMuted }}>No data yet.</p>
  else if (widget.chart === 'table') body = (
    <div className="max-h-[240px] overflow-auto">
      <table className="w-full text-sm">
        <tbody>
          {data.rows.map(r => (
            <tr key={r.label} style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
              <td className="py-1.5 pr-3" style={{ color: FF.tealText }}>{r.label}</td>
              <td className="py-1.5 text-right tabular-nums font-medium" style={{ color: FF.tealDark }}>{fmt(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  else body = (
    <ResponsiveContainer width="100%" height={240}>
      {widget.chart === 'pie' ? (
        <PieChart>
          <Pie data={data.rows} dataKey="value" nameKey="label" outerRadius={90} label={({ name }) => String(name).slice(0, 14)}>
            {data.rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip formatter={v => fmt(Number(v))} />
        </PieChart>
      ) : widget.chart === 'line' ? (
        <LineChart data={data.rows}>
          <CartesianGrid strokeDasharray="3 3" stroke={FF.border} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={v => fmt(Number(v))} />
          <Line type="monotone" dataKey="value" name={widget.title} stroke={FF.purple} strokeWidth={2} dot />
        </LineChart>
      ) : (
        <BarChart data={data.rows}>
          <CartesianGrid strokeDasharray="3 3" stroke={FF.border} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={data.rows.length > 6 ? -30 : 0} textAnchor={data.rows.length > 6 ? 'end' : 'middle'} height={data.rows.length > 6 ? 60 : 30} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={v => fmt(Number(v))} />
          <Bar dataKey="value" name={widget.title} fill={FF.purple} radius={[4, 4, 0, 0]} />
        </BarChart>
      )}
    </ResponsiveContainer>
  )
  return (
    <section className={`rounded-xl bg-white p-4 flex flex-col gap-3 ${widget.wide ? 'md:col-span-2' : ''}`} style={{ border: `1px solid ${FF.border}` }}>
      <h3 className="text-sm font-semibold" style={{ color: FF.tealText }}>{widget.title}</h3>
      {body}
    </section>
  )
}

export function CustomDashboardPage() {
  const [list, setList] = useState<CustomDashboard[] | null>(null)
  const [activeId, setActiveId] = useState('')
  const [data, setData] = useState<Record<string, WidgetData> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch('/api/custom-dashboards')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Request failed (${r.status})`)))
      .then((rows: CustomDashboard[]) => { setList(rows); setActiveId(rows[0]?.id ?? '') })
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    if (!activeId) return
    setData(null)
    apiFetch(`/api/custom-dashboards/${activeId}/data`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Request failed (${r.status})`)))
      .then(setData)
      .catch(e => setError(e.message))
  }, [activeId])

  if (error) return <p className="text-sm" style={{ color: FF.red }}>Could not load custom dashboards: {error}</p>
  if (!list) return <div className="h-40 rounded-xl animate-pulse" style={{ background: FF.borderFaint }} />
  if (!list.length) return <p className="text-sm" style={{ color: FF.textMuted }}>No custom dashboards have been set up for your organisation yet.</p>

  const active = list.find(d => d.id === activeId)
  return (
    <div className="flex flex-col gap-4">
      {list.length > 1 && <TabPill tabs={list.map(d => ({ key: d.id, label: d.title }))} active={activeId} onChange={setActiveId} />}
      {active && !active.widgets.length && <p className="text-sm" style={{ color: FF.textMuted }}>This dashboard has no widgets yet.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {active?.widgets.map(w => <WidgetView key={w.id} widget={w} data={data?.[w.id]} />)}
      </div>
    </div>
  )
}
