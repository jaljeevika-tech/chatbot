// src/components/finance-mgmt/AdvanceSettlementPanel.tsx
// Advance Settlement sub-tab: employees submit bills against paid advances
// (partial settlements allowed); managers and Finance review them; Finance
// tracks open balances (refund / reimburse) and spend per budget line.
// The budget-line report is read-only — it never touches the Financial Tracker.

import { useMemo, useState } from 'react'
import { Plus, ReceiptIndianRupee, Wallet } from 'lucide-react'
import { FF } from '../../theme/colors'
import { EmptyState } from '../ui/EmptyState'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import { fmGet, fmtDate, inr, type Advance, type Settlement } from './fmApi'
import { Btn, Card, ErrorBox, LoadingRow, Segmented, StatusChip, inputCls, inputStyle, tdCls, thCls, useFmLoad } from './fmUi'
import { AdvanceList } from './AdvanceRequestsPanel'

type Scope = 'tosettle' | 'mine' | 'approvals' | 'team' | 'all' | 'balances' | 'report'

function SettlementList({ settlements, showSubmitter, emptyTitle }: { settlements: Settlement[]; showSubmitter: boolean; emptyTitle: string }) {
  const { openSettlement } = useFm()
  if (!settlements.length) return <EmptyState compact icon={<ReceiptIndianRupee className="w-6 h-6" />} title={emptyTitle} />
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead style={{ background: FF.bg, color: FF.textMuted }}>
            <tr>
              <th className={thCls}>Ref</th>
              {showSubmitter && <th className={thCls}>Submitted by</th>}
              <th className={thCls}>Advance</th>
              <th className={`${thCls} text-right`}>Claimed</th>
              <th className={`${thCls} text-right`}>Approved</th>
              <th className={thCls}>Status</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map(s => (
              <tr key={s.id} className="border-t cursor-pointer hover:bg-gray-50" style={{ borderColor: FF.borderFaint }} onClick={() => openSettlement(s.id)}>
                <td className={tdCls}>
                  <div className="font-semibold whitespace-nowrap" style={{ color: FF.purple }}>{s.ref_no}</div>
                  <div className="text-xs" style={{ color: FF.textFaint }}>{fmtDate(s.created_at)}</div>
                </td>
                {showSubmitter && <td className={tdCls} style={{ color: FF.tealDark }}>{s.submitted_by_name}</td>}
                <td className={tdCls}>
                  <div className="font-medium" style={{ color: FF.tealDark }}>{s.advance_ref} · {s.project_name || s.project_key}</div>
                  <div className="text-xs line-clamp-1" style={{ color: FF.textMuted }}>{s.advance_purpose}</div>
                </td>
                <td className={`${tdCls} text-right whitespace-nowrap font-semibold`} style={{ color: FF.tealDark }}>{inr(s.amount_claimed)}</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{s.amount_approved != null ? inr(s.amount_approved) : '—'}</td>
                <td className={tdCls}><StatusChip status={s.status} kind="settlement" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden divide-y divide-[#E4F0F1]">
        {settlements.map(s => (
          <li key={s.id}>
            <button className="w-full text-left px-4 py-3 space-y-1" onClick={() => openSettlement(s.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm" style={{ color: FF.purple }}>{s.ref_no}</span>
                <StatusChip status={s.status} kind="settlement" />
              </div>
              <div className="text-sm font-medium" style={{ color: FF.tealDark }}>
                {inr(s.amount_claimed)} against {s.advance_ref}
              </div>
              <div className="text-xs" style={{ color: FF.textMuted }}>{showSubmitter ? `${s.submitted_by_name} · ` : ''}{fmtDate(s.created_at)}</div>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function ToSettle() {
  const { version, newSettlement, openAdvance } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ advances: Advance[] }>('/advances?scope=mine'), [version])
  const open = (data?.advances || []).filter(a => a.status === 'disbursed')
  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <LoadingRow />
  if (!open.length) {
    return (
      <Card><EmptyState compact icon={<Wallet className="w-6 h-6" />} title="No advances waiting for bills"
        body="When Finance pays you an advance, it appears here so you can submit the bills after your activity." /></Card>
    )
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {open.map(a => {
        const pct = a.disbursed_amount ? Math.min(100, Math.round(((a.spent + a.pending_claims) / a.disbursed_amount) * 100)) : 0
        return (
          <Card key={a.id} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <button className="text-left min-w-0" onClick={() => openAdvance(a.id)}>
                <div className="font-semibold text-sm" style={{ color: FF.purple }}>{a.ref_no}</div>
                <div className="text-sm font-medium truncate" style={{ color: FF.tealDark }}>{a.project_name || a.project_key}</div>
                <div className="text-xs line-clamp-2" style={{ color: FF.textMuted }}>{a.purpose}</div>
              </button>
              <div className="text-right shrink-0">
                <div className="text-[10.5px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>Paid {fmtDate(a.disbursed_on)}</div>
                <div className="text-base font-bold" style={{ color: FF.tealDark }}>{inr(a.disbursed_amount)}</div>
              </div>
            </div>
            <div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: FF.borderFaint }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: FF.purple }} />
              </div>
              <div className="flex justify-between text-xs mt-1.5" style={{ color: FF.textMuted }}>
                <span>Bills approved {inr(a.spent)}{a.pending_claims ? ` · pending ${inr(a.pending_claims)}` : ''}</span>
                <span className="font-semibold" style={{ color: a.balance < 0 ? FF.purple : FF.amber }}>
                  {a.balance < 0 ? `${inr(-a.balance)} owed to you` : `${inr(a.balance)} left`}
                </span>
              </div>
            </div>
            <Btn variant="primary" small onClick={() => newSettlement(a.id)}><ReceiptIndianRupee className="w-3.5 h-3.5" />Submit bills</Btn>
          </Card>
        )
      })}
    </div>
  )
}

interface ReportRow {
  project_key: string; project_name: string | null; budget_section: string | null; budget_head: string | null
  advances: number; disbursed: number; spent: number; refunds: number; reimbursements: number; outstanding: number
}

function BudgetLineReport() {
  const { version } = useFm()
  const { projects } = useProjectContext()
  const [project, setProject] = useState('')
  const { data, error, loading } = useFmLoad(
    () => fmGet<{ rows: ReportRow[] }>(`/reports/budget-lines${project ? `?project=${encodeURIComponent(project)}` : ''}`),
    [project, version])
  const rows = data?.rows || []
  const total = rows.reduce((t, r) => ({ disbursed: t.disbursed + r.disbursed, spent: t.spent + r.spent, outstanding: t.outstanding + r.outstanding }),
    { disbursed: 0, spent: 0, outstanding: 0 })
  return (
    <Card>
      <div className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b" style={{ borderColor: FF.borderFaint }}>
        <div className="text-xs" style={{ color: FF.textMuted }}>Paid advances and approved bills per budget line. Read-only — the Financial Tracker is not changed.</div>
        <select className={`${inputCls} sm:w-64`} style={inputStyle} value={project} onChange={e => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
        </select>
      </div>
      {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : !rows.length ? (
        <EmptyState compact title="No paid advances yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead style={{ background: FF.bg, color: FF.textMuted }}>
              <tr>
                <th className={thCls}>Project</th><th className={thCls}>Budget line</th>
                <th className={`${thCls} text-right`}>Advances</th><th className={`${thCls} text-right`}>Paid out</th>
                <th className={`${thCls} text-right`}>Bills approved</th><th className={`${thCls} text-right`}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t" style={{ borderColor: FF.borderFaint }}>
                  <td className={tdCls} style={{ color: FF.tealDark }}>{r.project_name || r.project_key}</td>
                  <td className={tdCls} style={{ color: r.budget_head ? FF.tealDark : FF.textFaint }}>
                    {r.budget_head ? <>{r.budget_section && <span className="text-xs block" style={{ color: FF.textFaint }}>{r.budget_section}</span>}{r.budget_head}</> : 'Not linked'}
                  </td>
                  <td className={`${tdCls} text-right`}>{r.advances}</td>
                  <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(r.disbursed)}</td>
                  <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(r.spent)}</td>
                  <td className={`${tdCls} text-right whitespace-nowrap font-semibold`} style={{ color: Math.abs(r.outstanding) < 0.005 ? FF.textFaint : FF.amber }}>{inr(r.outstanding)}</td>
                </tr>
              ))}
              <tr className="border-t-2 font-bold" style={{ borderColor: FF.border, color: FF.tealDark }}>
                <td className={tdCls} colSpan={3}>Total</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(total.disbursed)}</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(total.spent)}</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(total.outstanding)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function SettlementsTable({ scope }: { scope: 'mine' | 'approvals' | 'team' | 'all' }) {
  const { version } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ settlements: Settlement[] }>(`/settlements?scope=${scope}`), [scope, version])
  return (
    <Card>
      {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : (
        <SettlementList settlements={data?.settlements || []} showSubmitter={scope !== 'mine'}
          emptyTitle={scope === 'approvals' ? 'No settlements waiting for you' : 'No settlements yet'} />
      )}
    </Card>
  )
}

