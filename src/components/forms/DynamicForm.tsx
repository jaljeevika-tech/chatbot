// Renders an XLSForm-shaped schema (lib/forms.js) and edits its answers. All logic —
// skip logic, calculations, repeat counts, required, constraints — comes from
// lib/odkForm.js, the same code the server validates submissions with.

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { MapPin, Plus, Trash2, X } from 'lucide-react'
import { buildTree, evaluateForm, type Answers, type FormRow, type FormSchema, type TreeNode } from '../../../lib/odkForm'
import { FF } from '../../theme/colors'
import { Btn, inputStyle } from '../hr/hrUi'
import { getLocationFix } from '../../utils/hr/geo'
import { lgdOptions, type LgdLevel } from './lgdOptions'
import { apiFetch } from '../../utils/apiFetch'

const LGD_LEVELS: LgdLevel[] = ['state', 'district', 'block', 'panchayat', 'village']

type Path = (string | number)[]

function setAt(obj: Answers, path: Path, value: unknown): Answers {
  const [head, ...rest] = path
  const copy: any = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) }
  copy[head] = rest.length ? setAt(copy[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value) : value
  if (value === undefined && !rest.length) delete copy[head]
  return copy
}

/** Starting answers for a fresh form / repeat instance: each question's literal default. */
export function defaultAnswers(nodes: TreeNode[]): Answers {
  const out: Answers = {}
  for (const { row, children } of nodes) {
    if (row.type === 'begin_group') Object.assign(out, defaultAnswers(children))
    else if (row.default && !row.type.startsWith('begin_') && row.type !== 'calculate') out[row.name] = row.type === 'select_multiple' ? row.default.split(' ') : row.default
  }
  return out
}

const MAX_SIDE = 1600
/** Phone photos are 3–8 MB; re-encode to ≤1600px JPEG so the offline queue and upload stay small. */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(img.src)
      resolve(canvas.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => reject(new Error('Could not read that image'))
    img.src = URL.createObjectURL(file)
  })
}
const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file)
})

export function DynamicForm({ schema, value, onChange, showErrors }: {
  schema: FormSchema; value: Answers; onChange: (next: Answers) => void; showErrors: boolean
}) {
  const { tree } = useMemo(() => buildTree(schema.survey), [schema])
  const { errors, relevant, repeatCounts } = useMemo(() => evaluateForm(schema, value), [schema, value])
  const set = (path: Path, v: unknown) => onChange(setAt(value, path, v))

  const renderNodes = (nodes: TreeNode[], obj: Answers, path: Path, prefix: string): ReactNode => nodes.map(({ row, children }) => {
    if (row.archived || row.type === 'calculate') return null
    const key = prefix + row.name
    if (relevant[key] === false) return null

    if (row.type === 'begin_group') return (
      <fieldset key={key} style={{ border: `1px solid ${FF.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {row.label && <legend style={{ fontSize: 14, fontWeight: 600, color: FF.tealDark, padding: '0 6px' }}>{row.label}</legend>}
        {renderNodes(children, obj, path, prefix)}
      </fieldset>
    )

    if (row.type === 'begin_repeat') {
      const items = (Array.isArray(obj[row.name]) ? obj[row.name] : []) as Answers[]
      const fixed = repeatCounts[key]
      const shown = fixed !== undefined ? Array.from({ length: fixed }, (_, i) => items[i] ?? {}) : items
      if (fixed === 0) return null
      return (
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: FF.tealDark }}>{row.label}</div>
          {shown.map((item, i) => (
            <div key={i} style={{ border: `1px solid ${FF.border}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12.5, fontWeight: 600, color: FF.textMuted }}>{row.label} {i + 1}</span>
                {fixed === undefined && (
                  <Btn variant="ghost" aria-label={`Remove ${row.label} ${i + 1}`} onClick={() => set([...path, row.name], items.filter((_, j) => j !== i))}>
                    <Trash2 className="w-4 h-4" />
                  </Btn>
                )}
              </div>
              {renderNodes(children, item, [...path, row.name, i], `${key}[${i}].`)}
            </div>
          ))}
          {fixed === undefined && (
            <Btn style={{ alignSelf: 'flex-start' }} onClick={() => set([...path, row.name], [...items, defaultAnswers(children)])}>
              <span className="inline-flex items-center gap-1.5"><Plus className="w-4 h-4" />Add {row.label}</span>
            </Btn>
          )}
        </div>
      )
    }

    return (
      <Question key={key} row={row} value={obj[row.name]} siblings={obj} choices={schema.choices[row.list ?? ''] ?? []}
        error={showErrors ? errors[key] : undefined}
        onChange={v => {
          const level = row.appearance?.startsWith('lgd-') ? row.appearance.slice(4) as LgdLevel : null
          if (!level) return set([...path, row.name], v)
          // A new state/district/... invalidates every level below it (as in the registration forms).
          let next = setAt(value, [...path, row.name], v)
          for (const lower of LGD_LEVELS.slice(LGD_LEVELS.indexOf(level) + 1)) if (lower in obj) next = setAt(next, [...path, lower], undefined)
          onChange(next)
        }} />
    )
  })

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{renderNodes(tree, value, [], '')}</div>
}

