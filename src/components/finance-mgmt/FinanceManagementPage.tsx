// Finance Management tab: Advance Request, Ledger Request, Compliance Calendar, Advance
// Settlement, plus Budget Management and Settings for Finance + admins. Backend:
// services/finance via /api/finance-mgmt/*. This page owns the detail/create modals and
// exposes openers through FmContext so any row, notification or modal can open a record.

import { useEffect, useRef, useState } from 'react'
import { Bell, HandCoins, BookOpen, CalendarClock, ReceiptIndianRupee, Settings, AlertTriangle, Loader2, Check, Pencil, Landmark } from 'lucide-react'
import { FF } from '../../theme/colors'
import { FmContext } from './fmContext'
import { canEditFinance, fmGet, fmPatch, fmPost, fmtDateTime, type FmMe, type FmNotification } from './fmApi'
import { Btn, ErrorBox, inputCls, inputStyle } from './fmUi'
import { AdvanceRequestsPanel } from './AdvanceRequestsPanel'
import { AdvanceSettlementPanel } from './AdvanceSettlementPanel'
import { LedgerRequestsPanel } from './LedgerRequestsPanel'
import { FinanceSettingsPanel } from './FinanceSettingsPanel'
import { BudgetPanel } from './BudgetPanel'
import { FinanceCompliancePanel } from './FinanceCompliancePanel'
import { useFmController } from './useFmController'

type SubTab = 'advances' | 'ledger' | 'compliance' | 'settlement' | 'budget' | 'settings'
const TAB_KEY = 'fm_tab'
const ENTITY_TAB: Record<string, SubTab> = { advance: 'advances', settlement: 'settlement', ledger: 'ledger' }

function readTab(): SubTab {
  try {
    const t = localStorage.getItem(TAB_KEY) as SubTab | null
    return t && ['advances', 'ledger', 'compliance', 'settlement', 'budget', 'settings'].includes(t) ? t : 'advances'
  } catch { return 'advances' }
}

