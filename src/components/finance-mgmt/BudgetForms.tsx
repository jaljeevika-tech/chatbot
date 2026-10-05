// Budget Management forms (Finance only): grant, receipt, expense, account, statement
// balance, transfer, and Excel/CSV expense upload. Backend: services/finance/src/budget.js.

import { useEffect, useMemo, useState } from 'react'
import { Download, FileSpreadsheet, Loader2, Upload, AlertTriangle } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import {
  ACCOUNT_KIND_LABEL, fmPatch, fmPost, fmtDate, inr, todayIso,
  type BankAccount, type BankAccountKind, type Expense, type Grant, type Receipt, type Transfer,
} from './fmApi'
import { Btn, ErrorBox, Field, FmModal, HistoryPanel, inputCls, inputStyle, tdCls, thCls } from './fmUi'

type Close = () => void

function useSubmit(onDone: () => void, open?: boolean) {
  const { changed } = useFm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) setError(null) }, [open])
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); changed(); onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return { busy, error, setError, run }
}

function AccountSelect({ value, onChange, disabled, allowNone, noneLabel = 'Not tagged', currentName }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; allowNone?: boolean; noneLabel?: string; currentName?: string | null
}) {
  const { me } = useFm()
  const list = me.bank_accounts || []
  return (
    <select className={inputCls} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      <option value="">{allowNone ? noneLabel : 'Select account…'}</option>
      {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      {value && !list.some(a => a.id === value) && <option value={value}>{currentName || 'Current account'} (inactive)</option>}
    </select>
  )
}

// ══ Grant budget ═════════════════════════════════════════════════════════════
export function GrantFormModal({ open, onClose, grant }: { open: boolean; onClose: Close; grant?: Grant | null }) {
  const { projects, loadProjects } = useProjectContext()
  const [f, setF] = useState({ project_key: '', donor: '', grant_ref: '', period_from: '', period_to: '', approved_amount: '', notes: '' })
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    if (!projects.length) void loadProjects()
    setF(grant
      ? { project_key: grant.project_key, donor: grant.donor || '', grant_ref: grant.grant_ref || '', period_from: grant.period_from,
          period_to: grant.period_to, approved_amount: String(grant.approved), notes: grant.notes || '' }
      : { project_key: '', donor: '', grant_ref: '', period_from: '', period_to: '', approved_amount: '', notes: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, grant])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = () => run(() => {
    const body = { ...f, project_name: projects.find(p => p.project_key === f.project_key)?.name || grant?.project_name || null }
    return grant ? fmPatch(`/budget/budgets/${grant.id}`, body) : fmPost('/budget/budgets', body)
  })
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="md" title={grant ? 'Edit approved budget' : 'Add approved budget'}
      subtitle="One sanctioned total per project per grant period. The Financial Tracker is not changed."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn variant="primary" busy={busy} onClick={submit}>Save</Btn></>}>
      <Field label="Project" required>
        <select className={inputCls} style={inputStyle} value={f.project_key} onChange={set('project_key')} disabled={busy}>
          <option value="">Select a project…</option>
          {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
          {grant && !projects.some(p => p.project_key === grant.project_key) && <option value={grant.project_key}>{grant.project_name || grant.project_key}</option>}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Donor"><input className={inputCls} style={inputStyle} value={f.donor} onChange={set('donor')} disabled={busy} placeholder="e.g. HDFC Parivartan" /></Field>
        <Field label="Grant / agreement ref."><input className={inputCls} style={inputStyle} value={f.grant_ref} onChange={set('grant_ref')} disabled={busy} /></Field>
        <Field label="Grant period from" required><input type="date" className={inputCls} style={inputStyle} value={f.period_from} onChange={set('period_from')} disabled={busy} /></Field>
        <Field label="Grant period to" required><input type="date" className={inputCls} style={inputStyle} value={f.period_to} min={f.period_from || undefined} onChange={set('period_to')} disabled={busy} /></Field>
      </div>
      <Field label="Approved budget (₹)" required>
        <input type="number" inputMode="decimal" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.approved_amount} onChange={set('approved_amount')} disabled={busy} />
      </Field>
      <Field label="Notes"><textarea className={inputCls} style={inputStyle} rows={2} value={f.notes} onChange={set('notes')} disabled={busy} /></Field>
      <ErrorBox message={error} />
      {grant && <HistoryPanel type="budget" id={grant.id} />}
    </FmModal>
  )
}

