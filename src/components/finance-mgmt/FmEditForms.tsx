// Finance/admin correction forms (services/finance/src/edits.js) for advances, adjustments,
// settlements and ledger requests. The server logs each change old → new, notifies the
// requester, refuses edits to your own requests and recomputes balances.

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Paperclip, CheckCircle2, Loader2, FileText, Upload } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import {
  fmDelete, fmGet, fmPatch, inr, openFmFile, uploadFmFile, PAYMENT_MODE_LABEL,
  type Adjustment, type Advance, type LedgerRequest, type PaymentMode, type Settlement, type SettlementLine,
} from './fmApi'
import { Btn, ErrorBox, Field, FmModal, inputCls, inputStyle, tdCls, thCls } from './fmUi'

function useSave(onDone: () => void, openKey: unknown) {
  const { changed } = useFm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setError(null) }, [openKey])
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); changed(); onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return { busy, error, run }
}

function AccountSelect({ value, onChange, disabled, currentName }: { value: string; onChange: (v: string) => void; disabled?: boolean; currentName?: string | null }) {
  const { me } = useFm()
  const list = me.bank_accounts || []
  return (
    <select className={inputCls} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      <option value="">Not tagged</option>
      {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      {value && !list.some(a => a.id === value) && <option value={value}>{currentName || 'Current account'} (inactive)</option>}
    </select>
  )
}

const MODES = Object.keys(PAYMENT_MODE_LABEL) as PaymentMode[]

// ══ Advance ═════════════════════════════════════════════════════════════════
export function AdvanceEditModal({ advance: a, onClose }: { advance: Advance | null; onClose: () => void }) {
  const { me } = useFm()
  const { projects, loadProjects } = useProjectContext()
  const [f, setF] = useState<Record<string, string>>({})
  const [lines, setLines] = useState<{ section: string; budget_head: string; budget_line_item: string | null }[]>([])
  const { busy, error, run } = useSave(onClose, a)
  const paid = a?.status === 'disbursed' || a?.status === 'settled'
  const approvedStage = paid || a?.status === 'approved'

  useEffect(() => {
    if (!a) return
    if (!projects.length) void loadProjects()
    setF({
      project_key: a.project_key, budget: a.budget_head ? `${a.budget_section || ''}||${a.budget_head}` : '', purpose: a.purpose,
      amount_requested: String(a.amount_requested), amount_approved: a.amount_approved != null ? String(a.amount_approved) : '',
      needed_by: a.needed_by || '', activity_from: a.activity_from || '', activity_to: a.activity_to || '', finance_note: a.finance_note || '',
      disbursed_amount: a.disbursed_amount != null ? String(a.disbursed_amount) : '', disbursed_on: a.disbursed_on || '',
      payment_mode: a.payment_mode || '', payment_ref: a.payment_ref || '', bank_account_id: a.bank_account_id || '',
    })
  }, [a]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!f.project_key) { setLines([]); return }
    let cancelled = false
    fmGet<{ lines: typeof lines }>(`/budget-lines?project=${encodeURIComponent(f.project_key)}`)
      .then(d => { if (!cancelled) setLines(d.lines) }).catch(() => { if (!cancelled) setLines([]) })
    return () => { cancelled = true }
  }, [f.project_key])

  const set = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const grouped = useMemo(() => {
    const m = new Map<string, typeof lines>()
    for (const l of lines) m.set(l.section, [...(m.get(l.section) || []), l])
    return [...m.entries()]
  }, [lines])

  function save() {
    if (!a) return
    const [section, head] = f.budget ? f.budget.split('||') : [null, null]
    const body: Record<string, unknown> = {
      project_key: f.project_key, project_name: projects.find(p => p.project_key === f.project_key)?.name || a.project_name,
      budget_section: section || null, budget_head: head || null, purpose: f.purpose, amount_requested: f.amount_requested,
      needed_by: f.needed_by || null, activity_from: f.activity_from || null, activity_to: f.activity_to || null, finance_note: f.finance_note,
    }
    if (approvedStage && f.amount_approved) body.amount_approved = f.amount_approved
    if (paid) Object.assign(body, {
      disbursed_amount: f.disbursed_amount, disbursed_on: f.disbursed_on, payment_mode: f.payment_mode, payment_ref: f.payment_ref,
      ...(me.bank_accounts?.length || a.bank_account_id ? { bank_account_id: f.bank_account_id || null } : {}),
    })
    return run(() => fmPatch(`/advances/${a.id}`, body))
  }

  return (
    <FmModal open={!!a} onClose={onClose} busy={busy} size="lg" title={a ? `Edit advance ${a.ref_no}` : 'Edit advance'}
      subtitle="Every change is saved in the advance's history (old → new) and the requester is notified."
      footer={<><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn variant="primary" busy={busy} onClick={save}>Save changes</Btn></>}>
      {a && <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Project" required>
            <select className={inputCls} style={inputStyle} value={f.project_key || ''} onChange={e => setF(x => ({ ...x, project_key: e.target.value, budget: '' }))} disabled={busy}>
              {!projects.some(p => p.project_key === a.project_key) && <option value={a.project_key}>{a.project_name || a.project_key}</option>}
              {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Budget line">
            <select className={inputCls} style={inputStyle} value={f.budget || ''} onChange={set('budget')} disabled={busy}>
              <option value="">Not linked to a budget line</option>
              {f.budget && !lines.some(l => `${l.section}||${l.budget_head}` === f.budget) && <option value={f.budget}>{f.budget.split('||')[1]}</option>}
              {grouped.map(([sec, ls]) => (
                <optgroup key={sec} label={sec}>{ls.map(l => <option key={l.budget_head} value={`${l.section}||${l.budget_head}`}>{l.budget_line_item ? `${l.budget_line_item} · ` : ''}{l.budget_head}</option>)}</optgroup>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Purpose" required><textarea className={inputCls} style={inputStyle} rows={2} value={f.purpose || ''} onChange={set('purpose')} disabled={busy} /></Field>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Amount requested (₹)" required><input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount_requested || ''} onChange={set('amount_requested')} disabled={busy} /></Field>
          {approvedStage && <Field label="Amount approved (₹)"><input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount_approved || ''} onChange={set('amount_approved')} disabled={busy} /></Field>}
          <Field label="Needed by"><input type="date" className={inputCls} style={inputStyle} value={f.needed_by || ''} onChange={set('needed_by')} disabled={busy} /></Field>
          <Field label="Activity from"><input type="date" className={inputCls} style={inputStyle} value={f.activity_from || ''} onChange={set('activity_from')} disabled={busy} /></Field>
          <Field label="Activity to"><input type="date" className={inputCls} style={inputStyle} value={f.activity_to || ''} onChange={set('activity_to')} disabled={busy} /></Field>
        </div>
        {paid && (
          <div className="rounded-xl p-3 space-y-3" style={{ background: FF.bg }}>
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: FF.textMuted }}>Payment</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field label="Amount paid (₹)" required><input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.disbursed_amount || ''} onChange={set('disbursed_amount')} disabled={busy} /></Field>
              <Field label="Paid on" required><input type="date" className={inputCls} style={inputStyle} value={f.disbursed_on || ''} onChange={set('disbursed_on')} disabled={busy} /></Field>
              <Field label="Mode" required>
                <select className={inputCls} style={inputStyle} value={f.payment_mode || ''} onChange={set('payment_mode')} disabled={busy}>
                  {MODES.map(m => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
                </select>
              </Field>
              <Field label="Reference / UTR"><input className={inputCls} style={inputStyle} value={f.payment_ref || ''} onChange={set('payment_ref')} disabled={busy} /></Field>
            </div>
            {(me.bank_accounts?.length || a.bank_account_id) ? (
              <Field label="Paid from account"><AccountSelect value={f.bank_account_id || ''} onChange={v => setF(x => ({ ...x, bank_account_id: v }))} disabled={busy} /></Field>
            ) : null}
          </div>
        )}
        <Field label="Finance note"><input className={inputCls} style={inputStyle} value={f.finance_note || ''} onChange={set('finance_note')} disabled={busy} /></Field>
        <ErrorBox message={error} />
      </>}
    </FmModal>
  )
}

