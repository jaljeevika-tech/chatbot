// Form builder (KoBo/XLSForm-style) for one organisation. Schema rules and the
// built-in (system) fields live server-side in lib/forms.js; this screen only
// edits the XLSForm-shaped JSON and shows the server's validation errors.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowDown, ArrowUp, Archive, ArchiveRestore, ClipboardList, Lock, Plus, Trash2, Upload, Save } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg, ApiError } from './api'
import { navigate, routeHref } from './route'
import type { OrgRow } from './types'
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Skeleton, Switch, Textarea, fmtDateTime, useConfirm } from './ui'

type Row = {
  type: string; name: string; label?: string; hint?: string; required?: boolean; list?: string
  relevant?: string; constraint?: string; constraint_message?: string; calculation?: string
  repeat_count?: string; default?: string; appearance?: string; archived?: boolean; system?: boolean
}
type Choice = { name: string; label: string }
type Schema = { settings: { form_title: string }; survey: Row[]; choices: Record<string, Choice[]> }

type FormSummary = {
  form_key: string; kind: 'entity' | 'custom'; title: string; archived_at: string | null; updated_at: string | null
  has_draft: boolean; published_version: number | null; published_at: string | null; submissions: number
}
type FormDetail = {
  form_key: string; kind: 'entity' | 'custom'; title: string; schema: Schema; has_draft: boolean
  published_version: number | null; versions: { version: number; published_at: string; published_by: string | null }[]
  published_names: string[]; errors: string[]
}

const TYPES: [string, string][] = [
  ['text', 'Text'], ['integer', 'Whole number'], ['decimal', 'Decimal'], ['date', 'Date'], ['time', 'Time'],
  ['datetime', 'Date & time'], ['select_one', 'Select one'], ['select_multiple', 'Select many'],
  ['geopoint', 'GPS location'], ['image', 'Photo / signature'], ['audio', 'Audio'], ['barcode', 'Barcode / QR'],
  ['note', 'Note'], ['calculate', 'Calculation'], ['begin_group', 'Group'], ['begin_repeat', 'Repeat group'],
]
const TYPE_LABEL: Record<string, string> = Object.fromEntries([...TYPES, ['end_group', 'End of group'], ['end_repeat', 'End of repeat']])
const isEnd = (t: string) => t === 'end_group' || t === 'end_repeat'
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 64)

export function OrgFormsTab({ org, formKey }: { org: OrgRow; formKey?: string }) {
  return formKey ? <FormEditor key={formKey} org={org} formKey={formKey} /> : <FormList org={org} />
}

