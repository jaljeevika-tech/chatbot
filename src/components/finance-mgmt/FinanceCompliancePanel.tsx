// src/components/finance-mgmt/FinanceCompliancePanel.tsx
// Compliance Calendar sub-tab of Finance Management — the same org-wide
// compliance_items the project Compliance Calendar shows (routes/compliance.routes.js),
// plus add / edit / delete for the Finance team, admins and managers.

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, CalendarClock } from 'lucide-react'
import { FF, ffStatusColors, type FFStatus } from '../../theme/colors'
import { apiFetch } from '../../utils/apiFetch'
import { EmptyState } from '../ui/EmptyState'
import { StatusBadge } from '../ui/StatusBadge'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import { Btn, Card, ErrorBox, Field, FmModal, LoadingRow, inputCls, inputStyle, useFmLoad } from './fmUi'

interface Item {
  id: string; item: string; status: 'overdue' | 'upcoming' | 'valid'; dueLabel: string
  due_date: string | null; project_key: string | null; manual_status: 'overdue' | 'upcoming' | 'valid' | null
}
const STATUS: Record<Item['status'], FFStatus> = { overdue: 'red', upcoming: 'amber', valid: 'green' }
const STATUS_LABEL: Record<Item['status'], string> = { overdue: 'Overdue', upcoming: 'Due soon', valid: 'Valid' }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error || `Request failed (${res.status})`), { status: res.status })
  return data as T
}

function ItemFormModal({ open, item, onClose }: { open: boolean; item: Item | null; onClose: () => void }) {
  const { changed } = useFm()
  const { projects } = useProjectContext()
  const [f, setF] = useState({ item: '', due_date: '', project_key: '', manual_status: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setError(null)
    setF(item ? { item: item.item, due_date: item.due_date || '', project_key: item.project_key || '', manual_status: item.manual_status || '' }
              : { item: '', due_date: '', project_key: '', manual_status: '' })
  }, [open, item])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  async function save() {
    if (!f.item.trim()) return setError('Describe the compliance item.')
    setBusy(true); setError(null)
    try {
      const body = { item: f.item.trim(), due_date: f.due_date || null, manual_status: f.manual_status || null, ...(item ? {} : { project_key: f.project_key || null }) }
      if (item) await api('PUT', `/compliance-items/${item.id}`, body)
      else await api('POST', '/compliance-items', body)
      changed(); onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="md" title={item ? 'Edit compliance item' : 'Add compliance item'}
      subtitle="Shown here and in the project Compliance Calendar."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn variant="primary" busy={busy} onClick={save}>Save</Btn></>}>
      <Field label="Item" required><input className={inputCls} style={inputStyle} value={f.item} onChange={set('item')} disabled={busy} placeholder="e.g. TDS return Q2 (24Q / 26Q)" /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Due / valid until"><input type="date" className={inputCls} style={inputStyle} value={f.due_date} onChange={set('due_date')} disabled={busy} /></Field>
        <Field label="Status" hint="Automatic: overdue after the date, due soon within 30 days.">
          <select className={inputCls} style={inputStyle} value={f.manual_status} onChange={set('manual_status')} disabled={busy}>
            <option value="">Automatic from date</option><option value="overdue">Overdue</option><option value="upcoming">Due soon</option><option value="valid">Valid</option>
          </select>
        </Field>
      </div>
      {!item && (
        <Field label="Project" hint="Leave as organisation-wide unless it belongs to one project.">
          <select className={inputCls} style={inputStyle} value={f.project_key} onChange={set('project_key')} disabled={busy}>
            <option value="">Organisation-wide</option>
            {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <ErrorBox message={error} />
    </FmModal>
  )
}

export function FinanceCompliancePanel() {
  const { version, changed } = useFm()
  const { projects } = useProjectContext()
  const { data, error, loading } = useFmLoad(() => api<{ items: Item[] }>('GET', '/compliance-items'), [version])
  const [form, setForm] = useState<{ open: boolean; item: Item | null }>({ open: false, item: null })
  const [err, setErr] = useState<string | null>(null)
  const projectName = (k: string | null) => (k ? projects.find(p => p.project_key === k)?.name || k : 'Organisation-wide')

  async function del(it: Item) {
    if (!confirm(`Delete "${it.item}"?`)) return
    setErr(null)
    try { await api('DELETE', `/compliance-items/${it.id}`); changed() } catch (e) { setErr((e as Error).message) }
  }

  if (error) {
    return /403|Access denied/i.test(error)
      ? <Card><EmptyState compact icon={<CalendarClock className="w-6 h-6" />} title="Compliance calendar is for the Finance team, managers and admins" /></Card>
      : <ErrorBox message={error} />
  }
  if (loading && !data) return <LoadingRow />
  const items = data?.items || []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" style={{ color: FF.textMuted }}>Statutory and donor due dates across the organisation — the same items as each project's Compliance Calendar.</p>
        <Btn variant="primary" onClick={() => setForm({ open: true, item: null })}><Plus className="w-4 h-4" />Add item</Btn>
      </div>
      <ErrorBox message={err} />
      {!items.length ? (
        <Card><EmptyState compact icon={<CalendarClock className="w-6 h-6" />} title="No compliance items yet" body="Add due dates for TDS, PF/ESI, GST, FCRA, 80G / 12A renewals, audits and donor reports." /></Card>
      ) : items.map(c => {
        const colors = ffStatusColors(STATUS[c.status])
        return (
          <div key={c.id} className="flex items-center justify-between gap-3 flex-wrap px-4 py-3.5 sm:px-[22px] sm:py-4"
            style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderLeft: `4px solid ${colors.fg}`, borderRadius: 10 }}>
            <div className="min-w-0">
              <div style={{ fontSize: 14.5, fontWeight: 500, color: FF.tealDark }}>{c.item}</div>
              <div style={{ fontSize: 12, color: FF.textMuted, marginTop: 3 }}>{c.dueLabel} · {projectName(c.project_key)}{c.manual_status ? ' · status set manually' : ''}</div>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge bg={colors.bg} fg={colors.fg} label={STATUS_LABEL[c.status]} shape="pill" size="sm" />
              <button aria-label={`Edit ${c.item}`} onClick={() => setForm({ open: true, item: c })} style={{ color: FF.tealDark }}><Pencil className="w-4 h-4" /></button>
              <button aria-label={`Delete ${c.item}`} onClick={() => del(c)} style={{ color: FF.red }}><Trash2 className="w-4 h-4" /></button>
            </div>
          </div>
        )
      })}
      <ItemFormModal open={form.open} item={form.item} onClose={() => setForm({ open: false, item: null })} />
    </div>
  )
}
