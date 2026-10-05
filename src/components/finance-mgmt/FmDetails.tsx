// Advance and Settlement detail modals, showing each viewer the actions open at the
// current step (manager approve/decline, Finance approve/pay/review/refund, requester
// cancel/submit bills, admin reassign). The server enforces every rule.

import { useEffect, useState, type ReactNode } from 'react'
import { FileText, ExternalLink, ReceiptIndianRupee, Wallet, Pencil } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useFm } from './fmContext'
import {
  canEditFinance, fmGet, fmPost, fmtDate, inr, openFmFile, todayIso, PAYMENT_MODE_LABEL,
  type Adjustment, type Advance, type FmEvent, type PaymentMode, type Settlement, type SettlementLine,
} from './fmApi'
import { Btn, ErrorBox, Field, FmModal, KV, LoadingRow, SectionTitle, StatusChip, Timeline, inputCls, inputStyle, tdCls, thCls } from './fmUi'
import { AdjustmentEditModal, AdvanceEditModal, SettlementEditModal } from './FmEditForms'

function MoneySummary({ a }: { a: Advance }) {
  const owed = a.balance < 0
  const cells: [string, string, string?][] = [
    ['Paid', inr(a.disbursed_amount)],
    ['Bills approved', inr(a.spent)],
    ['Bills pending', inr(a.pending_claims)],
    ['Refunded', inr(a.refunds)],
    ['Reimbursed', inr(a.reimbursements)],
    [owed ? 'Owed to employee' : 'Unspent balance', inr(Math.abs(a.balance)), Math.abs(a.balance) < 0.005 ? FF.green : owed ? FF.purple : FF.amber],
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {cells.map(([k, v, color]) => (
        <div key={k} className="rounded-xl px-3 py-2" style={{ background: FF.bg }}>
          <div className="text-[10.5px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{k}</div>
          <div className="text-sm font-bold" style={{ color: color || FF.tealDark }}>{v}</div>
        </div>
      ))}
    </div>
  )
}

function ActionBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: '#F7F4FC', border: `1px solid #E2D9F3` }}>
      <div className="text-xs font-bold uppercase tracking-wider" style={{ color: FF.purple }}>{title}</div>
      {children}
    </div>
  )
}

function NoteInput({ value, onChange, placeholder, disabled }: { value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean }) {
  return <textarea className={inputCls} style={inputStyle} rows={2} maxLength={1000} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} disabled={disabled} />
}

