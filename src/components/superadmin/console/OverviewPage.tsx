import { useEffect, useState } from 'react'
import { Building2, Users, AlertTriangle, Clock, ArrowRight, Plus } from 'lucide-react'
import { saApi, errMsg } from './api'
import { routeHref } from './route'
import type { OrgRow, PlatformStats } from './types'
import { Card, PageHeader, StatusBadge, AccessBadge, Badge, Skeleton, EmptyState, fmtDate, daysUntil, type Tone } from './ui'

type Attention = { org: OrgRow; label: string; tone: Tone }

/** Orgs a super admin should act on, most urgent first. */
function attentionList(orgs: OrgRow[]): Attention[] {
  const out: (Attention & { rank: number })[] = []
  for (const o of orgs) {
    const d = daysUntil(o.subscription_expires_at)
    if (o.subscription_status === 'suspended') out.push({ org: o, label: 'Suspended', tone: 'danger', rank: 0 })
    else if (o.access_state === 'read_only') out.push({ org: o, label: 'Read-only: subscription expired', tone: 'danger', rank: 1 })
    else if (o.access_state === 'grace') out.push({ org: o, label: 'In grace period', tone: 'warning', rank: 2 })
    else if (d !== null && d >= 0 && d <= 14) out.push({ org: o, label: `${o.subscription_status === 'trialing' ? 'Trial' : 'Subscription'} ends in ${d} day${d === 1 ? '' : 's'}`, tone: 'warning', rank: 3 })
    else if (!o.plan_id) out.push({ org: o, label: 'No plan assigned', tone: 'neutral', rank: 4 })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

function Kpi({ label, value, sub, icon }: { label: string; value: number | string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-sa-border bg-sa-surface p-4 sm:p-5">
      <div className="flex items-center justify-between text-sa-muted">
        <span className="text-xs font-semibold">{label}</span>{icon}
      </div>
      <div className="text-2xl sm:text-3xl font-semibold text-sa-text mt-2 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-sa-muted mt-1">{sub}</div>}
    </div>
  )
}

export function OverviewPage() {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [orgs, setOrgs]   = useState<OrgRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([saApi<PlatformStats>('/api/superadmin/stats'), saApi<OrgRow[]>('/api/superadmin/orgs')])
      .then(([s, o]) => { if (live) { setStats(s); setOrgs(o) } })
      .catch(e => { if (live) setError(errMsg(e)) })
    return () => { live = false }
  }, [])

  const n = (v: number | string | undefined) => Number(v ?? 0)
  const o = stats?.orgs
  const attention = orgs ? attentionList(orgs) : []
  const recent = orgs ? [...orgs].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()).slice(0, 5) : []
  const totalOrgs = n(o?.total_orgs)

  return (
    <>
      <PageHeader title="Platform overview" subtitle="Organisations, subscriptions and anything that needs your attention."
        actions={<a href={routeHref({ page: 'orgs' }) + '?new'} className="inline-flex items-center gap-1.5 rounded-lg bg-sa-primary text-sa-on-primary px-3.5 py-2 text-sm font-semibold hover:bg-sa-primary-hover"><Plus className="w-4 h-4" />New organisation</a>} />

      {error && <div className="mb-6 rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {stats ? <>
          <Kpi label="Organisations" value={totalOrgs} icon={<Building2 className="w-4 h-4" />} />
          <Kpi label="Paying (active)" value={n(o?.active_orgs)} sub={`${n(o?.trialing_orgs)} on trial`} icon={<Clock className="w-4 h-4" />} />
          <Kpi label="Needs attention" value={attention.filter(a => a.tone !== 'neutral').length}
            sub={`${n(o?.suspended_orgs)} suspended · ${n(o?.expired_orgs)} expired`} icon={<AlertTriangle className="w-4 h-4" />} />
          <Kpi label="Users" value={n(stats.users.total_users)} sub="across all organisations" icon={<Users className="w-4 h-4" />} />
        </> : Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-3" title="Needs attention" description="Suspensions, expiries, trials ending within 14 days and orgs without a plan." padded={false}>
          {!orgs ? <div className="p-5 flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
            : attention.length === 0 ? <EmptyState title="All clear">No organisation needs action right now.</EmptyState>
            : (
              <ul className="divide-y divide-sa-border">
                {attention.map(({ org, label, tone }) => (
                  <li key={org.id}>
                    <a href={routeHref({ page: 'orgs', orgId: org.id, orgTab: 'plan' })}
                      className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-sa-subtle">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-sa-text truncate">{org.name}</div>
                        <div className="text-xs text-sa-muted">{org.plan_name ?? 'No plan'} · {Number(org.user_count)} users</div>
                      </div>
                      <Badge tone={tone}>{label}</Badge>
                    </a>
                  </li>
                ))}
              </ul>
            )}
        </Card>

        <Card className="lg:col-span-2" title="Plan distribution">
          {!stats ? <Skeleton className="h-32" /> : (
            <div className="flex flex-col gap-3">
              {stats.plans.map(p => {
                const pct = totalOrgs ? Math.round((n(p.org_count) / totalOrgs) * 100) : 0
                return (
                  <div key={p.slug}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-sa-text">{p.plan_name}</span>
                      <span className="text-sa-muted tabular-nums">{n(p.org_count)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-sa-subtle overflow-hidden">
                      <div className="h-full rounded-full bg-sa-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-5" title="Recently added" padded={false}
          actions={<a href={routeHref({ page: 'orgs' })} className="text-xs font-semibold text-sa-primary inline-flex items-center gap-1">All organisations <ArrowRight className="w-3.5 h-3.5" /></a>}>
          {!orgs ? <div className="p-5"><Skeleton className="h-20" /></div> : (
            <ul className="divide-y divide-sa-border">
              {recent.map(org => (
                <li key={org.id}>
                  <a href={routeHref({ page: 'orgs', orgId: org.id })} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-sa-subtle">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-sa-text truncate">{org.name}</div>
                      <div className="text-xs text-sa-muted">/{org.slug} · added {fmtDate(org.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0"><AccessBadge state={org.access_state} /><StatusBadge status={org.subscription_status} /></div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
