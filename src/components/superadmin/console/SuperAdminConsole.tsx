// FieldFlow platform console — the super admin's home. Sidebar shell + hash
// routing (route.ts); each page lives in its own file in this folder.

import { Component, useEffect, useState, type ReactNode } from 'react'
import {
  LayoutDashboard, Building2, CreditCard, Receipt, Sparkles, ScrollText,
  LogOut, Menu, Sun, Moon, Monitor, ShieldCheck,
} from 'lucide-react'
import { useAuthContext } from '../../../context/AuthContext'
import { useRoute, routeHref, type Page } from './route'
import { OverviewPage } from './OverviewPage'
import { OrgsPage } from './OrgsPage'
import { OrgDetailPage } from './OrgDetailPage'
import { PlansPage } from './PlansPage'
import { AuditPage } from './AuditPage'
import { PromptManager } from '../PromptManager'
import { BillingDashboard } from '../BillingDashboard'

type ThemePref = 'light' | 'dark' | 'system'
const THEME_KEY = 'ff-sa-theme'

function useThemePref() {
  const [pref, setPref] = useState<ThemePref>(() => {
    try { return (localStorage.getItem(THEME_KEY) as ThemePref) || 'system' } catch { return 'system' }
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const update = (p: ThemePref) => {
    setPref(p)
    try { localStorage.setItem(THEME_KEY, p) } catch { /* private mode — preference just won't persist */ }
  }
  const resolved: 'light' | 'dark' = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
  return { pref, resolved, update }
}

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'overview', label: 'Overview',        icon: <LayoutDashboard className="w-4 h-4" /> },
  { page: 'orgs',     label: 'Organisations',   icon: <Building2 className="w-4 h-4" /> },
  { page: 'plans',    label: 'Plans',           icon: <CreditCard className="w-4 h-4" /> },
  { page: 'billing',  label: 'Usage & costs',   icon: <Receipt className="w-4 h-4" /> },
  { page: 'prompts',  label: 'AI prompts',      icon: <Sparkles className="w-4 h-4" /> },
  { page: 'audit',    label: 'Audit log',       icon: <ScrollText className="w-4 h-4" /> },
]

export function SuperAdminConsole() {
  const { user, logout } = useAuthContext()
  const route = useRoute()
  const theme = useThemePref()
  const [navOpen, setNavOpen] = useState(false)

  // Close the mobile drawer whenever the page changes.
  useEffect(() => { setNavOpen(false) }, [route.page, route.orgId])

  const sidebar = (
    <nav className="flex flex-col h-full bg-sa-sidebar text-sa-sidebar-text" aria-label="Console">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center"><ShieldCheck className="w-4.5 h-4.5" /></div>
        <div className="leading-tight">
          <div className="font-semibold text-[15px]">FieldFlow</div>
          <div className="text-[11px] text-sa-sidebar-muted uppercase tracking-wider">Platform console</div>
        </div>
      </div>
      <div className="flex-1 px-3 py-2 flex flex-col gap-0.5">
        {NAV.map(n => {
          const active = route.page === n.page
          return (
            <a key={n.page} href={routeHref({ page: n.page })} aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-sa-sidebar-active text-white font-semibold' : 'text-sa-sidebar-muted hover:text-white hover:bg-white/5'}`}>
              {n.icon}{n.label}
            </a>
          )
        })}
      </div>
      <div className="px-3 pb-4 pt-3 border-t border-white/10 flex flex-col gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-white/5" role="radiogroup" aria-label="Theme">
          {([['light', <Sun key="s" className="w-3.5 h-3.5" />], ['dark', <Moon key="m" className="w-3.5 h-3.5" />], ['system', <Monitor key="c" className="w-3.5 h-3.5" />]] as const).map(([p, icon]) => (
            <button key={p} role="radio" aria-checked={theme.pref === p} aria-label={`${p} theme`} title={`${p[0].toUpperCase()}${p.slice(1)} theme`}
              onClick={() => theme.update(p)}
              className={`flex-1 flex items-center justify-center py-1.5 rounded-md cursor-pointer transition-colors ${theme.pref === p ? 'bg-white/15 text-white' : 'text-sa-sidebar-muted hover:text-white'}`}>
              {icon}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{user?.name || 'Super admin'}</div>
            <div className="text-[11px] text-sa-sidebar-muted truncate">{user?.phone}</div>
          </div>
          <button onClick={() => { void logout() }} title="Sign out" aria-label="Sign out"
            className="p-2 rounded-lg text-sa-sidebar-muted hover:text-white hover:bg-white/10 cursor-pointer">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </nav>
  )

  let content: ReactNode
  switch (route.page) {
    case 'orgs':    content = route.orgId ? <OrgDetailPage key={route.orgId} orgId={route.orgId} tab={route.orgTab ?? 'overview'} formKey={route.formKey} /> : <OrgsPage />; break
    case 'plans':   content = <PlansPage />; break
    case 'billing': content = <LightIsland title="Usage & costs" subtitle="Estimated AI cost per organisation, from usage events."><BillingDashboard /></LightIsland>; break
    case 'prompts': content = <LightIsland title="AI prompts" subtitle="Prompt library used by the AI features."><PromptManager /></LightIsland>; break
    case 'audit':   content = <AuditPage />; break
    default:        content = <OverviewPage />
  }

  return (
    <div className="sa-console flex h-screen overflow-hidden font-sans" data-theme={theme.resolved}>
      <aside className="hidden lg:block w-64 shrink-0">{sidebar}</aside>

      {navOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/50" onClick={() => setNavOpen(false)} aria-hidden="true" />
          <aside className="relative w-72 max-w-[85vw] h-full">{sidebar}</aside>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-sa-sidebar text-sa-sidebar-text">
          <button onClick={() => setNavOpen(true)} aria-label="Open navigation" className="p-1.5 -ml-1.5 rounded-lg hover:bg-white/10 cursor-pointer"><Menu className="w-5 h-5" /></button>
          <span className="font-semibold">FieldFlow console</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
            <PageErrorBoundary key={`${route.page}/${route.orgId ?? ''}`}>{content}</PageErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}

/** One page failing to render must not blank the whole console (and its nav). */
class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('[superadmin console]', error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="rounded-xl border border-sa-border bg-sa-surface p-8 text-center">
        <div className="text-base font-semibold text-sa-text">This page couldn't be displayed</div>
        <p className="text-sm text-sa-muted mt-1">{this.state.error.message}</p>
        <button onClick={() => this.setState({ error: null })} className="mt-4 rounded-lg border border-sa-border px-3.5 py-2 text-sm font-semibold text-sa-text hover:bg-sa-subtle cursor-pointer">Try again</button>
      </div>
    )
  }
}

/** PromptManager and BillingDashboard are styled for a light background; in
 *  dark mode they sit on a light card rather than being restyled twice. */
function LightIsland({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold text-sa-text tracking-tight">{title}</h1>
        <p className="text-sm text-sa-muted mt-1">{subtitle}</p>
      </div>
      <div className="rounded-xl border border-sa-border bg-white text-gray-900 p-1 sm:p-2 overflow-x-auto" style={{ colorScheme: 'light' }}>{children}</div>
    </>
  )
}