// ── List ──────────────────────────────────────────────────────────────────────
function FormList({ org }: { org: OrgRow }) {
  const { toast } = useToast()
  const [forms, setForms] = useState<FormSummary[] | null>(null)
  const [creating, setCreating] = useState<{ title: string; key: string; keyTouched: boolean } | null>(null)
  const [createError, setCreateError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    saApi<FormSummary[]>(`/api/superadmin/org/${org.id}/forms`).then(setForms).catch(e => toast(errMsg(e), 'error'))
  }, [org.id, toast])
  useEffect(load, [load])

  const open = (key: string) => navigate({ page: 'orgs', orgId: org.id, orgTab: 'forms', formKey: key })

  const create = async () => {
    if (!creating) return
    if (forms?.some(f => f.form_key === creating.key)) return setCreateError('A form with this ID already exists.')
    setSaving(true); setCreateError('')
    try {
      await saApi(`/api/superadmin/org/${org.id}/forms/${creating.key}`, {
        method: 'PUT', body: { title: creating.title, schema: { settings: { form_title: creating.title }, survey: [], choices: {} } },
      })
      open(creating.key)
    } catch (e) { setCreateError(errMsg(e)) } finally { setSaving(false) }
  }

  const toggleArchive = async (f: FormSummary) => {
    try {
      await saApi(`/api/superadmin/org/${org.id}/forms/${f.form_key}/archive`, { method: 'POST', body: { archived: !f.archived_at } })
      toast(f.archived_at ? `${f.title} restored` : `${f.title} archived`); load()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const status = (f: FormSummary) => (
    <>
      {f.published_version ? <Badge tone="success">Published v{f.published_version}</Badge> : <Badge>{f.kind === 'entity' ? 'Default fields' : 'Not published'}</Badge>}
      {f.has_draft && <Badge tone="warning">Unpublished changes</Badge>}
      {f.archived_at && <Badge tone="danger">Archived</Badge>}
    </>
  )

  return (
    <>
      <Card padded={false} title="Forms"
        description="Built-in forms keep their core fields (they feed dashboards and reports); add questions, skip logic, groups and repeats around them. Custom forms are standalone surveys."
        actions={<Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setCreateError(''); setCreating({ title: '', key: '', keyTouched: false }) }}>New form</Button>}>
        {!forms ? <div className="p-5 flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
          : forms.length === 0 ? <EmptyState icon={<ClipboardList className="w-8 h-8" />} title="No forms" />
          : (
            <ul className="divide-y divide-sa-border">
              {forms.map(f => (
                <li key={f.form_key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <button className="min-w-0 text-left cursor-pointer" onClick={() => open(f.form_key)}>
                    <div className="text-sm font-medium text-sa-text flex flex-wrap items-center gap-2">
                      {f.title}<Badge tone={f.kind === 'entity' ? 'primary' : 'neutral'}>{f.kind === 'entity' ? 'Built-in' : 'Custom'}</Badge>{status(f)}
                    </div>
                    <div className="text-xs text-sa-muted">
                      <span className="font-mono">{f.form_key}</span>
                      {f.published_at && <> · published {fmtDateTime(f.published_at)}</>}
                      {f.submissions > 0 && <> · {f.submissions} submission{f.submissions === 1 ? '' : 's'}</>}
                    </div>
                  </button>
                  <div className="flex gap-1.5">
                    {f.kind === 'custom' && f.updated_at && (
                      <Button size="sm" variant="ghost" icon={f.archived_at ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />} onClick={() => toggleArchive(f)}>
                        {f.archived_at ? 'Restore' : 'Archive'}
                      </Button>
                    )}
                    <Button size="sm" onClick={() => open(f.form_key)}>Edit</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Dialog open={!!creating} onClose={() => setCreating(null)} title="New form" size="sm"
        description="A standalone survey, e.g. a household baseline. Staff fill it in FieldFlow or KoboCollect / ODK Collect."
        footer={<>
          <Button onClick={() => setCreating(null)}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!creating?.title.trim() || !/^[a-z][a-z0-9_]{1,63}$/.test(creating?.key ?? '')} onClick={create}>Create</Button>
        </>}>
        {creating && (
          <div className="flex flex-col gap-4">
            <Field label="Title">{id => <Input id={id} autoFocus value={creating.title}
              onChange={e => setCreating({ ...creating, title: e.target.value, key: creating.keyTouched ? creating.key : slug(e.target.value).replace(/^_/, 'f_') })} />}</Field>
            <Field label="Form ID" hint="Lowercase letters, digits and _. Used by ODK Collect and in exports; can't be changed later." error={createError}>
              {id => <Input id={id} className="font-mono" value={creating.key} onChange={e => setCreating({ ...creating, key: e.target.value, keyTouched: true })} />}
            </Field>
          </div>
        )}
      </Dialog>
    </>
  )
}

// ── Editor ────────────────────────────────────────────────────────────────────
function FormEditor({ org, formKey }: { org: OrgRow; formKey: string }) {
  const { toast } = useToast()
  const { confirm, dialog } = useConfirm()
  const [form, setForm] = useState<FormDetail | null>(null)
  const [schema, setSchema] = useState<Schema | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'publish'>('')
  const [addType, setAddType] = useState('text')
  const [loadError, setLoadError] = useState('')

  const url = `/api/superadmin/org/${org.id}/forms/${formKey}`
  const load = useCallback(async () => {
    try {
      const f = await saApi<FormDetail>(url)
      setForm(f); setSchema(f.schema); setErrors(f.errors); setDirty(false)
    } catch (e) { setLoadError(errMsg(e)) }
  }, [url])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const published = useMemo(() => new Set(form?.published_names ?? []), [form])
  const depths = useMemo(() => {
    let d = 0
    return (schema?.survey ?? []).map(r => { if (isEnd(r.type)) d = Math.max(0, d - 1); const at = d; if (r.type.startsWith('begin_')) d++; return at })
  }, [schema])

  const back = (
    <a href={routeHref({ page: 'orgs', orgId: org.id, orgTab: 'forms' })} className="inline-flex items-center gap-1 text-xs font-semibold text-sa-muted hover:text-sa-text mb-3"
      onClick={e => { if (dirty && !window.confirm('Discard unsaved changes?')) e.preventDefault() }}>
      <ArrowLeft className="w-3.5 h-3.5" /> All forms
    </a>
  )
  if (loadError) return <>{back}<div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{loadError}</div></>
  if (!form || !schema) return <>{back}<Skeleton className="h-96" /></>

  const update = (next: Schema) => { setSchema(next); setDirty(true) }
  const setRow = (i: number, patch: Partial<Row>) => update({ ...schema, survey: schema.survey.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const setChoices = (list: string, items: Choice[]) => update({ ...schema, choices: { ...schema.choices, [list]: items } })

  const uniqueName = (base: string) => {
    const names = new Set(schema.survey.map(r => r.name))
    let n = 1; while (names.has(`${base}_${n}`)) n++
    return `${base}_${n}`
  }
  const add = () => {
    const at = Math.min(selected + 1, schema.survey.length)
    const name = uniqueName(addType.replace(/^begin_/, ''))
    const rows: Row[] = addType.startsWith('begin_')
      ? [{ type: addType, name, label: TYPE_LABEL[addType] }, { type: addType.replace('begin_', 'end_'), name: '' }]
      : [{ type: addType, name, label: addType === 'calculate' ? undefined : 'New question', ...(addType.startsWith('select_') ? { list: name } : {}) }]
    const choices = addType.startsWith('select_') ? { ...schema.choices, [name]: [{ name: 'option_1', label: 'Option 1' }] } : schema.choices
    update({ ...schema, survey: [...schema.survey.slice(0, at), ...rows, ...schema.survey.slice(at)], choices })
    setSelected(at)
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= schema.survey.length) return
    const survey = [...schema.survey];[survey[i], survey[j]] = [survey[j], survey[i]]
    update({ ...schema, survey }); setSelected(j)
  }
  const remove = (i: number) => {
    const r = schema.survey[i]
    let drop = new Set([i])
    if (r.type.startsWith('begin_')) { // remove the matching end too; contents move up a level
      let d = 0
      for (let j = i; j < schema.survey.length; j++) {
        const t = schema.survey[j].type
        if (t.startsWith('begin_')) d++
        if (isEnd(t) && --d === 0) { drop = new Set([i, j]); break }
      }
    }
    update({ ...schema, survey: schema.survey.filter((_, j) => !drop.has(j)) })
    setSelected(Math.max(0, i - 1))
  }

  const save = async () => {
    setBusy('save')
    try {
      const r = await saApi<{ errors: string[] }>(url, { method: 'PUT', body: { title: schema.settings.form_title, schema } })
      setErrors(r.errors); setDirty(false); setForm({ ...form, has_draft: true })
      toast(r.errors.length ? 'Draft saved — fix the problems listed before publishing' : 'Draft saved')
      return r.errors
    } catch (e) { toast(errMsg(e), 'error'); return null } finally { setBusy('') }
  }
  const publish = async () => {
    const errs = dirty || !form.has_draft ? await save() : errors
    if (errs === null) return
    if (errs.length) return toast('Fix the problems listed before publishing', 'error')
    const ok = await confirm({
      title: `Publish ${form.published_version ? `version ${form.published_version + 1}` : 'this form'}?`,
      body: 'Field staff get this version next time their app syncs. Existing answers keep the version they were collected with.',
      confirmLabel: 'Publish',
    })
    if (!ok) return
    setBusy('publish')
    try {
      const r = await saApi<{ version: number }>(`${url}/publish`, { method: 'POST' })
      toast(`Published version ${r.version}`); await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) void load()
      toast(errMsg(e), 'error')
    } finally { setBusy('') }
  }

  const row = schema.survey[selected] as Row | undefined
  const locked = !!row && (row.system || published.has(row.name))
  const usage = (list: string) => schema.survey.filter(r => r.list === list).length

  return (
    <>
      {back}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div className="min-w-0 flex-1">
          <Input aria-label="Form title" value={schema.settings.form_title} className="text-base font-semibold max-w-md"
            onChange={e => update({ ...schema, settings: { ...schema.settings, form_title: e.target.value } })} />
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-sa-muted">
            <span className="font-mono">{formKey}</span>
            {form.published_version ? <Badge tone="success">Published v{form.published_version}</Badge> : <Badge>Not published</Badge>}
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : form.has_draft && <Badge tone="warning">Draft not published</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button icon={<Save className="w-4 h-4" />} loading={busy === 'save'} disabled={!dirty || !!busy} onClick={() => void save()}>Save draft</Button>
          <Button variant="primary" icon={<Upload className="w-4 h-4" />} loading={busy === 'publish'} disabled={!!busy || (!dirty && !form.has_draft && !!form.published_version)} onClick={() => void publish()}>Publish</Button>
        </div>
      </div>

      {errors.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">
          <strong>{errors.length} problem{errors.length === 1 ? '' : 's'} to fix before publishing{dirty ? ' (as of last save)' : ''}:</strong>
          <ul className="list-disc ml-5 mt-1">{errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        <Card padded={false} className="lg:col-span-2" title={`${schema.survey.filter(r => !isEnd(r.type)).length} questions`}>
          <ol className="max-h-[65vh] overflow-y-auto py-1">
            {schema.survey.map((r, i) => (
              <li key={i} style={{ paddingLeft: 12 + depths[i] * 16 }}
                className={`flex items-center gap-2 pr-2 py-1.5 border-l-2 ${i === selected ? 'border-sa-primary bg-sa-primary-soft' : 'border-transparent hover:bg-sa-subtle'}`}>
                <button className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => setSelected(i)}>
                  <span className={`block text-sm truncate ${r.archived ? 'line-through text-sa-muted' : 'text-sa-text'} ${isEnd(r.type) ? 'text-sa-muted italic' : ''}`}>
                    {isEnd(r.type) ? TYPE_LABEL[r.type] : (r.label || r.name)}{r.required && <span className="text-sa-danger"> *</span>}
                  </span>
                  {!isEnd(r.type) && <span className="flex items-center gap-1 text-[11px] text-sa-muted">
                    {r.system && <Lock className="w-3 h-3" aria-label="Built-in field" />}{TYPE_LABEL[r.type] ?? r.type} · <span className="font-mono">{r.name}</span>
                  </span>}
                </button>
                <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="w-3.5 h-3.5" /></Button>
                <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === schema.survey.length - 1} onClick={() => move(i, 1)}><ArrowDown className="w-3.5 h-3.5" /></Button>
              </li>
            ))}
          </ol>
          <div className="flex gap-2 p-3 border-t border-sa-border">
            <Select aria-label="Question type" value={addType} onChange={e => setAddType(e.target.value)}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Button icon={<Plus className="w-4 h-4" />} onClick={add}>Add</Button>
          </div>
        </Card>

        <Card className="lg:col-span-3" title={row ? (isEnd(row.type) ? TYPE_LABEL[row.type] : row.label || row.name) : 'No question selected'}
          description={row?.system ? 'Built-in field: saved to its own column. You can relabel, reorder and add conditions, but not rename, retype or delete it.'
            : row && published.has(row.name) ? 'Published question: archive it instead of deleting so old answers stay readable.' : undefined}
          actions={row && !row.system && !isEnd(row.type) && (published.has(row.name)
            ? <Button size="sm" variant="ghost" icon={row.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />} onClick={() => setRow(selected, { archived: !row.archived })}>{row.archived ? 'Restore' : 'Archive'}</Button>
            : <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => remove(selected)}>Delete</Button>)}>
          {!row ? <p className="text-sm text-sa-muted">Add a question to get started.</p>
            : isEnd(row.type) ? <p className="text-sm text-sa-muted">Questions above this marker (back to its matching start) belong to the {row.type === 'end_repeat' ? 'repeat' : 'group'}. Move it to change what's inside.</p>
            : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Type">{id => (
                  <Select id={id} value={row.type} disabled={locked || row.type.startsWith('begin_')} onChange={e => setRow(selected, { type: e.target.value, ...(e.target.value.startsWith('select_') && !row.list ? { list: row.name } : {}) })}>
                    {TYPES.filter(([v]) => row.type.startsWith('begin_') || !v.startsWith('begin_')).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                )}</Field>
                <Field label="Name" hint={<>Data column; use <code>{'${' + row.name + '}'}</code> in conditions.</>}>{id => (
                  <Input id={id} className="font-mono" value={row.name} disabled={locked} onChange={e => setRow(selected, { name: e.target.value })} />
                )}</Field>
                {row.type !== 'calculate' && <Field label="Label" className="sm:col-span-2">{id => <Textarea id={id} rows={2} value={row.label ?? ''} onChange={e => setRow(selected, { label: e.target.value })} />}</Field>}
                {!row.type.startsWith('begin_') && row.type !== 'calculate' && row.type !== 'note' && <>
                  <Field label="Hint" className="sm:col-span-2">{id => <Input id={id} value={row.hint ?? ''} onChange={e => setRow(selected, { hint: e.target.value })} />}</Field>
                  <div className="sm:col-span-2"><Switch label="Required" checked={!!row.required} onChange={v => setRow(selected, { required: v })} /></div>
                </>}

                {row.type.startsWith('select_') && (
                  <ChoiceEditor list={row.list ?? ''} lists={Object.keys(schema.choices)} items={schema.choices[row.list ?? ''] ?? []} usage={usage(row.list ?? '')}
                    disabled={!!row.system && !!row.list} onPick={list => { setRow(selected, { list }); if (!schema.choices[list]) setChoices(list, []) }}
                    onChange={items => setChoices(row.list ?? '', items)} />
                )}

                <Expr label="Show only if (relevant)" placeholder="${age} >= 18" value={row.relevant} onChange={v => setRow(selected, { relevant: v })} />
                {row.type === 'calculate' && <Expr label="Calculation" placeholder="${male_count} + ${female_count}" value={row.calculation} onChange={v => setRow(selected, { calculation: v })} />}
                {row.type === 'begin_repeat' && <Expr label="Repeat count (optional)" placeholder="${members}" value={row.repeat_count} onChange={v => setRow(selected, { repeat_count: v })} />}
                {!row.type.startsWith('begin_') && row.type !== 'calculate' && row.type !== 'note' && <>
                  <Expr label="Constraint" placeholder=". >= 0 and . <= 120" value={row.constraint} onChange={v => setRow(selected, { constraint: v })} />
                  <Field label="Constraint message">{id => <Input id={id} value={row.constraint_message ?? ''} onChange={e => setRow(selected, { constraint_message: e.target.value })} />}</Field>
                  <Field label="Default">{id => <Input id={id} value={row.default ?? ''} onChange={e => setRow(selected, { default: e.target.value })} />}</Field>
                </>}
                <Field label="Appearance" hint="ODK appearance, e.g. multiline, minimal, signature, numbers.">{id => (
                  <Input id={id} className="font-mono" value={row.appearance ?? ''} disabled={!!row.system && !!row.appearance?.startsWith('lgd-')} onChange={e => setRow(selected, { appearance: e.target.value })} />
                )}</Field>
              </div>
            )}
        </Card>
      </div>

      {form.versions.length > 0 && (
        <Card className="mt-4" title="Versions" padded={false}>
          <ul className="divide-y divide-sa-border text-sm">
            {form.versions.map(v => (
              <li key={v.version} className="flex justify-between gap-3 px-5 py-2">
                <span className="text-sa-text">v{v.version}</span>
                <span className="text-sa-muted">{fmtDateTime(v.published_at)}{v.published_by ? ` · ${v.published_by}` : ''}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialog}
    </>
  )
}

function Expr({ label, value, onChange, placeholder }: { label: string; value?: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <Field label={label} className="sm:col-span-2" hint="ODK XPath: refer to other questions as ${name}; . is this answer.">
      {id => <Input id={id} className="font-mono" placeholder={placeholder} value={value ?? ''} onChange={e => onChange(e.target.value)} />}
    </Field>
  )
}

function ChoiceEditor({ list, lists, items, usage, disabled, onPick, onChange }: {
  list: string; lists: string[]; items: Choice[]; usage: number; disabled: boolean
  onPick: (list: string) => void; onChange: (items: Choice[]) => void
}) {
  const [newList, setNewList] = useState('')
  const set = (i: number, patch: Partial<Choice>) => onChange(items.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <div className="sm:col-span-2 flex flex-col gap-3 rounded-lg border border-sa-border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Choice list" className="flex-1 min-w-40" hint={usage > 1 ? `Shared by ${usage} questions. Edits apply to all of them.` : undefined}>{id => (
          <Select id={id} value={list} disabled={disabled} onChange={e => onPick(e.target.value)}>
            {!lists.includes(list) && <option value={list}>{list || 'Choose…'}</option>}
            {lists.map(l => <option key={l} value={l}>{l}</option>)}
          </Select>
        )}</Field>
        {!disabled && <>
          <Input aria-label="New list name" placeholder="new_list" className="w-36 font-mono" value={newList} onChange={e => setNewList(slug(e.target.value))} />
          <Button disabled={!newList || lists.includes(newList)} onClick={() => { onPick(newList); setNewList('') }}>New list</Button>
        </>}
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-sa-muted text-left"><th className="font-semibold pb-1">Value (saved)</th><th className="font-semibold pb-1">Label (shown)</th><th /></tr></thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={i}>
              <td className="pr-2 py-1"><Input aria-label="Value" className="font-mono py-1.5" value={c.name} disabled={disabled} onChange={e => set(i, { name: e.target.value })} /></td>
              <td className="pr-2 py-1"><Input aria-label="Label" className="py-1.5" value={c.label} onChange={e => set(i, { label: e.target.value, ...(!disabled && c.name === slug(c.label) ? { name: slug(e.target.value) } : {}) })} /></td>
              <td><Button size="sm" variant="ghost" aria-label="Remove option" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} className="self-start" onClick={() => onChange([...items, { name: '', label: '' }])}>Add option</Button>}
    </div>
  )
}