// ══ Donor receipt ════════════════════════════════════════════════════════════
export function ReceiptFormModal({ open, onClose, grants, grantId, existing }: { open: boolean; onClose: Close; grants: Grant[]; grantId?: string; existing?: Receipt | null }) {
  const [f, setF] = useState({ budget_id: '', bank_account_id: '', received_on: todayIso(), amount: '', tranche: '', reference: '', note: '' })
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    setF(existing
      ? { budget_id: existing.budget_id || '', bank_account_id: existing.bank_account_id || '', received_on: existing.received_on, amount: String(existing.amount),
          tranche: existing.tranche || '', reference: existing.reference || '', note: existing.note || '' }
      : { budget_id: grantId || (grants.length === 1 ? grants[0].id : ''), bank_account_id: '', received_on: todayIso(), amount: '', tranche: '', reference: '', note: '' })
  }, [open, grantId, grants, existing])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const g = grants.find(x => x.id === f.budget_id)
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="md" title={existing ? 'Edit donor receipt' : 'Record money received from donor'}
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} onClick={() => run(() => existing ? fmPatch(`/budget/receipts/${existing.id}`, f) : fmPost('/budget/receipts', f))}>Save receipt</Btn></>}>
      <Field label="Grant" required hint={g ? `Approved ${inr(g.approved)} · received so far ${inr(g.received)} · pending ${inr(g.pending_from_donor)}` : undefined}>
        <select className={inputCls} style={inputStyle} value={f.budget_id} onChange={set('budget_id')} disabled={busy}>
          <option value="">Select the grant…</option>
          {grants.map(x => <option key={x.id} value={x.id}>{x.project_name || x.project_key} · {fmtDate(x.period_from)} – {fmtDate(x.period_to)}{x.donor ? ` · ${x.donor}` : ''}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Date received" required><input type="date" className={inputCls} style={inputStyle} value={f.received_on} max={todayIso()} onChange={set('received_on')} disabled={busy} /></Field>
        <Field label="Amount (₹)" required><input type="number" inputMode="decimal" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount} onChange={set('amount')} disabled={busy} /></Field>
        <Field label="Received into account" required><AccountSelect value={f.bank_account_id} onChange={v => setF(x => ({ ...x, bank_account_id: v }))} disabled={busy} currentName={existing?.account_name} /></Field>
        <Field label="Tranche"><input className={inputCls} style={inputStyle} value={f.tranche} onChange={set('tranche')} disabled={busy} placeholder="e.g. Tranche 2 of 4" /></Field>
      </div>
      <Field label="UTR / reference"><input className={inputCls} style={inputStyle} value={f.reference} onChange={set('reference')} disabled={busy} /></Field>
      <Field label="Note"><input className={inputCls} style={inputStyle} value={f.note} onChange={set('note')} disabled={busy} /></Field>
      <ErrorBox message={error} />
      {existing && <HistoryPanel type="receipt" id={existing.id} />}
    </FmModal>
  )
}

