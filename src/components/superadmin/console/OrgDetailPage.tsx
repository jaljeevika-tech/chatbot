import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, LayoutGrid, Users, CreditCard, Palette, ToggleRight,
  Database, Plug, ScrollText, Lock, ClipboardList,
} from 'lucide-react'
import { saApi, errMsg } from './api'
import { navigate, routeHref, type OrgTab } from './route'
import type { OrgRow } from './types'
import { Button, Card, CopyButton, PageHeader, StatusBadge, AccessBadge, Badge, Tabs, Skeleton, fmtDate, daysUntil } from './ui'
import { OrgUsersTab } from './OrgUsersTab'
import { OrgPlanTab } from './OrgPlanTab'
import { OrgBrandingTab, OrgModulesTab, OrgDataTab } from './OrgSettingsTabs'
import { OrgIntegrationsTab } from './OrgIntegrationsTab'
import { AuditTable } from './AuditPage'
import { OrgFormsTab } from './OrgFormsTab'

const TABS: { id: OrgTab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview',     label: 'Overview',        icon: <LayoutGrid className="w-4 h-4" /> },
  { id: 'users',        label: 'Users',           icon: <Users className="w-4 h-4" /> },
  { id: 'plan',         label: 'Plan & billing',  icon: <CreditCard className="w-4 h-4" /> },
  { id: 'branding',     label: 'Branding',        icon: <Palette className="w-4 h-4" /> },
  { id: 'modules',      label: 'Modules & AI',    icon: <ToggleRight className="w-4 h-4" /> },
  { id: 'data',         label: 'Data sources',    icon: <Database className="w-4 h-4" /> },
  { id: 'integrations', label: 'Integrations',    icon: <Plug className="w-4 h-4" /> },
  { id: 'forms',        label: 'Forms',           icon: <ClipboardList className="w-4 h-4" /> },
  { id: 'audit',        label: 'Activity',        icon: <ScrollText className="w-4 h-4" /> },
]


export function OrgDetailPage({ orgId, tab, formKey }: { orgId: string; tab: OrgTab; formKey?: string }) {
  const [org, setOrg] = useState<OrgRow | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const all = await saApi<OrgRow[]>('/api/superadmin/orgs')
      const found = all.find(o => o.id === orgId)
      if (!found) setError('Organisation not found. It may have been removed.')
      setOrg(found ?? null)
    } catch (e) { setError(errMsg(e)) }
  }, [orgId])
  useEffect(() => { void reload() }, [reload])

  const back = (
    <a href={routeHref({ page: 'orgs' })} className="inline-flex items-center gap-1 text-xs font-semibold text-sa-muted hover:text-sa-text mb-2">
      <ArrowLeft className="w-3.5 h-3.5" /> Organisations
    </a>
  )

  if (error && !org) return <>{back}<div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{error}</div></>
  if (!org) return <>{back}<Skeleton className="h-10 w-64 mb-4" /><Skeleton className="h-64" /></>

  const loginUrl = `${window.location.origin}/?org=${org.slug}`
  const logo = typeof org.metadata?.branding?.logo_url === 'string' ? org.metadata.branding.logo_url : ''

  return (
    <>
      <PageHeader back={back}
        title={
          <span className="flex items-center gap-3">
            {logo
              ? <img src={logo} alt="" className="w-9 h-9 rounded-lg object-contain bg-white border border-sa-border" />
              : <span className="w-9 h-9 rounded-lg bg-sa-primary-soft text-sa-primary flex items-center justify-center text-base font-semibold">{org.name.charAt(0)}</span>}
            <span className="truncate">{org.name}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">/{org.slug}</span>
            <StatusBadge status={org.subscription_status} />
            <AccessBadge state={org.access_state} />
            {org.plan_name && <Badge tone="primary">{org.plan_name}</Badge>}
          </span>
        }
        actions={<CopyButton text={loginUrl} label="Copy login link" />} />

      {org.subscription_status === 'suspended' && (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" />
          <span><strong>Suspended.</strong> Users are read-only and AI is paused.{org.suspended_reason ? ` Reason: ${org.suspended_reason}` : ''}</span>
        </div>
      )}

      <Tabs tabs={TABS} value={tab} onChange={t => navigate({ page: 'orgs', orgId, orgTab: t })} />

      {tab === 'overview'     && <OrgOverviewTab org={org} loginUrl={loginUrl} />}
      {tab === 'users'        && <OrgUsersTab org={org} onChanged={reload} />}
      {tab === 'plan'         && <OrgPlanTab org={org} onChanged={reload} />}
      {tab === 'branding'     && <OrgBrandingTab org={org} onSaved={reload} />}
      {tab === 'modules'      && <OrgModulesTab org={org} onSaved={reload} />}
      {tab === 'data'         && <OrgDataTab org={org} onSaved={reload} />}
      {tab === 'integrations' && <OrgIntegrationsTab org={org} />}
      {tab === 'forms'        && <OrgFormsTab org={org} formKey={formKey} />}
      {tab === 'audit'        && <Card title="Activity" description="Super admin changes to this organisation." padded={false}><AuditTable orgId={org.id} /></Card>}
    </>
  )
}

function OrgOverviewTab({ org, loginUrl }: { org: OrgRow; loginUrl: string }) {
  const used = Number(org.user_count)
  const unlimited = org.max_users == null || org.max_users >= 9999
  const d = daysUntil(org.subscription_expires_at)
  const go = (t: OrgTab) => navigate({ page: 'orgs', orgId: org.id, orgTab: t })
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-4 py-2 text-sm border-b border-sa-border last:border-0">
      <span className="text-sa-muted">{k}</span><span className="text-sa-text text-right">{v}</span>
    </div>
  )
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card title="Subscription" actions={<Button size="sm" onClick={() => go('plan')}>Manage</Button>}>
        <Row k="Plan" v={org.plan_name ?? 'None'} />
        <Row k="Status" v={<StatusBadge status={org.subscription_status} />} />
        <Row k="Ends" v={org.subscription_expires_at ? `${fmtDate(org.subscription_expires_at)}${d !== null && d >= 0 ? ` (in ${d} days)` : ''}` : 'No end date'} />
        <Row k="AI features" v={org.ai_enabled ? 'Included' : 'Not included'} />
        <Row k="Billing email" v={org.billing_email || '—'} />
      </Card>
      <Card title="Seats" actions={<Button size="sm" onClick={() => go('users')}>Manage users</Button>}>
        <div className="text-3xl font-semibold text-sa-text tabular-nums">{used}<span className="text-base text-sa-muted font-normal">{unlimited ? ' users' : ` / ${org.max_users} seats`}</span></div>
        {!unlimited && (
          <div className="h-2 rounded-full bg-sa-subtle overflow-hidden mt-3">
            <div className={`h-full rounded-full ${used > (org.max_users ?? 0) ? 'bg-sa-danger' : 'bg-sa-primary'}`} style={{ width: `${Math.min(100, (used / Math.max(1, org.max_users ?? 1)) * 100)}%` }} />
          </div>
        )}
        <p className="text-xs text-sa-muted mt-3">The org's own admins can't add users beyond the plan's seat limit. You can override it when adding a user here.</p>
      </Card>
      <Card title="Login" className="lg:col-span-2" description="Share this link with the organisation's admins. Staff sign in with their phone number and password.">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <code className="flex-1 min-w-0 truncate rounded-lg bg-sa-subtle border border-sa-border px-3 py-2 text-sm text-sa-text">{loginUrl}</code>
          <CopyButton text={loginUrl} />
        </div>
        <Row k="Created" v={fmtDate(org.created_at)} />
      </Card>
    </div>
  )
}