// ══ Refund / reimbursement ═══════════════════════════════════════════════════
export function AdjustmentEditModal({ advanceId, adj, onClose }: { advanceId: string; adj: Adjustment | null; onClose: () => void }) {
  const { me } = useFm()
  const [f, setF] = useState<Record<string, string>>({})
  const { busy, error, run } = useSave(onClose, adj)
  useEffect(() => {
    if (adj) setF({ amount: String(adj.amount), txn_date: adj.txn_date, payment_mode: adj.payment_mode || 'cash', payment_ref: adj.payment_ref || '', note: adj.note || '', bank_account_id: adj.bank_account_id || '' })
  }, [adj])
  const set = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const label = adj?.kind === 'refund' ? 'refund' : 'reimbursement'
  return (
    <FmModal open={!!adj} onClose={onClose} busy={busy} size="md" title={`Edit ${label}`}
      subtitle="The advance balance recalculates; the change is recorded in its history."
      footer={adj && <>
        <Btn variant="danger" busy={busy} className="mr-auto" onClick={() => { if (confirm(`Remove this ${label} of ${inr(adj.amount)}?`)) run(() => fmDelete(`/advances/${advanceId}/adjustments/${adj.id}`)) }}>
          <Trash2 className="w-3.5 h-3.5" />Remove
        </Btn>
        <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} onClick={() => run(() => fmPatch(`/advances/${advanceId}/adjustments/${adj.id}`, {
          amount: f.amount, txn_date: f.txn_date, payment_mode: f.payment_mode, payment_ref: f.payment_ref, note: f.note,
          ...(me.bank_accounts?.length || adj.bank_account_id ? { bank_account_id: f.bank_account_id || null } : {}),
        }))}>Save changes</Btn>
      </>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount (₹)" required><input type="number" min="1" step="0.01" className={inputCls} style={inputStyle} value={f.amount || ''} onChange={set('amount')} disabled={busy} /></Field>
        <Field label="Date" required><input type="date" className={inputCls} style={inputStyle} value={f.txn_date || ''} onChange={set('txn_date')} disabled={busy} /></Field>
        <Field label="Mode" required>
          <select className={inputCls} style={inputStyle} value={f.payment_mode || ''} onChange={set('payment_mode')} disabled={busy}>
            {MODES.map(m => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
          </select>
        </Field>
        <Field label="Reference"><input className={inputCls} style={inputStyle} value={f.payment_ref || ''} onChange={set('payment_ref')} disabled={busy} /></Field>
      </div>
      {(me.bank_accounts?.length || adj?.bank_account_id) ? (
        <Field label={adj?.kind === 'refund' ? 'Received into account' : 'Paid from account'}>
          <AccountSelect value={f.bank_account_id || ''} onChange={v => setF(x => ({ ...x, bank_account_id: v }))} disabled={busy} />
        </Field>
      ) : null}
      <Field label="Note"><input className={inputCls} style={inputStyle} value={f.note || ''} onChange={set('note')} disabled={busy} /></Field>
      <ErrorBox message={error} />
    </FmModal>
  )
}

// ══ Settlement + bill lines ══════════════════════════════════════════════════
interface LineDraft {
  key: string; id?: string; expense_date: string; category: string; description: string; amount: string; amount_approved: string
  bill_file_id: string; bill_name: string; replaced: boolean; remove: boolean; uploading: boolean
}

export function SettlementEditModal({ settlement: s, lines: initial, onClose }: { settlement: Settlement | null; lines: SettlementLine[]; onClose: () => void }) {
  const { me } = useFm()
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([])
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const { busy, error, run } = useSave(onClose, s)
  const approved = s?.status === 'approved'

  useEffect(() => {
    if (!s) return
    setNote(s.note || ''); setUploadErr(null)
    setLines(initial.map(l => ({
      key: l.id, id: l.id, expense_date: l.expense_date, category: l.category, description: l.description || '', amount: String(l.amount),
      amount_approved: l.amount_approved != null ? String(l.amount_approved) : '', bill_file_id: l.bill_file_id, bill_name: l.bill_file_name,
      replaced: false, remove: false, uploading: false,
    })))
  }, [s, initial])

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)))
  const cats = [...new Set([...me.expense_categories, ...lines.map(l => l.category).filter(Boolean)])]
  const kept = lines.filter(l => !l.remove)
  const claimed = kept.reduce((t, l) => t + (Number(l.amount) || 0), 0)
  const approvedTotal = kept.reduce((t, l) => t + (Number(l.amount_approved === '' ? l.amount : l.amount_approved) || 0), 0)

  async function attach(key: string, file: File | undefined) {
    if (!file) return
    setLine(key, { uploading: true }); setUploadErr(null)
    try {
      const up = await uploadFmFile(file, 'bill')
      setLine(key, { uploading: false, bill_file_id: up.id, bill_name: up.file_name, replaced: true })
    } catch (e) {
      setLine(key, { uploading: false }); setUploadErr((e as Error).message)
    }
  }

  function save() {
    if (!s) return
    const body = {
      note,
      lines: lines.map(l => l.id
        ? (l.remove ? { id: l.id, remove: true } : {
            id: l.id, expense_date: l.expense_date, category: l.category, description: l.description, amount: l.amount,
            ...(approved ? { amount_approved: l.amount_approved } : {}), ...(l.replaced ? { bill_file_id: l.bill_file_id } : {}),
          })
        : { expense_date: l.expense_date, category: l.category, description: l.description, amount: l.amount,
            ...(approved ? { amount_approved: l.amount_approved } : {}), bill_file_id: l.bill_file_id }),
    }
    return run(() => fmPatch(`/settlements/${s.id}`, body))
  }

  return (
    <FmModal open={!!s} onClose={onClose} busy={busy} size="2xl" title={s ? `Edit settlement ${s.ref_no}` : 'Edit settlement'}
      subtitle="Change, add or remove bill lines. Totals and the advance balance recalculate; every change goes into the history."
      footer={<>
        <span className="mr-auto self-center text-sm" style={{ color: FF.tealDark }}>
          Claimed <b>{inr(claimed)}</b>{approved && <> · approved <b>{inr(approvedTotal)}</b></>}
        </span>
        <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} disabled={lines.some(l => l.uploading)} onClick={save}>Save changes</Btn>
      </>}>
      <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
        <table className="w-full min-w-[940px]">
          <thead style={{ background: FF.bg, color: FF.textMuted }}>
            <tr>
              <th className={thCls}>Date</th><th className={thCls}>Category</th><th className={thCls}>Description</th>
              <th className={thCls}>Claimed (₹)</th>{approved && <th className={thCls}>Approved (₹)</th>}<th className={thCls}>Bill</th><th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.key} className="border-t" style={{ borderColor: FF.borderFaint, opacity: l.remove ? 0.45 : 1 }}>
                <td className={tdCls}><input type="date" className={`${inputCls} w-[150px]`} style={inputStyle} value={l.expense_date} onChange={e => setLine(l.key, { expense_date: e.target.value })} disabled={busy || l.remove} /></td>
                <td className={tdCls}>
                  <select className={`${inputCls} min-w-[160px]`} style={inputStyle} value={l.category} onChange={e => setLine(l.key, { category: e.target.value })} disabled={busy || l.remove}>
                    <option value="">Select…</option>{cats.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className={tdCls}><input className={`${inputCls} min-w-[200px]`} style={inputStyle} value={l.description} onChange={e => setLine(l.key, { description: e.target.value })} disabled={busy || l.remove} /></td>
                <td className={tdCls}><input type="number" min="1" step="0.01" className={`${inputCls} w-28`} style={inputStyle} value={l.amount} onChange={e => setLine(l.key, { amount: e.target.value })} disabled={busy || l.remove} /></td>
                {approved && <td className={tdCls}><input type="number" min="0" step="0.01" className={`${inputCls} w-28`} style={inputStyle} value={l.amount_approved} placeholder={l.amount} onChange={e => setLine(l.key, { amount_approved: e.target.value })} disabled={busy || l.remove} /></td>}
                <td className={`${tdCls} whitespace-nowrap`}>
                  <div className="flex items-center gap-2">
                    {l.bill_file_id && (
                      <button className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: FF.purple }} onClick={() => openFmFile(l.bill_file_id).catch(e => setUploadErr(e.message))} title={l.bill_name}>
                        <FileText className="w-3.5 h-3.5" />{l.replaced ? 'New bill' : 'View'}
                      </button>
                    )}
                    <label className={`inline-flex items-center gap-1 text-xs font-semibold cursor-pointer ${busy || l.remove || l.uploading ? 'opacity-50 pointer-events-none' : ''}`} style={{ color: l.bill_file_id ? FF.tealDark : FF.red }}>
                      {l.uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : l.replaced ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Paperclip className="w-3.5 h-3.5" />}
                      {l.bill_file_id ? 'Replace' : 'Attach *'}
                      <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { attach(l.key, e.target.files?.[0]); e.target.value = '' }} />
                    </label>
                  </div>
                </td>
                <td className={tdCls}>
                  {l.id ? (
                    <button className="text-xs font-semibold" style={{ color: l.remove ? FF.tealDark : FF.red }} onClick={() => setLine(l.key, { remove: !l.remove })} disabled={busy}>
                      {l.remove ? 'Undo' : 'Remove'}
                    </button>
                  ) : (
                    <button aria-label="Discard new line" style={{ color: FF.red }} onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} disabled={busy}><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Btn small onClick={() => setLines(ls => [...ls, {
        key: `new-${Date.now()}`, expense_date: ls[ls.length - 1]?.expense_date || '', category: '', description: '', amount: '', amount_approved: '',
        bill_file_id: '', bill_name: '', replaced: true, remove: false, uploading: false,
      }])} disabled={busy}><Plus className="w-3.5 h-3.5" />Add line</Btn>
      <Field label="Note"><textarea className={inputCls} style={inputStyle} rows={2} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></Field>
      <ErrorBox message={uploadErr} />
      <ErrorBox message={error} />
    </FmModal>
  )
}

