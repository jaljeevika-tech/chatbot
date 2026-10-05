// Org settings stored in organizations.metadata. Each tab saves only its own
// section(s), laid over the stored section so keys this UI doesn't show survive.

import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, Info } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import type { OrgRow } from './types'
import { Button, Card, Field, Input, Select, Textarea, Switch, Badge, CopyButton } from './ui'

type Meta = Record<string, unknown>
const section = (org: OrgRow, key: string): Meta => {
  const v = (org.metadata as Meta)?.[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Meta : {}
}

function useMetaSave(org: OrgRow, onSaved: () => void) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const save = async (patch: Record<string, Meta>) => {
    setSaving(true)
    try {
      const merged: Record<string, Meta> = {}
      for (const [k, v] of Object.entries(patch)) merged[k] = { ...section(org, k), ...v }
      await saApi(`/api/superadmin/org/${org.id}/metadata`, { method: 'PATCH', body: merged })
      toast('Saved'); onSaved()
    } catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }
  return { save, saving }
}

const SaveBar = ({ saving, onSave, dirty }: { saving: boolean; onSave: () => void; dirty: boolean }) => (
  <div className="flex items-center justify-end gap-3 mt-5">
    {dirty && <span className="text-xs text-sa-warning">Unsaved changes</span>}
    <Button variant="primary" loading={saving} disabled={!dirty} onClick={onSave}>Save changes</Button>
  </div>
)

// ── Branding ──────────────────────────────────────────────────────────────────
const THEME_FIELDS = [
  { key: 'primary',    label: 'Primary',    hint: 'Buttons, links, highlights' },
  { key: 'sidebar',    label: 'Sidebar',    hint: 'Navigation background' },
  { key: 'accent',     label: 'Accent',     hint: 'Secondary highlights' },
  { key: 'background', label: 'Background', hint: 'Page background' },
] as const
const HEX = /^#[0-9a-fA-F]{6}$/

