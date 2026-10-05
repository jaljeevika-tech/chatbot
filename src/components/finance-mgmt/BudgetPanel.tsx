// Budget Management sub-tab (Finance + admins): per grant, approved → received → paid out →
// utilised → in hand; per bank account, computed vs statement balance. Every figure is
// computed in services/finance/src/budget.js.

import { useMemo, useState, type ReactNode } from 'react'
import { Plus, Upload, Landmark, ArrowRightLeft, Pencil, Trash2, AlertTriangle, Wallet, Search } from 'lucide-react'
import { FF } from '../../theme/colors'
import { EmptyState } from '../ui/EmptyState'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import {
  ACCOUNT_KIND_LABEL, canEditFinance, fmDelete, fmGet, fmPatch, fmtDate, inr,
  type BankAccount, type BudgetOverview, type Expense, type Grant, type Receipt, type Transfer, type Advance,
} from './fmApi'
import { Btn, Card, ErrorBox, FmModal, LoadingRow, SectionTitle, Segmented, StatusChip, inputCls, inputStyle, tdCls, thCls, useFmLoad } from './fmUi'
import {
  AccountFormModal, ExpenseFormModal, ExpenseUploadModal, GrantFormModal, ReceiptFormModal, StatementFormModal, TransferFormModal,
  type StatementRef,
} from './BudgetForms'

type View = 'grants' | 'receipts' | 'expenses' | 'bank'
const signed = (n: number) => (n < 0 ? `−${inr(-n)}` : inr(n))
const TRACK = '#DCEAEC'   // lighter step of the teal ramp (meter track)
const FILL = FF.tealDark

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <Card className="px-4 py-3 min-w-0">
      <div className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{label}</div>
      <div className="text-xl font-bold truncate" style={{ color: tone === 'bad' ? FF.red : FF.tealDark }}>{value}</div>
      {sub && <div className="text-[11.5px] mt-0.5" style={{ color: tone === 'warn' ? FF.amber : FF.textMuted }}>{sub}</div>}
    </Card>
  )
}

