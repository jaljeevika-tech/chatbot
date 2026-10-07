// Forms tab: staff fill the org's published custom forms (works offline — answers queue in
// IndexedDB and send when back online) and see submissions (admin/manager: all, staff: own).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ClipboardList, RefreshCw, Send } from 'lucide-react'
import { useAuthContext } from '../../context/AuthContext'
import { apiFetch } from '../../utils/apiFetch'
import { cacheForms, cachedForms, discard, enqueue, flush, listQueued, type PublishedForm, type QueuedSubmission } from '../../utils/formOutbox'
import { buildTree, evaluateForm, type Answers } from '../../../lib/odkForm'
import { FF } from '../../theme/colors'
import { Btn, Card, Muted, Notice } from '../hr/hrUi'
import { EmptyState } from '../ui/EmptyState'
import { DynamicForm, defaultAnswers } from './DynamicForm'

type View = { kind: 'list' } | { kind: 'fill'; form: PublishedForm } | { kind: 'subs'; form: PublishedForm }

export function FormsPage() {
  const { user } = useAuthContext()
  const userKey = user ? `${user.orgId}:${user.uid}` : ''
  const [forms, setForms] = useState<PublishedForm[] | null>(null)
  const [offlineCopy, setOfflineCopy] = useState(false)
  const [queue, setQueue] = useState<QueuedSubmission[]>([])
  const [view, setView] = useState<View>({ kind: 'list' })

  const refreshQueue = useCallback(async () => { if (userKey) setQueue(await listQueued(userKey)) }, [userKey])
  const sync = useCallback(async () => { if (userKey) { await flush(userKey); await refreshQueue() } }, [userKey, refreshQueue])

  useEffect(() => {
    if (!userKey) return
    apiFetch('/api/forms')
      .then(async r => { if (!r.ok) throw new Error(); const list = await r.json() as PublishedForm[]; setForms(list); setOfflineCopy(false); void cacheForms(userKey, list) })
      .catch(async () => { setForms(await cachedForms(userKey) ?? []); setOfflineCopy(true) })
    void sync()
    const onOnline = () => void sync()
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => void sync(), 60_000)
    return () => { window.removeEventListener('online', onOnline); window.clearInterval(timer) }
  }, [userKey, sync])

  if (view.kind === 'fill') return <FillForm form={view.form} userKey={userKey} onBack={() => { setView({ kind: 'list' }); void refreshQueue() }} onQueued={sync} />
  if (view.kind === 'subs') return <Submissions form={view.form} onBack={() => setView({ kind: 'list' })} />

  const pending = queue.filter(q => q.status === 'pending')
  const rejected = queue.filter(q => q.status === 'rejected')

  return (
    <div className="flex flex-col gap-4">
      {offlineCopy && <Notice>You're offline — showing the forms saved on this device. New answers are kept here and sent when you reconnect.</Notice>}
      {pending.length > 0 && (
        <Notice>
          <span className="flex items-center justify-between gap-3 flex-wrap">
            {pending.length} submission{pending.length === 1 ? '' : 's'} waiting to send.
            <Btn onClick={() => void sync()}><span className="inline-flex items-center gap-1.5"><RefreshCw className="w-4 h-4" />Send now</span></Btn>
          </span>
        </Notice>
      )}
      {rejected.map(q => (
        <Notice key={q.instanceId} tone="red">
          <strong>{q.formTitle}</strong> ({new Date(q.createdAt).toLocaleString()}) wasn't accepted: {q.error}
          <span className="flex gap-2 mt-2">
            <Btn onClick={async () => { await enqueue({ ...q, status: 'pending', error: undefined }); await sync() }}>Retry</Btn>
            <Btn variant="danger" onClick={async () => { if (confirm('Discard these answers? This cannot be undone.')) { await discard(q.instanceId); await refreshQueue() } }}>Discard</Btn>
          </span>
        </Notice>
      ))}
      <Card title="Forms">
        {!forms ? <Muted>Loading…</Muted>
          : forms.length === 0 ? <EmptyState icon={<ClipboardList className="w-8 h-8" />} title="No forms yet" body="Your administrator hasn't published any forms for your organisation." compact />
          : (
            <ul className="flex flex-col" style={{ gap: 8 }}>
              {forms.map(f => (
                <li key={f.form_key} className="flex items-center justify-between gap-3 flex-wrap" style={{ border: `1px solid ${FF.border}`, borderRadius: 10, padding: '12px 14px' }}>
                  <div>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: FF.tealDark }}>{f.title}</div>
                    <div style={{ fontSize: 12, color: FF.textFaint }}>Version {f.version} · {f.schema.survey.filter(r => !r.type.startsWith('end_') && !r.type.startsWith('begin_') && r.type !== 'calculate' && !r.archived).length} questions</div>
                  </div>
                  <div className="flex gap-2">
                    {!offlineCopy && <Btn onClick={() => setView({ kind: 'subs', form: f })}>Submissions</Btn>}
                    <Btn variant="primary" onClick={() => setView({ kind: 'fill', form: f })}>Fill</Btn>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  )
}

function FillForm({ form, userKey, onBack, onQueued }: { form: PublishedForm; userKey: string; onBack: () => void; onQueued: () => Promise<void> }) {
  const fresh = useCallback(() => defaultAnswers(buildTree(form.schema.survey).tree), [form])
  const [answers, setAnswers] = useState<Answers>(fresh)
  const [showErrors, setShowErrors] = useState(false)
  const [status, setStatus] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const ev = evaluateForm(form.schema, answers)
    const count = Object.keys(ev.errors).length
    if (count) {
      setShowErrors(true)
      setStatus({ tone: 'red', text: `${count} answer${count === 1 ? ' needs' : 's need'} attention.` })
      requestAnimationFrame(() => document.querySelector('[aria-invalid="true"]')?.scrollIntoView({ block: 'center' }))
      return
    }
    setSaving(true)
    const instanceId = `uuid:${crypto.randomUUID()}`
    try {
      await enqueue({
        instanceId, userKey, formKey: form.form_key, formTitle: form.title, version: form.version,
        data: ev.data, createdAt: new Date().toISOString(), status: 'pending',
      })
    } catch {
      setSaving(false)
      return setStatus({ tone: 'red', text: "Couldn't save on this device (storage full or blocked). Your answers are still on screen — don't close this page." })
    }
    await onQueued()
    const stillQueued = (await listQueued(userKey)).find(q => q.instanceId === instanceId)
    setSaving(false)
    setAnswers(fresh()); setShowErrors(false)
    setStatus(!stillQueued ? { tone: 'green', text: 'Submitted. You can fill another.' }
      : stillQueued.status === 'rejected' ? { tone: 'red', text: `Saved on this device but the server didn't accept it: ${stillQueued.error} Go back to All forms to retry or discard it.` }
      : { tone: 'amber', text: 'Saved on this device. It will send automatically when the connection is back.' })
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 720 }}>
      <BackLink onClick={onBack} />
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      <Card title={form.title}>
        <DynamicForm schema={form.schema} value={answers} onChange={a => { setAnswers(a); if (status?.tone === 'green') setStatus(null) }} showErrors={showErrors} />
        <div className="flex gap-2" style={{ marginTop: 20 }}>
          <Btn variant="primary" big disabled={saving} onClick={() => void submit()}>
            <span className="inline-flex items-center gap-1.5"><Send className="w-4 h-4" />{saving ? 'Saving…' : 'Submit'}</span>
          </Btn>
        </div>
      </Card>
    </div>
  )
}