// ══ Single expense ═══════════════════════════════════════════════════════════
export function ExpenseFormModal({ open, onClose, existing }: { open: boolean; onClose: Close; existing?: Expense | null }) {
  const { me } = useFm()
  const { projects, loadProjects } = useProjectContext()
  const blank = { project_key: '', paid_on: todayIso(), category: '', payee: '', description: '', amount: '', voucher_ref: '', bank_account_id: '' }
  const [f, setF] = useState(blank)
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    if (!projects.length) void loadProjects()
    setF(existing
      ? { project_key: existing.project_key || '', paid_on: existing.paid_on, category: existing.category, payee: existing.payee || '',
          description: existing.description || '', amount: String(existing.amount), voucher_ref: existing.voucher_ref || '', bank_account_id: existing.bank_account_id || '' }
      : blank)
  }, [open, existing]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = () => run(() => {
    const body = { ...f, bank_account_id: f.bank_account_id || null, project_name: projects.find(p => p.project_key === f.project_key)?.name || existing?.project_name || null }
    return existing ? fmPatch(`/budget/expenses/${existing.id}`, body) : fmPost('/budget/expenses', body)
  })
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="md" title={existing ? 'Edit project expense' : 'Add project expense'}
      subtitle="Vendor bills, salaries, rent and other payments not made through staff advances."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn variant="primary" busy={busy} onClick={submit}>Save expense</Btn></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Project" required>
          <select className={inputCls} style={inputStyle} value={f.project_key} onChange={set('project_key')} disabled={busy}>
            <option value="">Select a project…</option>
            {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
            {existing?.project_key && !projects.some(p => p.project_key === existing.project_key) && <option value={existing.project_key}>{existing.project_name || existing.project_key}</option>}
          </select>
        </Field>
        <Field label="Date paid" required><input type="date" className={inputCls} style={inputStyle} value={f.paid_on} max={todayIso()} onChange={set('paid_on')} disabled={busy} /></Field>
        <Field label="Category" required>
          <input className={inputCls} style={inputStyle} value={f.category} onChange={set('category')} disabled={busy} list="fm-exp-cats" placeholder="e.g. Salaries" />
          <datalist id="fm-exp-cats">{['Salaries', 'Rent', 'Vendor / supplies', 'Professional fees', 'Utilities', ...me.expense_categories].map(c => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Amount (₹)" required><input type="number" inputMode="decimal" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount} onChange={set('amount')} disabled={busy} /></Field>
        <Field label="Payee"><input className={inputCls} style={inputStyle} value={f.payee} onChange={set('payee')} disabled={busy} /></Field>
        <Field label="Voucher no."><input className={inputCls} style={inputStyle} value={f.voucher_ref} onChange={set('voucher_ref')} disabled={busy} /></Field>
      </div>
      <Field label="Paid from account" hint="Leave blank only if you don't know — untagged payments are flagged in the bank reconciliation.">
        <AccountSelect value={f.bank_account_id} onChange={v => setF(x => ({ ...x, bank_account_id: v }))} disabled={busy} allowNone currentName={existing?.account_name} />
      </Field>
      <Field label="Description"><input className={inputCls} style={inputStyle} value={f.description} onChange={set('description')} disabled={busy} /></Field>
      <ErrorBox message={error} />
      {existing && <HistoryPanel type="expense" id={existing.id} />}
    </FmModal>
  )
}

// ══ Bank account ═════════════════════════════════════════════════════════════
export function AccountFormModal({ open, onClose, account }: { open: boolean; onClose: Close; account?: BankAccount | null }) {
  const blank = { name: '', kind: '' as BankAccountKind | '', bank_name: '', account_last4: '', opening_balance: '0', opening_date: `${new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1}-04-01` }
  const [f, setF] = useState(blank)
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    setF(account ? { name: account.name, kind: account.kind, bank_name: account.bank_name || '', account_last4: account.account_last4 || '',
      opening_balance: String(account.opening_balance), opening_date: account.opening_date } : blank)
  }, [open, account]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="md" title={account ? 'Edit bank account' : 'Add bank account'}
      subtitle="Only the last 4 digits of the account number are stored."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} onClick={() => run(() => account ? fmPatch(`/budget/accounts/${account.id}`, f) : fmPost('/budget/accounts', f))}>Save account</Btn></>}>
      <Field label="Account name" required><input className={inputCls} style={inputStyle} value={f.name} onChange={set('name')} disabled={busy} placeholder="e.g. FCRA Main — SBI New Delhi" /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Type" required>
          <select className={inputCls} style={inputStyle} value={f.kind} onChange={set('kind')} disabled={busy}>
            <option value="">Select…</option>
            {(Object.keys(ACCOUNT_KIND_LABEL) as BankAccountKind[]).map(k => <option key={k} value={k}>{ACCOUNT_KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Bank"><input className={inputCls} style={inputStyle} value={f.bank_name} onChange={set('bank_name')} disabled={busy} /></Field>
        <Field label="Account no. — last 4 digits"><input className={inputCls} style={inputStyle} value={f.account_last4} maxLength={4} inputMode="numeric" onChange={set('account_last4')} disabled={busy} /></Field>
        <div />
        <Field label="Opening balance (₹)" required><input type="number" step="0.01" className={inputCls} style={inputStyle} value={f.opening_balance} onChange={set('opening_balance')} disabled={busy} /></Field>
        <Field label="Opening balance as on" required hint="Movements before this date are not counted.">
          <input type="date" className={inputCls} style={inputStyle} value={f.opening_date} onChange={set('opening_date')} disabled={busy} />
        </Field>
      </div>
      <ErrorBox message={error} />
      {account && <HistoryPanel type="bank_account" id={account.id} />}
    </FmModal>
  )
}

// ══ Statement balance ════════════════════════════════════════════════════════
export interface StatementRef { id: string; bank_account_id: string; account_name: string; as_of: string; balance: number; note: string | null }

export function StatementFormModal({ open, onClose, accountId, existing }: { open: boolean; onClose: Close; accountId?: string; existing?: StatementRef | null }) {
  const [f, setF] = useState({ bank_account_id: '', as_of: todayIso(), balance: '', note: '' })
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    setF(existing
      ? { bank_account_id: existing.bank_account_id, as_of: existing.as_of, balance: String(existing.balance), note: existing.note || '' }
      : { bank_account_id: accountId || '', as_of: todayIso(), balance: '', note: '' })
  }, [open, accountId, existing])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="sm" title={existing ? `Edit statement balance — ${existing.account_name}` : 'Enter bank statement balance'}
      subtitle="The closing balance shown on the bank statement / passbook. It is compared with the computed balance on the same date."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} onClick={() => run(() => existing
          ? fmPatch(`/budget/statements/${existing.id}`, { as_of: f.as_of, balance: f.balance, note: f.note })
          : fmPost('/budget/statements', f))}>Save</Btn></>}>
      {!existing && <Field label="Account" required><AccountSelect value={f.bank_account_id} onChange={v => setF(x => ({ ...x, bank_account_id: v }))} disabled={busy} /></Field>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="As on date" required><input type="date" className={inputCls} style={inputStyle} value={f.as_of} max={todayIso()} onChange={set('as_of')} disabled={busy} /></Field>
        <Field label="Balance (₹)" required><input type="number" step="0.01" className={inputCls} style={inputStyle} value={f.balance} onChange={set('balance')} disabled={busy} /></Field>
      </div>
      <Field label="Note"><input className={inputCls} style={inputStyle} value={f.note} onChange={set('note')} disabled={busy} /></Field>
      <ErrorBox message={error} />
      {existing && <HistoryPanel type="statement" id={existing.id} />}
    </FmModal>
  )
}