// ── Meter: one measure against the approved budget ───────────────────────────
function Meter({ label, value, of, hint }: { label: string; value: number; of: number; hint?: string }) {
  const pct = of > 0 ? (value / of) * 100 : 0
  const over = pct > 100.05
  return (
    <div title={`${label}: ${inr(value)} of ${inr(of)} approved (${pct.toFixed(1)}%)${hint ? ` — ${hint}` : ''}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span style={{ color: FF.textMuted }}>{label}</span>
        <span className="font-semibold whitespace-nowrap" style={{ color: over ? FF.red : FF.tealDark }}>
          {inr(value)} <span className="font-normal" style={{ color: FF.textFaint }}>· {pct.toFixed(0)}%{over ? ' — over budget' : ''}</span>
        </span>
      </div>
      <div className="h-2 mt-1 rounded-full overflow-hidden" style={{ background: TRACK }} role="meter" aria-valuemin={0} aria-valuemax={of} aria-valuenow={value} aria-label={label}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: over ? FF.red : FILL }} />
      </div>
    </div>
  )
}

function Kv({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{label}</div>
      <div className="text-sm font-semibold truncate" style={{ color: tone || FF.tealDark }}>{value}</div>
    </div>
  )
}

function GrantCard({ g, onOpen }: { g: Grant; onOpen: () => void }) {
  return (
    <Card className="p-4 space-y-3">
      <button className="w-full text-left" onClick={onOpen}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-[15px] truncate" style={{ color: FF.tealDark }}>{g.project_name || g.project_key}</div>
            <div className="text-xs" style={{ color: FF.textMuted }}>
              {fmtDate(g.period_from)} – {fmtDate(g.period_to)}{g.donor ? ` · ${g.donor}` : ''}{g.grant_ref ? ` · ${g.grant_ref}` : ''}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10.5px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>Approved</div>
            <div className="text-base font-bold" style={{ color: FF.tealDark }}>{inr(g.approved)}</div>
          </div>
        </div>
      </button>
      <div className="space-y-2.5">
        <Meter label="Received from donor" value={g.received} of={g.approved} />
        <Meter label="Paid out" value={g.paid_out} of={g.approved} hint={`staff ${inr(g.staff_paid + g.reimbursed - g.refunded)} + other ${inr(g.other_expenses)}`} />
        <Meter label="Bills submitted by staff" value={g.bills_submitted} of={g.approved} />
        <Meter label="Utilised (approved bills + expenses)" value={g.utilised} of={g.approved} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t" style={{ borderColor: FF.borderFaint }}>
        <Kv label="Funds in hand" value={signed(g.funds_in_hand)} tone={g.funds_in_hand < 0 ? FF.red : undefined} />
        <Kv label="Held by staff" value={inr(g.held_by_staff)} tone={g.held_by_staff > 0 ? FF.amber : undefined} />
        <Kv label="Owed to staff" value={inr(g.owed_to_staff)} tone={g.owed_to_staff > 0 ? FF.purple : undefined} />
        <Kv label="Pending from donor" value={inr(g.pending_from_donor)} />
      </div>
    </Card>
  )
}

interface GrantDetail { grant: Grant; receipts: Receipt[]; expenses: Expense[]; advances: Advance[]; expenses_by_category: { category: string; n: number; amount: number }[] }

function GrantDetailModal({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (g: Grant) => void }) {
  const { me, version, openAdvance, changed } = useFm()
  const { data, error, loading } = useFmLoad(() => id ? fmGet<GrantDetail>(`/budget/budgets/${id}`) : Promise.resolve(null), [id, version])
  const [busy, setBusy] = useState(false)
  const [actErr, setActErr] = useState<string | null>(null)
  const g = data?.grant
  async function del() {
    if (!g || !confirm('Delete this approved budget? Its donor receipts must be deleted first.')) return
    setBusy(true); setActErr(null)
    try { await fmDelete(`/budget/budgets/${g.id}`); changed(); onClose() } catch (e) { setActErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <FmModal open={!!id} onClose={onClose} busy={busy} size="xl"
      title={g ? `${g.project_name || g.project_key} — budget` : 'Budget'}
      subtitle={g && `${fmtDate(g.period_from)} – ${fmtDate(g.period_to)}${g.donor ? ` · ${g.donor}` : ''}${g.grant_ref ? ` · ${g.grant_ref}` : ''}`}
      footer={g && <>
        {canEditFinance(me) && <Btn variant="danger" busy={busy} onClick={del}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>}
        {canEditFinance(me) && <Btn onClick={() => onEdit(g)}><Pencil className="w-3.5 h-3.5" />Edit</Btn>}
        <Btn onClick={onClose}>Close</Btn>
      </>}>
      {error ? <ErrorBox message={error} /> : loading || !data || !g ? <LoadingRow /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kv label="Approved" value={inr(g.approved)} />
            <Kv label="Received" value={inr(g.received)} />
            <Kv label="Paid out" value={inr(g.paid_out)} />
            <Kv label="Utilised" value={`${inr(g.utilised)} (${g.utilisation_pct}%)`} />
            <Kv label="Funds in hand" value={signed(g.funds_in_hand)} tone={g.funds_in_hand < 0 ? FF.red : undefined} />
            <Kv label="Budget left" value={signed(g.budget_left)} tone={g.budget_left < 0 ? FF.red : undefined} />
            <Kv label="Held by staff" value={inr(g.held_by_staff)} />
            <Kv label="Owed to staff" value={inr(g.owed_to_staff)} />
          </div>
          <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: FF.bg, color: FF.textMuted }}>
            <div><b style={{ color: FF.tealDark }}>Paid out</b> = staff advances paid {inr(g.staff_paid)} + reimbursed {inr(g.reimbursed)} − refunded {inr(g.refunded)} + other expenses {inr(g.other_expenses)}</div>
            <div><b style={{ color: FF.tealDark }}>Utilised</b> = staff bills approved {inr(g.bills_approved)} + other expenses {inr(g.other_expenses)} · bills submitted (incl. pending) {inr(g.bills_submitted)}</div>
          </div>
          <ErrorBox message={actErr} />

          <SectionTitle>Donor receipts ({data.receipts.length})</SectionTitle>
          {data.receipts.length ? (
            <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
              <table className="w-full min-w-[560px]"><thead style={{ background: FF.bg, color: FF.textMuted }}>
                <tr><th className={thCls}>Date</th><th className={thCls}>Tranche</th><th className={thCls}>Account</th><th className={thCls}>Reference</th><th className={`${thCls} text-right`}>Amount</th></tr>
              </thead><tbody style={{ color: FF.tealDark }}>
                {data.receipts.map(r => (
                  <tr key={r.id} className="border-t" style={{ borderColor: FF.borderFaint }}>
                    <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(r.received_on)}</td><td className={tdCls}>{r.tranche || '—'}</td>
                    <td className={tdCls}>{r.account_name}</td><td className={tdCls}>{r.reference || '—'}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap font-semibold`}>{inr(r.amount)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ) : <div className="text-xs" style={{ color: FF.textFaint }}>Nothing received yet.</div>}

          <SectionTitle>Staff advances in this period ({data.advances.length})</SectionTitle>
          {data.advances.length ? (
            <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
              <table className="w-full min-w-[620px]"><thead style={{ background: FF.bg, color: FF.textMuted }}>
                <tr><th className={thCls}>Ref</th><th className={thCls}>Employee</th><th className={`${thCls} text-right`}>Paid</th><th className={`${thCls} text-right`}>Bills approved</th><th className={`${thCls} text-right`}>Balance</th><th className={thCls}>Status</th></tr>
              </thead><tbody style={{ color: FF.tealDark }}>
                {data.advances.map(a => (
                  <tr key={a.id} className="border-t cursor-pointer hover:bg-gray-50" style={{ borderColor: FF.borderFaint }} onClick={() => openAdvance(a.id)}>
                    <td className={tdCls} style={{ color: FF.purple, fontWeight: 600 }}>{a.ref_no}</td><td className={tdCls}>{a.requester_name}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(a.disbursed_amount)}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(a.spent)}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap`} style={{ color: a.balance > 0 ? FF.amber : a.balance < 0 ? FF.purple : FF.textFaint }}>
                      {a.balance < 0 ? `${inr(-a.balance)} owed` : inr(a.balance)}
                    </td>
                    <td className={tdCls}><StatusChip status={a.status} kind="advance" /></td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ) : <div className="text-xs" style={{ color: FF.textFaint }}>No staff advances paid in this period.</div>}

          <SectionTitle>Other expenses ({data.expenses.length})</SectionTitle>
          {data.expenses_by_category.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.expenses_by_category.map(c => (
                <span key={c.category} className="px-2.5 py-1 rounded-lg text-xs" style={{ background: FF.bg, color: FF.tealDark }}>
                  {c.category}: <b>{inr(c.amount)}</b> <span style={{ color: FF.textFaint }}>({c.n})</span>
                </span>
              ))}
            </div>
          )}
          {data.expenses.length ? <ExpenseTable expenses={data.expenses.slice(0, 200)} /> : <div className="text-xs" style={{ color: FF.textFaint }}>No other expenses recorded in this period.</div>}
        </>
      )}
    </FmModal>
  )
}

function ExpenseTable({ expenses, onDelete, onUndoBatch, onEdit, showProject }: {
  expenses: Expense[]; onDelete?: (e: Expense) => void; onUndoBatch?: (batch: string) => void; onEdit?: (e: Expense) => void; showProject?: boolean
}) {
  return (
    <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
      <table className="w-full min-w-[760px]">
        <thead style={{ background: FF.bg, color: FF.textMuted }}>
          <tr>
            <th className={thCls}>Date</th>{showProject && <th className={thCls}>Project</th>}<th className={thCls}>Category</th>
            <th className={thCls}>Payee / description</th><th className={thCls}>Voucher</th><th className={thCls}>Account</th>
            <th className={`${thCls} text-right`}>Amount</th>{onDelete && <th className={thCls} />}
          </tr>
        </thead>
        <tbody style={{ color: FF.tealDark }}>
          {expenses.map(e => (
            <tr key={e.id} className="border-t" style={{ borderColor: FF.borderFaint }}>
              <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(e.paid_on)}</td>
              {showProject && <td className={tdCls}>{e.project_name || e.project_key}</td>}
              <td className={tdCls}>{e.category}</td>
              <td className={tdCls}>
                <div>{e.payee || '—'}</div>
                {e.description && <div className="text-xs line-clamp-1" style={{ color: FF.textMuted }}>{e.description}</div>}
              </td>
              <td className={tdCls}>{e.voucher_ref || '—'}</td>
              <td className={tdCls}>{e.account_name || <span className="text-xs" style={{ color: FF.amber }}>not tagged</span>}</td>
              <td className={`${tdCls} text-right whitespace-nowrap font-semibold`}>{inr(e.amount)}</td>
              {onDelete && (
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  {e.upload_batch && onUndoBatch && (
                    <button className="text-xs font-semibold mr-3" style={{ color: FF.purple }} onClick={() => onUndoBatch(e.upload_batch!)} title="Delete every row from this upload">Undo upload</button>
                  )}
                  {onEdit && <button aria-label="Edit expense" className="mr-3" onClick={() => onEdit(e)} style={{ color: FF.tealDark }}><Pencil className="w-3.5 h-3.5" /></button>}
                  <button aria-label="Delete expense" onClick={() => onDelete(e)} style={{ color: FF.red }}><Trash2 className="w-3.5 h-3.5" /></button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReceiptsView({ grants, onAdd, onEdit }: { grants: Grant[]; onAdd: () => void; onEdit: (r: Receipt) => void }) {
  const { me, version, changed } = useFm()
  const { data, error, loading } = useFmLoad(() => fmGet<{ receipts: Receipt[] }>('/budget/receipts'), [version])
  const [err, setErr] = useState<string | null>(null)
  const rows = data?.receipts || []
  async function del(r: Receipt) {
    if (!confirm(`Delete the receipt of ${inr(r.amount)} on ${fmtDate(r.received_on)}?`)) return
    try { await fmDelete(`/budget/receipts/${r.id}`); changed() } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="space-y-3">
      {canEditFinance(me) && <div className="flex justify-end"><Btn variant="primary" onClick={onAdd} disabled={!grants.length}><Plus className="w-4 h-4" />Record receipt</Btn></div>}
      <ErrorBox message={err} />
      <Card>
        {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : !rows.length ? (
          <EmptyState compact icon={<Landmark className="w-6 h-6" />} title="No donor receipts yet" body={grants.length ? 'Record each tranche received from a donor against its grant.' : 'Add an approved budget first.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead style={{ background: FF.bg, color: FF.textMuted }}>
                <tr><th className={thCls}>Date</th><th className={thCls}>Project · donor</th><th className={thCls}>Tranche</th><th className={thCls}>Account</th><th className={thCls}>Reference</th><th className={`${thCls} text-right`}>Amount</th>{canEditFinance(me) && <th className={thCls} />}</tr>
              </thead>
              <tbody style={{ color: FF.tealDark }}>
                {rows.map(r => (
                  <tr key={r.id} className="border-t" style={{ borderColor: FF.borderFaint }}>
                    <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(r.received_on)}</td>
                    <td className={tdCls}>{r.project_name || r.project_key}{r.donor && <div className="text-xs" style={{ color: FF.textMuted }}>{r.donor}</div>}</td>
                    <td className={tdCls}>{r.tranche || '—'}</td><td className={tdCls}>{r.account_name}</td><td className={tdCls}>{r.reference || '—'}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap font-semibold`}>{inr(r.amount)}</td>
                    {canEditFinance(me) && <td className={`${tdCls} text-right whitespace-nowrap`}>
                      <button aria-label="Edit receipt" className="mr-3" onClick={() => onEdit(r)} style={{ color: FF.tealDark }}><Pencil className="w-3.5 h-3.5" /></button>
                      <button aria-label="Delete receipt" onClick={() => del(r)} style={{ color: FF.red }}><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function ExpensesView({ onAdd, onUpload, onEdit, initialUntagged }: { onAdd: () => void; onUpload: () => void; onEdit: (e: Expense) => void; initialUntagged?: boolean }) {
  const { me, version, changed } = useFm()
  const { projects } = useProjectContext()
  const [project, setProject] = useState('')
  const [untagged, setUntagged] = useState(!!initialUntagged)
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const qs = new URLSearchParams({ ...(project ? { project } : {}), ...(untagged ? { untagged: '1' } : {}) }).toString()
  const { data, error, loading } = useFmLoad(() => fmGet<{ expenses: Expense[] }>(`/budget/expenses${qs ? `?${qs}` : ''}`), [qs, version])
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (data?.expenses || []).filter(e => !n || [e.category, e.payee, e.description, e.voucher_ref].some(v => v?.toLowerCase().includes(n)))
  }, [data, q])
  const total = rows.reduce((t, e) => t + e.amount, 0)
  async function del(e: Expense) {
    if (!confirm(`Delete ${e.category} expense of ${inr(e.amount)} on ${fmtDate(e.paid_on)}?`)) return
    try { await fmDelete(`/budget/expenses/${e.id}`); changed() } catch (x) { setErr((x as Error).message) }
  }
  async function undo(batch: string) {
    const n = (data?.expenses || []).filter(e => e.upload_batch === batch).length
    if (!confirm(`Undo this upload? All rows from that file (${n}+ shown here) will be deleted.`)) return
    try { await fmDelete(`/budget/expenses/batch/${batch}`); changed() } catch (x) { setErr((x as Error).message) }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: FF.textFaint }} />
          <input className={`${inputCls} pl-9`} style={inputStyle} placeholder="Search category, payee, voucher…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className={`${inputCls} sm:w-56`} style={inputStyle} value={project} onChange={e => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap px-1" style={{ color: FF.tealDark }}>
          <input type="checkbox" checked={untagged} onChange={e => setUntagged(e.target.checked)} />No account only
        </label>
        {canEditFinance(me) && <>
          <Btn onClick={onUpload}><Upload className="w-4 h-4" />Upload Excel</Btn>
          <Btn variant="primary" onClick={onAdd}><Plus className="w-4 h-4" />Add expense</Btn>
        </>}
      </div>
      <ErrorBox message={err} />
      {error ? <ErrorBox message={error} /> : loading && !data ? <Card><LoadingRow /></Card> : !rows.length ? (
        <Card><EmptyState compact icon={<Wallet className="w-6 h-6" />} title="No expenses found" body="Record vendor bills, salaries, rent and other project payments, one by one or from an Excel / Tally export." /></Card>
      ) : (
        <>
          <div className="text-xs" style={{ color: FF.textMuted }}>{rows.length} expense{rows.length === 1 ? '' : 's'} · total <b style={{ color: FF.tealDark }}>{inr(total)}</b>{rows.length >= 2000 ? ' (latest 2,000 shown — filter by project)' : ''}</div>
          <ExpenseTable expenses={rows} showProject onDelete={canEditFinance(me) ? del : undefined} onUndoBatch={canEditFinance(me) ? undo : undefined} onEdit={canEditFinance(me) ? onEdit : undefined} />
        </>
      )}
    </div>
  )
}

