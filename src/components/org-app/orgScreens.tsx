// FieldFlow Org app screens: phone layouts of the dashboard's HR and Finance panels.
// No data of their own; HR state comes from useHrData, Finance from useFmController (owned by OrgApp).

import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import {
  BarChart3, CalendarClock, CheckCircle2, ChevronRight, CloudOff, ExternalLink, Loader2, LogOut,
  Settings, Share, SlidersHorizontal, Users, X,
} from 'lucide-react'
import { FF } from '../../theme/colors'
import type { AuthUser } from '../../context/AuthContext'
import type { OrgMetadata } from '../../types/org'
import type { FmMe, Advance, LedgerRequest } from '../finance-mgmt/fmApi'
import { fmGet } from '../finance-mgmt/fmApi'
import { Btn, Card, ErrorBox, LoadingRow, useFmLoad } from '../finance-mgmt/fmUi'
import { useFm } from '../finance-mgmt/fmContext'
import type { useFmController } from '../finance-mgmt/useFmController'
import { AdvanceList, AdvanceRequestsPanel } from '../finance-mgmt/AdvanceRequestsPanel'
import { AdvanceSettlementPanel, SettlementsTable } from '../finance-mgmt/AdvanceSettlementPanel'
import { LedgerList, LedgerRequestsPanel } from '../finance-mgmt/LedgerRequestsPanel'
import { EmptyState } from '../ui/EmptyState'
import type { HrData } from '../hr/useHrData'
import type { HrBootstrap, OutboxItem } from '../../types/hr'
import { ProblemRow, SyncBar } from '../hr/HrManagementPage'
import { ApprovalsPanel } from '../hr/ApprovalsPanel'
import { Notice, fmtDays } from '../hr/hrUi'
import {
  ORG_APP_NAME, canPromptInstall, isIos, isStandalone, promptInstall, subscribeInstallPrompt,
} from './orgAppRoute'

export type FmController = ReturnType<typeof useFmController>
export type FmSection = 'advances' | 'settlement' | 'ledger'
export type SubScreen = 'team' | 'hr-reports' | 'hr-settings' | 'fm-settings' | 'compliance'

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}>
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  )
}

export function OfflineCard({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <Card className="p-5 flex flex-col items-center text-center gap-2">
      <span className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: FF.amberBg, color: FF.amber }}>
        <CloudOff className="w-5 h-5" />
      </span>
      <div className="font-semibold text-[15px]" style={{ color: FF.tealDark }}>{title}</div>
      <p className="text-[13px] leading-relaxed" style={{ color: FF.textMuted }}>{body}</p>
      {onRetry && <Btn className="mt-1" onClick={onRetry}>Try again</Btn>}
    </Card>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-[11px] uppercase tracking-wider font-bold px-1" style={{ color: FF.textMuted }}>{children}</h2>
}

// ── Gates: what a screen shows before its data is ready ──────────────────────
/** HR works offline from the copy saved on this phone; the sync bar says so. */
export function HrGate({ hr, children }: { hr: HrData; children: (data: HrBootstrap) => ReactNode }) {
  const { data, loading, error, fromCache } = hr
  if (loading) return <Spinner />
  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone={error ? 'red' : 'amber'}>
          {error ?? "You're offline and this phone hasn't saved any HR data yet. Open the app once while connected — after that, attendance and leave work offline."}
        </Notice>
        <div><Btn onClick={() => void hr.refresh()}>Try again</Btn></div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <SyncBar data={data} fromCache={fromCache} hr={hr} />
      {error && <Notice tone="red">{error}</Notice>}
      {hr.sync.problems.map(p => <ProblemRow key={p.clientId} p={p} data={data} />)}
      {children(data)}
    </div>
  )
}

/** Finance is online-only. */
export function FinanceGate({ fm, children }: { fm: FmController; children: (me: FmMe) => ReactNode }) {
  if (fm.me) return <>{children(fm.me)}</>
  if (fm.meError) {
    return (
      <div className="space-y-3">
        <ErrorBox message={fm.meError} />
        <Btn onClick={fm.reload}>Try again</Btn>
      </div>
    )
  }
  if (fm.offline) {
    return (
      <OfflineCard title="Finance needs a connection" onRetry={fm.reload}
        body="Advances, bills and ledger requests load when you're back online. Attendance and leave keep working offline." />
    )
  }
  return <Spinner />
}

