// HR Management tab — attendance + leave, backed by services/hr.
// Works offline: data saved on this device is shown immediately, and every
// change goes into an outbox that syncs when there's a connection
// (utils/hr/hrSync.ts). Settings, reports and the flagged list need a connection.

import { Suspense, lazy, useState } from 'react'
import { CloudOff, Loader2, RefreshCw, Wifi } from 'lucide-react'
import { FF } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'
import { dateInTz } from '../../../services/hr/dates'
import { dismissProblem, flush } from '../../utils/hr/hrSync'
import type { HrBootstrap, SyncProblem } from '../../types/hr'
import { useHrData } from './useHrData'
import { AttendancePanel } from './AttendancePanel'
import { LeavePanel } from './LeavePanel'
import { TeamPanel } from './TeamPanel'
import { ApprovalsPanel } from './ApprovalsPanel'
import { ReportsPanel } from './ReportsPanel'
import { HrSettingsPanel } from './HrSettingsPanel'
import { TimesheetPanel } from './TimesheetPanel'
import { OrgChartPanel } from './OrgChartPanel'
import { Btn, FONT, Muted, Notice, fmtDate, fmtRange } from './hrUi'

const HrDashboardPanel = lazy(() => import('./HrDashboardPanel'))

export { warmHrOffline } from './useHrData'

type HrTab = 'dashboard' | 'attendance' | 'leave' | 'timesheet' | 'team' | 'approvals' | 'reports' | 'orgchart' | 'settings'

export function HrManagementPage() {
  const hr = useHrData()
  const { data, loading, error, fromCache, sync, refresh } = hr
  const [tab, setTab] = useState<HrTab>('attendance')

  if (loading) {
    return <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3" style={{ fontFamily: FONT, maxWidth: 560 }}>
        <Notice tone={error ? 'red' : 'amber'}>
          {error ?? "You're offline and this device hasn't saved any HR data yet. Open this tab once while connected — after that it works offline."}
        </Notice>
        <div><Btn onClick={() => void refresh()}>Try again</Btn></div>
      </div>
    )
  }

  const { me } = data
  const leads = me.isManager || me.isHr || me.isAdmin
  const approvalsCount = data.approvals.length
  const tabs: { key: HrTab; label: string }[] = [
    ...(me.isHr || me.isAdmin ? [{ key: 'dashboard' as HrTab, label: 'Dashboard' }] : []),
    { key: 'attendance', label: 'My attendance' },
    { key: 'leave', label: 'My leave' },
    { key: 'timesheet', label: 'Timesheet' },
    ...(leads ? [
      { key: 'team' as HrTab, label: 'Team' },
      { key: 'approvals' as HrTab, label: approvalsCount ? `Approvals (${approvalsCount})` : 'Approvals' },
      { key: 'reports' as HrTab, label: 'Reports' },
    ] : []),
    { key: 'orgchart', label: 'Org chart' },
    ...(me.isAdmin ? [{ key: 'settings' as HrTab, label: 'Settings' }] : []),
  ]
  const active = tabs.some(t => t.key === tab) ? tab : 'attendance'

  return (
    <div className="flex flex-col gap-4" style={{ fontFamily: FONT }}>
      <SyncBar data={data} fromCache={fromCache} hr={hr} />
      {error && <Notice tone="red">{error}</Notice>}
      {sync.problems.map(p => <ProblemRow key={p.clientId} p={p} data={data} />)}
      <TabPill tabs={tabs} active={active} onChange={setTab} />
      {active === 'dashboard' && <Suspense fallback={<Muted>Loading dashboard…</Muted>}><HrDashboardPanel /></Suspense>}
      {active === 'attendance' && <AttendancePanel hr={hr} data={data} />}
      {active === 'leave' && <LeavePanel hr={hr} data={data} />}
      {active === 'team' && <TeamPanel hr={hr} data={data} />}
      {active === 'approvals' && <ApprovalsPanel hr={hr} data={data} />}
      {active === 'reports' && <ReportsPanel data={data} />}
      {active === 'timesheet' && <TimesheetPanel data={data} />}
      {active === 'orgchart' && <OrgChartPanel data={data} />}
      {active === 'settings' && <HrSettingsPanel data={data} onChanged={refresh} />}
    </div>
  )
}

export function SyncBar({ data, fromCache, hr }: { data: HrBootstrap; fromCache: boolean; hr: ReturnType<typeof useHrData> }) {
  const { sync } = hr
  const pending = sync.pending.length
  const savedAt = data.cachedAt
    ? new Date(data.cachedAt).toLocaleString('en-IN', { timeZone: data.settings.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : null
  return (
    <div className="flex items-center gap-3 flex-wrap" role="status"
      style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>
      {sync.online ? (
        <span className="inline-flex items-center gap-1.5" style={{ color: FF.green }}><Wifi className="w-4 h-4" /> Online</span>
      ) : (
        <span className="inline-flex items-center gap-1.5" style={{ color: FF.amber }}>
          <CloudOff className="w-4 h-4" /> Offline — changes are saved on this device
        </span>
      )}
      {fromCache && savedAt && <span style={{ color: FF.textMuted }}>Showing data saved {savedAt}</span>}
      <span style={{ color: pending ? FF.purple : FF.textFaint }}>
        {pending ? `${pending} change${pending > 1 ? 's' : ''} waiting to sync` : 'All changes synced'}
      </span>
      {sync.lastError && <span style={{ color: FF.amber }}>{sync.lastError}</span>}
      <span style={{ marginLeft: 'auto' }}>
        <Btn variant="ghost" disabled={sync.syncing} onClick={() => { void flush(); void hr.refresh() }} aria-label="Sync now">
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className={`w-4 h-4 ${sync.syncing ? 'animate-spin' : ''}`} /> Sync now
          </span>
        </Btn>
      </span>
    </div>
  )
}

/** A queued change the server refused (e.g. leave balance ran out, or
 *  someone else already decided the request). */
export function ProblemRow({ p, data }: { p: SyncProblem; data: HrBootstrap }) {
  const when = fmtDate(dateInTz(new Date(p.createdAt), data.settings.timezone))
  const name = (id: string) => data.team.find(u => u.id === id)?.name ?? 'an employee'
  const pl = p.payload as Record<string, string>
  const what: Record<SyncProblem['kind'], string> = {
    check_in:        `Your check-in on ${when}`,
    check_out:       `Your check-out on ${when}`,
    mark_attendance: `Attendance for ${name(pl.userId)} on ${pl.date ? fmtDate(pl.date) : when}`,
    review_flag:     'Reviewing a flagged check-in',
    leave_request:   `Your leave request for ${pl.startDate ? fmtRange(pl.startDate, pl.endDate) : when}`,
    leave_cancel:    'Cancelling a leave request',
    leave_decision:  `${pl.decision === 'approve' ? 'Approving' : 'Rejecting'} a leave request`,
  }
  return (
    <Notice tone="red">
      <div className="flex items-start justify-between gap-3">
        <span><b>{what[p.kind]}</b> wasn't saved: {p.error}</span>
        <button type="button" onClick={() => void dismissProblem(p.clientId)}
          style={{ fontWeight: 600, textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap' }}>Dismiss</button>
      </div>
    </Notice>
  )
}