// ══ Transfer between own accounts ════════════════════════════════════════════
export function TransferFormModal({ open, onClose, existing }: { open: boolean; onClose: Close; existing?: Transfer | null }) {
  const [f, setF] = useState({ from_account_id: '', to_account_id: '', transfer_on: todayIso(), amount: '', reference: '', note: '' })
  const { busy, error, run } = useSubmit(onClose, open)
  useEffect(() => {
    if (!open) return
    setF(existing
      ? { from_account_id: existing.from_account_id || '', to_account_id: existing.to_account_id || '', transfer_on: existing.transfer_on,
          amount: String(existing.amount), reference: existing.reference || '', note: existing.note || '' }
      : { from_account_id: '', to_account_id: '', transfer_on: todayIso(), amount: '', reference: '', note: '' })
  }, [open, existing])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  return (
    <FmModal open={open} onClose={onClose} busy={busy} size="sm" title={existing ? 'Edit transfer' : 'Record transfer between accounts'}
      subtitle="e.g. FCRA main → FCRA utilisation. Moves money between your own accounts; project totals don't change."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} onClick={() => run(() => existing ? fmPatch(`/budget/transfers/${existing.id}`, f) : fmPost('/budget/transfers', f))}>Save transfer</Btn></>}>
      <Field label="From account" required><AccountSelect value={f.from_account_id} onChange={v => setF(x => ({ ...x, from_account_id: v }))} disabled={busy} currentName={existing?.from_name} /></Field>
      <Field label="To account" required><AccountSelect value={f.to_account_id} onChange={v => setF(x => ({ ...x, to_account_id: v }))} disabled={busy} currentName={existing?.to_name} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Date" required><input type="date" className={inputCls} style={inputStyle} value={f.transfer_on} max={todayIso()} onChange={set('transfer_on')} disabled={busy} /></Field>
        <Field label="Amount (₹)" required><input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount} onChange={set('amount')} disabled={busy} /></Field>
      </div>
      <Field label="Reference"><input className={inputCls} style={inputStyle} value={f.reference} onChange={set('reference')} disabled={busy} /></Field>
      <ErrorBox message={error} />
      {existing && <HistoryPanel type="transfer" id={existing.id} />}
    </FmModal>
  )
}