/** Leave requests still waiting on me — minus ones I've decided on this phone but not yet synced. */
export function leaveWaitingCount(data: HrBootstrap, pending: OutboxItem[]): number {
  const decided = new Set(pending
    .filter((p): p is OutboxItem<'leave_decision'> => p.kind === 'leave_decision')
    .map(p => p.payload.requestId))
  return data.approvals.filter(r => !decided.has(r.id)).length
}

// ── Home summary (top of the first tab) ──────────────────────────────────────
export function Greeting({ name, hrData, fmMe, approvals, onLeave, onSettle, onApprovals }: {
  name: string; hrData: HrBootstrap | null; fmMe: FmMe | null; approvals: number
  onLeave: () => void; onSettle: () => void; onApprovals: () => void
}) {
  const hour = new Date().getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const first = name.trim().split(/\s+/)[0]
  const leaveLeft = hrData?.balances.filter(b => b.isActive && b.quota > 0).reduce((t, b) => t + b.available, 0)
  const toSettle = fmMe?.counts.my_open_advances ?? 0
  const tiles: { label: string; value: string; onClick: () => void; tone?: string }[] = [
    ...(leaveLeft != null ? [{ label: 'Leave left', value: fmtDays(leaveLeft), onClick: onLeave }] : []),
    ...(toSettle > 0 ? [{ label: 'Advances to settle', value: String(toSettle), onClick: onSettle, tone: FF.amber }] : []),
  ]
  return (
    <section>
      <div className="text-[13px]" style={{ color: FF.textMuted }}>
        {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      <h2 className="text-[24px] leading-tight font-semibold" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>
        {hello}{first ? `, ${first}` : ''}
      </h2>
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          {tiles.map(t => (
            <button key={t.label} onClick={t.onClick} className="text-left rounded-2xl bg-white px-3.5 py-2.5 active:bg-gray-50"
              style={{ border: `1px solid ${FF.border}` }}>
              <div className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{t.label}</div>
              <div className="text-[18px] font-bold" style={{ color: t.tone ?? FF.tealDark }}>{t.value}</div>
            </button>
          ))}
        </div>
      )}
      {approvals > 0 && (
        <button onClick={onApprovals} className="w-full mt-2 rounded-2xl px-3.5 py-3 flex items-center gap-3 text-left active:opacity-80"
          style={{ background: FF.redBg, color: FF.red }}>
          <span className="min-w-[28px] h-7 px-1.5 rounded-full flex items-center justify-center text-[13px] font-bold text-white" style={{ background: FF.red }}>
            {approvals}
          </span>
          <span className="flex-1 text-[13.5px] font-semibold">{approvals === 1 ? 'Request is' : 'Requests are'} waiting for your approval</span>
          <span className="inline-flex items-center gap-0.5 text-[13px] font-semibold">Review <ChevronRight className="w-4 h-4" /></span>
        </button>
      )}
    </section>
  )
}