type Submission = { id: string; data: Answers; source: string; created_at: string; version: number; submitted_by: string | null; media: Record<string, string> }

function Submissions({ form, onBack }: { form: PublishedForm; onBack: () => void }) {
  const [rows, setRows] = useState<Submission[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    apiFetch(`/api/forms/${form.form_key}/submissions`)
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setRows(j) })
      .catch(e => setError(e.message || 'Could not load submissions'))
  }, [form.form_key])

  // Top-level questions only; repeats show their instance count.
  const columns = useMemo(() => buildTree(form.schema.survey).tree
    .flatMap(function flat(n): typeof n[] { return n.row.type === 'begin_group' ? n.children.flatMap(flat) : [n] })
    .filter(n => n.row.type !== 'note' && n.row.type !== 'calculate'), [form])

  const show = (s: Submission, row: typeof columns[number]['row']) => {
    const v = s.data[row.name]
    if (v == null || v === '') return ''
    if (row.type === 'begin_repeat') return `${(v as unknown[]).length} ${row.label}`
    if (row.type === 'image' || row.type === 'audio') {
      const mediaId = s.media[String(v)]
      return mediaId ? <Btn variant="ghost" style={{ padding: '2px 6px', minHeight: 0 }} onClick={() => void openMedia(form.form_key, mediaId)}>View</Btn> : ''
    }
    if (row.list) {
      const labels = Object.fromEntries((form.schema.choices[row.list] ?? []).map(c => [c.name, c.label]))
      return (Array.isArray(v) ? v : [v]).map(x => labels[String(x)] ?? String(x)).join(', ')
    }
    return String(v)
  }

  const cell = { padding: '8px 10px', borderBottom: `1px solid ${FF.border}`, fontSize: 13, color: FF.tealText, textAlign: 'left' as const, whiteSpace: 'nowrap' as const, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }
  return (
    <div className="flex flex-col gap-4">
      <BackLink onClick={onBack} />
      <Card title={`${form.title} — submissions`}>
        {error ? <Notice tone="red">{error}</Notice> : !rows ? <Muted>Loading…</Muted> : rows.length === 0 ? <Muted>No submissions yet.</Muted> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...cell, fontWeight: 600, color: FF.textMuted }}>Submitted</th>
                  <th style={{ ...cell, fontWeight: 600, color: FF.textMuted }}>By</th>
                  {columns.map(c => <th key={c.row.name} style={{ ...cell, fontWeight: 600, color: FF.textMuted }}>{c.row.label || c.row.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id}>
                    <td style={cell}>{new Date(s.created_at).toLocaleString()}</td>
                    <td style={cell}>{s.submitted_by ?? '—'}</td>
                    {columns.map(c => <td key={c.row.name} style={cell}>{show(s, c.row)}</td>)}
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

async function openMedia(formKey: string, mediaId: string) {
  const win = window.open('', '_blank')
  const r = await apiFetch(`/api/forms/${formKey}/media/${mediaId}`)
  if (!r.ok) { win?.close(); return alert('Could not open that file') }
  const url = URL.createObjectURL(await r.blob())
  if (win) win.location.href = url; else window.location.href = url
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1" style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 600, color: FF.textMuted, background: 'none', border: 0, cursor: 'pointer' }}>
      <ArrowLeft className="w-4 h-4" /> All forms
    </button>
  )
}
