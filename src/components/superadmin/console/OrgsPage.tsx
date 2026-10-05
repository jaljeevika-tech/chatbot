import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Building2, RefreshCw } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import { navigate, routeHref } from './route'
import type { OrgRow, PlanInfo } from './types'
import {
  Button, Card, Dialog, Field, Input, Select, PageHeader, StatusBadge, AccessBadge,
  Skeleton, EmptyState, fmtDate, daysUntil,
} from './ui'

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)

type StatusFilter = 'all' | 'active' | 'trialing' | 'attention' | 'inactive'

function NewOrgDialog({ open, onClose, plans }: { open: boolean; onClose: () => void; plans: PlanInfo[] }) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [planId, setPlanId] = useState('')
  const [trialDays, setTrialDays] = useState(30)
  const [billingEmail, setBillingEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (!slugTouched) setSlug(slugify(name)) }, [name, slugTouched])
  useEffect(() => {
    if (open) { setName(''); setSlug(''); setSlugTouched(false); setPlanId(''); setTrialDays(30); setBillingEmail(''); setError('') }
  }, [open])

  const create = async () => {
    if (!name.trim() || !slug.trim()) { setError('Name and login slug are required'); return }
    setSaving(true); setError('')
    try {
      const org = await saApi<{ id: string; name: string }>('/api/superadmin/orgs', {
        method: 'POST',
        body: { name: name.trim(), slug: slug.trim(), plan_id: planId || null, trial_days: trialDays, billing_email: billingEmail.trim() },
      })
      toast(`${org.name} created. Add its first admin next.`)
      onClose()
      navigate({ page: 'orgs', orgId: org.id, orgTab: 'users' })
    } catch (e) { setError(errMsg(e)) }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New organisation"
      description="It starts as a free trial. You can change the plan and dates later."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={create}>Create organisation</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Organisation name">{id => <Input id={id} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pratham Education Foundation" autoFocus />}</Field>
        <Field label="Login slug" hint={<>Login link: <span className="font-mono">{window.location.origin}/?org={slug || '…'}</span>. Can't be changed later.</>}>
          {id => <Input id={id} value={slug} onChange={e => { setSlugTouched(true); setSlug(slugify(e.target.value)) }} className="font-mono" />}
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Plan">
            {id => (
              <Select id={id} value={planId} onChange={e => setPlanId(e.target.value)}>
                <option value="">No plan yet</option>
                {plans.filter(p => p.is_active).map(p => <option key={p.id} value={p.id}>{p.name}{p.ai_enabled ? ' · AI' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Trial length (days)">
            {id => <Input id={id} type="number" min={1} max={365} value={trialDays} onChange={e => setTrialDays(Math.max(1, Math.min(365, +e.target.value || 30)))} />}
          </Field>
        </div>
        <Field label="Billing email (optional)">{id => <Input id={id} type="email" value={billingEmail} onChange={e => setBillingEmail(e.target.value)} placeholder="finance@ngo.org" />}</Field>
        {error && <div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-3 py-2">{error}</div>}
      </div>
    </Dialog>
  )
}

export function OrgsPage() {
  const [orgs, setOrgs]   = useState<OrgRow[] | null>(null)
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [error, setError] = useState('')
  const [q, setQ]         = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [planFilter, setPlanFilter] = useState('')
  const [showNew, setShowNew] = useState(() => window.location.hash.includes('?new'))

  const load = () => {
    setError('')
    saApi<OrgRow[]>('/api/superadmin/orgs').then(setOrgs).catch(e => setError(errMsg(e)))
  }
  useEffect(() => {
    load()
    saApi<PlanInfo[]>('/api/superadmin/plans').then(setPlans).catch(() => {})
  }, [])

  const closeNew = () => {
    setShowNew(false)
    if (window.location.hash.includes('?new')) history.replaceState(null, '', routeHref({ page: 'orgs' }))
  }

  const filtered = useMemo(() => (orgs ?? []).filter(o => {
    const needle = q.trim().toLowerCase()
    if (needle && !o.name.toLowerCase().includes(needle) && !o.slug.toLowerCase().includes(needle) && !(o.billing_email ?? '').toLowerCase().includes(needle)) return false
    if (planFilter && (o.plan_id ?? 'none') !== planFilter) return false
    const st = o.subscription_status ?? 'inactive'
    if (status === 'attention') return o.access_state !== 'ok' || st === 'suspended' || st === 'expired'
    if (status !== 'all' && st !== status) return false
    return true
  }), [orgs, q, status, planFilter])

  return (
    <>
      <PageHeader title="Organisations" subtitle={orgs ? `${orgs.length} organisation${orgs.length === 1 ? '' : 's'} on the platform` : 'Loading…'}
        actions={<>
          <Button variant="ghost" icon={<RefreshCw className="w-4 h-4" />} onClick={load} aria-label="Refresh" />
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setShowNew(true)}>New organisation</Button>
        </>} />

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-sa-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, slug or billing email" className="pl-9" aria-label="Search organisations" />
        </div>
        <Select value={status} onChange={e => setStatus(e.target.value as StatusFilter)} className="sm:w-44" aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="attention">Needs attention</option>
          <option value="inactive">Inactive</option>
        </Select>
        <Select value={planFilter} onChange={e => setPlanFilter(e.target.value)} className="sm:w-44" aria-label="Filter by plan">
          <option value="">All plans</option>
          <option value="none">No plan</option>
          {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>

      {error && <div className="mb-4 rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{error}</div>}

      <Card padded={false}>
        {!orgs ? <div className="p-5 flex flex-col gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}</div>
          : filtered.length === 0 ? (
            <EmptyState icon={<Building2 className="w-8 h-8" />} title={orgs.length ? 'No matches' : 'No organisations yet'}>
              {orgs.length ? 'Try a different search or filter.' : 'Create the first organisation to get started.'}
            </EmptyState>
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-sa-muted border-b border-sa-border">
                      <th className="font-semibold px-5 py-3">Organisation</th>
                      <th className="font-semibold px-3 py-3">Plan</th>
                      <th className="font-semibold px-3 py-3">Status</th>
                      <th className="font-semibold px-3 py-3 text-right">Seats</th>
                      <th className="font-semibold px-3 py-3">Renews / ends</th>
                      <th className="font-semibold px-5 py-3">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-sa-border">
                    {filtered.map(o => {
                      const d = daysUntil(o.subscription_expires_at)
                      const used = Number(o.user_count)
                      const over = o.max_users != null && used > o.max_users
                      return (
                        <tr key={o.id} className="hover:bg-sa-subtle cursor-pointer" onClick={() => navigate({ page: 'orgs', orgId: o.id })}>
                          <td className="px-5 py-3">
                            <a href={routeHref({ page: 'orgs', orgId: o.id })} className="font-medium text-sa-text hover:text-sa-primary" onClick={e => e.stopPropagation()}>{o.name}</a>
                            <div className="text-xs text-sa-muted font-mono">/{o.slug}</div>
                          </td>
                          <td className="px-3 py-3 text-sa-text">{o.plan_name ?? <span className="text-sa-muted">None</span>}</td>
                          <td className="px-3 py-3"><div className="flex flex-wrap gap-1"><StatusBadge status={o.subscription_status} /><AccessBadge state={o.access_state} /></div></td>
                          <td className={`px-3 py-3 text-right tabular-nums ${over ? 'text-sa-danger font-semibold' : 'text-sa-text'}`}>
                            {used}{o.max_users != null && o.max_users < 9999 ? <span className="text-sa-muted"> / {o.max_users}</span> : ''}
                          </td>
                          <td className="px-3 py-3 text-sa-text">
                            {o.subscription_expires_at ? <>{fmtDate(o.subscription_expires_at)}{d !== null && d >= 0 && d <= 14 && <div className="text-xs text-sa-warning">in {d} day{d === 1 ? '' : 's'}</div>}</> : <span className="text-sa-muted">No end date</span>}
                          </td>
                          <td className="px-5 py-3 text-sa-muted">{fmtDate(o.created_at)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="md:hidden divide-y divide-sa-border">
                {filtered.map(o => (
                  <li key={o.id}>
                    <a href={routeHref({ page: 'orgs', orgId: o.id })} className="block px-4 py-3 hover:bg-sa-subtle">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-sa-text truncate">{o.name}</div>
                          <div className="text-xs text-sa-muted">{o.plan_name ?? 'No plan'} · {Number(o.user_count)} users</div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0"><StatusBadge status={o.subscription_status} /><AccessBadge state={o.access_state} /></div>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
      </Card>

      <NewOrgDialog open={showNew} onClose={closeNew} plans={plans} />
    </>
  )
}
