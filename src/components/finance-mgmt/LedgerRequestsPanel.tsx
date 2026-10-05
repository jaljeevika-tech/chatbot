// Ledger Request sub-tab: own staff ledgers are generated from this app's records and
// released by Finance; vendor/other ledgers are uploaded by Finance from Tally.

import { useEffect, useMemo, useState } from 'react'
import { Plus, BookOpen, Download, Printer, Upload, CheckCircle2, Loader2, FileText, Pencil } from 'lucide-react'
import { FF } from '../../theme/colors'
import { EmptyState } from '../ui/EmptyState'
import { useFm } from './fmContext'
import {
  canEditFinance, fmGet, fmPost, fmtDate, inr, openFmFile, todayIso, uploadFmFile,
  type FmEvent, type LedgerRequest, type StaffStatement,
} from './fmApi'
import { LedgerEditModal } from './FmEditForms'
import { Btn, Card, ErrorBox, Field, FmModal, KV, LoadingRow, SectionTitle, Segmented, StatusChip, Timeline, inputCls, inputStyle, tdCls, thCls, useFmLoad } from './fmUi'

const TYPE_LABEL: Record<LedgerRequest['ledger_type'], string> = {
  staff: 'My staff advance ledger', vendor: 'Vendor / party ledger', other: 'Other ledger',
}
const ledgerTitle = (l: LedgerRequest) => l.ledger_type === 'staff' ? `Staff ledger — ${l.requester_name}` : l.party_name || TYPE_LABEL[l.ledger_type]

function fyStartIso() {
  const d = new Date()
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}