// ══ Ledger request ═══════════════════════════════════════════════════════════
export function LedgerEditModal({ request: l, onClose }: { request: LedgerRequest | null; onClose: () => void }) {
  const [f, setF] = useState<Record<string, string>>({})
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const { busy, error, run } = useSave(onClose, l)
  useEffect(() => {
    if (!l) return
    setF({ ledger_type: l.ledger_type, party_name: l.party_name || '', from_date: l.from_date, to_date: l.to_date, purpose: l.purpose || '', finance_note: l.finance_note || '' })
    setFile(null); setUploadErr(null)
  }, [l])
  const set = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  async function attach(fl: File | undefined) {
    if (!fl) return
    setUploading(true); setUploadErr(null)
    try { const up = await uploadFmFile(fl, 'statement'); setFile({ id: up.id, name: up.file_name }) } catch (e) { setUploadErr((e as Error).message) } finally { setUploading(false) }
  }
  const canReplaceFile = l?.status === 'fulfilled' && f.ledger_type !== 'staff'
  return (
    <FmModal open={!!l} onClose={onClose} busy={busy} size="md" title={l ? `Edit ledger request ${l.ref_no}` : 'Edit ledger request'}
      subtitle="The requester is notified and the change is recorded in the history."
      footer={l && <>
        <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" busy={busy} disabled={uploading} onClick={() => run(() => fmPatch(`/ledger-requests/${l.id}`, { ...f, ...(file ? { statement_file_id: file.id } : {}) }))}>Save changes</Btn>
      </>}>
      <Field label="Ledger" required>
        <select className={inputCls} style={inputStyle} value={f.ledger_type || ''} onChange={set('ledger_type')} disabled={busy}>
          <option value="staff">Staff advance ledger</option><option value="vendor">Vendor / party ledger</option><option value="other">Other ledger</option>
        </select>
      </Field>
      {f.ledger_type !== 'staff' && (
        <Field label={f.ledger_type === 'vendor' ? 'Vendor / party name' : 'Ledger name'} required>
          <input className={inputCls} style={inputStyle} value={f.party_name || ''} onChange={set('party_name')} disabled={busy} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label="From" required><input type="date" className={inputCls} style={inputStyle} value={f.from_date || ''} onChange={set('from_date')} disabled={busy} /></Field>
        <Field label="To" required><input type="date" className={inputCls} style={inputStyle} value={f.to_date || ''} onChange={set('to_date')} disabled={busy} /></Field>
      </div>
      <Field label="Purpose"><input className={inputCls} style={inputStyle} value={f.purpose || ''} onChange={set('purpose')} disabled={busy} /></Field>
      <Field label="Finance note"><input className={inputCls} style={inputStyle} value={f.finance_note || ''} onChange={set('finance_note')} disabled={busy} /></Field>
      {canReplaceFile && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: FF.textMuted }}>Statement: {file ? <b style={{ color: FF.green }}>{file.name} (new)</b> : l?.statement_file_name || '—'}</span>
          <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${busy || uploading ? 'opacity-50 pointer-events-none' : ''}`} style={{ border: `1px dashed ${FF.border}`, color: FF.tealDark }}>
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Replace file
            <input type="file" className="sr-only" accept=".pdf,.xlsx,.xls,.csv,image/jpeg,image/png" onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
      )}
      <ErrorBox message={uploadErr} />
      <ErrorBox message={error} />
    </FmModal>
  )
}