function PaymentFields({ mode, setMode, reference, setReference, date, setDate, disabled, dateLabel = 'Payment date' }: {
  // `reference`, not `ref` — React reserves `ref`, and a string there crashes the render.
  mode: PaymentMode | ''; setMode: (m: PaymentMode) => void; reference: string; setReference: (s: string) => void
  date: string; setDate: (s: string) => void; disabled?: boolean; dateLabel?: string
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Field label={dateLabel} required>
        <input type="date" className={inputCls} style={inputStyle} value={date} max={todayIso()} onChange={e => setDate(e.target.value)} disabled={disabled} />
      </Field>
      <Field label="Mode" required>
        <select className={inputCls} style={inputStyle} value={mode} onChange={e => setMode(e.target.value as PaymentMode)} disabled={disabled}>
          <option value="">Select…</option>
          {(Object.keys(PAYMENT_MODE_LABEL) as PaymentMode[]).map(m => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
        </select>
      </Field>
      <Field label="Reference / UTR" required={mode !== 'cash' && mode !== ''}>
        <input className={inputCls} style={inputStyle} value={reference} maxLength={200} onChange={e => setReference(e.target.value)} disabled={disabled} placeholder={mode === 'cheque' ? 'Cheque no.' : 'UTR / txn id'} />
      </Field>
    </div>
  )
}

/** Optional bank account (Budget Management) — shown only once Finance has accounts set up. */
function AccountPicker({ value, onChange, label, disabled }: { value: string; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  const { me } = useFm()
  if (!me.bank_accounts?.length) return null
  return (
    <Field label={label} hint="Counts this payment in that account's balance in Budget Management.">
      <select className={inputCls} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
        <option value="">Not tagged</option>
        {me.bank_accounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </Field>
  )
}

function ReassignBox({ kind, id, onDone }: { kind: 'advances' | 'settlements'; id: string; onDone: () => void }) {
  const { me } = useFm()
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <ActionBox title="Admin · reassign approver">
      <div className="flex flex-col sm:flex-row gap-2">
        <select className={inputCls} style={inputStyle} value={to} onChange={e => setTo(e.target.value)} disabled={busy}>
          <option value="">Choose a new approving manager…</option>
          {me.approvers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <Btn busy={busy} disabled={!to} onClick={async () => {
          setBusy(true); setError(null)
          try { await fmPost(`/${kind}/${id}/reassign`, { manager_id: to }); onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
        }}>Reassign</Btn>
      </div>
      <ErrorBox message={error} />
    </ActionBox>
  )
}

// ══ Advance detail ═══════════════════════════════════════════════════════════
interface AdvanceDetail { advance: Advance; settlements: Settlement[]; adjustments: Adjustment[]; events: FmEvent[] }

export function AdvanceDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { me, changed, version, openSettlement, newSettlement } = useFm()
  const [data, setData] = useState<AdvanceDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [approvedAmt, setApprovedAmt] = useState('')
  const [payAmt, setPayAmt] = useState('')
  const [payDate, setPayDate] = useState(todayIso())
  const [payMode, setPayMode] = useState<PaymentMode | ''>('')
  const [payRef, setPayRef] = useState('')
  const [payAccount, setPayAccount] = useState('')
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [adjEdit, setAdjEdit] = useState<Adjustment | null>(null)

  useEffect(() => {
    if (!id) { setData(null); return }
    let cancelled = false
    setLoadError(null)
    fmGet<AdvanceDetail>(`/advances/${id}`)
      .then(d => {
        if (cancelled) return
        setData(d)
        setApprovedAmt(String(d.advance.amount_requested))
        setPayAmt(String(d.advance.amount_approved ?? ''))
        const b = d.advance.balance
        if (Math.abs(b) >= 0.005) setPayAmt(String(Math.abs(b)))
      })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message) })
    return () => { cancelled = true }
  }, [id, version])

  useEffect(() => { setNote(''); setError(null); setPayMode(''); setPayRef(''); setPayDate(todayIso()); setAdjustOpen(false); setPayAccount('') }, [id])

  async function act(path: string, body: unknown) {
    setBusy(true); setError(null)
    try {
      await fmPost(path, body)
      setNote(''); setPayRef(''); setPayMode(''); setAdjustOpen(false); setPayAccount('')
      changed()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const a = data?.advance
  const mine = a?.requester_id === me.me.id
  const isManagerStep = !!a && a.status === 'pending_manager' && a.manager_id === me.me.id && !mine
  const isFinanceStep = !!a && me.me.is_finance && !mine && a.status === 'pending_finance'
  const canDisburse   = !!a && me.me.is_finance && !mine && a.status === 'approved'
  const canAdjust     = !!a && me.me.is_finance && !mine && a.status === 'disbursed' && Math.abs(a.balance) >= 0.005
  // The adjust form opens by itself only once bills are approved and none are pending;
  // before that (e.g. refunding a cancelled activity) it sits behind a button.
  const showAdjust    = canAdjust && (adjustOpen || (a!.spent > 0 && a!.pending_settlements === 0))
  const canCancel     = !!a && mine && ['pending_manager', 'pending_finance', 'approved'].includes(a.status)
  const canSettle     = !!a && mine && a.status === 'disbursed'
  const canReassign   = !!a && me.me.is_admin && a.status === 'pending_manager'
  // Finance team + admins correct any field at any stage — never their own request.
  const canEdit       = !!a && canEditFinance(me) && !mine

  return (
    <FmModal
      open={!!id} onClose={onClose} busy={busy} size="xl"
      title={a ? `Advance ${a.ref_no}` : 'Advance'}
      subtitle={a && <span className="inline-flex items-center gap-2"><StatusChip status={a.status} kind="advance" /> Requested {fmtDate(a.created_at)} by {a.requester_name}</span>}
      footer={a && (
        <>
          {canCancel && <Btn variant="danger" busy={busy} onClick={() => { if (confirm('Cancel this advance request?')) act(`/advances/${a.id}/cancel`, {}) }}>Cancel request</Btn>}
          {canSettle && <Btn variant="primary" onClick={() => newSettlement(a.id)}><ReceiptIndianRupee className="w-3.5 h-3.5" />Submit bills</Btn>}
          {canEdit && <Btn onClick={() => setEditing(true)} disabled={busy}><Pencil className="w-3.5 h-3.5" />Edit</Btn>}
          <Btn onClick={onClose} disabled={busy}>Close</Btn>
        </>
      )}
    >
      {loadError ? <ErrorBox message={loadError} /> : !a ? <LoadingRow /> : (
        <>
          <KV items={[
            ['Project', a.project_name || a.project_key],
            ['Budget line', a.budget_head ? `${a.budget_section ? a.budget_section + ' › ' : ''}${a.budget_head}` : 'Not linked'],
            ['Purpose', a.purpose],
            ['Amount requested', <b key="r">{inr(a.amount_requested)}</b>],
            ['Amount approved', a.amount_approved != null ? inr(a.amount_approved) : '—'],
            ['Needed by', fmtDate(a.needed_by)],
            ['Activity dates', a.activity_from ? `${fmtDate(a.activity_from)}${a.activity_to ? ' – ' + fmtDate(a.activity_to) : ''}` : '—'],
            ['Approving manager', a.manager_name || '—'],
            ...(a.disbursed_on ? [['Payment', `${inr(a.disbursed_amount)} on ${fmtDate(a.disbursed_on)} · ${a.payment_mode ? PAYMENT_MODE_LABEL[a.payment_mode] : ''}${a.payment_ref ? ' · ' + a.payment_ref : ''}`] as [string, ReactNode]] : []),
            ...(a.manager_note ? [['Manager note', a.manager_note] as [string, ReactNode]] : []),
            ...(a.finance_note ? [['Finance note', a.finance_note] as [string, ReactNode]] : []),
          ]} />

          {(a.status === 'disbursed' || a.status === 'settled') && (
            <>
              <SectionTitle>Settlement position</SectionTitle>
              <MoneySummary a={a} />
            </>
          )}

          {isManagerStep && (
            <ActionBox title="Your approval (reporting manager)">
              <NoteInput value={note} onChange={setNote} placeholder="Note (required if you decline)" disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Btn variant="success" busy={busy} onClick={() => act(`/advances/${a.id}/manager-decision`, { decision: 'approve', note })}>Approve</Btn>
                <Btn variant="danger" busy={busy} onClick={() => act(`/advances/${a.id}/manager-decision`, { decision: 'reject', note })}>Decline</Btn>
              </div>
            </ActionBox>
          )}

          {isFinanceStep && (
            <ActionBox title="Finance approval">
              <Field label="Amount to approve (₹)" hint={`Requested ${inr(a.amount_requested)}. You can approve less.`}>
                <input type="number" min="1" step="0.01" max={a.amount_requested} className={inputCls} style={inputStyle}
                  value={approvedAmt} onChange={e => setApprovedAmt(e.target.value)} disabled={busy} />
              </Field>
              <NoteInput value={note} onChange={setNote} placeholder="Note (required if you reject or approve less)" disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Btn variant="success" busy={busy} onClick={() => act(`/advances/${a.id}/finance-decision`, { decision: 'approve', note, amount_approved: approvedAmt })}>Approve</Btn>
                <Btn variant="danger" busy={busy} onClick={() => act(`/advances/${a.id}/finance-decision`, { decision: 'reject', note })}>Reject</Btn>
              </div>
            </ActionBox>
          )}

          {canDisburse && (
            <ActionBox title="Record payment to employee">
              <Field label="Amount paid (₹)" hint={`Approved ${inr(a.amount_approved)}`}>
                <input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={payAmt} onChange={e => setPayAmt(e.target.value)} disabled={busy} />
              </Field>
              <PaymentFields mode={payMode} setMode={setPayMode} reference={payRef} setReference={setPayRef} date={payDate} setDate={setPayDate} disabled={busy} />
              <AccountPicker label="Paid from account" value={payAccount} onChange={setPayAccount} disabled={busy} />
              <Btn variant="primary" busy={busy} onClick={() => act(`/advances/${a.id}/disburse`, { amount: payAmt, disbursed_on: payDate, payment_mode: payMode, payment_ref: payRef, bank_account_id: payAccount || null })}>
                <Wallet className="w-3.5 h-3.5" />Mark as paid
              </Btn>
            </ActionBox>
          )}

          {canAdjust && !showAdjust && (
            <Btn small onClick={() => setAdjustOpen(true)}>Record refund / reimbursement…</Btn>
          )}
          {showAdjust && (
            <ActionBox title={a.balance > 0 ? 'Record refund from employee' : 'Record reimbursement to employee'}>
              <div className="text-xs" style={{ color: FF.textMuted }}>
                {a.balance > 0
                  ? `${a.requester_name} holds ${inr(a.balance)} unspent${a.pending_settlements ? ` (and has ${a.pending_settlements} settlement(s) still under review — you may want to wait)` : ''}.`
                  : `${inr(-a.balance)} is owed to ${a.requester_name} for spending above the advance.`}
              </div>
              <Field label="Amount (₹)">
                <input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={payAmt} onChange={e => setPayAmt(e.target.value)} disabled={busy} />
              </Field>
              <PaymentFields mode={payMode} setMode={setPayMode} reference={payRef} setReference={setPayRef} date={payDate} setDate={setPayDate} disabled={busy} dateLabel="Date" />
              <AccountPicker label={a.balance > 0 ? 'Received into account' : 'Paid from account'} value={payAccount} onChange={setPayAccount} disabled={busy} />
              <NoteInput value={note} onChange={setNote} placeholder="Note (optional)" disabled={busy} />
              <Btn variant="primary" busy={busy} onClick={() => act(`/advances/${a.id}/adjustments`, {
                kind: a.balance > 0 ? 'refund' : 'reimbursement', amount: payAmt, txn_date: payDate, payment_mode: payMode, payment_ref: payRef, note, bank_account_id: payAccount || null,
              })}>
                {a.balance > 0 ? 'Record refund' : 'Record reimbursement'}
              </Btn>
            </ActionBox>
          )}

          {canReassign && <ReassignBox kind="advances" id={a.id} onDone={changed} />}
          <ErrorBox message={error} />

          {data!.settlements.length > 0 && (
            <>
              <SectionTitle>Settlements</SectionTitle>
              <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
                <table className="w-full min-w-[520px]">
                  <thead style={{ background: FF.bg, color: FF.textMuted }}>
                    <tr><th className={thCls}>Ref</th><th className={thCls}>Submitted</th><th className={thCls}>Claimed</th><th className={thCls}>Approved</th><th className={thCls}>Status</th></tr>
                  </thead>
                  <tbody>
                    {data!.settlements.map(s => (
                      <tr key={s.id} className="border-t cursor-pointer hover:bg-gray-50" style={{ borderColor: FF.borderFaint }} onClick={() => openSettlement(s.id)}>
                        <td className={tdCls} style={{ color: FF.purple, fontWeight: 600 }}>{s.ref_no}</td>
                        <td className={tdCls}>{fmtDate(s.created_at)}</td>
                        <td className={tdCls}>{inr(s.amount_claimed)}</td>
                        <td className={tdCls}>{s.amount_approved != null ? inr(s.amount_approved) : '—'}</td>
                        <td className={tdCls}><StatusChip status={s.status} kind="settlement" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data!.adjustments.length > 0 && (
            <>
              <SectionTitle>Refunds &amp; reimbursements</SectionTitle>
              <ul className="space-y-1.5">
                {data!.adjustments.map(j => (
                  <li key={j.id} className="text-sm flex flex-wrap gap-x-2" style={{ color: FF.tealDark }}>
                    <b>{j.kind === 'refund' ? 'Refund received' : 'Reimbursed'} {inr(j.amount)}</b>
                    <span style={{ color: FF.textMuted }}>
                      {fmtDate(j.txn_date)}{j.payment_mode ? ` · ${PAYMENT_MODE_LABEL[j.payment_mode]}` : ''}{j.payment_ref ? ` · ${j.payment_ref}` : ''} · by {j.recorded_by_name}{j.note ? ` — ${j.note}` : ''}
                    </span>
                    {canEdit && (
                      <button className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: FF.purple }} onClick={() => setAdjEdit(j)}>
                        <Pencil className="w-3 h-3" />Edit
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <SectionTitle>History</SectionTitle>
          <Timeline events={data!.events} />
          <AdvanceEditModal advance={editing ? a : null} onClose={() => setEditing(false)} />
          <AdjustmentEditModal advanceId={a.id} adj={adjEdit} onClose={() => setAdjEdit(null)} />
        </>
      )}
    </FmModal>
  )
}

// ══ Settlement detail ════════════════════════════════════════════════════════
interface SettlementDetail { settlement: Settlement; lines: SettlementLine[]; advance: Advance; events: FmEvent[] }

export function SettlementDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { me, changed, version, openAdvance } = useFm()
  const [data, setData] = useState<SettlementDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [lineAmt, setLineAmt] = useState<Record<string, string>>({})
  const [fileError, setFileError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!id) { setData(null); return }
    let cancelled = false
    setLoadError(null)
    fmGet<SettlementDetail>(`/settlements/${id}`)
      .then(d => {
        if (cancelled) return
        setData(d)
        setLineAmt(Object.fromEntries(d.lines.map(l => [l.id, String(l.amount_approved ?? l.amount)])))
      })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message) })
    return () => { cancelled = true }
  }, [id, version])

  useEffect(() => { setNote(''); setError(null); setFileError(null) }, [id])

  async function act(path: string, body: unknown) {
    setBusy(true); setError(null)
    try { await fmPost(path, body); setNote(''); changed() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const s = data?.settlement
  const mine = s?.submitted_by === me.me.id
  const isManagerStep = !!s && s.status === 'pending_manager' && s.manager_id === me.me.id && !mine
  const isFinanceStep = !!s && me.me.is_finance && !mine && s.status === 'pending_finance'
  const canWithdraw   = !!s && mine && ['pending_manager', 'pending_finance'].includes(s.status)
  const canReassign   = !!s && me.me.is_admin && s.status === 'pending_manager'
  const canEdit       = !!s && canEditFinance(me) && !mine && s.status !== 'cancelled'
  const approvedTotal = data ? data.lines.reduce((t, l) => t + (Number(lineAmt[l.id]) || 0), 0) : 0

  return (
    <FmModal
      open={!!id} onClose={onClose} busy={busy} size="xl"
      title={s ? `Settlement ${s.ref_no}` : 'Settlement'}
      subtitle={s && <span className="inline-flex items-center gap-2"><StatusChip status={s.status} kind="settlement" /> Submitted {fmtDate(s.created_at)} by {s.submitted_by_name}</span>}
      footer={s && (
        <>
          {canWithdraw && <Btn variant="danger" busy={busy} onClick={() => { if (confirm('Withdraw this settlement?')) act(`/settlements/${s.id}/cancel`, {}) }}>Withdraw</Btn>}
          <Btn onClick={() => openAdvance(s.advance_id)}>Open advance {s.advance_ref}</Btn>
          {canEdit && <Btn onClick={() => setEditing(true)} disabled={busy}><Pencil className="w-3.5 h-3.5" />Edit</Btn>}
          <Btn onClick={onClose} disabled={busy}>Close</Btn>
        </>
      )}
    >
      {loadError ? <ErrorBox message={loadError} /> : !s || !data ? <LoadingRow /> : (
        <>
          <KV items={[
            ['Advance', `${s.advance_ref} — ${s.advance_purpose}`],
            ['Project', s.project_name || s.project_key],
            ['Amount claimed', <b key="c">{inr(s.amount_claimed)}</b>],
            ['Amount approved', s.amount_approved != null ? inr(s.amount_approved) : '—'],
            ['Approving manager', s.manager_name || '—'],
            ...(s.note ? [['Note from employee', s.note] as [string, ReactNode]] : []),
            ...(s.manager_note ? [['Manager note', s.manager_note] as [string, ReactNode]] : []),
            ...(s.finance_note ? [['Finance note', s.finance_note] as [string, ReactNode]] : []),
          ]} />

          <SectionTitle>Expenses &amp; bills</SectionTitle>
          <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
            <table className="w-full min-w-[640px]">
              <thead style={{ background: FF.bg, color: FF.textMuted }}>
                <tr>
                  <th className={thCls}>Date</th><th className={thCls}>Category</th><th className={thCls}>Description</th>
                  <th className={`${thCls} text-right`}>Claimed</th>
                  <th className={`${thCls} text-right`}>{isFinanceStep ? 'Approve (₹)' : 'Approved'}</th>
                  <th className={thCls}>Bill</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map(l => (
                  <tr key={l.id} className="border-t" style={{ borderColor: FF.borderFaint }}>
                    <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(l.expense_date)}</td>
                    <td className={tdCls}>{l.category}</td>
                    <td className={tdCls} style={{ color: FF.textMuted }}>{l.description || '—'}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(l.amount)}</td>
                    <td className={`${tdCls} text-right`}>
                      {isFinanceStep ? (
                        <input type="number" min="0" max={l.amount} step="0.01" aria-label="Approved amount"
                          className="w-28 rounded-lg px-2 py-1 text-sm text-right outline-none" style={inputStyle}
                          value={lineAmt[l.id] ?? ''} onChange={e => setLineAmt(m => ({ ...m, [l.id]: e.target.value }))} disabled={busy} />
                      ) : l.amount_approved != null ? (
                        <span style={{ color: l.amount_approved < l.amount ? FF.red : FF.tealDark }}>{inr(l.amount_approved)}</span>
                      ) : '—'}
                    </td>
                    <td className={tdCls}>
                      <button className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: FF.purple }}
                        onClick={() => { setFileError(null); openFmFile(l.bill_file_id).catch(e => setFileError(e.message)) }}>
                        <FileText className="w-3.5 h-3.5" />View<ExternalLink className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox message={fileError} />

          <SectionTitle>Advance position</SectionTitle>
          <MoneySummary a={data.advance} />

          {isManagerStep && (
            <ActionBox title="Your approval (reporting manager)">
              <div className="text-xs" style={{ color: FF.textMuted }}>Check the expenses are genuine and for this activity. Finance will verify the bills.</div>
              <NoteInput value={note} onChange={setNote} placeholder="Note (required if you send it back)" disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Btn variant="success" busy={busy} onClick={() => act(`/settlements/${s.id}/manager-decision`, { decision: 'approve', note })}>Approve</Btn>
                <Btn variant="danger" busy={busy} onClick={() => act(`/settlements/${s.id}/manager-decision`, { decision: 'reject', note })}>Send back</Btn>
              </div>
            </ActionBox>
          )}

          {isFinanceStep && (
            <ActionBox title="Finance review">
              <div className="text-sm" style={{ color: FF.tealDark }}>
                Approving <b>{inr(approvedTotal)}</b> of {inr(s.amount_claimed)} claimed.
                {approvedTotal < s.amount_claimed - 0.005 && <span style={{ color: FF.red }}> {inr(s.amount_claimed - approvedTotal)} disallowed — add a note.</span>}
              </div>
              <NoteInput value={note} onChange={setNote} placeholder="Note (required if you reject or disallow any amount)" disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Btn variant="success" busy={busy} onClick={() => act(`/settlements/${s.id}/finance-decision`, {
                  decision: 'approve', note, lines: data.lines.map(l => ({ id: l.id, amount_approved: lineAmt[l.id] })),
                })}>Approve settlement</Btn>
                <Btn variant="danger" busy={busy} onClick={() => act(`/settlements/${s.id}/finance-decision`, { decision: 'reject', note })}>Reject</Btn>
              </div>
            </ActionBox>
          )}

          {canReassign && <ReassignBox kind="settlements" id={s.id} onDone={changed} />}
          <ErrorBox message={error} />

          <SectionTitle>History</SectionTitle>
          <Timeline events={data.events} />
          <SettlementEditModal settlement={editing ? s : null} lines={data.lines} onClose={() => setEditing(false)} />
        </>
      )}
    </FmModal>
  )
}