// ── Statement table + print / CSV ────────────────────────────────────────────
const drcr = (n: number) => (Math.abs(n) < 0.005 ? inr(0) : `${inr(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`)
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function downloadCsv(st: StaffStatement) {
  // Text starting with = + - @ would run as a formula in Excel — prefix with '.
  const q = (v: string | number) => {
    const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v)
    return `"${s.replace(/"/g, '""')}"`
  }
  const lines = [
    ['Date', 'Ref', 'Particulars', 'Debit', 'Credit', 'Balance'],
    [st.from_date, '', 'Opening balance', '', '', st.opening_balance],
    ...st.rows.map(r => [r.date, r.ref, r.particulars, r.debit || '', r.credit || '', r.balance]),
    ['', '', 'Totals', st.totals.debit, st.totals.credit, ''],
    [st.to_date, '', 'Closing balance', '', '', st.closing_balance],
  ].map(r => r.map(q).join(','))
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `${st.ref_no.replace(/\//g, '-')}_staff_ledger.csv`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function printStatement(st: StaffStatement) {
  const w = window.open('', '_blank')
  if (!w) return
  const row = (cells: string[], bold = false) =>
    `<tr${bold ? ' style="font-weight:700"' : ''}>${cells.map((c, i) => `<td${i >= 3 ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(st.ref_no)} — Staff ledger</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#16414C;margin:32px}h1{font-size:18px;margin:0}p{margin:4px 0 16px;color:#5C7378}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #D9E6E8;padding:6px 8px;text-align:left}th{background:#F2F7F8;font-size:11px;text-transform:uppercase}
.n{text-align:right;white-space:nowrap}@media print{body{margin:12mm}}</style></head><body>
<h1>Staff advance ledger — ${esc(st.employee)}</h1>
<p>${esc(fmtDate(st.from_date))} to ${esc(fmtDate(st.to_date))} · ${esc(st.ref_no)} · Dr = held by employee, Cr = owed to employee</p>
<table><thead><tr><th>Date</th><th>Ref</th><th>Particulars</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead><tbody>
${row([esc(fmtDate(st.from_date)), '', 'Opening balance', '', '', esc(drcr(st.opening_balance))], true)}
${st.rows.map(r => row([esc(fmtDate(r.date)), esc(r.ref), esc(r.particulars), r.debit ? esc(inr(r.debit)) : '', r.credit ? esc(inr(r.credit)) : '', esc(drcr(r.balance))])).join('')}
${row(['', '', 'Totals', esc(inr(st.totals.debit)), esc(inr(st.totals.credit)), ''], true)}
${row([esc(fmtDate(st.to_date)), '', 'Closing balance', '', '', esc(drcr(st.closing_balance))], true)}
</tbody></table><script>window.onload=()=>window.print()</script></body></html>`)
  w.document.close()
}

function StatementTable({ st }: { st: StaffStatement }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs" style={{ color: FF.textMuted }}>Dr = money held by the employee · Cr = money owed to the employee</div>
        <div className="flex gap-2">
          <Btn small onClick={() => printStatement(st)}><Printer className="w-3.5 h-3.5" />Print / PDF</Btn>
          <Btn small onClick={() => downloadCsv(st)}><Download className="w-3.5 h-3.5" />CSV</Btn>
        </div>
      </div>
      <div className="rounded-xl overflow-x-auto" style={{ border: `1px solid ${FF.border}` }}>
        <table className="w-full min-w-[640px]">
          <thead style={{ background: FF.bg, color: FF.textMuted }}>
            <tr>
              <th className={thCls}>Date</th><th className={thCls}>Ref</th><th className={thCls}>Particulars</th>
              <th className={`${thCls} text-right`}>Debit</th><th className={`${thCls} text-right`}>Credit</th><th className={`${thCls} text-right`}>Balance</th>
            </tr>
          </thead>
          <tbody style={{ color: FF.tealDark }}>
            <tr className="font-semibold" style={{ background: '#FAFCFC' }}>
              <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(st.from_date)}</td><td className={tdCls} /><td className={tdCls}>Opening balance</td>
              <td className={tdCls} /><td className={tdCls} /><td className={`${tdCls} text-right whitespace-nowrap`}>{drcr(st.opening_balance)}</td>
            </tr>
            {st.rows.map((r, i) => (
              <tr key={i} className="border-t" style={{ borderColor: FF.borderFaint }}>
                <td className={`${tdCls} whitespace-nowrap`}>{fmtDate(r.date)}</td>
                <td className={`${tdCls} whitespace-nowrap`} style={{ color: FF.textMuted }}>{r.ref}</td>
                <td className={tdCls}><span className="line-clamp-2" title={r.particulars}>{r.particulars}</span></td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{r.debit ? inr(r.debit) : ''}</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{r.credit ? inr(r.credit) : ''}</td>
                <td className={`${tdCls} text-right whitespace-nowrap`}>{drcr(r.balance)}</td>
              </tr>
            ))}
            {!st.rows.length && (
              <tr className="border-t" style={{ borderColor: FF.borderFaint }}>
                <td className={`${tdCls} text-center`} colSpan={6} style={{ color: FF.textFaint }}>No transactions in this period</td>
              </tr>
            )}
            <tr className="border-t-2 font-bold" style={{ borderColor: FF.border }}>
              <td className={tdCls} colSpan={3}>Closing balance · {fmtDate(st.to_date)}</td>
              <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(st.totals.debit)}</td>
              <td className={`${tdCls} text-right whitespace-nowrap`}>{inr(st.totals.credit)}</td>
              <td className={`${tdCls} text-right whitespace-nowrap`}>{drcr(st.closing_balance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function LedgerFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { changed, openLedger, me } = useFm()
  const [type, setType] = useState<LedgerRequest['ledger_type']>('staff')
  const [party, setParty] = useState('')
  const [from, setFrom] = useState(fyStartIso())
  const [to, setTo] = useState(todayIso())
  const [purpose, setPurpose] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setType('staff'); setParty(''); setFrom(fyStartIso()); setTo(todayIso()); setPurpose(''); setError(null)
  }, [open])

  async function submit() {
    setError(null)
    if (type !== 'staff' && !party.trim()) return setError(type === 'vendor' ? 'Enter the vendor / party name.' : 'Enter which ledger you need.')
    if (!from || !to) return setError('Choose the period.')
    if (to < from) return setError('To date must be on or after the from date.')
    setSaving(true)
    try {
      const { request } = await fmPost<{ request: { id: string } }>('/ledger-requests', {
        ledger_type: type, party_name: type === 'staff' ? null : party, from_date: from, to_date: to, purpose: purpose || null,
      })
      changed(); onClose(); openLedger(request.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FmModal open={open} onClose={onClose} busy={saving} size="md" title="Request a ledger statement"
      subtitle="Finance will review and share the statement here."
      footer={<>
        <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        <Btn variant="primary" busy={saving} onClick={submit}>Send request</Btn>
      </>}>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold mb-1" style={{ color: FF.tealDark }}>Which ledger? <span style={{ color: FF.red }}>*</span></legend>
        {(Object.keys(TYPE_LABEL) as LedgerRequest['ledger_type'][]).map(t => (
          <label key={t} className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer"
            style={{ border: `1.5px solid ${type === t ? FF.purple : FF.border}`, background: type === t ? '#F7F4FC' : '#fff' }}>
            <input type="radio" name="ledger_type" className="mt-0.5" checked={type === t} onChange={() => setType(t)} disabled={saving} />
            <span>
              <span className="block text-sm font-semibold" style={{ color: FF.tealDark }}>{TYPE_LABEL[t]}</span>
              <span className="block text-xs" style={{ color: FF.textMuted }}>
                {t === 'staff' ? `Advances paid to ${me.me.name}, bills settled, refunds and reimbursements — prepared automatically.`
                  : t === 'vendor' ? 'A supplier or party account — Finance shares the statement from the books.'
                  : 'Any other ledger — name it below.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {type !== 'staff' && (
        <Field label={type === 'vendor' ? 'Vendor / party name' : 'Ledger name'} required>
          <input className={inputCls} style={inputStyle} value={party} maxLength={300} onChange={e => setParty(e.target.value)} disabled={saving}
            placeholder={type === 'vendor' ? 'e.g. Shree Ganesh Printers' : 'e.g. Travel expenses — Kosi project'} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label="From" required>
          <input type="date" className={inputCls} style={inputStyle} value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} disabled={saving} />
        </Field>
        <Field label="To" required>
          <input type="date" className={inputCls} style={inputStyle} value={to} min={from || undefined} onChange={e => setTo(e.target.value)} disabled={saving} />
        </Field>
      </div>
      <Field label="Purpose">
        <input className={inputCls} style={inputStyle} value={purpose} maxLength={1000} onChange={e => setPurpose(e.target.value)} disabled={saving}
          placeholder="e.g. Reconciling my advances before year end" />
      </Field>
      <ErrorBox message={error} />
    </FmModal>
  )
}

// Detail / Finance action
export function LedgerDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { me, changed, version } = useFm()
  const [data, setData] = useState<{ request: LedgerRequest; events: FmEvent[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statement, setStatement] = useState<StaffStatement | null>(null)
  const [stLoading, setStLoading] = useState(false)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const l = data?.request
  const mine = l?.requester_id === me.me.id
  const financeCanAct = !!l && me.me.is_finance && !mine && l.status === 'pending'
  const canEdit = !!l && canEditFinance(me) && !mine && l.status !== 'cancelled'
  const [editing, setEditing] = useState(false)
  const canSeeStatement = !!l && l.ledger_type === 'staff' && (me.me.is_finance || me.me.is_admin || (mine && l.status === 'fulfilled'))

  useEffect(() => {
    setStatement(null); setNote(''); setFile(null); setError(null)
    if (!id) { setData(null); return }
    let cancelled = false
    setLoadError(null)
    fmGet<{ request: LedgerRequest; events: FmEvent[] }>(`/ledger-requests/${id}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message) })
    return () => { cancelled = true }
  }, [id, version])

  useEffect(() => {
    if (!canSeeStatement || !l) return
    let cancelled = false
    setStLoading(true)
    fmGet<{ statement: StaffStatement }>(`/ledger-requests/${l.id}/statement`)
      .then(d => { if (!cancelled) setStatement(d.statement) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setStLoading(false) })
    return () => { cancelled = true }
  }, [canSeeStatement, l])

  async function act(path: string, body: unknown) {
    setBusy(true); setError(null)
    try { await fmPost(path, body); changed() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function attach(f: File | undefined) {
    if (!f) return
    setUploading(true); setError(null)
    try { const up = await uploadFmFile(f, 'statement'); setFile({ id: up.id, name: up.file_name }) }
    catch (e) { setError((e as Error).message) }
    finally { setUploading(false) }
  }

  return (
    <FmModal open={!!id} onClose={onClose} busy={busy} size="xl"
      title={l ? `Ledger request ${l.ref_no}` : 'Ledger request'}
      subtitle={l && <span className="inline-flex items-center gap-2"><StatusChip status={l.status} kind="ledger" /> Requested {fmtDate(l.created_at)} by {l.requester_name}</span>}
      footer={l && (
        <>
          {mine && l.status === 'pending' && (
            <Btn variant="danger" busy={busy} onClick={() => { if (confirm('Cancel this request?')) act(`/ledger-requests/${l.id}/cancel`, {}) }}>Cancel request</Btn>
          )}
          {l.statement_file_id && (
            <Btn variant="primary" onClick={() => openFmFile(l.statement_file_id!).catch(e => setError(e.message))}>
              <Download className="w-3.5 h-3.5" />Download statement
            </Btn>
          )}
          {canEdit && <Btn onClick={() => setEditing(true)} disabled={busy}><Pencil className="w-3.5 h-3.5" />Edit</Btn>}
          <Btn onClick={onClose} disabled={busy}>Close</Btn>
        </>
      )}>
      {loadError ? <ErrorBox message={loadError} /> : !l || !data ? <LoadingRow /> : (
        <>
          <KV items={[
            ['Ledger', ledgerTitle(l)],
            ['Type', TYPE_LABEL[l.ledger_type]],
            ['Period', `${fmtDate(l.from_date)} – ${fmtDate(l.to_date)}`],
            ['Purpose', l.purpose || '—'],
            ...(l.finance_note ? [['Finance note', l.finance_note] as [string, string]] : []),
            ...(l.finance_action_by_name ? [['Handled by', `${l.finance_action_by_name} · ${fmtDate(l.finance_action_at)}`] as [string, string]] : []),
          ]} />

          {l.ledger_type === 'staff' && (
            <>
              <SectionTitle>{l.status === 'fulfilled' ? 'Statement' : 'Statement preview'}</SectionTitle>
              {canSeeStatement ? (stLoading || !statement ? <LoadingRow /> : <StatementTable st={statement} />) : (
                <div className="rounded-xl p-4 text-sm" style={{ background: FF.bg, color: FF.textMuted }}>
                  {l.status === 'pending' ? 'Finance is reviewing your request. The statement will appear here once it is released.' : 'No statement for this request.'}
                </div>
              )}
            </>
          )}

          {financeCanAct && (
            <div className="rounded-xl p-4 space-y-3" style={{ background: '#F7F4FC', border: '1px solid #E2D9F3' }}>
              <div className="text-xs font-bold uppercase tracking-wider" style={{ color: FF.purple }}>Finance action</div>
              {l.ledger_type !== 'staff' && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${busy || uploading ? 'opacity-50 pointer-events-none' : ''}`}
                    style={{ border: `1px dashed ${file ? FF.green : FF.border}`, color: file ? FF.green : FF.tealDark, background: '#fff' }}>
                    {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : file ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Upload className="w-3.5 h-3.5" />}
                    {uploading ? 'Uploading…' : file ? 'Replace file' : 'Upload statement (PDF / Excel / CSV) *'}
                    <input type="file" className="sr-only" accept=".pdf,.xlsx,.xls,.csv,image/jpeg,image/png"
                      onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                  {file && <span className="text-xs inline-flex items-center gap-1" style={{ color: FF.textMuted }}><FileText className="w-3.5 h-3.5" />{file.name}</span>}
                </div>
              )}
              <textarea className={inputCls} style={inputStyle} rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} disabled={busy}
                placeholder="Note to the requester (required if you reject)" />
              <div className="flex flex-wrap gap-2">
                <Btn variant="success" busy={busy} disabled={uploading || (l.ledger_type !== 'staff' && !file)}
                  onClick={() => act(`/ledger-requests/${l.id}/fulfil`, { note: note || null, statement_file_id: file?.id || null })}>
                  {l.ledger_type === 'staff' ? 'Approve & share statement' : 'Send statement'}
                </Btn>
                <Btn variant="danger" busy={busy} onClick={() => act(`/ledger-requests/${l.id}/reject`, { note })}>Reject</Btn>
              </div>
            </div>
          )}
          <ErrorBox message={error} />

          <SectionTitle>History</SectionTitle>
          <Timeline events={data.events} />
          <LedgerEditModal request={editing ? l : null} onClose={() => setEditing(false)} />
        </>
      )}
    </FmModal>
  )
}

export function LedgerRequestsPanel({ onNew }: { onNew: () => void }) {
  const { me, version } = useFm()
  const canQueue = me.me.is_finance || me.me.is_admin
  const [scope, setScope] = useState<'mine' | 'queue'>(me.counts.ledger_finance > 0 ? 'queue' : 'mine')
  const { data, error, loading } = useFmLoad(() => fmGet<{ requests: LedgerRequest[] }>(`/ledger-requests?scope=${scope}`), [scope, version])
  const rows = useMemo(() => data?.requests || [], [data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {canQueue ? (
          <Segmented options={[
            { key: 'mine' as const, label: 'My requests' },
            { key: 'queue' as const, label: 'Finance queue', count: me.counts.ledger_finance },
          ]} value={scope} onChange={setScope} />
        ) : <div />}
        <Btn variant="primary" onClick={onNew}><Plus className="w-4 h-4" />New ledger request</Btn>
      </div>
      <Card>
        {error ? <div className="p-4"><ErrorBox message={error} /></div> : loading && !data ? <LoadingRow /> : !rows.length ? (
          <EmptyState compact icon={<BookOpen className="w-6 h-6" />}
            title={scope === 'queue' ? 'No ledger requests yet' : 'You have not requested any statements'}
            body={scope === 'mine' ? 'Ask Finance for your advance ledger, a vendor ledger or any other statement.' : undefined} />
        ) : <LedgerList requests={rows} showRequester={scope === 'queue'} />}
      </Card>
    </div>
  )
}

/** Ledger request rows; tapping one opens its detail modal. */
export function LedgerList({ requests, showRequester }: { requests: LedgerRequest[]; showRequester: boolean }) {
  const { openLedger } = useFm()
  return (
    <ul className="divide-y divide-[#E4F0F1]">
      {requests.map(l => (
        <li key={l.id}>
          <button className="w-full text-left px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 hover:bg-gray-50" onClick={() => openLedger(l.id)}>
            <div className="sm:w-40 shrink-0">
              <div className="font-semibold text-sm" style={{ color: FF.purple }}>{l.ref_no}</div>
              <div className="text-xs" style={{ color: FF.textFaint }}>{fmtDate(l.created_at)}</div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate" style={{ color: FF.tealDark }}>{ledgerTitle(l)}</div>
              <div className="text-xs" style={{ color: FF.textMuted }}>
                {showRequester && l.ledger_type !== 'staff' ? `${l.requester_name} · ` : ''}{fmtDate(l.from_date)} – {fmtDate(l.to_date)}
              </div>
            </div>
            <div className="shrink-0"><StatusChip status={l.status} kind="ledger" /></div>
          </button>
        </li>
      ))}
    </ul>
  )
}
