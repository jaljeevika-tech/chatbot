// FieldFlow Org: the dashboard's HR + Finance panels as an installable phone app at /org/.
// This is the phone shell (app bar, bottom tabs, hash routing so Android Back works).
// HR works offline via its outbox; Finance needs a connection.

import { useEffect, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { CalendarDays, ChevronLeft, ClipboardCheck, Clock, CloudOff, LogOut, Menu, RefreshCw, Wallet, ExternalLink } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { useOrg } from '../../context/OrgContext'
import { makeCanSeeTab } from '../../utils/tabAccess'
import { flush } from '../../utils/hr/hrSync'
import { useHrData } from '../hr/useHrData'
import { AttendancePanel } from '../hr/AttendancePanel'
import { LeavePanel } from '../hr/LeavePanel'
import { TeamPanel } from '../hr/TeamPanel'
import { ReportsPanel } from '../hr/ReportsPanel'
import { HrSettingsPanel } from '../hr/HrSettingsPanel'
import { FONT } from '../hr/hrUi'
import { FmContext } from '../finance-mgmt/fmContext'
import { fmActionCount, useFmController } from '../finance-mgmt/useFmController'
import { NotificationsBell } from '../finance-mgmt/FinanceManagementPage'
import { FinanceSettingsPanel } from '../finance-mgmt/FinanceSettingsPanel'
import { ComplianceCalendarPage } from '../dashboard/ComplianceCalendarPage'
import { ORG_APP_NAME } from './orgAppRoute'
import {
  ApprovalsScreen, FinanceGate, FinanceScreen, Greeting, HrGate, InstallCard, MoreScreen, OfflineCard,
  leaveWaitingCount, type FmSection, type SubScreen,
} from './orgScreens'

type Tab = 'attendance' | 'leave' | 'finance' | 'approvals' | 'more'
interface Route { tab: Tab; sub: SubScreen | null }

const TABS: readonly Tab[] = ['attendance', 'leave', 'finance', 'approvals', 'more']
const SUBS: readonly SubScreen[] = ['team', 'hr-reports', 'hr-settings', 'fm-settings', 'compliance']
const TITLE: Record<Tab, string> = { attendance: 'Attendance', leave: 'Leave', finance: 'Finance', approvals: 'Approvals', more: 'More' }
const SUB_TITLE: Record<SubScreen, string> = {
  team: 'Team attendance', 'hr-reports': 'HR reports', 'hr-settings': 'HR settings',
  'fm-settings': 'Finance settings', compliance: 'Compliance due dates',
}
const ENTITY_SECTION: Record<string, FmSection> = { advance: 'advances', settlement: 'settlement', ledger: 'ledger' }

function readRoute(): Route {
  const [tab, sub] = window.location.hash.replace(/^#/, '').split('/')
  return {
    tab: (TABS as readonly string[]).includes(tab) ? tab as Tab : 'attendance',
    sub: tab === 'more' && (SUBS as readonly string[]).includes(sub) ? sub as SubScreen : null,
  }
}

const FM_SECTION_KEY = 'org_app_fm_section'
const INSTALL_DISMISSED_KEY = 'org_app_install_dismissed'
function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

function subscribeOnline(fn: () => void) {
  window.addEventListener('online', fn)
  window.addEventListener('offline', fn)
  return () => { window.removeEventListener('online', fn); window.removeEventListener('offline', fn) }
}
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine)

interface NavTab { key: Tab; label: string; icon: ComponentType<{ className?: string; style?: React.CSSProperties }>; badge?: number }

export function OrgApp() {
  const { user, logout } = useAuthContext()
  const { org } = useOrg()
  const canSeeTab = makeCanSeeTab(user, org)
  const hasHr = canSeeTab('hr')
  const hasFm = canSeeTab('financemgmt')
  const hr = useHrData(hasHr)
  const fm = useFmController(hasFm)
  const online = useOnline()
  const [route, setRoute] = useState<Route>(readRoute)
  const [fmSection, setFmSectionState] = useState<FmSection>(() => {
    const s = readStored(FM_SECTION_KEY)
    return s === 'settlement' || s === 'ledger' ? s : 'advances'
  })
  const [installDismissed, setInstallDismissed] = useState(() => readStored(INSTALL_DISMISSED_KEY) === '1')
  const [refreshing, setRefreshing] = useState(false)

  // OrgContext retitles the page with the org's dashboard title on every load.
  useEffect(() => { document.title = ORG_APP_NAME }, [org])

  useEffect(() => {
    const sync = () => setRoute(readRoute())
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync) }
  }, [])

  // Back in the foreground (phone unlocked, switched back to the app): fresh data.
  const { refresh: refreshHr } = hr
  const { reload: reloadFm } = fm
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (hasHr) void refreshHr()
      if (hasFm) reloadFm()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [hasHr, hasFm, refreshHr, reloadFm])

  const hrData = hr.data
  const hrLead = !!hrData && (hrData.me.isManager || hrData.me.isHr || hrData.me.isAdmin)
  const fmMe = fm.me
  const fmApprover = !!fmMe && (fmMe.me.role === 'manager' || fmMe.me.is_admin || fmMe.me.is_finance || fmActionCount(fmMe) > 0)
  const approvals = (hrLead && hrData ? leaveWaitingCount(hrData, hr.sync.pending) : 0) + fmActionCount(fmMe)

  const tabs: NavTab[] = [
    ...(hasHr ? [
      { key: 'attendance' as Tab, label: 'Attendance', icon: Clock },
      { key: 'leave' as Tab, label: 'Leave', icon: CalendarDays },
    ] : []),
    ...(hasFm ? [{ key: 'finance' as Tab, label: 'Finance', icon: Wallet }] : []),
    ...(hrLead || fmApprover ? [{ key: 'approvals' as Tab, label: 'Approvals', icon: ClipboardCheck, badge: approvals }] : []),
    { key: 'more', label: 'More', icon: Menu },
  ]
  const tab: Tab = tabs.some(t => t.key === route.tab) ? route.tab : tabs[0].key
  const subAllowed: Record<SubScreen, boolean> = {
    team: hrLead, 'hr-reports': hrLead, 'hr-settings': !!hrData?.me.isAdmin,
    'fm-settings': !!fmMe?.me.is_admin, compliance: hasFm,
  }
  const sub = tab === 'more' && route.sub && subAllowed[route.sub] ? route.sub : null

  // Tabs replace the history entry (switching tabs shouldn't pile up Back
  // steps); a More sub-page pushes one, so Back returns to More.
  function goTab(t: Tab) {
    history.replaceState(null, '', `#${t}`)
    setRoute({ tab: t, sub: null })
    window.scrollTo(0, 0)
  }
  function openSub(s: SubScreen) {
    history.pushState({ orgAppSub: true }, '', `#more/${s}`)
    setRoute({ tab: 'more', sub: s })
    window.scrollTo(0, 0)
  }
  function back() {
    if ((history.state as { orgAppSub?: boolean } | null)?.orgAppSub) history.back()
    else goTab('more')
  }
  function setFmSection(s: FmSection) {
    setFmSectionState(s)
    store(FM_SECTION_KEY, s)
  }

  // Links in Finance emails / WhatsApp: #finance/<advance|settlement|ledger>/<id>.
  const fmCtx = fm.ctx
  useEffect(() => {
    const m = /^#finance\/(advance|settlement|ledger)\/([0-9a-f-]{36})$/i.exec(window.location.hash)
    if (!m || !fmCtx) return
    history.replaceState(null, '', '#finance')
    setFmSection(ENTITY_SECTION[m[1]])
    const open = { advance: fmCtx.openAdvance, settlement: fmCtx.openSettlement, ledger: fmCtx.openLedger }
    open[m[1] as keyof typeof open](m[2])
  }, [fmCtx, route]) // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshAll() {
    setRefreshing(true)
    try {
      if (hasHr) await Promise.allSettled([flush(), refreshHr()])
      if (hasFm) { if (fm.ctx) fm.ctx.changed(); else reloadFm() }
    } finally {
      setRefreshing(false)
    }
  }

  function signOut() {
    const pending = hr.sync.pending.length
    const msg = pending
      ? `${pending} change${pending > 1 ? 's are' : ' is'} still waiting to sync. ${pending > 1 ? 'They stay' : 'It stays'} on this phone and ${pending > 1 ? 'upload' : 'uploads'} when you sign in again.\n\nSign out?`
      : `Sign out of ${ORG_APP_NAME}?`
    if (window.confirm(msg)) void logout()
  }

  if (!hasHr && !hasFm) return <NoAccess onSignOut={() => void logout()} />

  const home = tabs[0].key
  const showInstall = !installDismissed
  let screen: ReactNode
  if (sub === 'team') screen = <HrGate hr={hr}>{data => <TeamPanel hr={hr} data={data} />}</HrGate>
  else if (sub === 'hr-reports') screen = <HrGate hr={hr}>{data => <ReportsPanel data={data} />}</HrGate>
  else if (sub === 'hr-settings') screen = <HrGate hr={hr}>{data => <HrSettingsPanel data={data} onChanged={refreshHr} />}</HrGate>
  else if (sub === 'fm-settings') screen = <FinanceGate fm={fm}>{() => <FinanceSettingsPanel />}</FinanceGate>
  else if (sub === 'compliance') {
    screen = online
      ? <ComplianceCalendarPage />
      : <OfflineCard title="Due dates need a connection" body="The compliance calendar loads when you're back online." />
  } else if (tab === 'attendance') screen = <HrGate hr={hr}>{data => <AttendancePanel hr={hr} data={data} />}</HrGate>
  else if (tab === 'leave') screen = <HrGate hr={hr}>{data => <LeavePanel hr={hr} data={data} />}</HrGate>
  else if (tab === 'finance') screen = <FinanceScreen fm={fm} section={fmSection} onSection={setFmSection} />
  else if (tab === 'approvals') screen = <ApprovalsScreen hr={hr} hrLead={hrLead} fm={fm} fmApprover={fmApprover} />
  else screen = (
    <MoreScreen user={user} org={org} hasHr={hasHr} hasFm={hasFm} hrData={hrData} hrLead={hrLead} fmMe={fmMe}
      onOpen={openSub} onLogout={signOut} />
  )

  if (!sub && tab === home) {
    screen = (
      <div className="space-y-5">
        <Greeting name={user?.name || hrData?.me.name || ''} hrData={hrData} fmMe={fmMe} approvals={approvals}
          onLeave={() => goTab(hasHr ? 'leave' : 'more')}
          onSettle={() => { setFmSection('settlement'); goTab('finance') }}
          onApprovals={() => goTab('approvals')} />
        {showInstall && <InstallCard onDismiss={() => { setInstallDismissed(true); store(INSTALL_DISMISSED_KEY, '1') }} />}
        {screen}
      </div>
    )
  }

  return (
    <FmContext.Provider value={fm.ctx}>
      <div className="min-h-screen" style={{ background: FF.bg, fontFamily: FONT }}>
        <header className="sticky top-0 z-40" style={{ background: FF.tealDark, paddingTop: 'env(safe-area-inset-top)' }}>
          <div className="max-w-screen-sm mx-auto h-14 pl-3 pr-2 flex items-center gap-2">
            {sub ? (
              <button onClick={back} aria-label="Back" className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-white active:bg-white/10">
                <ChevronLeft className="w-6 h-6" />
              </button>
            ) : (
              <img src={org?.branding?.logo_url || '/logo.png'} alt="" className="w-9 h-9 rounded-lg object-contain bg-white p-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1 ml-0.5">
              <h1 className="text-[17px] font-semibold text-white truncate leading-tight">{sub ? SUB_TITLE[sub] : TITLE[tab]}</h1>
              <div className="text-[11.5px] truncate" style={{ color: FF.sidebarTextDim }}>{org?.branding?.org_name || ORG_APP_NAME}</div>
            </div>
            {!online && (
              <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-1 rounded-full shrink-0"
                style={{ background: 'rgba(255,255,255,0.12)', color: FF.amberBg }}>
                <CloudOff className="w-3.5 h-3.5" /> Offline
              </span>
            )}
            <button onClick={() => void refreshAll()} disabled={refreshing} aria-label="Refresh"
              className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0 active:bg-white/10 disabled:opacity-60">
              <RefreshCw className={`w-[18px] h-[18px] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            {fmMe && fm.ctx && (
              <NotificationsBell me={fmMe} onChanged={fm.ctx.changed} onOpen={n => {
                if (n.entity_type) { setFmSection(ENTITY_SECTION[n.entity_type]); goTab('finance') }
                fm.openNotification(n)
              }} />
            )}
          </div>
        </header>

        <main className="max-w-screen-sm mx-auto px-4 pt-4" style={{ paddingBottom: 'calc(88px + env(safe-area-inset-bottom))' }}>
          {screen}
        </main>

        <nav aria-label="App sections" className="fixed bottom-0 inset-x-0 z-30 bg-white border-t"
          style={{ borderColor: FF.border, paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="max-w-screen-sm mx-auto grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map(({ key, label, icon: Icon, badge }) => {
              const on = key === tab
              return (
                <button key={key} onClick={() => goTab(key)} aria-current={on ? 'page' : undefined}
                  aria-label={badge ? `${label}, ${badge} waiting` : label}
                  className="h-16 flex flex-col items-center justify-center gap-1">
                  <span className="relative h-7 px-4 rounded-full flex items-center transition-colors" style={{ background: on ? '#E1ECEE' : 'transparent' }}>
                    <Icon className="w-[22px] h-[22px]" style={{ color: on ? FF.tealDark : FF.textFaint }} />
                    {!!badge && (
                      <span className="absolute -top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-[18px] text-white text-center"
                        style={{ background: FF.red }}>
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-semibold" style={{ color: on ? FF.tealDark : FF.textMuted }}>{label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {fm.modals}
      </div>
    </FmContext.Provider>
  )
}

function NoAccess({ onSignOut }: { onSignOut: () => void }) {
  const { org } = useOrg()
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: FF.bg, fontFamily: FONT }}>
      <div className="max-w-sm w-full bg-white rounded-2xl p-6 text-center space-y-3" style={{ border: `1px solid ${FF.border}` }}>
        <img src={org?.branding?.logo_url || '/logo.png'} alt="" className="w-14 h-14 mx-auto object-contain" />
        <h1 className="text-lg font-semibold" style={{ color: FF.tealDark }}>No HR or Finance access</h1>
        <p className="text-sm leading-relaxed" style={{ color: FF.textMuted }}>
          Your account can't open HR Management or Finance Management. Ask your organisation's admin to turn them on for you
          in Settings → Tab access.
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <a href="/" className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold text-white" style={{ background: FF.purple }}>
            <ExternalLink className="w-4 h-4" /> Open full dashboard
          </a>
          <button onClick={onSignOut} className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold"
            style={{ color: FF.red, border: `1px solid ${FF.border}` }}>
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
