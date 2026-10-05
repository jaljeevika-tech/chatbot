// New Advance Request and Advance Settlement forms; both go to the requester's manager, then Finance.

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Paperclip, CheckCircle2, Loader2, Send } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useProjectContext } from '../../context/ProjectContext'
import { useFm } from './fmContext'
import { fmGet, fmPost, inr, todayIso, uploadFmFile, type Advance } from './fmApi'
import { Btn, ErrorBox, Field, FmModal, inputCls, inputStyle } from './fmUi'

const LAST_APPROVER_KEY = 'fm_last_approver'

function readLastApprover(): string {
  try { return localStorage.getItem(LAST_APPROVER_KEY) || '' } catch { return '' }
}
function rememberApprover(id: string) {
  try { localStorage.setItem(LAST_APPROVER_KEY, id) } catch { /* private mode */ }
}

// ══ New Advance Request ══════════════════════════════════════════════════════
export function AdvanceFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, changed, openAdvance } = useFm()
  const { projects, loadProjects } = useProjectContext()
  const [projectKey, setProjectKey] = useState('')
  const [lines, setLines] = useState<{ section: string; budget_head: string; budget_line_item: string | null }[]>([])
  const [linesLoading, setLinesLoading] = useState(false)
  const [budgetLine, setBudgetLine] = useState('') // `${section}||${head}`
  const [purpose, setPurpose] = useState('')
  const [amount, setAmount] = useState('')
  const [neededBy, setNeededBy] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [approver, setApprover] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (!projects.length) void loadProjects()
    setProjectKey(''); setBudgetLine(''); setPurpose(''); setAmount(''); setNeededBy(''); setFrom(''); setTo(''); setError(null)
    const last = readLastApprover()
    setApprover(me.me.manager?.id || (me.approvers.some(a => a.id === last) ? last : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setBudgetLine(''); setLines([])
    if (!projectKey) return
    let cancelled = false
    setLinesLoading(true)
    fmGet<{ lines: typeof lines }>(`/budget-lines?project=${encodeURIComponent(projectKey)}`)
      .then(d => { if (!cancelled) setLines(d.lines) })
      .catch(() => { if (!cancelled) setLines([]) })
      .finally(() => { if (!cancelled) setLinesLoading(false) })
    return () => { cancelled = true }
  }, [projectKey])

  const grouped = useMemo(() => {
    const m = new Map<string, typeof lines>()
    for (const l of lines) m.set(l.section, [...(m.get(l.section) || []), l])
    return [...m.entries()]
  }, [lines])

  const managerKnown = !!me.me.manager
  const approverOptions = managerKnown && !me.approvers.some(a => a.id === me.me.manager!.id)
    ? [{ id: me.me.manager!.id, name: me.me.manager!.name, role: 'manager' }, ...me.approvers]
    : me.approvers

  async function submit() {
    setError(null)
    if (!projectKey) return setError('Choose a project.')
    if (!purpose.trim()) return setError('Describe what the advance is for.')
    if (!(Number(amount) > 0)) return setError('Enter the amount you need.')
    if (!approver) return setError('Choose the manager who should approve this.')
    if (from && to && to < from) return setError('Activity end must be on or after the start date.')
    const [section, head] = budgetLine ? budgetLine.split('||') : [null, null]
    setSaving(true)
    try {
      const { advance } = await fmPost<{ advance: { id: string; ref_no: string } }>('/advances', {
        project_key: projectKey,
        project_name: projects.find(p => p.project_key === projectKey)?.name || null,
        budget_section: section, budget_head: head,
        purpose, amount: Number(amount), needed_by: neededBy || null,
        activity_from: from || null, activity_to: to || null, manager_id: approver,
      })
      rememberApprover(approver)
      changed()
      onClose()
      openAdvance(advance.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FmModal
      open={open} onClose={onClose} busy={saving} size="md"
      title="New advance request"
      subtitle="Goes to your manager first, then to Finance for approval and payment."
      footer={<>
        <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} busy={saving}><Send className="w-3.5 h-3.5" />Submit request</Btn>
      </>}
    >
      <Field label="Project" required>
        <select className={inputCls} style={inputStyle} value={projectKey} onChange={e => setProjectKey(e.target.value)} disabled={saving}>
          <option value="">Select a project…</option>
          {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
        </select>
      </Field>

      <Field label="Budget line" hint={projectKey && !linesLoading && !lines.length
        ? "This project's Financial Tracker has no budget lines yet — you can leave this blank."
        : 'Optional. Used for reporting only — the Financial Tracker is not changed.'}>
        <select className={inputCls} style={inputStyle} value={budgetLine} onChange={e => setBudgetLine(e.target.value)}
          disabled={saving || !projectKey || linesLoading || !lines.length}>
          <option value="">{linesLoading ? 'Loading…' : 'Not linked to a budget line'}</option>
          {grouped.map(([section, ls]) => (
            <optgroup key={section} label={section}>
              {ls.map(l => (
                <option key={l.budget_head} value={`${l.section}||${l.budget_head}`}>
                  {l.budget_line_item ? `${l.budget_line_item} · ` : ''}{l.budget_head}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>

      <Field label="Purpose" required>
        <textarea className={inputCls} style={inputStyle} rows={3} maxLength={2000} value={purpose} onChange={e => setPurpose(e.target.value)}
          disabled={saving} placeholder="e.g. Field visit to Saharsa for FPO training — travel, venue and refreshments" />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Amount (₹)" required>
          <input type="number" inputMode="decimal" min="1" step="0.01" className={inputCls} style={inputStyle}
            value={amount} onChange={e => setAmount(e.target.value)} disabled={saving} placeholder="0" />
        </Field>
        <Field label="Needed by">
          <input type="date" className={inputCls} style={inputStyle} value={neededBy} min={todayIso()} onChange={e => setNeededBy(e.target.value)} disabled={saving} />
        </Field>
        <Field label="Activity from">
          <input type="date" className={inputCls} style={inputStyle} value={from} onChange={e => setFrom(e.target.value)} disabled={saving} />
        </Field>
        <Field label="Activity to">
          <input type="date" className={inputCls} style={inputStyle} value={to} min={from || undefined} onChange={e => setTo(e.target.value)} disabled={saving} />
        </Field>
      </div>

      <Field label="Approving manager" required
        hint={managerKnown ? `Your reporting manager is ${me.me.manager!.name}.` : 'Your reporting manager is not set in your profile — choose who should approve.'}>
        <select className={inputCls} style={inputStyle} value={approver} onChange={e => setApprover(e.target.value)} disabled={saving}>
          <option value="">Select…</option>
          {approverOptions.map(a => <option key={a.id} value={a.id}>{a.name}{a.id === me.me.manager?.id ? ' (reporting manager)' : ''}</option>)}
        </select>
      </Field>

      {me.finance_team_size === 0 && (
        <div className="rounded-xl p-3 text-xs" style={{ background: FF.amberBg, color: FF.amber }}>
          No one is set up as Finance yet, so after manager approval this will wait until an admin adds the Finance team.
        </div>
      )}
      <ErrorBox message={error} />
    </FmModal>
  )
}

// ══ New Settlement ═══════════════════════════════════════════════════════════
interface LineDraft {
  key: number
  expense_date: string
  category: string
  description: string
  amount: string
  file: { id: string; name: string } | null
  uploading: boolean
  uploadError: string | null
}

let lineSeq = 0
const blankLine = (category = ''): LineDraft => ({
  key: ++lineSeq, expense_date: todayIso(), category, description: '', amount: '', file: null, uploading: false, uploadError: null,
})

export function SettlementFormModal({ open, onClose, advanceId }: { open: boolean; onClose: () => void; advanceId?: string }) {
  const { me, changed, openSettlement } = useFm()
  const [advances, setAdvances] = useState<Advance[] | null>(null)
  const [selected, setSelected] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNote(''); setError(null); setLines([blankLine()]); setAdvances(null)
    fmGet<{ advances: Advance[] }>('/advances?scope=mine')
      .then(d => {
        const openOnes = d.advances.filter(a => a.status === 'disbursed')
        setAdvances(openOnes)
        setSelected(advanceId && openOnes.some(a => a.id === advanceId) ? advanceId : openOnes.length === 1 ? openOnes[0].id : '')
      })
      .catch(e => { setAdvances([]); setError((e as Error).message) })
  }, [open, advanceId])

  const adv = advances?.find(a => a.id === selected) || null
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const afterBalance = adv ? Math.round((adv.balance - adv.pending_claims - total) * 100) / 100 : 0
  const anyUploading = lines.some(l => l.uploading)

  const setLine = (key: number, patch: Partial<LineDraft>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)))

  async function attach(key: number, file: File | undefined) {
    if (!file) return
    setLine(key, { uploading: true, uploadError: null })
    try {
      const f = await uploadFmFile(file, 'bill')
      setLine(key, { uploading: false, file: { id: f.id, name: f.file_name } })
    } catch (e) {
      setLine(key, { uploading: false, uploadError: (e as Error).message })
    }
  }

  async function submit() {
    setError(null)
    if (!adv) return setError('Choose the advance you are settling.')
    for (const [i, l] of lines.entries()) {
      const n = i + 1
      if (!l.expense_date) return setError(`Line ${n}: add the date.`)
      if (!l.category) return setError(`Line ${n}: choose a category.`)
      if (!(Number(l.amount) > 0)) return setError(`Line ${n}: enter the amount.`)
      if (!l.file) return setError(`Line ${n}: attach the bill or receipt.`)
    }
    setSaving(true)
    try {
      const { settlement } = await fmPost<{ settlement: { id: string } }>('/settlements', {
        advance_id: adv.id, note: note || null,
        lines: lines.map(l => ({
          expense_date: l.expense_date, category: l.category, description: l.description || null,
          amount: Number(l.amount), bill_file_id: l.file!.id,
        })),
      })
      changed()
      onClose()
      openSettlement(settlement.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FmModal
      open={open} onClose={onClose} busy={saving} size="xl"
      title="Submit bills (advance settlement)"
      subtitle="Attach a bill or receipt for every expense. Goes to your manager, then Finance. You can settle in parts."
      footer={<>
        <span className="mr-auto self-center text-sm font-semibold" style={{ color: FF.tealDark }}>Total {inr(total)}</span>
        <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} busy={saving} disabled={anyUploading || !adv}><Send className="w-3.5 h-3.5" />Submit settlement</Btn>
      </>}
    >
      {advances === null ? (
        <div className="flex justify-center py-8" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : advances.length === 0 ? (
        <div className="rounded-xl p-4 text-sm" style={{ background: FF.bg, color: FF.textMuted }}>
          You have no paid advances waiting for bills. Advances appear here once Finance records the payment.
        </div>
      ) : (
        <>
          <Field label="Advance" required>
            <select className={inputCls} style={inputStyle} value={selected} onChange={e => setSelected(e.target.value)} disabled={saving}>
              <option value="">Select the advance…</option>
              {advances.map(a => (
                <option key={a.id} value={a.id}>
                  {a.ref_no} · {a.project_name || a.project_key} · {inr(a.disbursed_amount)} paid · balance {inr(a.balance)}
                </option>
              ))}
            </select>
          </Field>

          {adv && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ['Paid to you', inr(adv.disbursed_amount)],
                ['Bills approved', inr(adv.spent)],
                ['Bills pending', inr(adv.pending_claims)],
                [afterBalance >= 0 ? 'Left after this' : 'Owed to you after this', inr(Math.abs(afterBalance))],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl px-3 py-2" style={{ background: FF.bg }}>
                  <div className="text-[10.5px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{k}</div>
                  <div className="text-sm font-semibold" style={{ color: FF.tealDark }}>{v}</div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={l.key} className="rounded-xl p-3 space-y-3" style={{ border: `1px solid ${FF.border}` }}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold" style={{ color: FF.textMuted }}>Expense {i + 1}</span>
                  {lines.length > 1 && (
                    <button onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} disabled={saving}
                      className="text-xs inline-flex items-center gap-1" style={{ color: FF.red }} aria-label={`Remove expense ${i + 1}`}>
                      <Trash2 className="w-3.5 h-3.5" />Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <Field label="Date" required className="sm:col-span-3">
                    <input type="date" className={inputCls} style={inputStyle} value={l.expense_date} max={todayIso()}
                      onChange={e => setLine(l.key, { expense_date: e.target.value })} disabled={saving} />
                  </Field>
                  <Field label="Category" required className="sm:col-span-3">
                    <select className={inputCls} style={inputStyle} value={l.category} onChange={e => setLine(l.key, { category: e.target.value })} disabled={saving}>
                      <option value="">Select…</option>
                      {me.expense_categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Description" className="sm:col-span-4">
                    <input className={inputCls} style={inputStyle} value={l.description} maxLength={500} placeholder="e.g. Bus fare Patna–Saharsa"
                      onChange={e => setLine(l.key, { description: e.target.value })} disabled={saving} />
                  </Field>
                  <Field label="Amount (₹)" required className="sm:col-span-2">
                    <input type="number" inputMode="decimal" min="1" step="0.01" className={inputCls} style={inputStyle} value={l.amount}
                      onChange={e => setLine(l.key, { amount: e.target.value })} disabled={saving} />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${saving || l.uploading ? 'opacity-50 pointer-events-none' : ''}`}
                    style={{ border: `1px dashed ${l.file ? FF.green : FF.border}`, color: l.file ? FF.green : FF.tealDark }}>
                    {l.uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : l.file ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Paperclip className="w-3.5 h-3.5" />}
                    {l.uploading ? 'Uploading…' : l.file ? 'Replace bill' : 'Attach bill / receipt *'}
                    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only"
                      onChange={e => { attach(l.key, e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                  {l.file && <span className="text-xs truncate max-w-[240px]" style={{ color: FF.textMuted }}>{l.file.name}</span>}
                  {l.uploadError && <span className="text-xs" style={{ color: FF.red }}>{l.uploadError}</span>}
                </div>
              </div>
            ))}
            <Btn small onClick={() => setLines(ls => [...ls, blankLine(ls[ls.length - 1]?.category || '')])} disabled={saving}>
              <Plus className="w-3.5 h-3.5" />Add another expense
            </Btn>
          </div>

          <Field label="Note for approvers">
            <textarea className={inputCls} style={inputStyle} rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} disabled={saving} />
          </Field>
        </>
      )}
      <ErrorBox message={error} />
    </FmModal>
  )
}