// ══ Excel / CSV expense upload ═══════════════════════════════════════════════
const TEMPLATE_HEADERS = ['Date', 'Project', 'Category', 'Payee', 'Description', 'Amount', 'Voucher No', 'Paid From Account']
// Header aliases (lower-cased, spaces/punctuation stripped) → field. Covers
// this template and common Tally/Excel day-book exports.
const HEADER_ALIASES: Record<string, string> = {
  date: 'paid_on', paidon: 'paid_on', voucherdate: 'paid_on', paymentdate: 'paid_on', vchdate: 'paid_on',
  project: 'project', projectname: 'project', costcentre: 'project', costcenter: 'project',
  category: 'category', ledger: 'category', expensehead: 'category', head: 'category', particulars: 'category',
  payee: 'payee', party: 'payee', partyname: 'payee', vendor: 'payee', paidto: 'payee',
  description: 'description', narration: 'description', remarks: 'description',
  amount: 'amount', debit: 'amount', debitamount: 'amount', amountrs: 'amount', amountinr: 'amount',
  voucherno: 'voucher_ref', voucher: 'voucher_ref', vchno: 'voucher_ref', voucherref: 'voucher_ref', billno: 'voucher_ref',
  paidfromaccount: 'account', account: 'account', bank: 'account', bankaccount: 'account', paidfrom: 'account',
}
const normKey = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** Excel serial / Date / 'dd-mm-yyyy' / 'dd/mm/yy' / 'yyyy-mm-dd' / '1-Apr-2026' → 'YYYY-MM-DD' (Indian day-first). */
export function toIsoDate(v: unknown): string | null {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ok = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
  }
  if (v instanceof Date && !isNaN(v.getTime())) return ok(v.getFullYear(), v.getMonth() + 1, v.getDate())
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const dt = new Date(Math.round((v - 25569) * 86400000)) // Excel serial → UTC
    return ok(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
  }
  const s = String(v ?? '').trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return ok(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s)
  if (m) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]*(\d{2}|\d{4})$/.exec(s)
  if (m && MONTHS[m[2].toLowerCase()]) return ok(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()], +m[1])
  return null
}