function BankView({ accounts, onAddAccount, onEditAccount, onStatement, onEditStatement, onTransfer, onEditTransfer }: {
  accounts: BankAccount[]; onAddAccount: () => void; onEditAccount: (a: BankAccount) => void; onStatement: (id: string) => void
  onEditStatement: (st: StatementRef) => void; onTransfer: () => void; onEditTransfer: (t: Transfer) => void
}) {
  const { me, version, changed } = useFm()
  const { data } = useFmLoad(() => fmGet<{ transfers: Transfer[] }>('/budget/transfers'), [version])
  const [err, setErr] = useState<string | null>(null)
  async function toggle(a: BankAccount) {
    try { await fmPatch(`/budget/accounts/${a.id}`, { active: !a.active }); changed() } catch (e) { setErr((e as Error).message) }
  }
  async function delTransfer(t: Transfer) {
    if (!confirm(`Delete transfer of ${inr(t.amount)} on ${fmtDate(t.transfer_on)}?`)) return
    try { await fmDelete(`/budget/transfers/${t.id}`); changed() } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="space-y-4">
      {canEditFinance(me) && (
        <div className="flex flex-wrap justify-end gap-2">
          <Btn onClick={onTransfer} disabled={accounts.filter(a => a.active).length < 2}><ArrowRightLeft className="w-4 h-4" />Record transfer</Btn>
          <Btn variant="primary" onClick={onAddAccount}><Plus className="w-4 h-4" />Add account</Btn>
        </div>
      )}
      <ErrorBox message={err} />
      <Card>
        {!accounts.length ? (
          <EmptyState compact icon={<Landmark className="w-6 h-6" />} title="No bank accounts yet"
            body="Add each account the organisation uses (FCRA main, FCRA utilisation, local, cash in hand) with its opening balance." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead style={{ background: FF.bg, color: FF.textMuted }}>
                <tr>
                  <th className={thCls}>Account</th><th className={`${thCls} text-right`}>Computed balance</th>
                  <th className={`${thCls} text-right`}>Statement balance</th><th className={`${thCls} text-right`}>Difference</th>{canEditFinance(me) && <th className={thCls} />}
                </tr>
              </thead>
              <tbody style={{ color: FF.tealDark }}>
                {accounts.map(a => {
                  const off = a.difference != null && Math.abs(a.difference) >= 0.005
                  return (
                    <tr key={a.id} className="border-t" style={{ borderColor: FF.borderFaint, opacity: a.active ? 1 : 0.55 }}>
                      <td className={tdCls}>
                        <div className="font-semibold">{a.name}{!a.active && ' (inactive)'}</div>
                        <div className="text-xs" style={{ color: FF.textMuted }}>
                          {ACCOUNT_KIND_LABEL[a.kind]}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_last4 ? ` · ••${a.account_last4}` : ''} · opening {signed(a.opening_balance)} on {fmtDate(a.opening_date)}
                        </div>
                        {a.before_opening > 0 && <div className="text-xs" style={{ color: FF.amber }}>{a.before_opening} entr{a.before_opening === 1 ? 'y' : 'ies'} dated before the opening date are not counted</div>}
                      </td>
                      <td className={`${tdCls} text-right whitespace-nowrap font-semibold`} style={{ color: a.computed_balance < 0 ? FF.red : undefined }}>{signed(a.computed_balance)}</td>
                      <td className={`${tdCls} text-right whitespace-nowrap`}>
                        {a.statement_balance == null ? <span className="text-xs" style={{ color: FF.textFaint }}>not entered</span> : (
                          <>
                            <div>{signed(a.statement_balance)}</div>
                            <div className="text-xs" style={{ color: FF.textMuted }}>
                              as on {fmtDate(a.statement_as_of)}
                              {canEditFinance(me) && a.statement_id && (
                                <button className="ml-2 font-semibold" style={{ color: FF.purple }} onClick={() => onEditStatement({
                                  id: a.statement_id!, bank_account_id: a.id, account_name: a.name, as_of: a.statement_as_of!, balance: a.statement_balance!, note: a.statement_note ?? null,
                                })}>Edit</button>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                      <td className={`${tdCls} text-right whitespace-nowrap`}>
                        {a.difference == null ? '—' : off ? (
                          <span className="inline-flex items-center gap-1 font-semibold" style={{ color: FF.red }} title={`Computed on ${fmtDate(a.statement_as_of)}: ${signed(a.computed_at_statement ?? 0)}`}>
                            <AlertTriangle className="w-3.5 h-3.5" />{signed(a.difference)}
                          </span>
                        ) : <span className="font-semibold" style={{ color: FF.green }}>Matches</span>}
                      </td>
                      {canEditFinance(me) && (
                        <td className={`${tdCls} whitespace-nowrap text-right`}>
                          {a.active && <button className="text-xs font-semibold mr-3" style={{ color: FF.purple }} onClick={() => onStatement(a.id)}>Enter statement</button>}
                          <button className="text-xs font-semibold mr-3" style={{ color: FF.tealDark }} onClick={() => onEditAccount(a)}>Edit</button>
                          <button className="text-xs" style={{ color: FF.textMuted }} onClick={() => toggle(a)}>{a.active ? 'Deactivate' : 'Reactivate'}</button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="text-xs" style={{ color: FF.textMuted }}>
        Difference = statement balance − computed balance on the statement date. A gap usually means a receipt, payment, bank charge or transfer hasn't been recorded here, or an expense isn't tagged to this account.
      </div>

      {(data?.transfers.length ?? 0) > 0 && (
        <>
          <SectionTitle>Transfers between accounts</SectionTitle>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead style={{ background: FF.bg, color: FF.textMuted }}><tr><th className={thCls}>Date</th><th className={thCls}>From → to</th><th className={thCls}>Reference</th><th className={`${thCls} text-right`}>Amount</th>{canEditFinance(me) && <th className={thCls} />}</tr></thead>
                <tbody style={{ color: FF.tealDark }}>
                  {data!.transfers.map(t => (
                    <tr key={t.id} className="border-t" style={{ borderColor: FF.borderFaint }}>
                      <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(t.transfer_on)}</td><td className={tdCls}>{t.from_name} → {t.to_name}</td>
                      <td className={tdCls}>{t.reference || '—'}</td><td className={`${tdCls} text-right whitespace-nowrap font-semibold`}>{inr(t.amount)}</td>
                      {canEditFinance(me) && <td className={`${tdCls} text-right whitespace-nowrap`}>
                        <button aria-label="Edit transfer" className="mr-3" onClick={() => onEditTransfer(t)} style={{ color: FF.tealDark }}><Pencil className="w-3.5 h-3.5" /></button>
                        <button aria-label="Delete transfer" onClick={() => delTransfer(t)} style={{ color: FF.red }}><Trash2 className="w-3.5 h-3.5" /></button>
                      </td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

export function BudgetPanel() {
  const { me, version } = useFm()
  const [view, setView] = useState<View>('grants')
  const { data, error, loading } = useFmLoad(() => fmGet<BudgetOverview>('/budget/overview'), [version])
  const [grantForm, setGrantForm] = useState<{ open: boolean; grant?: Grant | null }>({ open: false })
  const [grantId, setGrantId] = useState<string | null>(null)
  const [receiptForm, setReceiptForm] = useState<{ open: boolean; existing?: Receipt | null }>({ open: false })
  const [expenseForm, setExpenseForm] = useState<{ open: boolean; existing?: Expense | null }>({ open: false })
  const [upload, setUpload] = useState(false)
  const [accountForm, setAccountForm] = useState<{ open: boolean; account?: BankAccount | null }>({ open: false })
  const [statement, setStatement] = useState<{ open: boolean; accountId?: string; existing?: StatementRef | null }>({ open: false })
  const [transfer, setTransfer] = useState<{ open: boolean; existing?: Transfer | null }>({ open: false })
  const [projectFilter, setProjectFilter] = useState('')

  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <LoadingRow />
  if (!data) return null
  const t = data.totals
  const g = data.gaps
  const noAccounts = !data.accounts.length
  const grants = projectFilter ? data.grants.filter(x => x.project_key === projectFilter) : data.grants
  const projectsWithGrants = [...new Map(data.grants.map(x => [x.project_key, x.project_name || x.project_key])).entries()]

  return (
    <div className="space-y-4">
      {/* Organisation totals across all grants */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Approved budget" value={inr(t.approved)} sub={`${data.grants.length} grant${data.grants.length === 1 ? '' : 's'}`} />
        <Tile label="Received from donors" value={inr(t.received)} sub={`${inr(t.pending_from_donor)} still due`} />
        <Tile label="Paid out" value={inr(t.paid_out)} sub={`staff ${inr(t.staff_paid + t.reimbursed - t.refunded)} · other ${inr(t.other_expenses)}`} />
        <Tile label="Bills submitted" value={inr(t.bills_submitted)} sub={`${inr(t.bills_approved)} approved`} />
        <Tile label="In bank (computed)" value={signed(t.bank_computed)} tone={t.bank_computed < 0 ? 'bad' : undefined}
          sub={t.bank_difference == null ? 'no statement balances entered yet'
            : `${t.bank_reconciled} of ${t.bank_accounts} accounts checked · ${Math.abs(t.bank_difference) < 0.005 ? 'matches statements' : `gap ${signed(t.bank_difference)}`}`} />
        <Tile label="With staff" value={inr(t.held_by_staff)} tone={t.held_by_staff > 0 ? 'warn' : undefined}
          sub={t.owed_to_staff > 0 ? `${inr(t.owed_to_staff)} owed to staff` : 'unspent advances to account for'} />
      </div>

      {(g.exp_untagged_n > 0 || g.adv_untagged_n > 0 || g.exp_outside_n > 0 || g.adv_outside_n > 0) && (
        <div className="rounded-xl px-4 py-3 text-xs space-y-1" style={{ background: FF.amberBg, color: FF.amber }}>
          <div className="font-semibold inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />Some money isn't fully accounted for</div>
          {g.exp_untagged_n > 0 && <div>{g.exp_untagged_n} expense{g.exp_untagged_n === 1 ? '' : 's'} ({inr(g.exp_untagged_amt)}) not tagged to a bank account — <button className="underline font-semibold" onClick={() => setView('expenses')}>review</button></div>}
          {g.adv_untagged_n > 0 && <div>{g.adv_untagged_n} staff advance payment{g.adv_untagged_n === 1 ? '' : 's'} ({inr(g.adv_untagged_amt)}) recorded without a "paid from" account, so they aren't in any bank balance.</div>}
          {g.exp_outside_n > 0 && <div>{g.exp_outside_n} expense{g.exp_outside_n === 1 ? '' : 's'} ({inr(g.exp_outside_amt)}) dated outside every grant period of their project.</div>}
          {g.adv_outside_n > 0 && <div>{g.adv_outside_n} staff advance{g.adv_outside_n === 1 ? '' : 's'} ({inr(g.adv_outside_amt)}) paid outside every grant period of their project.</div>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={[
          { key: 'grants' as View, label: 'Projects & grants' },
          { key: 'receipts' as View, label: 'Donor receipts' },
          { key: 'expenses' as View, label: 'Expenses' },
          { key: 'bank' as View, label: 'Bank accounts' },
        ]} value={view} onChange={setView} />
        {view === 'grants' && (
          <div className="flex flex-wrap gap-2">
            {projectsWithGrants.length > 1 && (
              <select className={`${inputCls} sm:w-56`} style={inputStyle} value={projectFilter} onChange={e => setProjectFilter(e.target.value)} aria-label="Filter by project">
                <option value="">All projects</option>
                {projectsWithGrants.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
              </select>
            )}
            {canEditFinance(me) && <Btn variant="primary" onClick={() => setGrantForm({ open: true })}><Plus className="w-4 h-4" />Add approved budget</Btn>}
          </div>
        )}
      </div>

      {canEditFinance(me) && noAccounts && view !== 'bank' && (
        <div className="rounded-xl px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2" style={{ background: FF.bg, color: FF.tealDark }}>
          <span>Start by adding the organisation's bank accounts with their opening balances — receipts and payments are tagged to them.</span>
          <Btn small onClick={() => setView('bank')}>Set up accounts</Btn>
        </div>
      )}

      {view === 'grants' && (grants.length ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {grants.map(x => <GrantCard key={x.id} g={x} onOpen={() => setGrantId(x.id)} />)}
        </div>
      ) : (
        <Card><EmptyState compact icon={<Landmark className="w-6 h-6" />} title="No approved budgets yet"
          body="Add each project's sanctioned budget for its grant period to start tracking money received, spent and in the bank." /></Card>
      ))}
      {view === 'receipts' && <ReceiptsView grants={data.grants} onAdd={() => setReceiptForm({ open: true })} onEdit={r => setReceiptForm({ open: true, existing: r })} />}
      {view === 'expenses' && <ExpensesView onAdd={() => setExpenseForm({ open: true })} onUpload={() => setUpload(true)} onEdit={e => setExpenseForm({ open: true, existing: e })} />}
      {view === 'bank' && (
        <BankView accounts={data.accounts} onAddAccount={() => setAccountForm({ open: true })} onEditAccount={a => setAccountForm({ open: true, account: a })}
          onStatement={id => setStatement({ open: true, accountId: id })} onEditStatement={st => setStatement({ open: true, existing: st })}
          onTransfer={() => setTransfer({ open: true })} onEditTransfer={t => setTransfer({ open: true, existing: t })} />
      )}

      <GrantFormModal open={grantForm.open} grant={grantForm.grant} onClose={() => setGrantForm({ open: false })} />
      <GrantDetailModal id={grantId} onClose={() => setGrantId(null)} onEdit={x => { setGrantId(null); setGrantForm({ open: true, grant: x }) }} />
      <ReceiptFormModal open={receiptForm.open} existing={receiptForm.existing} grants={data.grants} onClose={() => setReceiptForm({ open: false })} />
      <ExpenseFormModal open={expenseForm.open} existing={expenseForm.existing} onClose={() => setExpenseForm({ open: false })} />
      <ExpenseUploadModal open={upload} onClose={() => setUpload(false)} />
      <AccountFormModal open={accountForm.open} account={accountForm.account} onClose={() => setAccountForm({ open: false })} />
      <StatementFormModal open={statement.open} accountId={statement.accountId} existing={statement.existing} onClose={() => setStatement({ open: false })} />
      <TransferFormModal open={transfer.open} existing={transfer.existing} onClose={() => setTransfer({ open: false })} />
    </div>
  )
}