// ── Notifications bell ───────────────────────────────────────────────────────
export function NotificationsBell({ me, onOpen, onChanged }: { me: FmMe; onOpen: (n: FmNotification) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<FmNotification[] | null>(null)
  const [editingEmail, setEditingEmail] = useState(false)
  const [email, setEmail] = useState(me.me.email || '')
  const [emailErr, setEmailErr] = useState<string | null>(null)
  const [savingEmail, setSavingEmail] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    fmGet<{ notifications: FmNotification[] }>('/notifications').then(d => setItems(d.notifications)).catch(() => setItems([]))
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => setEmail(me.me.email || ''), [me.me.email])

  async function markAll() {
    await fmPost('/notifications/read', {}).catch(() => {})
    setItems(xs => xs?.map(x => ({ ...x, read_at: x.read_at || new Date().toISOString() })) || null)
    onChanged()
  }

  async function click(n: FmNotification) {
    if (!n.read_at) fmPost('/notifications/read', { ids: [n.id] }).then(onChanged).catch(() => {})
    setOpen(false)
    onOpen(n)
  }

  async function saveEmail() {
    setSavingEmail(true); setEmailErr(null)
    try { await fmPatch('/me', { email: email.trim() || null }); setEditingEmail(false); onChanged() }
    catch (e) { setEmailErr((e as Error).message) }
    finally { setSavingEmail(false) }
  }

  const unread = me.counts.unread
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} aria-label={`Finance notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}
        className="relative w-10 h-10 rounded-xl flex items-center justify-center bg-white" style={{ border: `1px solid ${FF.border}`, color: FF.tealDark }}>
        <Bell className="w-[18px] h-[18px]" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-[18px] text-white text-center" style={{ background: FF.red }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-[min(92vw,380px)] bg-white rounded-2xl shadow-xl z-40 overflow-hidden" style={{ border: `1px solid ${FF.border}` }}>
          <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: FF.borderFaint }}>
            <span className="font-semibold text-sm" style={{ color: FF.tealDark }}>Finance notifications</span>
            {unread > 0 && <button className="text-xs font-semibold" style={{ color: FF.purple }} onClick={markAll}>Mark all read</button>}
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            {items === null ? (
              <div className="flex justify-center py-8" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : !items.length ? (
              <div className="text-center text-xs py-8" style={{ color: FF.textFaint }}>You're all caught up.</div>
            ) : items.map(n => (
              <button key={n.id} onClick={() => click(n)} className="w-full text-left px-4 py-3 border-b hover:bg-gray-50 flex gap-2.5" style={{ borderColor: FF.borderFaint }}>
                <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: n.read_at ? 'transparent' : FF.purple }} />
                <span className="min-w-0">
                  <span className="block text-sm" style={{ color: FF.tealDark, fontWeight: n.read_at ? 400 : 600 }}>{n.title}</span>
                  {n.body && <span className="block text-xs line-clamp-2 mt-0.5" style={{ color: FF.textMuted }}>{n.body}</span>}
                  <span className="block text-[11px] mt-0.5" style={{ color: FF.textFaint }}>{fmtDateTime(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="px-4 py-3 text-xs space-y-2" style={{ background: FF.bg }}>
            {editingEmail ? (
              <div className="flex gap-2">
                <input type="email" className={inputCls} style={inputStyle} value={email} autoFocus placeholder="you@org.org"
                  onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEmail() }} disabled={savingEmail} />
                <Btn small variant="primary" busy={savingEmail} onClick={saveEmail} aria-label="Save email"><Check className="w-3.5 h-3.5" /></Btn>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2" style={{ color: FF.textMuted }}>
                <span className="truncate">Email alerts to: <b style={{ color: me.me.email ? FF.tealDark : FF.amber }}>{me.me.email || 'not set'}</b></span>
                <button className="inline-flex items-center gap-1 font-semibold shrink-0" style={{ color: FF.purple }} onClick={() => setEditingEmail(true)}>
                  <Pencil className="w-3 h-3" />{me.me.email ? 'Change' : 'Add'}
                </button>
              </div>
            )}
            {emailErr && <div style={{ color: FF.red }}>{emailErr}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function FinanceManagementPage() {
  const { me, meError, offline, ctx, modals, newLedger, openNotification } = useFmController()
  const [tab, setTabState] = useState<SubTab>(readTab)

  const setTab = (t: SubTab) => {
    setTabState(t)
    try { localStorage.setItem(TAB_KEY, t) } catch { /* private mode */ }
  }

  if (meError || (offline && !me)) {
    return <div className="max-w-xl"><ErrorBox message={meError ?? 'Finance Management needs an internet connection.'} /></div>
  }
  if (!me || !ctx) {
    return <div className="flex items-center justify-center py-20" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }

  const c = me.counts
  const tabs: { key: SubTab; label: string; icon: typeof Bell; count: number }[] = [
    { key: 'advances',   label: 'Advance Request',     icon: HandCoins,          count: c.adv_manager + c.adv_finance + c.adv_disburse },
    { key: 'ledger',     label: 'Ledger Request',      icon: BookOpen,           count: c.ledger_finance },
    { key: 'compliance', label: 'Compliance Calendar', icon: CalendarClock,      count: 0 },
    { key: 'settlement', label: 'Advance Settlement',  icon: ReceiptIndianRupee, count: c.stl_manager + c.stl_finance + c.my_open_advances },
    ...(me.me.is_finance || me.me.is_admin ? [{ key: 'budget' as SubTab, label: 'Budget Management', icon: Landmark, count: 0 }] : []),
    ...(canEditFinance(me) ? [{ key: 'settings' as SubTab, label: 'Settings', icon: Settings, count: 0 }] : []),
  ]
  const active = tabs.some(t => t.key === tab) ? tab : 'advances'

  function openFromNotification(n: FmNotification) {
    if (n.entity_type) setTab(ENTITY_TAB[n.entity_type])
    openNotification(n)
  }

  return (
    <FmContext.Provider value={ctx}>
      <div className="space-y-5" style={{ fontFamily: "'IBM Plex Sans',sans-serif" }}>
        <div className="flex items-start gap-3">
          <nav className="flex-1 min-w-0 flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Finance Management sections">
            {tabs.map(({ key, label, icon: Icon, count }) => {
              const on = key === active
              return (
                <button key={key} onClick={() => setTab(key)} aria-current={on ? 'page' : undefined}
                  className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
                  style={{ background: on ? FF.tealDark : '#fff', color: on ? '#fff' : FF.tealDark, border: `1px solid ${on ? FF.tealDark : FF.border}` }}>
                  <Icon className="w-4 h-4" />
                  {label}
                  {count > 0 && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] leading-[18px] text-white text-center" style={{ background: FF.red }}>{count}</span>
                  )}
                </button>
              )
            })}
          </nav>
          <NotificationsBell me={me} onOpen={openFromNotification} onChanged={ctx.changed} />
        </div>

        {me.finance_team_size === 0 && (
          <div className="rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm" style={{ background: FF.amberBg, color: FF.amber }}>
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <b>No Finance team set up yet.</b>{' '}
              {me.me.is_admin
                ? 'Mark who handles Finance in Settings so approved advances can be paid and ledger requests answered.'
                : 'Requests will wait after manager approval until an admin adds the Finance team.'}
            </div>
            {me.me.is_admin && active !== 'settings' && <Btn small onClick={() => setTab('settings')}>Open Settings</Btn>}
          </div>
        )}

        {active === 'advances' && <AdvanceRequestsPanel />}
        {active === 'ledger' && <LedgerRequestsPanel onNew={newLedger} />}
        {active === 'compliance' && <FinanceCompliancePanel />}
        {active === 'settlement' && <AdvanceSettlementPanel />}
        {active === 'budget' && (me.me.is_finance || me.me.is_admin) && <BudgetPanel />}
        {active === 'settings' && canEditFinance(me) && <FinanceSettingsPanel />}
      </div>

      {modals}
    </FmContext.Provider>
  )
}
