import { useEffect, useState } from 'react'
import { Lock, Unlock, CalendarPlus } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import type { OrgRow, PlanInfo } from './types'
import { Button, Card, Field, Input, Select, Textarea, Skeleton, AccessBadge, fmtDate, useConfirm, type AccessState } from './ui'

type Sub = {
  plan_id: string | null
  subscription_status: string | null
  subscription_expires_at: string | null
  billing_email: string | null
  billing_notes: string | null
  access?: { state: AccessState; reason?: string; grace_ends_at?: string | null }
}

// <input type="date"> works in local days; the API stores an instant.
const toDateInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const endOfLocalDay = (ymd: string) => new Date(`${ymd}T23:59:59`).toISOString()
const addDays = (ymd: string, n: number) => {
  const base = ymd ? new Date(`${ymd}T12:00:00`) : new Date()
  if (base.getTime() < Date.now()) base.setTime(Date.now())   // extending a lapsed date starts from today
  base.setDate(base.getDate() + n)
  return toDateInput(base.toISOString())
}

const STATUS_HELP: Record<string, string> = {
  active:   'Paying customer. Full access until the end date (if set).',
  trialing: 'Free trial. Full access until the end date, then a 7-day grace period, then read-only.',
  expired:  'Lapsed. Read-only once the 7-day grace period after the end date has passed.',
  inactive: 'Legacy "not set up" status. Not enforced, so the org has full access. Prefer Active or Trialing.',
}

export function OrgPlanTab({ org, onChanged }: { org: OrgRow; onChanged: () => void }) {
  const { toast } = useToast()
  const { confirm, dialog } = useConfirm()
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [sub, setSub] = useState<Sub | null>(null)
  const [form, setForm] = useState({ plan_id: '', status: 'trialing', ends: '', billing_email: '', billing_notes: '' })
  const [saving, setSaving] = useState(false)

  const load = () => {
    saApi<Sub>(`/api/superadmin/org/${org.id}/subscription`).then(s => {
      setSub(s)
      setForm({
        plan_id: s.plan_id ?? '', status: s.subscription_status ?? 'inactive',
        ends: toDateInput(s.subscription_expires_at), billing_email: s.billing_email ?? '', billing_notes: s.billing_notes ?? '',
      })
    }).catch(e => toast(errMsg(e), 'error'))
  }
  useEffect(() => {
    load()
    saApi<PlanInfo[]>('/api/superadmin/plans').then(setPlans).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id])

  const suspended = sub?.subscription_status === 'suspended'
  const plan = plans.find(p => p.id === form.plan_id)

  const save = async () => {
    setSaving(true)
    try {
      await saApi(`/api/superadmin/org/${org.id}/subscription`, {
        method: 'POST',
        body: {
          plan_id: form.plan_id || null,
          status: suspended ? undefined : form.status,
          expires_at: form.ends ? endOfLocalDay(form.ends) : '',
          billing_email: form.billing_email.trim(),
          billing_notes: form.billing_notes,
        },
      })
      toast('Subscription saved'); load(); onChanged()
    } catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }

  const toggleSuspend = async () => {
    if (suspended) {
      const ok = await confirm({ title: `Unsuspend ${org.name}?`, body: 'Its previous status is restored and users can add data again.', confirmLabel: 'Unsuspend' })
      if (!ok) return
    }
    const reason = suspended ? null : await confirm({
      title: `Suspend ${org.name}?`, danger: true, confirmLabel: 'Suspend organisation',
      body: 'Users immediately become read-only: they can view and export, but not add data, and AI is paused. No data is deleted. You can unsuspend at any time.',
      reasonLabel: 'Reason (recorded in the audit log)',
    })
    if (!suspended && !reason) return
    try {
      await saApi(`/api/superadmin/org/${org.id}/${suspended ? 'unsuspend' : 'suspend'}`, { method: 'POST', body: suspended ? {} : { reason } })
      toast(suspended ? 'Organisation unsuspended' : 'Organisation suspended'); load(); onChanged()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  if (!sub) return <Skeleton className="h-80" />

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2" title="Subscription" description="Enforced on the server: seat limit, AI access, and read-only after expiry."
        actions={<AccessBadge state={sub.access?.state} />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Plan" hint={plan ? `${plan.max_users >= 9999 ? 'Unlimited' : plan.max_users} seats · AI ${plan.ai_enabled ? 'included' : 'not included'}` : 'No plan: no seat or AI limits are enforced.'}>
            {id => (
              <Select id={id} value={form.plan_id} onChange={e => setForm({ ...form, plan_id: e.target.value })}>
                <option value="">No plan</option>
                {plans.map(p => <option key={p.id} value={p.id} disabled={!p.is_active && p.id !== form.plan_id}>{p.name}{p.is_active ? '' : ' (retired)'}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Status" hint={suspended ? 'Suspended. Use Unsuspend to change.' : STATUS_HELP[form.status]}>
            {id => (
              <Select id={id} value={suspended ? 'suspended' : form.status} disabled={suspended} onChange={e => setForm({ ...form, status: e.target.value })}>
                {suspended && <option value="suspended">Suspended</option>}
                <option value="trialing">Trialing</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="inactive">Inactive (legacy)</option>
              </Select>
            )}
          </Field>
          <Field label="Ends on" hint={sub.access?.grace_ends_at ? `Grace period ends ${fmtDate(sub.access.grace_ends_at)}.` : 'Leave empty for no end date.'}>
            {id => (
              <div className="flex flex-col gap-2">
                <Input id={id} type="date" value={form.ends} onChange={e => setForm({ ...form, ends: e.target.value })} />
                <div className="flex flex-wrap gap-1.5">
                  {[14, 30, 365].map(n => (
                    <Button key={n} size="sm" type="button" icon={<CalendarPlus className="w-3.5 h-3.5" />} onClick={() => setForm(f => ({ ...f, ends: addDays(f.ends, n) }))}>
                      +{n === 365 ? '1 year' : `${n} days`}
                    </Button>
                  ))}
                  {form.ends && <Button size="sm" variant="ghost" type="button" onClick={() => setForm(f => ({ ...f, ends: '' }))}>Clear</Button>}
                </div>
              </div>
            )}
          </Field>
          <Field label="Billing email">{id => <Input id={id} type="email" value={form.billing_email} onChange={e => setForm({ ...form, billing_email: e.target.value })} placeholder="finance@ngo.org" />}</Field>
          <Field label="Billing notes" className="sm:col-span-2">{id => <Textarea id={id} rows={2} value={form.billing_notes} onChange={e => setForm({ ...form, billing_notes: e.target.value })} placeholder="PO number, invoice references, agreed discounts…" />}</Field>
        </div>
        <div className="flex justify-end mt-5"><Button variant="primary" loading={saving} onClick={save}>Save subscription</Button></div>
      </Card>

      <Card title={suspended ? 'Suspended' : 'Suspend organisation'}
        description={suspended ? org.suspended_reason ?? undefined : 'Emergency switch for non-payment, abuse or a contract dispute.'}>
        <p className="text-sm text-sa-muted mb-4">
          {suspended
            ? 'Users can view and export but can’t add data. AI is paused.'
            : 'Takes effect immediately. Users can still view and export. Nothing is deleted.'}
        </p>
        <Button variant={suspended ? 'secondary' : 'danger'} icon={suspended ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />} onClick={toggleSuspend} className="w-full">
          {suspended ? 'Unsuspend' : 'Suspend organisation'}
        </Button>
      </Card>
      {dialog}
    </div>
  )
}