interface ParsedRow {
  row: number
  data: { project_key: string; project_name: string | null; paid_on: string; category: string; payee: string | null
    description: string | null; amount: number; voucher_ref: string | null; bank_account_id: string | null }
  label: { project: string; account: string }
  errors: string[]
}

export function ExpenseUploadModal({ open, onClose }: { open: boolean; onClose: Close }) {
  const { me, changed } = useFm()
  const { projects, loadProjects } = useProjectContext()
  const [rows, setRows] = useState<ParsedRow[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [server, setServer] = useState<{ duplicates: number[]; errors: { row: number; error: string }[] } | null>(null)
  const [skipDupes, setSkipDupes] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ inserted: number; total: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setRows(null); setFileName(''); setServer(null); setError(null); setDone(null); setSkipDupes(true)
    if (!projects.length) void loadProjects()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function downloadTemplate() {
    const XLSX: any = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const sample = [TEMPLATE_HEADERS, [todayIso(), projects[0]?.name || 'Project name', 'Salaries', 'Staff payroll', 'September salaries', 150000, 'PV-0001', me.bank_accounts?.[0]?.name || '']]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sample), 'Expenses')
    const max = Math.max(projects.length, me.bank_accounts?.length || 0, 1)
    const lists = [['Projects (use these names)', 'Bank accounts (use these names)']]
    for (let i = 0; i < max; i++) lists.push([projects[i]?.name || '', me.bank_accounts?.[i]?.name || ''])
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lists), 'Valid names')
    XLSX.writeFile(wb, 'project-expenses-template.xlsx')
  }

  async function parse(file: File | undefined) {
    if (!file) return
    setParsing(true); setError(null); setServer(null); setDone(null); setFileName(file.name)
    try {
      const XLSX: any = await import('xlsx')
      // CSV/TXT: read as UTF-8 text with every cell a string; SheetJS would read bytes as Latin-1
      // and guess dates US-style (02/10 → 10 Feb). toIsoDate parses day-first. Excel dates come
      // as raw serials (cellDates shifts them a day back in IST).
      const isText = /\.(csv|txt)$/i.test(file.name)
      const wb = isText
        ? XLSX.read(await file.text(), { type: 'string', raw: true })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true })
      if (!raw.length) throw new Error('The first sheet has no rows.')
      const fieldOf: Record<string, string> = {}
      for (const h of Object.keys(raw[0])) if (HEADER_ALIASES[normKey(h)]) fieldOf[h] = HEADER_ALIASES[normKey(h)]
      const needed = ['paid_on', 'project', 'category', 'amount']
      const missing = needed.filter(n => !Object.values(fieldOf).includes(n))
      if (missing.length) throw new Error(`Missing column(s): ${missing.map(m => ({ paid_on: 'Date', project: 'Project', category: 'Category', amount: 'Amount' }[m])).join(', ')}. Use the template headers.`)
      const projByName = new Map<string, { key: string; name: string }>()
      for (const p of projects) { projByName.set(normKey(p.name), { key: p.project_key, name: p.name }); projByName.set(normKey(p.project_key), { key: p.project_key, name: p.name }) }
      const acctByName = new Map((me.bank_accounts || []).map(a => [normKey(a.name), a.id]))
      const out: ParsedRow[] = []
      raw.forEach((r, i) => {
        const v: Record<string, unknown> = {}
        for (const [h, fld] of Object.entries(fieldOf)) if (v[fld] == null || v[fld] === '') v[fld] = r[h]
        if (Object.values(v).every(x => String(x ?? '').trim() === '')) return // blank line
        const errors: string[] = []
        const paid_on = toIsoDate(v.paid_on)
        if (!paid_on) errors.push(`date "${String(v.paid_on)}" not understood`)
        const projLabel = String(v.project ?? '').trim()
        const proj = projByName.get(normKey(projLabel))
        if (!proj) errors.push(projLabel ? `project "${projLabel}" not found` : 'project missing')
        const amount = Number(String(v.amount ?? '').replace(/[₹,\s]/g, ''))
        if (!(amount > 0)) errors.push('amount must be a positive number')
        const category = String(v.category ?? '').trim()
        if (!category) errors.push('category missing')
        const acctLabel = String(v.account ?? '').trim()
        const acct = acctLabel ? acctByName.get(normKey(acctLabel)) : null
        if (acctLabel && !acct) errors.push(`account "${acctLabel}" not found`)
        out.push({
          row: i + 2, // spreadsheet row (header is row 1)
          data: { project_key: proj?.key || '', project_name: proj?.name || null, paid_on: paid_on || '', category,
            payee: String(v.payee ?? '').trim() || null, description: String(v.description ?? '').trim() || null,
            amount: Math.round(amount * 100) / 100, voucher_ref: String(v.voucher_ref ?? '').trim() || null, bank_account_id: acct || null },
          label: { project: proj?.name || projLabel, account: acctLabel },
          errors,
        })
      })
      if (!out.length) throw new Error('No expense rows found.')
      setRows(out)
      const valid = out.filter(r => !r.errors.length)
      if (valid.length) {
        setChecking(true)
        const res = await fmPost<{ duplicates: number[]; errors: { row: number; error: string }[] }>('/budget/expenses/bulk', { rows: valid.map(r => r.data), dry_run: true })
        setServer({ duplicates: res.duplicates.map(i => valid[i - 1].row), errors: res.errors.map(e => ({ row: valid[e.row - 1].row, error: e.error })) })
      }
    } catch (e) {
      setError((e as Error).message); setRows(null)
    } finally {
      setParsing(false); setChecking(false)
    }
  }

  const dupSet = useMemo(() => new Set(server?.duplicates || []), [server])
  const srvErr = useMemo(() => new Map((server?.errors || []).map(e => [e.row, e.error])), [server])
  const bad = (rows || []).filter(r => r.errors.length || srvErr.has(r.row))
  const toSave = (rows || []).filter(r => !r.errors.length && !srvErr.has(r.row) && !(skipDupes && dupSet.has(r.row)))
  const totalToSave = toSave.reduce((t, r) => t + r.data.amount, 0)

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fmPost<{ inserted: number; total: number }>('/budget/expenses/bulk', { rows: toSave.map(r => r.data) })
      setDone(res); changed()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FmModal open={open} onClose={onClose} busy={saving} size="xl" title="Upload expenses from Excel / Tally"
      subtitle="First sheet, one payment per row. Columns: Date, Project, Category, Amount (required) · Payee, Description, Voucher No, Paid From Account."
      footer={done ? <Btn variant="primary" onClick={onClose}>Done</Btn> : <>
        <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        {rows && <Btn variant="primary" busy={saving} disabled={!toSave.length || checking} onClick={save}><Upload className="w-3.5 h-3.5" />Save {toSave.length} expense{toSave.length === 1 ? '' : 's'} · {inr(totalToSave)}</Btn>}
      </>}>
      {done ? (
        <div className="rounded-xl p-4 text-sm" style={{ background: FF.greenBg, color: FF.green }}>
          Saved {done.inserted} expenses totalling {inr(done.total)}. You can undo the whole upload from the Expenses list.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Btn small onClick={downloadTemplate}><Download className="w-3.5 h-3.5" />Download template</Btn>
            <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ${parsing ? 'opacity-50 pointer-events-none' : ''}`}
              style={{ background: FF.purple, color: '#fff' }}>
              {parsing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
              {fileName ? 'Choose another file' : 'Choose .xlsx / .csv'}
              <input type="file" className="sr-only" accept=".xlsx,.xls,.csv" onChange={e => { parse(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {fileName && <span className="text-xs" style={{ color: FF.textMuted }}>{fileName}</span>}
            {checking && <span className="text-xs inline-flex items-center gap-1" style={{ color: FF.textMuted }}><Loader2 className="w-3 h-3 animate-spin" />Checking for duplicates…</span>}
          </div>

          {rows && (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2.5 py-1 rounded-lg" style={{ background: FF.bg, color: FF.tealDark }}><b>{rows.length}</b> rows read</span>
                <span className="px-2.5 py-1 rounded-lg" style={{ background: FF.greenBg, color: FF.green }}><b>{toSave.length}</b> ready to save</span>
                {bad.length > 0 && <span className="px-2.5 py-1 rounded-lg" style={{ background: FF.redBg, color: FF.red }}><b>{bad.length}</b> with problems (left out)</span>}
                {dupSet.size > 0 && (
                  <label className="px-2.5 py-1 rounded-lg inline-flex items-center gap-1.5 cursor-pointer" style={{ background: FF.amberBg, color: FF.amber }}>
                    <input type="checkbox" checked={skipDupes} onChange={e => setSkipDupes(e.target.checked)} />
                    Leave out <b>{dupSet.size}</b> likely duplicate{dupSet.size === 1 ? '' : 's'} (already recorded)
                  </label>
                )}
              </div>
              <div className="rounded-xl overflow-auto max-h-[380px]" style={{ border: `1px solid ${FF.border}` }}>
                <table className="w-full min-w-[760px]">
                  <thead className="sticky top-0" style={{ background: FF.bg, color: FF.textMuted }}>
                    <tr>{['Row', 'Date', 'Project', 'Category', 'Payee', 'Amount', 'Voucher', 'Account', 'Status'].map(hd => <th key={hd} className={thCls}>{hd}</th>)}</tr>
                  </thead>
                  <tbody style={{ color: FF.tealDark }}>
                    {rows.slice(0, 300).map(r => {
                      const problem = r.errors.join('; ') || srvErr.get(r.row)
                      const dup = dupSet.has(r.row)
                      return (
                        <tr key={r.row} className="border-t" style={{ borderColor: FF.borderFaint, background: problem ? '#FDF4F2' : dup ? '#FBF6EA' : undefined }}>
                          <td className={tdCls} style={{ color: FF.textFaint }}>{r.row}</td>
                          <td className={`${tdCls} whitespace-nowrap`}>{r.data.paid_on ? fmtDate(r.data.paid_on) : '—'}</td>
                          <td className={tdCls}>{r.label.project || '—'}</td>
                          <td className={tdCls}>{r.data.category || '—'}</td>
                          <td className={tdCls}>{r.data.payee || ''}</td>
                          <td className={`${tdCls} text-right whitespace-nowrap`}>{r.data.amount > 0 ? inr(r.data.amount) : '—'}</td>
                          <td className={tdCls}>{r.data.voucher_ref || ''}</td>
                          <td className={tdCls}>{r.label.account || <span style={{ color: FF.textFaint }}>not tagged</span>}</td>
                          <td className={`${tdCls} text-xs`} style={{ color: problem ? FF.red : dup ? FF.amber : FF.green }}>
                            {problem || (dup ? (skipDupes ? 'Duplicate — left out' : 'Possible duplicate') : 'OK')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length > 300 && <div className="text-xs" style={{ color: FF.textMuted }}>Showing the first 300 of {rows.length} rows; all rows are checked and saved.</div>}
              {toSave.some(r => !r.data.bank_account_id) && (
                <div className="text-xs inline-flex items-center gap-1.5" style={{ color: FF.amber }}>
                  <AlertTriangle className="w-3.5 h-3.5" />Some rows have no "Paid From Account" — they will be flagged as untagged in the bank reconciliation.
                </div>
              )}
            </>
          )}
        </>
      )}
      <ErrorBox message={error} />
    </FmModal>
  )
}
