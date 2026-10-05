// Custom dashboard builder for one org. Widgets come from the dashboard service's
// fixed metric catalog (services/dashboard/src/custom.js); the org sees the result
// in its "Custom Dashboards" tab.

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Eye, LayoutDashboard } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import type { OrgRow } from './types'
import { Button, Card, Field, Input, Select, Switch, EmptyState, Skeleton, Badge, useConfirm, fmtDateTime } from './ui'
import { WidgetView, type ChartType, type CustomDashboard, type Widget, type WidgetData } from '../../dashboard/CustomDashboardPage'

type CatalogMetric = { key: string; label: string; source: string; dated: boolean; projectScoped: boolean; groupBys: { key: string; label: string }[] }
type Catalog = { metrics: CatalogMetric[]; charts: ChartType[] }
type Draft = Omit<CustomDashboard, 'id'> & { id?: string; updated_at?: string }

const CHART_LABEL: Record<ChartType, string> = { kpi: 'Single number', bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart', table: 'Table' }
const newId = () => Math.random().toString(36).slice(2, 10)

function blankWidget(m: CatalogMetric): Widget {
  return { id: newId(), title: m.label, metric: m.key, chart: 'kpi', groupBy: 'none', projectKey: '', from: '', to: '', wide: false }
}

function WidgetEditor({ w, catalog, orgId, onChange, onMove, onRemove, first, last }: {
  w: Widget; catalog: Catalog; orgId: string; first: boolean; last: boolean
  onChange: (w: Widget) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void
}) {
  const { toast } = useToast()
  const [preview, setPreview] = useState<WidgetData | null>(null)
  const [loading, setLoading] = useState(false)
  const meta = catalog.metrics.find(m => m.key === w.metric)
  const set = (p: Partial<Widget>) => { setPreview(null); onChange({ ...w, ...p }) }
  const sources = [...new Set(catalog.metrics.map(m => m.source))]

  const runPreview = async () => {
    setLoading(true)
    try { setPreview(await saApi<WidgetData>(`/api/superadmin/org/${orgId}/custom-dashboards/preview`, { method: 'POST', body: { widget: w } })) }
    catch (e) { toast(errMsg(e), 'error') }
    finally { setLoading(false) }
  }

  return (
    <div className="rounded-lg border border-sa-border p-4 flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Title" className="lg:col-span-2">{id => <Input id={id} value={w.title} maxLength={80} onChange={e => set({ title: e.target.value })} />}</Field>
        <Field label="Metric" className="lg:col-span-2">{id => (
          <Select id={id} value={w.metric} onChange={e => {
            const m = catalog.metrics.find(x => x.key === e.target.value)!
            const keepGroup = m.groupBys.some(g => g.key === w.groupBy)
            set({ metric: m.key, title: w.title === meta?.label ? m.label : w.title, groupBy: keepGroup ? w.groupBy : w.chart === 'kpi' ? 'none' : (m.groupBys[0]?.key ?? 'none') })
          }}>
            {sources.map(s => (
              <optgroup key={s} label={s}>
                {catalog.metrics.filter(m => m.source === s).map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </optgroup>
            ))}
          </Select>
        )}</Field>
        <Field label="Show as">{id => (
          <Select id={id} value={w.chart} onChange={e => {
            const chart = e.target.value as ChartType
            set({ chart, groupBy: chart === 'kpi' ? 'none' : w.groupBy === 'none' ? (meta?.groupBys[0]?.key ?? 'none') : w.groupBy })
          }}>
            {catalog.charts.map(c => <option key={c} value={c}>{CHART_LABEL[c]}</option>)}
          </Select>
        )}</Field>
        <Field label="Group by">{id => (
          <Select id={id} value={w.groupBy} disabled={w.chart === 'kpi'} onChange={e => set({ groupBy: e.target.value })}>
            {w.chart === 'kpi' && <option value="none">—</option>}
            {meta?.groupBys.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
          </Select>
        )}</Field>
        <Field label="Project key" hint={meta?.projectScoped ? 'Blank = all projects' : 'Org-wide registry'}>{id => (
          <Input id={id} value={w.projectKey} disabled={!meta?.projectScoped} placeholder="e.g. kosi-2026" onChange={e => set({ projectKey: e.target.value.trim() })} />
        )}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">{id => <Input id={id} type="date" value={w.from} disabled={!meta?.dated} onChange={e => set({ from: e.target.value })} />}</Field>
          <Field label="To">{id => <Input id={id} type="date" value={w.to} disabled={!meta?.dated} onChange={e => set({ to: e.target.value })} />}</Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="w-56"><Switch checked={w.wide} onChange={wide => onChange({ ...w, wide })} label="Full width" /></div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Eye className="w-3.5 h-3.5" />} loading={loading} onClick={runPreview}>Preview</Button>
          <Button size="sm" aria-label="Move up" disabled={first} icon={<ArrowUp className="w-3.5 h-3.5" />} onClick={() => onMove(-1)} />
          <Button size="sm" aria-label="Move down" disabled={last} icon={<ArrowDown className="w-3.5 h-3.5" />} onClick={() => onMove(1)} />
          <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onRemove}>Remove</Button>
        </div>
      </div>
      {preview && <div className="grid grid-cols-1"><WidgetView widget={{ ...w, wide: false }} data={preview} /></div>}
    </div>
  )
}

function DashboardEditor({ org, catalog, initial, onSaved, onCancel }: {
  org: OrgRow; catalog: Catalog; initial: Draft; onSaved: () => void; onCancel: () => void
}) {
  const { toast } = useToast()
  const { confirm, dialog } = useConfirm()
  const [d, setD] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const setW = (widgets: Widget[]) => setD(prev => ({ ...prev, widgets }))
  const base = `/api/superadmin/org/${org.id}/custom-dashboards`

  const save = async () => {
    setSaving(true)
    try {
      const body = { title: d.title, visible_to: d.visible_to, sort_order: d.sort_order, widgets: d.widgets }
      await saApi(d.id ? `${base}/${d.id}` : base, { method: d.id ? 'PUT' : 'POST', body })
      toast('Dashboard saved'); onSaved()
    } catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }
  const remove = async () => {
    if (!d.id || !await confirm({ title: `Delete “${d.title}”?`, body: `${org.name}'s users will no longer see it.`, confirmLabel: 'Delete', danger: true })) return
    try { await saApi(`${base}/${d.id}`, { method: 'DELETE' }); toast('Dashboard deleted'); onSaved() }
    catch (e) { toast(errMsg(e), 'error') }
  }
  const move = (i: number, dir: -1 | 1) => {
    const next = [...d.widgets]; [next[i], next[i + dir]] = [next[i + dir], next[i]]; setW(next)
  }

  return (
    <Card title={d.id ? 'Edit dashboard' : 'New dashboard'}
      actions={<>
        {d.id && <Button variant="danger" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={remove}>Delete</Button>}
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" loading={saving} disabled={!d.title.trim()} onClick={save}>Save</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Title">{id => <Input id={id} value={d.title} maxLength={120} onChange={e => setD({ ...d, title: e.target.value })} />}</Field>
          <Field label="Visible to">{id => (
            <Select id={id} value={d.visible_to} onChange={e => setD({ ...d, visible_to: e.target.value as Draft['visible_to'] })}>
              <option value="all">Everyone in the organisation</option>
              <option value="admin">Admins only</option>
            </Select>
          )}</Field>
          <Field label="Order" hint="Lower shows first">{id => <Input id={id} type="number" value={d.sort_order} onChange={e => setD({ ...d, sort_order: parseInt(e.target.value) || 0 })} />}</Field>
        </div>
        {d.widgets.map((w, i) => (
          <WidgetEditor key={w.id} w={w} catalog={catalog} orgId={org.id} first={i === 0} last={i === d.widgets.length - 1}
            onChange={nw => setW(d.widgets.map(x => (x.id === w.id ? nw : x)))}
            onMove={dir => move(i, dir)} onRemove={() => setW(d.widgets.filter(x => x.id !== w.id))} />
        ))}
        <div>
          <Button icon={<Plus className="w-4 h-4" />} disabled={d.widgets.length >= 24} onClick={() => setW([...d.widgets, blankWidget(catalog.metrics[0])])}>Add widget</Button>
        </div>
      </div>
      {dialog}
    </Card>
  )
}

export function OrgDashboardsTab({ org }: { org: OrgRow }) {
  const [list, setList] = useState<CustomDashboard[] | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const base = `/api/superadmin/org/${org.id}/custom-dashboards`

  const load = useCallback(() => {
    setError('')
    Promise.all([saApi<CustomDashboard[]>(base), saApi<Catalog>(`${base}/catalog`)])
      .then(([l, c]) => { setList(l); setCatalog(c) })
      .catch(e => setError(errMsg(e)))
  }, [base])
  useEffect(load, [load])

  if (error) return <Card><p className="text-sm text-sa-danger">{error}</p></Card>
  if (!list || !catalog) return <Skeleton className="h-40" />
  if (editing) return <DashboardEditor org={org} catalog={catalog} initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />

  return (
    <Card title="Custom dashboards" description={`Shown to ${org.name}'s users in a “Custom Dashboards” tab.`}
      actions={<Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />}
        onClick={() => setEditing({ title: '', visible_to: 'all', sort_order: list.length, widgets: [] })}>New dashboard</Button>}
      padded={list.length > 0}>
      {!list.length ? (
        <EmptyState icon={<LayoutDashboard className="w-8 h-8" />} title="No custom dashboards yet">
          Pick metrics from the catalog (training, MIS, beneficiaries, income, spend…) and choose how to show each one.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-sa-border">
          {list.map(d => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-sa-text">{d.title}</div>
                <div className="text-xs text-sa-muted">{d.widgets.length} widget{d.widgets.length === 1 ? '' : 's'} · updated {fmtDateTime(d.updated_at)}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={d.visible_to === 'admin' ? 'warning' : 'success'}>{d.visible_to === 'admin' ? 'Admins only' : 'Everyone'}</Badge>
                <Button size="sm" onClick={() => setEditing(d)}>Edit</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