// ── Install ──────────────────────────────────────────────────────────────────
/** "Install FieldFlow Org" — Chrome's own dialog on Android, instructions on iPhone. */
export function InstallCard({ onDismiss, always }: { onDismiss?: () => void; always?: boolean }) {
  const canPrompt = useSyncExternalStore(subscribeInstallPrompt, canPromptInstall)
  if (isStandalone()) return null
  const ios = isIos()
  if (!always && !canPrompt && !ios) return null
  return (
    <div className="rounded-2xl bg-white p-3.5 flex gap-3 items-start" style={{ border: `1px solid ${FF.border}` }}>
      <img src="/org-app/icon-192.png" alt="" className="w-11 h-11 rounded-xl shrink-0" style={{ border: `1px solid ${FF.borderFaint}` }} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm" style={{ color: FF.tealDark }}>Install {ORG_APP_NAME}</div>
        <div className="text-xs mt-0.5 leading-relaxed" style={{ color: FF.textMuted }}>
          {ios
            ? <>Tap <Share className="inline w-3.5 h-3.5 -mt-0.5" aria-label="Share" /> Share at the bottom of Safari, then <b>Add to Home Screen</b>.</>
            : canPrompt
              ? 'Opens from your home screen like an app, and check-in works without signal.'
              : 'Open your browser menu (⋮) and choose Install app or Add to Home screen.'}
        </div>
        {canPrompt && <Btn variant="primary" small className="mt-2" onClick={() => void promptInstall()}>Install</Btn>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="w-8 h-8 -mr-1 -mt-1 flex items-center justify-center shrink-0" style={{ color: FF.textFaint }}>
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

// ── Finance ──────────────────────────────────────────────────────────────────
function PillRow<T extends string>({ options, value, onChange, label }: {
  options: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void; label: string
}) {
  return (
    <div role="tablist" aria-label={label}
      className="flex gap-2 overflow-x-auto -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {options.map(o => {
        const on = o.key === value
        return (
          <button key={o.key} role="tab" aria-selected={on} onClick={() => onChange(o.key)}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-[13px] font-semibold"
            style={{ background: on ? FF.tealDark : '#fff', color: on ? '#fff' : FF.tealDark, border: `1px solid ${on ? FF.tealDark : FF.border}` }}>
            {o.label}
            {!!o.count && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] leading-[18px] text-white text-center" style={{ background: FF.red }}>{o.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function FinanceScreen({ fm, section, onSection }: { fm: FmController; section: FmSection; onSection: (s: FmSection) => void }) {
  return (
    <FinanceGate fm={fm}>
      {me => {
        const c = me.counts
        return (
          <div className="space-y-4">
            <PillRow label="Finance sections" value={section} onChange={onSection} options={[
              { key: 'advances', label: 'Advances', count: c.adv_manager + c.adv_finance + c.adv_disburse },
              { key: 'settlement', label: 'Bills & settlement', count: c.stl_manager + c.stl_finance + c.my_open_advances },
              { key: 'ledger', label: 'Ledger', count: c.ledger_finance },
            ]} />
            {me.finance_team_size === 0 && (
              <Notice tone="amber">
                <b>No Finance team set up yet.</b>{' '}
                {me.me.is_admin
                  ? 'Mark who handles Finance in More → Finance settings so approved advances can be paid.'
                  : 'Requests will wait after manager approval until an admin adds the Finance team.'}
              </Notice>
            )}
            {section === 'advances' && <AdvanceRequestsPanel />}
            {section === 'settlement' && <AdvanceSettlementPanel />}
            {section === 'ledger' && <LedgerRequestsPanel onNew={fm.newLedger} />}
          </div>
        )
      }}
    </FinanceGate>
  )
}

// ── Approvals: everything waiting on me, HR and Finance together ─────────────
function AdvanceQueue() {
  const { version } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ advances: Advance[] }>('/advances?scope=approvals'), [version])
  return (
    <Card>
      {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : (
        <AdvanceList advances={data?.advances || []} showRequester emptyTitle="No advances waiting for you" />
      )}
    </Card>
  )
}

function LedgerQueue() {
  const { version } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ requests: LedgerRequest[] }>('/ledger-requests?scope=queue'), [version])
  const pending = (data?.requests || []).filter(l => l.status === 'pending')
  return (
    <Card>
      {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : !pending.length ? (
        <EmptyState compact title="No ledger requests waiting" />
      ) : <LedgerList requests={pending} showRequester />}
    </Card>
  )
}

function FinanceApprovals({ me }: { me: FmMe }) {
  const c = me.counts
  const adv = c.adv_manager + c.adv_finance + c.adv_disburse
  const stl = c.stl_manager + c.stl_finance
  const ledger = c.ledger_finance
  if (!adv && !stl && !ledger) {
    return (
      <Card>
        <EmptyState compact icon={<CheckCircle2 className="w-6 h-6" />} title="Nothing waiting for you"
          body="Advances, bills and ledger requests that need your action appear here." />
      </Card>
    )
  }
  return (
    <div className="space-y-4">
      {adv > 0 && <div className="space-y-2"><div className="text-sm font-semibold px-1" style={{ color: FF.tealDark }}>Advances · {adv}</div><AdvanceQueue /></div>}
      {stl > 0 && <div className="space-y-2"><div className="text-sm font-semibold px-1" style={{ color: FF.tealDark }}>Bills to review · {stl}</div><SettlementsTable scope="approvals" /></div>}
      {ledger > 0 && <div className="space-y-2"><div className="text-sm font-semibold px-1" style={{ color: FF.tealDark }}>Ledger statements · {ledger}</div><LedgerQueue /></div>}
    </div>
  )
}

export function ApprovalsScreen({ hr, hrLead, fm, fmApprover }: { hr: HrData; hrLead: boolean; fm: FmController; fmApprover: boolean }) {
  return (
    <div className="space-y-6">
      {hrLead && (
        <section className="space-y-3">
          <SectionHeading>Leave requests</SectionHeading>
          <HrGate hr={hr}>{data => <ApprovalsPanel hr={hr} data={data} />}</HrGate>
        </section>
      )}
      {fmApprover && (
        <section className="space-y-3">
          <SectionHeading>Finance</SectionHeading>
          <FinanceGate fm={fm}>{me => <FinanceApprovals me={me} />}</FinanceGate>
        </section>
      )}
    </div>
  )
}

// ── More ─────────────────────────────────────────────────────────────────────
function Row({ icon: Icon, label, hint, onClick, href, tone }: {
  icon: ComponentType<{ className?: string }>; label: string; hint?: string
  onClick?: () => void; href?: string; tone?: string
}) {
  const body = (
    <>
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: FF.bg, color: tone ?? FF.tealDark }}>
        <Icon className="w-[18px] h-[18px]" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[14.5px] font-medium" style={{ color: tone ?? FF.tealDark }}>{label}</span>
        {hint && <span className="block text-xs mt-0.5" style={{ color: FF.textMuted }}>{hint}</span>}
      </span>
      {href ? <ExternalLink className="w-4 h-4 shrink-0" style={{ color: FF.textFaint }} />
        : <ChevronRight className="w-4 h-4 shrink-0" style={{ color: FF.textFaint }} />}
    </>
  )
  const cls = 'w-full flex items-center gap-3 px-4 py-3 text-left active:bg-gray-50'
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{body}</a>
    : <button onClick={onClick} className={cls}>{body}</button>
}

function RowGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <SectionHeading>{title}</SectionHeading>
      <Card className="divide-y divide-[#E4F0F1] overflow-hidden">{children}</Card>
    </section>
  )
}

const ROLE_LABEL: Record<string, string> = { superadmin: 'Super admin', admin: 'Admin', manager: 'Manager', employee: 'Employee' }

export function MoreScreen({ user, org, hasHr, hasFm, hrData, hrLead, fmMe, onOpen, onLogout }: {
  user: AuthUser | null; org: OrgMetadata | null; hasHr: boolean; hasFm: boolean
  hrData: HrBootstrap | null; hrLead: boolean; fmMe: FmMe | null
  onOpen: (s: SubScreen) => void; onLogout: () => void
}) {
  const name = user?.name || hrData?.me.name || ''
  const tags = [
    ROLE_LABEL[user?.role ?? ''] ?? user?.role,
    hrData?.me.isHr ? 'HR' : null,
    fmMe?.me.is_finance ? 'Finance team' : null,
  ].filter(Boolean).join(' · ')
  const hrRows = hasHr && hrData ? [
    ...(hrLead ? [
      <Row key="team" icon={Users} label="Team attendance" hint="Who's in today, flagged check-ins, mark attendance" onClick={() => onOpen('team')} />,
      <Row key="rep" icon={BarChart3} label="HR reports" hint="Monthly attendance and leave summaries" onClick={() => onOpen('hr-reports')} />,
    ] : []),
    ...(hrData.me.isAdmin ? [<Row key="hrs" icon={SlidersHorizontal} label="HR settings" hint="Leave types, holidays, locations, GPS rules" onClick={() => onOpen('hr-settings')} />] : []),
  ] : []
  const fmRows = hasFm ? [
    <Row key="cal" icon={CalendarClock} label="Compliance due dates" hint="Statutory and donor deadlines" onClick={() => onOpen('compliance')} />,
    ...(fmMe?.me.is_admin ? [<Row key="fms" icon={Settings} label="Finance settings" hint="Finance team, approvers, expense categories" onClick={() => onOpen('fm-settings')} />] : []),
  ] : []

  return (
    <div className="space-y-6">
      <Card className="p-4 flex items-center gap-3">
        <span className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold text-white shrink-0" style={{ background: FF.purple }}>
          {(name.trim()[0] || '?').toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-[16px] truncate" style={{ color: FF.tealDark }}>{name || 'Signed in'}</div>
          <div className="text-xs truncate" style={{ color: FF.textMuted }}>{tags}</div>
          <div className="text-xs truncate" style={{ color: FF.textFaint }}>{org?.branding?.org_name}</div>
        </div>
      </Card>

      <InstallCard always />

      {hrRows.length > 0 && <RowGroup title="Team & HR">{hrRows}</RowGroup>}
      {fmRows.length > 0 && <RowGroup title="Finance">{fmRows}</RowGroup>}

      <RowGroup title="Account">
        <Row icon={ExternalLink} label="Open full dashboard" hint="Reports, projects and everything else, in your browser" href="/" />
        <Row icon={LogOut} label="Sign out" onClick={onLogout} tone={FF.red} />
      </RowGroup>

      <p className="text-center text-[11px] pb-2" style={{ color: FF.textFaint }}>{ORG_APP_NAME}</p>
    </div>
  )
}
