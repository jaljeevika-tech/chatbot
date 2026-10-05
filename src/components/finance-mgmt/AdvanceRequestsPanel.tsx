// Advance Request sub-tab: raise and track advances, and (managers / Finance) work the
// approval queue. Every action happens in the detail modal.

import { useMemo, useState } from 'react'
import { Plus, Search, HandCoins } from 'lucide-react'
import { FF } from '../../theme/colors'
import { EmptyState } from '../ui/EmptyState'
import { useFm } from './fmContext'
import { fmGet, fmtDate, inr, type Advance } from './fmApi'
import { Btn, Card, ErrorBox, LoadingRow, Segmented, StatusChip, inputCls, inputStyle, tdCls, thCls, useFmLoad } from './fmUi'

type Scope = 'mine' | 'approvals' | 'team' | 'all'

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All statuses' },
  { key: 'open', label: 'In progress' },
  { key: 'pending_manager', label: 'With manager' },
  { key: 'pending_finance', label: 'With Finance' },
  { key: 'approved', label: 'Approved · to pay' },
  { key: 'disbursed', label: 'Paid · to settle' },
  { key: 'settled', label: 'Settled' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'cancelled', label: 'Cancelled' },
]
const OPEN = new Set(['pending_manager', 'pending_finance', 'approved', 'disbursed'])

export function AdvanceList({ advances, showRequester, emptyTitle, emptyBody }: {
  advances: Advance[]; showRequester: boolean; emptyTitle: string; emptyBody?: string
}) {
  const { openAdvance } = useFm()
  if (!advances.length) return <EmptyState compact icon={<HandCoins className="w-6 h-6" />} title={emptyTitle} body={emptyBody} />
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead style={{ background: FF.bg, color: FF.textMuted }}>
            <tr>
              <th className={thCls}>Ref</th>
              {showRequester && <th className={thCls}>Requested by</th>}
              <th className={thCls}>Project · purpose</th>
              <th className={`${thCls} text-right`}>Amount</th>
              <th className={thCls}>Status</th>
              <th className={`${thCls} text-right`}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {advances.map(a => (
              <tr key={a.id} className="border-t cursor-pointer hover:bg-gray-50" style={{ borderColor: FF.borderFaint }} onClick={() => openAdvance(a.id)}>
                <td className={tdCls}>
                  <div className="font-semibold whitespace-nowrap" style={{ color: FF.purple }}>{a.ref_no}</div>
                  <div className="text-xs" style={{ color: FF.textFaint }}>{fmtDate(a.created_at)}</div>
                </td>
                {showRequester && <td className={tdCls} style={{ color: FF.tealDark }}>{a.requester_name}</td>}
                <td className={tdCls}>
                  <div className="font-medium" style={{ color: FF.tealDark }}>{a.project_name || a.project_key}</div>
                  <div className="text-xs line-clamp-1" style={{ color: FF.textMuted }}>{a.purpose}</div>
                </td>
                <td className={`${tdCls} text-right whitespace-nowrap font-semibold`} style={{ color: FF.tealDark }}>
                  {inr(a.disbursed_amount ?? a.amount_approved ?? a.amount_requested)}
                </td>
                <td className={tdCls}><StatusChip status={a.status} kind="advance" /></td>
                <td className={`${tdCls} text-right whitespace-nowrap`} style={{ color: a.balance < 0 ? FF.purple : a.balance > 0 ? FF.amber : FF.textFaint }}>
                  {a.status === 'disbursed' ? (a.balance < 0 ? `${inr(-a.balance)} owed` : inr(a.balance)) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden divide-y divide-[#E4F0F1]">
        {advances.map(a => (
          <li key={a.id}>
            <button className="w-full text-left px-4 py-3 space-y-1" onClick={() => openAdvance(a.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm" style={{ color: FF.purple }}>{a.ref_no}</span>
                <StatusChip status={a.status} kind="advance" />
              </div>
              <div className="text-sm font-medium" style={{ color: FF.tealDark }}>
                {inr(a.disbursed_amount ?? a.amount_approved ?? a.amount_requested)} · {a.project_name || a.project_key}
              </div>
              <div className="text-xs line-clamp-2" style={{ color: FF.textMuted }}>
                {showRequester ? `${a.requester_name} — ` : ''}{a.purpose}
              </div>
              {a.status === 'disbursed' && (
                <div className="text-xs font-semibold" style={{ color: a.balance < 0 ? FF.purple : FF.amber }}>
                  {a.balance < 0 ? `${inr(-a.balance)} owed to employee` : `${inr(a.balance)} still to account for`}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function AdvanceRequestsPanel() {
  const { me, version, newAdvance } = useFm()
  const role = me.me.role
  const isManagerish = role === 'manager' || me.me.is_admin
  const approvalsCount = me.counts.adv_manager + me.counts.adv_finance + me.counts.adv_disburse
  const showApprovals = isManagerish || me.me.is_finance || approvalsCount > 0
  const [scope, setScope] = useState<Scope>(approvalsCount > 0 ? 'approvals' : 'mine')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')

  const { data, error, loading } = useFmLoad(() => fmGet<{ advances: Advance[] }>(`/advances?scope=${scope}`), [scope, version])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.advances || []).filter(a =>
      (!status || (status === 'open' ? OPEN.has(a.status) : a.status === status)) &&
      (!needle || [a.ref_no, a.purpose, a.project_name, a.project_key, a.requester_name, a.budget_head]
        .some(v => v?.toLowerCase().includes(needle))))
  }, [data, q, status])

  const options: { key: Scope; label: string; count?: number }[] = [
    { key: 'mine', label: 'My requests' },
    ...(showApprovals ? [{ key: 'approvals' as Scope, label: 'Needs my action', count: approvalsCount }] : []),
    ...(isManagerish ? [{ key: 'team' as Scope, label: 'My team' }] : []),
    ...(me.me.is_finance || me.me.is_admin ? [{ key: 'all' as Scope, label: 'All advances' }] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={options} value={scope} onChange={setScope} />
        <Btn variant="primary" onClick={newAdvance}><Plus className="w-4 h-4" />New advance request</Btn>
      </div>

      <Card>
        <div className="p-3 flex flex-col sm:flex-row gap-2 border-b" style={{ borderColor: FF.borderFaint }}>
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: FF.textFaint }} />
            <input className={`${inputCls} pl-9`} style={inputStyle} placeholder="Search ref, purpose, project, person…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <select className={`${inputCls} sm:w-48`} style={inputStyle} value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
            {STATUS_FILTERS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : (
          <AdvanceList
            advances={rows}
            showRequester={scope !== 'mine'}
            emptyTitle={scope === 'approvals' ? 'Nothing waiting for you' : q || status ? 'No advances match' : 'No advance requests yet'}
            emptyBody={scope === 'mine' && !q && !status ? 'Need money in hand for field work? Raise an advance — your manager approves it, then Finance pays you.' : undefined}
          />
        )}
      </Card>
    </div>
  )
}
