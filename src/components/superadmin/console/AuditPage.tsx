// Platform audit trail — every super admin write (GET /api/superadmin/audit).
// Secrets are redacted server-side before they're stored.

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, ScrollText } from 'lucide-react'
import { saApi, errMsg } from './api'
import { routeHref } from './route'
import { Button, Card, Select, PageHeader, Badge, Skeleton, EmptyState, fmtDateTime, type Tone } from './ui'

type AuditRow = {
  id: string; actor_uid: string; actor_name: string | null; action: string
  target_org_id: string | null; target_org_name: string | null
  target_type: string | null; target_id: string | null; diff: unknown; ip: string | null; created_at: string
}

const FILTERS = [
  { value: '',            label: 'All actions' },
  { value: 'org.',        label: 'Organisations' },
  { value: 'org.suspend', label: 'Suspensions' },
  { value: 'user.',       label: 'Users' },
  { value: 'plan.',       label: 'Plans' },
  { value: 'billing.',    label: 'Billing' },
]

const ACTION_TEXT: Record<string, [string, Tone]> = {
  'org.create':              ['Created organisation', 'success'],
  'org.metadata.update':     ['Changed settings', 'neutral'],
  'org.subscription.update': ['Changed subscription', 'primary'],
  'org.suspend':             ['Suspended', 'danger'],
  'org.unsuspend':           ['Unsuspended', 'success'],
  'user.create':             ['Added user', 'success'],
  'user.update':             ['Edited user', 'neutral'],
  'user.delete':             ['Removed user', 'danger'],
  'plan.create':             ['Created plan', 'success'],
  'plan.update':             ['Edited plan', 'neutral'],
  'billing.backfill':        ['Backfilled usage', 'neutral'],
}

/** Audit rows, optionally for one organisation (used on the org detail page). */
export function AuditTable({ orgId, action = '' }: { orgId?: string; action?: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState('')
  const PAGE = 50

  const load = useCallback(async (before?: string) => {
    const q = new URLSearchParams({ limit: String(PAGE) })
    if (orgId) q.set('org_id', orgId)
    if (action) q.set('action', action)
    if (before) q.set('before', before)
    try {
      const data = await saApi<AuditRow[]>(`/api/superadmin/audit?${q}`)
      setRows(prev => before ? [...(prev ?? []), ...data] : data)
      setHasMore(data.length === PAGE)
    } catch (e) { setError(errMsg(e)) }
  }, [orgId, action])

  useEffect(() => { setRows(null); void load() }, [load])

  if (error) return <div className="m-5 rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{error}</div>
  if (!rows) return <div className="p-5 flex flex-col gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>
  if (!rows.length) return <EmptyState icon={<ScrollText className="w-8 h-8" />} title="No activity yet">Super admin changes will appear here.</EmptyState>

  return (
    <>
      <ul className="divide-y divide-sa-border">
        {rows.map(r => {
          const [text, tone] = ACTION_TEXT[r.action] ?? [r.action, 'neutral' as Tone]
          const expanded = open === r.id
          return (
            <li key={r.id}>
              <button onClick={() => setOpen(expanded ? null : r.id)} aria-expanded={expanded}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left hover:bg-sa-subtle cursor-pointer">
                <ChevronRight className={`w-3.5 h-3.5 text-sa-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
                <Badge tone={tone}>{text}</Badge>
                {!orgId && r.target_org_id && (
                  <a href={routeHref({ page: 'orgs', orgId: r.target_org_id })} onClick={e => e.stopPropagation()} className="text-sm font-medium text-sa-text hover:text-sa-primary">
                    {r.target_org_name ?? 'Deleted organisation'}
                  </a>
                )}
                <span className="text-sm text-sa-muted">by {r.actor_name || r.actor_uid}</span>
                <span className="ml-auto text-xs text-sa-muted tabular-nums">{fmtDateTime(r.created_at)}</span>
              </button>
              {expanded && (
                <div className="px-5 pb-4 pl-11 text-xs text-sa-muted flex flex-col gap-2">
                  <div>Action <span className="font-mono">{r.action}</span> · target {r.target_type ?? '—'} <span className="font-mono">{r.target_id ?? ''}</span> · IP {r.ip ?? '—'}</div>
                  {r.diff != null && (
                    <pre className="rounded-lg bg-sa-subtle border border-sa-border p-3 text-sa-text overflow-auto max-h-72 whitespace-pre-wrap break-all">{JSON.stringify(r.diff, null, 2)}</pre>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {hasMore && (
        <div className="flex justify-center p-4 border-t border-sa-border">
          <Button size="sm" loading={loadingMore} onClick={async () => { setLoadingMore(true); await load(rows[rows.length - 1]?.id); setLoadingMore(false) }}>Load older</Button>
        </div>
      )}
    </>
  )
}

export function AuditPage() {
  const [action, setAction] = useState('')
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every change made from this console: who, what, when and from where. Passwords and secrets are never recorded."
        actions={
          <Select value={action} onChange={e => setAction(e.target.value)} aria-label="Filter actions" className="w-48">
            {FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
        } />
      <Card padded={false}><AuditTable action={action} /></Card>
    </>
  )
}