function Question({ row, value, siblings, choices, error, onChange }: {
  row: FormRow; value: unknown; siblings: Answers; choices: { name: string; label: string }[]; error?: string; onChange: (v: unknown) => void
}) {
  const id = useId()
  const [busy, setBusy] = useState('')
  const str = value == null ? '' : String(value)
  const describedBy = [row.hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': !!error || undefined, 'aria-required': row.required || undefined }
  const ctl = { ...inputStyle, ...(error ? { border: `1px solid ${FF.red}` } : {}) }

  if (row.type === 'note') return <div style={{ fontSize: 14, color: FF.tealText, whiteSpace: 'pre-wrap' }}>{row.label}</div>

  let control: ReactNode
  switch (row.type) {
    case 'integer': case 'decimal':
      control = <input {...common} type="number" inputMode={row.type === 'integer' ? 'numeric' : 'decimal'} step={row.type === 'integer' ? 1 : 'any'}
        style={ctl} value={str} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)} />
      break
    case 'date': case 'time':
      control = <input {...common} type={row.type} style={ctl} value={str} onChange={e => onChange(e.target.value || undefined)} />
      break
    case 'datetime':
      control = <input {...common} type="datetime-local" style={ctl} value={str.slice(0, 16)} onChange={e => onChange(e.target.value || undefined)} />
      break
    case 'select_one':
      control = row.appearance?.includes('minimal') || choices.length > 8
        ? (
          <select {...common} style={ctl} value={str} onChange={e => onChange(e.target.value || undefined)}>
            <option value="">Choose…</option>
            {choices.map(c => <option key={c.name} value={c.name}>{c.label}</option>)}
          </select>
        ) : (
          <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {choices.map(c => (
              <label key={c.name} className="inline-flex items-center gap-2" style={{ fontSize: 14, color: FF.tealText, cursor: 'pointer' }}>
                <input type="radio" name={id} checked={str === c.name} onChange={() => onChange(c.name)} />{c.label}
              </label>
            ))}
            {str && !row.required && <button type="button" onClick={() => onChange(undefined)} style={{ alignSelf: 'flex-start', fontSize: 12, color: FF.textMuted, background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>Clear</button>}
          </div>
        )
      break
    case 'select_multiple': {
      const picked = Array.isArray(value) ? value.map(String) : str.split(' ').filter(Boolean)
      control = (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choices.map(c => (
            <label key={c.name} className="inline-flex items-center gap-2" style={{ fontSize: 14, color: FF.tealText, cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(c.name)}
                onChange={e => { const next = e.target.checked ? [...picked, c.name] : picked.filter(p => p !== c.name); onChange(next.length ? next : undefined) }} />
              {c.label}
            </label>
          ))}
        </div>
      )
      break
    }
    case 'geopoint': {
      const [lat, lng, , acc] = str.split(' ')
      control = (
        <div className="flex items-center gap-2 flex-wrap">
          <Btn id={id} aria-describedby={describedBy} disabled={!!busy} onClick={async () => {
            setBusy('Locating…')
            const fix = await getLocationFix()
            setBusy('')
            if (fix.status === 'ok') onChange(`${fix.lat} ${fix.lng} 0 ${fix.accuracy}`)
            else alert(fix.status === 'denied' ? 'Location permission was denied.' : 'Could not get a GPS fix. Try again outdoors.')
          }}>
            <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" />{busy || (str ? 'Recapture location' : 'Capture location')}</span>
          </Btn>
          {str && <span style={{ fontSize: 13, color: FF.tealText }}>{lat}, {lng}{acc ? ` (±${acc} m)` : ''}</span>}
          {str && <Btn variant="ghost" aria-label="Clear location" onClick={() => onChange(undefined)}><X className="w-4 h-4" /></Btn>}
        </div>
      )
      break
    }
    case 'image': case 'audio': {
      const isImage = row.type === 'image'
      control = (
        <div className="flex flex-col gap-2">
          <input {...common} type="file" accept={isImage ? 'image/*' : 'audio/*'} capture={isImage ? 'environment' : undefined} disabled={!!busy}
            onChange={async e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              if (file.size > 25 * 1024 * 1024) return alert('That file is larger than 25 MB.')
              setBusy('Processing…')
              try {
                const url = isImage ? await compressImage(file) : await readDataUrl(file)
                if (url.length * 0.75 > 10 * 1024 * 1024) alert('That file is still larger than 10 MB after processing.')
                else onChange(url)
              } catch (err) { alert(err instanceof Error ? err.message : 'Could not read that file') } finally { setBusy('') }
            }} />
          {busy && <span style={{ fontSize: 12.5, color: FF.textMuted }}>{busy}</span>}
          {str.startsWith('data:image/') && <img src={str} alt={`${row.label} preview`} style={{ maxWidth: 240, borderRadius: 8, border: `1px solid ${FF.border}` }} />}
          {str.startsWith('data:audio/') && <audio controls src={str} />}
          {str && <Btn variant="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(undefined)}>Remove file</Btn>}
        </div>
      )
      break
    }
    default:
      if (row.appearance?.startsWith('lgd-')) {
        control = <LgdInput level={row.appearance.slice(4) as LgdLevel} common={common} style={ctl} value={str} siblings={siblings} onChange={onChange} />
        break
      }
      if (row.appearance === 'beneficiary-lookup') {
        control = <>
          <input {...common} type="text" autoCapitalize="characters" spellCheck={false} style={{ ...ctl, textTransform: 'uppercase' }} value={str}
            onChange={e => onChange(e.target.value.trim().toUpperCase() || undefined)} />
          <BeneficiaryPreview uid={str} />
        </>
        break
      }
      control = row.appearance?.includes('multiline')
        ? <textarea {...common} rows={3} style={ctl} value={str} onChange={e => onChange(e.target.value || undefined)} />
        : <input {...common} type="text" inputMode={row.appearance?.includes('numbers') ? 'numeric' : undefined} style={ctl} value={str} onChange={e => onChange(e.target.value || undefined)} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label id={`${id}-label`} htmlFor={id} style={{ fontSize: 14, fontWeight: 600, color: FF.tealDark }}>
        {row.label}{row.required && <span style={{ color: FF.red }} aria-hidden> *</span>}
      </label>
      {row.hint && <span id={`${id}-hint`} style={{ fontSize: 12.5, color: FF.textMuted, marginTop: -2 }}>{row.hint}</span>}
      {control}
      {error && <span id={`${id}-err`} role="alert" style={{ fontSize: 12.5, color: FF.red }}>{error}</span>}
    </div>
  )
}

function LgdInput({ level, common, style, value, siblings, onChange }: {
  level: LgdLevel; common: Record<string, unknown>; style: React.CSSProperties; value: string; siblings: Answers; onChange: (v: unknown) => void
}) {
  const [options, setOptions] = useState<string[] | null>(null)
  const listId = useId()
  const dropdown = level === 'state' || level === 'district'
  // Parent answers scope the lookup; for typeahead levels the typed text narrows it too.
  const scope = LGD_LEVELS.slice(0, LGD_LEVELS.indexOf(level)).map(l => String(siblings[l] ?? '')).join('|')
  useEffect(() => {
    let live = true
    const t = setTimeout(() => { void lgdOptions(level, siblings, dropdown ? '' : value).then(o => { if (live) setOptions(o) }) }, dropdown ? 0 : 250)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, scope, dropdown ? '' : value])

  if (dropdown && options) {
    return (
      <select {...common} style={style} value={value} onChange={e => onChange(e.target.value || undefined)}>
        <option value="">Select {level}…</option>
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  return (
    <>
      <input {...common} type="text" list={options ? listId : undefined} autoComplete="off" style={style} value={value}
        placeholder={level === 'district' && !siblings.state ? 'Select state first, or type' : undefined}
        onChange={e => onChange(e.target.value || undefined)} />
      {options && <datalist id={listId}>{options.map(o => <option key={o} value={o} />)}</datalist>}
    </>
  )
}

type Lookup = { state: 'found'; name: string; type: string; location: string } | { state: 'missing' | 'offline'; message: string }
const lookups = new Map<string, Lookup>()

/** Shows who a beneficiary UID belongs to before submit. Advisory only — the server re-checks on submit. */
function BeneficiaryPreview({ uid }: { uid: string }) {
  const [result, setResult] = useState<Lookup | null>(null)
  const complete = /^(IB|EB|CB)-[A-Z]+-\d+$/.test(uid)
  useEffect(() => {
    if (!complete) { setResult(null); return }
    if (lookups.has(uid)) { setResult(lookups.get(uid)!); return }
    let live = true
    const t = setTimeout(async () => {
      let next: Lookup
      try {
        const r = await apiFetch(`/api/forms/beneficiary-lookup?uid=${encodeURIComponent(uid)}`)
        const j = await r.json().catch(() => ({}))
        next = r.ok ? { state: 'found', name: j.name, type: j.type, location: j.location }
          : r.status === 404 || r.status === 400 ? { state: 'missing', message: j.error || 'No beneficiary found' }
          : { state: 'offline', message: "Couldn't check this UID right now. It will be checked when the form is sent." }
        if (next.state === 'found') lookups.set(uid, next) // a missing UID may be registered later this session
      } catch {
        next = { state: 'offline', message: "Can't check while offline. It will be checked when the form is sent." }
      }
      if (live) setResult(next)
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [uid, complete])

  if (!result) return null
  const tone = result.state === 'found' ? FF.green : result.state === 'missing' ? FF.red : FF.textMuted
  return (
    <span role="status" style={{ fontSize: 12.5, color: tone }}>
      {result.state === 'found' ? <><strong>{result.name}</strong> · {result.type}{result.location ? ` · ${result.location}` : ''}</> : result.message}
    </span>
  )
}
