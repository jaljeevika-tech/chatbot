import { useEffect, useState } from 'react'
import { Plus, Pencil, Sparkles, Users } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import type { PlanInfo, PlatformStats } from './types'
import { Button, Card, Dialog, Field, Input, Textarea, Switch, PageHeader, Badge, Skeleton } from './ui'

type Draft = Partial<PlanInfo> & { unlimited?: boolean }
const EMPTY: Draft = { name: '', slug: '', description: '', price_monthly: 0, max_users: 10, ai_enabled: false, sort_order: 0, is_active: true }
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export function PlansPage() {
  const { toast } = useToast()
  const [plans, setPlans] = useState<PlanInfo[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    saApi<PlanInfo[]>('/api/superadmin/plans').then(setPlans).catch(e => toast(errMsg(e), 'error'))
    saApi<PlatformStats>('/api/superadmin/stats')
      .then(s => setCounts(Object.fromEntries(s.plans.map(p => [p.slug, Number(p.org_count)]))))
      .catch(() => {})
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const isEdit = !!draft?.id
  const save = async () => {
    if (!draft?.name?.trim() || !draft.slug?.trim()) { setError('Name and slug are required'); return }
    setSaving(true); setError('')
    const body = {
      name: draft.name.trim(), description: draft.description ?? '', price_monthly: Number(draft.price_monthly) || 0,
      max_users: draft.unlimited ? 9999 : Math.max(1, Number(draft.max_users) || 1),
      ai_enabled: !!draft.ai_enabled, sort_order: Number(draft.sort_order) || 0,
      ...(isEdit ? { is_active: !!draft.is_active } : { slug: draft.slug.trim() }),
    }
    try {
      await saApi(isEdit ? `/api/superadmin/plans/${draft.id}` : '/api/superadmin/plans', { method: isEdit ? 'PATCH' : 'POST', body })
      toast(isEdit ? 'Plan updated' : 'Plan created'); setDraft(null); load()
    } catch (e) { setError(errMsg(e)) }
    finally { setSaving(false) }
  }

  return (
    <>
      <PageHeader title="Plans" subtitle="Subscription tiers. Seat limits and AI access are enforced on the server for every organisation on a plan."
        actions={<Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { setError(''); setDraft({ ...EMPTY }) }}>New plan</Button>} />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {!plans ? [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-56 rounded-xl" />) : plans.map(p => {
          const unlimited = p.max_users >= 9999
          return (
            <Card key={p.id} className={p.is_active ? '' : 'opacity-60'}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-base font-semibold text-sa-text">{p.name}</div>
                  <div className="text-xs text-sa-muted font-mono">{p.slug}</div>
                </div>
                {!p.is_active && <Badge>Retired</Badge>}
              </div>
              <div className="mt-4 text-2xl font-semibold text-sa-text tabular-nums">
                {Number(p.price_monthly) ? `₹${Number(p.price_monthly).toLocaleString('en-IN')}` : p.slug === 'enterprise' ? 'Custom' : 'Free'}
                {Number(p.price_monthly) > 0 && <span className="text-sm font-normal text-sa-muted"> / month</span>}
              </div>
              {p.description && <p className="text-sm text-sa-muted mt-2">{p.description}</p>}
              <ul className="mt-4 flex flex-col gap-1.5 text-sm text-sa-text">
                <li className="flex items-center gap-2"><Users className="w-4 h-4 text-sa-muted" />{unlimited ? 'Unlimited users' : `Up to ${p.max_users} users`}</li>
                <li className={`flex items-center gap-2 ${p.ai_enabled ? '' : 'text-sa-muted line-through'}`}><Sparkles className="w-4 h-4 text-sa-muted" />AI features</li>
              </ul>
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-sa-border">
                <span className="text-xs text-sa-muted">{counts[p.slug] ?? 0} organisation{counts[p.slug] === 1 ? '' : 's'}</span>
                <Button size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => { setError(''); setDraft({ ...p, unlimited }) }}>Edit</Button>
              </div>
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-sa-muted mt-4">Prices are recorded in INR for reference only. Payment collection and multi-currency pricing aren't connected yet.</p>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Edit ${draft?.name}` : 'New plan'}
        description={isEdit ? 'Changes apply immediately to every organisation on this plan.' : undefined}
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>{isEdit ? 'Save plan' : 'Create plan'}</Button></>}>
        {draft && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Name">{id => <Input id={id} value={draft.name ?? ''} autoFocus onChange={e => setDraft({ ...draft, name: e.target.value, ...(isEdit ? {} : { slug: slugify(e.target.value) }) })} />}</Field>
              <Field label="Slug" hint={isEdit ? 'Can’t be changed.' : undefined}>{id => <Input id={id} value={draft.slug ?? ''} disabled={isEdit} className="font-mono" onChange={e => setDraft({ ...draft, slug: slugify(e.target.value) })} />}</Field>
            </div>
            <Field label="Description">{id => <Textarea id={id} rows={2} value={draft.description ?? ''} onChange={e => setDraft({ ...draft, description: e.target.value })} />}</Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Price (₹ / month)">{id => <Input id={id} type="number" min={0} value={draft.price_monthly ?? 0} onChange={e => setDraft({ ...draft, price_monthly: +e.target.value })} />}</Field>
              <Field label="Max users">{id => <Input id={id} type="number" min={1} value={draft.unlimited ? '' : draft.max_users ?? 10} disabled={draft.unlimited} placeholder="Unlimited" onChange={e => setDraft({ ...draft, max_users: +e.target.value })} />}</Field>
              <Field label="Display order">{id => <Input id={id} type="number" value={draft.sort_order ?? 0} onChange={e => setDraft({ ...draft, sort_order: +e.target.value })} />}</Field>
            </div>
            <div className="divide-y divide-sa-border border-y border-sa-border">
              <Switch label="Unlimited users" checked={!!draft.unlimited} onChange={v => setDraft({ ...draft, unlimited: v })} />
              <Switch label="AI features" description="Notebook, report writer, AI insights and other AI tools." checked={!!draft.ai_enabled} onChange={v => setDraft({ ...draft, ai_enabled: v })} />
              {isEdit && <Switch label="Available for new organisations" description="Retired plans keep their existing organisations." checked={!!draft.is_active} onChange={v => setDraft({ ...draft, is_active: v })} />}
            </div>
            {error && <div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-3 py-2">{error}</div>}
          </div>
        )}
      </Dialog>
    </>
  )
}