export function OrgBrandingTab({ org, onSaved }: { org: OrgRow; onSaved: () => void }) {
  const stored = section(org, 'branding')
  const initial = {
    org_name: String(stored.org_name ?? org.name), tagline: String(stored.tagline ?? ''),
    dashboard_title: String(stored.dashboard_title ?? ''), logo_url: String(stored.logo_url ?? ''),
    theme: { primary: '#1D0752', sidebar: '#341272', accent: '#A78BFA', background: '#F5F3FB', ...(stored.theme as Record<string, string> ?? {}) },
  }
  const [b, setB] = useState(initial)
  const { save, saving } = useMetaSave(org, onSaved)
  const dirty = JSON.stringify(b) !== JSON.stringify(initial)
  const badHex = THEME_FIELDS.some(f => !HEX.test(b.theme[f.key] ?? ''))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-3" title="Identity" description="Shown in the organisation’s dashboard header, reports and login screen.">
        <div className="flex flex-col gap-4">
          <Field label="Display name">{id => <Input id={id} value={b.org_name} onChange={e => setB({ ...b, org_name: e.target.value })} />}</Field>
          <Field label="Tagline">{id => <Input id={id} value={b.tagline} onChange={e => setB({ ...b, tagline: e.target.value })} placeholder="e.g. Water for every village" />}</Field>
          <Field label="Dashboard title">{id => <Input id={id} value={b.dashboard_title} onChange={e => setB({ ...b, dashboard_title: e.target.value })} />}</Field>
          <Field label="Logo URL" hint="The org’s admins can also upload a logo from their own Settings. Direct upload here comes with the theming phase.">
            {id => <Input id={id} value={b.logo_url.startsWith('data:') ? '(uploaded image)' : b.logo_url} disabled={b.logo_url.startsWith('data:')} onChange={e => setB({ ...b, logo_url: e.target.value })} placeholder="https://…/logo.png" />}
          </Field>
        </div>
        <div className="mt-6">
          <div className="text-xs font-semibold text-sa-muted mb-2">Theme colours</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {THEME_FIELDS.map(f => (
              <div key={f.key} className="flex items-center gap-3 rounded-lg border border-sa-border p-2.5">
                <input type="color" aria-label={`${f.label} colour`} value={HEX.test(b.theme[f.key]) ? b.theme[f.key] : '#000000'}
                  onChange={e => setB({ ...b, theme: { ...b.theme, [f.key]: e.target.value } })}
                  className="w-9 h-9 rounded-md border border-sa-border cursor-pointer bg-transparent p-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-sa-text">{f.label}</div>
                  <div className="text-xs text-sa-muted">{f.hint}</div>
                </div>
                <Input aria-label={`${f.label} hex`} value={b.theme[f.key]} onChange={e => setB({ ...b, theme: { ...b.theme, [f.key]: e.target.value.trim() } })}
                  className={`w-24 font-mono text-xs py-1.5 ${HEX.test(b.theme[f.key]) ? '' : 'border-sa-danger'}`} />
              </div>
            ))}
          </div>
        </div>
        {badHex && <p className="text-xs text-sa-danger mt-3">Colours must be 6-digit hex values like #341272.</p>}
        <SaveBar saving={saving} dirty={dirty && !badHex} onSave={() => save({ branding: { ...b, theme: { ...(stored.theme as Meta ?? {}), ...b.theme } } })} />
      </Card>

      <Card className="lg:col-span-2" title="Preview" description="Approximate. Not every screen uses the org colours yet; that comes in the theming phase.">
        <div className="rounded-lg overflow-hidden border border-sa-border flex h-56" style={{ background: b.theme.background }}>
          <div className="w-20 p-2 flex flex-col gap-1.5" style={{ background: b.theme.sidebar }}>
            <div className="h-6 rounded bg-white/90 flex items-center justify-center overflow-hidden">
              {b.logo_url ? <img src={b.logo_url} alt="" className="max-h-5 max-w-full object-contain" /> : <span className="text-[9px] font-bold" style={{ color: b.theme.primary }}>LOGO</span>}
            </div>
            {[0, 1, 2, 3].map(i => <div key={i} className="h-2 rounded" style={{ background: i === 0 ? b.theme.accent : 'rgba(255,255,255,0.25)' }} />)}
          </div>
          <div className="flex-1 p-3 flex flex-col gap-2 min-w-0">
            <div className="text-xs font-bold truncate" style={{ color: b.theme.primary }}>{b.dashboard_title || b.org_name}</div>
            <div className="text-[10px] text-gray-500 truncate">{b.tagline}</div>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {[0, 1].map(i => <div key={i} className="h-10 rounded bg-white shadow-sm border border-black/5" />)}
            </div>
            <div className="mt-auto self-start rounded px-2 py-1 text-[10px] font-semibold text-white" style={{ background: b.theme.primary }}>Submit report</div>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ── Modules & AI ──────────────────────────────────────────────────────────────
// `on` = the default when a key is missing, so a first save doesn't flip it.
const MODULES: { key: string; label: string; description: string; enforced?: boolean; on?: boolean }[] = [
  { key: 'reports',          label: 'Field reports',        description: 'Daily field reporting and report library.', on: true },
  { key: 'worker_analytics', label: 'Worker analytics',     description: 'Per-worker performance insights.', on: true },
  { key: 'media_library',    label: 'Media library',        description: 'Photos, videos and documents per project.' },
  { key: 'notebook',         label: 'AI notebook',          description: 'Ask-AI notebook with audio and video overviews.' },
  { key: 'report_writer',    label: 'Report writer',        description: 'AI-assisted donor and impact report drafting.', on: true },
  { key: 'social_posts',     label: 'Social posts',         description: 'AI-generated social media posts from field stories.' },
  { key: 'finance',          label: 'Finance workspace',    description: 'Standalone finance page (#jems-finance).', enforced: true },
]
const LANGS = [['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['or', 'Odia'], ['bn', 'Bengali'], ['te', 'Telugu'], ['ta', 'Tamil']]

export function OrgModulesTab({ org, onSaved }: { org: OrgRow; onSaved: () => void }) {
  const storedMods = section(org, 'modules') as Record<string, { enabled?: boolean }>
  const storedAi = section(org, 'ai_config')
  const initMods = Object.fromEntries(MODULES.map(m => [m.key, storedMods[m.key]?.enabled ?? !!m.on]))
  const initAi = { system_persona: String(storedAi.system_persona ?? ''), default_language: String(storedAi.default_language ?? 'en') }
  const [mods, setMods] = useState<Record<string, boolean>>(initMods)
  const [ai, setAi] = useState(initAi)
  const { save, saving } = useMetaSave(org, onSaved)
  const dirty = JSON.stringify(mods) !== JSON.stringify(initMods) || JSON.stringify(ai) !== JSON.stringify(initAi)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card title="Modules" description="Turn features on or off for this organisation.">
        <div className="flex items-start gap-2 rounded-lg bg-sa-warning-soft text-sa-warning text-xs px-3 py-2 mb-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Only modules marked “enforced” are hidden from the org today. Full per-org and per-plan feature control comes in the theming &amp; white-label phase.</span>
        </div>
        <div className="divide-y divide-sa-border">
          {MODULES.map(m => (
            <Switch key={m.key} checked={!!mods[m.key]} onChange={v => setMods({ ...mods, [m.key]: v })}
              label={m.label} description={<>{m.description} {m.enforced && <Badge tone="success" className="ml-1">enforced</Badge>}</>} />
          ))}
        </div>
      </Card>
      <Card title="AI assistant" description={org.ai_enabled ? 'AI is included in this organisation’s plan.' : 'AI is not included in this organisation’s plan, so these settings have no effect until it is.'}>
        <div className="flex flex-col gap-4">
          <Field label="Default language">
            {id => <Select id={id} value={ai.default_language} onChange={e => setAi({ ...ai, default_language: e.target.value })}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
          </Field>
          <Field label="Persona" hint="How the AI describes the organisation and its work. Used as context in every AI answer.">
            {id => <Textarea id={id} rows={7} value={ai.system_persona} onChange={e => setAi({ ...ai, system_persona: e.target.value })} />}
          </Field>
        </div>
      </Card>
      <div className="lg:col-span-2">
        <SaveBar saving={saving} dirty={dirty} onSave={() => save({
          modules: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, { ...(storedMods[k] ?? {}), enabled: v }])),
          ai_config: ai,
        })} />
      </div>
    </div>
  )
}

// ── Data sources ──────────────────────────────────────────────────────────────
/** Accepts a full Google Sheets URL or a bare ID. */
const sheetIdFrom = (v: string) => v.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? v.trim()

type SheetTest = { ok: boolean; text: string; tabs?: string[] }

function SheetField({ label, hint, value, onChange }: { label: string; hint: ReactNode; value: string; onChange: (v: string) => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SheetTest | null>(null)
  const test = async () => {
    setTesting(true); setResult(null)
    try {
      const r = await saApi<{ title: string; tabs: string[] }>('/api/superadmin/sheets/test', { method: 'POST', body: { sheet_id: value } })
      setResult({ ok: true, text: `Connected to “${r.title}”`, tabs: r.tabs })
    } catch (e) { setResult({ ok: false, text: errMsg(e) }) }
    finally { setTesting(false) }
  }
  return (
    <Field label={label} hint={hint}>
      {id => (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input id={id} value={value} onChange={e => { setResult(null); onChange(sheetIdFrom(e.target.value)) }} placeholder="Paste the sheet URL or ID" className="font-mono text-xs" />
            {value && <>
              <Button type="button" loading={testing} onClick={test}>Test</Button>
              <a href={`https://docs.google.com/spreadsheets/d/${value}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-sa-border px-3 text-sm text-sa-text hover:bg-sa-subtle shrink-0">
                Open <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </>}
          </div>
          {result && (
            <div className={`rounded-lg text-xs px-3 py-2 ${result.ok ? 'bg-sa-success-soft text-sa-success' : 'bg-sa-danger-soft text-sa-danger'}`}>
              {result.text}{result.tabs?.length ? ` · tabs: ${result.tabs.join(', ')}` : ''}
            </div>
          )}
        </div>
      )}
    </Field>
  )
}

export function OrgDataTab({ org, onSaved }: { org: OrgRow; onSaved: () => void }) {
  const stored = section(org, 'data_sources')
  const initial = { users_sheet_id: String(stored.users_sheet_id ?? ''), reports_sheet_id: String(stored.reports_sheet_id ?? '') }
  const [d, setD] = useState(initial)
  const [saEmail, setSaEmail] = useState<string | null | undefined>(undefined)
  const { save, saving } = useMetaSave(org, onSaved)
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  useEffect(() => {
    saApi<{ google: { service_account_email: string | null } }>('/api/superadmin/platform/integrations')
      .then(p => setSaEmail(p.google.service_account_email)).catch(() => setSaEmail(null))
  }, [])
  return (
    <Card title="Google Sheets" description="Each sheet must be shared with the platform service account as an Editor.">
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sa-subtle border border-sa-border px-3 py-2.5 mb-5 text-sm">
        <span className="text-sa-muted">Share with</span>
        {saEmail === undefined ? <span className="text-sa-muted">…</span>
          : saEmail ? <><code className="text-xs text-sa-text break-all">{saEmail}</code><CopyButton text={saEmail} /></>
          : <Badge tone="danger">Service account not configured on the server</Badge>}
      </div>
      <div className="flex flex-col gap-5">
        <SheetField label="Users sheet" value={d.users_sheet_id} onChange={v => setD({ ...d, users_sheet_id: v })}
          hint="Needed for the org admin's own user management, and for sign-in of users who aren't in the database yet." />
        <SheetField label="Reports sheet (optional)" value={d.reports_sheet_id} onChange={v => setD({ ...d, reports_sheet_id: v })}
          hint="Where field reports submitted over WhatsApp are appended." />
      </div>
      <SaveBar saving={saving} dirty={dirty} onSave={() => save({ data_sources: d })} />
    </Card>
  )
}