function OpenBalances() {
  const { version } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ advances: Advance[] }>('/advances?scope=all'), [version])
  const rows = useMemo(() => (data?.advances || []).filter(a => a.status === 'disbursed')
    .sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance)), [data])
  const held = rows.filter(a => a.balance > 0).reduce((t, a) => t + a.balance, 0)
  const owed = rows.filter(a => a.balance < 0).reduce((t, a) => t - a.balance, 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          ['Open advances', String(rows.length), FF.tealDark],
          ['Held by staff (to account for)', inr(held), FF.amber],
          ['Owed to staff (to reimburse)', inr(owed), FF.purple],
        ].map(([k, v, c]) => (
          <Card key={k} className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{k}</div>
            <div className="text-lg font-bold" style={{ color: c }}>{v}</div>
          </Card>
        ))}
      </div>
      <Card>
        {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : (
          <AdvanceList advances={rows} showRequester emptyTitle="No open advances" />
        )}
      </Card>
    </div>
  )
}

export function AdvanceSettlementPanel() {
  const { me, newSettlement } = useFm()
  const isManagerish = me.me.role === 'manager' || me.me.is_admin
  const isFinanceView = me.me.is_finance || me.me.is_admin
  const approvalsCount = me.counts.stl_manager + me.counts.stl_finance
  const showApprovals = isManagerish || me.me.is_finance || approvalsCount > 0
  const [scope, setScope] = useState<Scope>(approvalsCount > 0 ? 'approvals' : 'tosettle')

  const options: { key: Scope; label: string; count?: number }[] = [
    { key: 'tosettle', label: 'To settle', count: me.counts.my_open_advances },
    { key: 'mine', label: 'My settlements' },
    ...(showApprovals ? [{ key: 'approvals' as Scope, label: 'Needs my action', count: approvalsCount }] : []),
    ...(isManagerish ? [{ key: 'team' as Scope, label: 'My team' }] : []),
    ...(isFinanceView ? [
      { key: 'all' as Scope, label: 'All settlements' },
      { key: 'balances' as Scope, label: 'Open balances' },
      { key: 'report' as Scope, label: 'By budget line' },
    ] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={options} value={scope} onChange={setScope} />
        <Btn variant="primary" onClick={() => newSettlement()}><Plus className="w-4 h-4" />Submit bills</Btn>
      </div>
      {scope === 'tosettle' ? <ToSettle />
        : scope === 'balances' ? <OpenBalances />
        : scope === 'report' ? <BudgetLineReport />
        : <SettlementsTable scope={scope} />}
    </div>
  )
}
