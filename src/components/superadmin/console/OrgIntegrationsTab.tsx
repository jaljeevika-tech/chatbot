// Per-org Email + WhatsApp settings. Secrets come back masked (SECRET_MASK); sending the
// mask back unchanged keeps the stored value.

import { useCallback, useEffect, useState } from 'react'
import { Mail, MessageCircle, Sheet, CheckCircle2, XCircle, Send, Activity, AlertTriangle } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg } from './api'
import { navigate } from './route'
import type { OrgRow } from './types'
import { Button, Card, Field, Input, Switch, Badge, Skeleton, fmtDateTime, CopyButton } from './ui'

const MASK = '••••••••'

type EmailCfg = {
  mode: 'platform' | 'smtp'; from_name: string; reply_to: string
  smtp_host: string; smtp_port: number; smtp_secure: boolean; smtp_user: string; smtp_pass: string; smtp_from_email: string
  last_test_at: string | null; last_test_ok: boolean | null; last_test_error: string | null
}
type EmailLogRow = { kind: string; to_address: string; subject: string; provider: string | null; ok: boolean; error: string | null; created_at: string }
type WaCfg = {
  configured: boolean; phone_number_id?: string; business_id?: string; display_phone?: string; enabled?: boolean
  access_token?: string; app_secret?: string; webhook_secret?: string; updated_at?: string
}
type OrgIntegrations = {
  migration_needed: boolean; email: EmailCfg | null; email_log: EmailLogRow[]; whatsapp: WaCfg
  sheets: { service_account_email: string | null; users_sheet_id: string; reports_sheet_id: string }
}
export type PlatformIntegrations = {
  email: { provider: string | null; resend_configured: boolean; from_address: string | null; ready: boolean }
  google: { service_account_email: string | null }
  whatsapp: { webhook_url: string | null; global_verify_token: boolean; global_app_secret: boolean }
  app_base_url: string | null
}

function TestResult({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg text-sm px-3 py-2 ${ok ? 'bg-sa-success-soft text-sa-success' : 'bg-sa-danger-soft text-sa-danger'}`}>
      {ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      <span className="min-w-0 break-words">{text}</span>
    </div>
  )
}

// ── Email ─────────────────────────────────────────────────────────────────────
function EmailCard({ org, cfg, log, platform, onSaved }: { org: OrgRow; cfg: EmailCfg; log: EmailLogRow[]; platform: PlatformIntegrations | null; onSaved: () => void }) {
  const { toast } = useToast()
  const [c, setC] = useState(cfg)
  const [saving, setSaving] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setC(cfg), [cfg])
  const dirty = JSON.stringify(c) !== JSON.stringify(cfg)
  const set = (p: Partial<EmailCfg>) => setC(prev => ({ ...prev, ...p }))
  const defaultFrom = `${org.name} via FieldFlow`

  const save = async () => {
    setSaving(true)
    try { await saApi(`/api/superadmin/org/${org.id}/email`, { method: 'PUT', body: c }); toast('Email settings saved'); onSaved() }
    catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }
  const test = async () => {
    setTesting(true); setResult(null)
    try {
      const r = await saApi<{ provider: string }>(`/api/superadmin/org/${org.id}/email/test`, { method: 'POST', body: { to: testTo } })
      setResult({ ok: true, text: `Sent to ${testTo} via ${r.provider === 'smtp' ? 'the org’s SMTP server' : r.provider === 'resend' ? 'Resend' : 'the platform SMTP account'}. Check the inbox (and spam).` })
      onSaved()
    } catch (e) { setResult({ ok: false, text: errMsg(e) }) }
    finally { setTesting(false) }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Mail className="w-4 h-4" />Email</span>}
      description="Invites, password resets and notifications for this organisation."
      actions={cfg.last_test_at ? <Badge tone={cfg.last_test_ok ? 'success' : 'danger'}>{cfg.last_test_ok ? 'Last test passed' : 'Last test failed'}</Badge> : <Badge>Not tested</Badge>}>
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Sending method" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {([['platform', 'FieldFlow sender', `Recommended. Sends as “${c.from_name || defaultFrom}” from ${platform?.email.from_address ?? 'the platform address'}. No setup needed.`],
             ['smtp', 'Organisation’s own server', 'Sends from their own domain (Google Workspace, Microsoft 365, Zoho…) using SMTP.']] as const).map(([v, t, d]) => (
            <button key={v} type="button" role="radio" aria-checked={c.mode === v} onClick={() => set({ mode: v })}
              className={`text-left rounded-lg border p-3 cursor-pointer transition-colors ${c.mode === v ? 'border-sa-primary bg-sa-primary-soft' : 'border-sa-border hover:bg-sa-subtle'}`}>
              <div className="text-sm font-semibold text-sa-text">{t}</div>
              <div className="text-xs text-sa-muted mt-0.5">{d}</div>
            </button>
          ))}
        </div>
        {c.mode === 'platform' && platform && !platform.email.ready && (
          <TestResult ok={false} text="Platform email isn't configured on the server yet. Set RESEND_API_KEY and PLATFORM_EMAIL_FROM. Until then, emails for this organisation will fail." />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Sender name" hint={`Default: ${defaultFrom}`}>{id => <Input id={id} value={c.from_name} placeholder={defaultFrom} onChange={e => set({ from_name: e.target.value })} />}</Field>
          <Field label="Reply-to (optional)" hint="Where replies go, e.g. the org’s admin inbox.">{id => <Input id={id} type="email" value={c.reply_to} placeholder="admin@ngo.org" onChange={e => set({ reply_to: e.target.value })} />}</Field>
        </div>

        {c.mode === 'smtp' && (
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-4 rounded-lg border border-sa-border p-4">
            <Field label="SMTP host" className="sm:col-span-4">{id => <Input id={id} value={c.smtp_host} placeholder="smtp.gmail.com" onChange={e => set({ smtp_host: e.target.value })} />}</Field>
            <Field label="Port" className="sm:col-span-2">{id => <Input id={id} type="number" value={c.smtp_port} onChange={e => { const p = +e.target.value; set({ smtp_port: p, smtp_secure: p === 465 ? true : p === 587 ? false : c.smtp_secure }) }} />}</Field>
            <Field label="Username" className="sm:col-span-3">{id => <Input id={id} value={c.smtp_user} autoComplete="off" onChange={e => set({ smtp_user: e.target.value })} />}</Field>
            <Field label="Password" className="sm:col-span-3" hint={c.smtp_pass === MASK ? 'Saved. Type to replace.' : 'Gmail / Microsoft 365: use an app password.'}>
              {id => <Input id={id} type="password" autoComplete="new-password" value={c.smtp_pass} onFocus={() => { if (c.smtp_pass === MASK) set({ smtp_pass: '' }) }} onBlur={() => { if (!c.smtp_pass && cfg.smtp_pass === MASK) set({ smtp_pass: MASK }) }} onChange={e => set({ smtp_pass: e.target.value })} />}
            </Field>
            <Field label="From address" className="sm:col-span-4" hint="Must be an address this account is allowed to send as.">{id => <Input id={id} type="email" value={c.smtp_from_email} placeholder="noreply@ngo.org" onChange={e => set({ smtp_from_email: e.target.value })} />}</Field>
            <div className="sm:col-span-2 flex items-end"><Switch label="SSL/TLS (port 465)" checked={c.smtp_secure} onChange={v => set({ smtp_secure: v })} /></div>
          </div>
        )}

        <div className="flex justify-end"><Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save email settings</Button></div>

        <div className="border-t border-sa-border pt-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-sa-muted">Send a test email</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.org" aria-label="Test recipient" />
            <Button icon={<Send className="w-4 h-4" />} loading={testing} disabled={!testTo || dirty} onClick={test} title={dirty ? 'Save first' : undefined}>Send test</Button>
          </div>
          {dirty && <p className="text-xs text-sa-muted">Save your changes before testing.</p>}
          {result && <TestResult {...result} />}
          {!result && cfg.last_test_at && !cfg.last_test_ok && cfg.last_test_error && <TestResult ok={false} text={`${fmtDateTime(cfg.last_test_at)}: ${cfg.last_test_error}`} />}
        </div>

        {log.length > 0 && (
          <details className="border-t border-sa-border pt-3">
            <summary className="text-xs font-semibold text-sa-muted cursor-pointer">Recent emails ({log.length})</summary>
            <ul className="mt-2 divide-y divide-sa-border text-xs">
              {log.map((l, i) => (
                <li key={i} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge tone={l.ok ? 'success' : 'danger'}>{l.ok ? 'Sent' : 'Failed'}</Badge>
                  <span className="text-sa-text">{l.kind}</span>
                  <span className="text-sa-muted truncate">{l.to_address}</span>
                  <span className="ml-auto text-sa-muted">{fmtDateTime(l.created_at)}</span>
                  {l.error && <span className="w-full text-sa-danger">{l.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  )
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
type WaHealth = { verified_name?: string; display_phone_number?: string; quality_rating?: string; code_verification_status?: string; name_status?: string; messaging_limit_tier?: string }

function WhatsAppCard({ org, cfg, platform, onSaved }: { org: OrgRow; cfg: WaCfg; platform: PlatformIntegrations | null; onSaved: () => void }) {
  const { toast } = useToast()
  const initial = {
    phone_number_id: cfg.phone_number_id ?? '', business_id: cfg.business_id ?? '', display_phone: cfg.display_phone ?? '',
    access_token: cfg.access_token ?? '', app_secret: cfg.app_secret ?? '', webhook_secret: cfg.webhook_secret ?? '', enabled: cfg.enabled ?? true,
  }
  const [w, setW] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [health, setHealth] = useState<{ ok: boolean; data?: WaHealth; error?: string } | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setW(initial), [cfg])
  const dirty = JSON.stringify(w) !== JSON.stringify(initial)
  const set = (p: Partial<typeof w>) => setW(prev => ({ ...prev, ...p }))
  const secretInput = (key: 'access_token' | 'app_secret') => ({
    type: 'password' as const, autoComplete: 'new-password', value: w[key],
    onFocus: () => { if (w[key] === MASK) set({ [key]: '' }) },
    onBlur: () => { if (!w[key] && initial[key] === MASK) set({ [key]: MASK }) },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value }),
  })

  const save = async () => {
    setSaving(true)
    try { await saApi(`/api/superadmin/org/${org.id}/whatsapp`, { method: 'PUT', body: w }); toast('WhatsApp settings saved'); setHealth(null); onSaved() }
    catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }
  const test = async () => {
    setTesting(true); setHealth(null)
    try { setHealth({ ok: true, data: await saApi<WaHealth>(`/api/superadmin/org/${org.id}/whatsapp/test`, { method: 'POST' }) }) }
    catch (e) { setHealth({ ok: false, error: errMsg(e) }) }
    finally { setTesting(false) }
  }
  const qualityTone = (q?: string) => q === 'GREEN' ? 'success' as const : q === 'YELLOW' ? 'warning' as const : q === 'RED' ? 'danger' as const : 'neutral' as const

  return (
    <Card title={<span className="flex items-center gap-2"><MessageCircle className="w-4 h-4" />WhatsApp Business <Badge>Default</Badge></span>}
      description="Meta WhatsApp Cloud API: field reports, flows and notifications over WhatsApp."
      actions={cfg.configured ? <Badge tone={cfg.enabled ? 'success' : 'neutral'}>{cfg.enabled ? 'Connected' : 'Paused'}</Badge> : <Badge>Not connected</Badge>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Phone number ID" hint="Numeric ID from Meta → WhatsApp → API setup (not the phone number).">{id => <Input id={id} value={w.phone_number_id} inputMode="numeric" className="font-mono" onChange={e => set({ phone_number_id: e.target.value.replace(/\D/g, '') })} />}</Field>
          <Field label="Display number">{id => <Input id={id} value={w.display_phone} placeholder="+91 98765 43210" onChange={e => set({ display_phone: e.target.value })} />}</Field>
          <Field label="Business account ID (optional)">{id => <Input id={id} value={w.business_id} className="font-mono" onChange={e => set({ business_id: e.target.value })} />}</Field>
          <Field label="Permanent access token" hint={w.access_token === MASK ? 'Saved (encrypted). Type to replace.' : 'System User token with whatsapp_business_messaging permission.'}>{id => <Input id={id} {...secretInput('access_token')} />}</Field>
          <Field label="App secret" hint={w.app_secret === MASK ? 'Saved (encrypted). Type to replace.' : platform?.whatsapp.global_app_secret ? 'Optional: the platform-wide secret is used if blank.' : 'Needed to verify incoming webhooks.'}>{id => <Input id={id} {...secretInput('app_secret')} />}</Field>
          <Field label="Webhook verify token" hint="Any random string; enter the same value in Meta’s webhook settings.">{id => <Input id={id} value={w.webhook_secret} className="font-mono" onChange={e => set({ webhook_secret: e.target.value })} />}</Field>
        </div>
        {platform?.whatsapp.webhook_url && (
          <Field label="Callback URL for Meta">
            {() => (
              <div className="flex gap-2 items-center">
                <code className="flex-1 min-w-0 truncate rounded-lg bg-sa-subtle border border-sa-border px-3 py-2 text-xs text-sa-text">{platform.whatsapp.webhook_url}</code>
                <CopyButton text={platform.whatsapp.webhook_url!} />
              </div>
            )}
          </Field>
        )}
        <div className="border-y border-sa-border"><Switch label="Enabled" description="Pausing stops inbound messages being processed for this org." checked={w.enabled} onChange={v => set({ enabled: v })} /></div>
        <div className="flex flex-wrap justify-end gap-2">
          {cfg.configured && <Button icon={<Activity className="w-4 h-4" />} loading={testing} disabled={dirty} onClick={test} title={dirty ? 'Save first' : undefined}>Check connection</Button>}
          <Button variant="primary" loading={saving} disabled={!dirty || !w.phone_number_id} onClick={save}>{cfg.configured ? 'Save WhatsApp settings' : 'Connect WhatsApp'}</Button>
        </div>
        {health && (health.ok && health.data ? (
          <div className="rounded-lg border border-sa-border p-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><div className="text-xs text-sa-muted">Verified name</div><div className="text-sa-text">{health.data.verified_name ?? '—'}</div></div>
            <div><div className="text-xs text-sa-muted">Number</div><div className="text-sa-text">{health.data.display_phone_number ?? '—'}</div></div>
            <div><div className="text-xs text-sa-muted">Quality</div><Badge tone={qualityTone(health.data.quality_rating)}>{health.data.quality_rating ?? 'Unknown'}</Badge></div>
            <div><div className="text-xs text-sa-muted">Name status</div><div className="text-sa-text">{health.data.name_status ?? '—'}</div></div>
            <div><div className="text-xs text-sa-muted">Verification</div><div className="text-sa-text">{health.data.code_verification_status ?? '—'}</div></div>
            <div><div className="text-xs text-sa-muted">Messaging limit</div><div className="text-sa-text">{health.data.messaging_limit_tier ?? '—'}</div></div>
          </div>
        ) : <TestResult ok={false} text={health.error ?? 'Check failed'} />)}
      </div>
    </Card>
  )
}

// ── Glific (optional connector) ───────────────────────────────────────────────
// For orgs that already run their bots on Glific: their flow POSTs reports to
// /api/whatsapp/webhook. Stored in organizations.metadata (secret masked/encrypted).
function GlificCard({ org, platform, onSaved }: { org: OrgRow; platform: PlatformIntegrations | null; onSaved: () => void }) {
  const { toast } = useToast()
  const meta = (org.metadata ?? {}) as Record<string, unknown>
  const initial = { glific_org_code: String(meta.glific_org_code ?? ''), glific_webhook_secret: String(meta.glific_webhook_secret ?? '') }
  const [g, setG] = useState(initial)
  const [saving, setSaving] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setG(initial), [org.metadata])
  const dirty = JSON.stringify(g) !== JSON.stringify(initial)
  const connected = !!initial.glific_webhook_secret
  const url = platform?.app_base_url ? `${platform.app_base_url}/api/whatsapp/webhook` : null

  const save = async () => {
    setSaving(true)
    try { await saApi(`/api/superadmin/org/${org.id}/metadata`, { method: 'PATCH', body: g }); toast('Glific settings saved'); onSaved() }
    catch (e) { toast(errMsg(e), 'error') }
    finally { setSaving(false) }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><MessageCircle className="w-4 h-4" />Glific <Badge>Optional</Badge></span>}
      description="Only for orgs already running their bots on Glific. Their Glific flow posts field reports here; Meta direct above is not needed for this."
      actions={<Badge tone={connected ? 'success' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Badge>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Org code" hint={`Sent as org_code by the Glific flow. Blank = use the slug "${org.slug}".`}>{id => <Input id={id} value={g.glific_org_code} className="font-mono" onChange={e => setG(p => ({ ...p, glific_org_code: e.target.value.trim() }))} />}</Field>
          <Field label="Webhook secret" hint={g.glific_webhook_secret === MASK ? 'Saved (encrypted). Type to replace.' : 'Same secret as the Glific webhook. Required: unsigned calls are refused.'}>
            {id => <Input id={id} type="password" autoComplete="new-password" value={g.glific_webhook_secret}
              onFocus={() => { if (g.glific_webhook_secret === MASK) setG(p => ({ ...p, glific_webhook_secret: '' })) }}
              onBlur={() => { if (!g.glific_webhook_secret && initial.glific_webhook_secret === MASK) setG(p => ({ ...p, glific_webhook_secret: MASK })) }}
              onChange={e => setG(p => ({ ...p, glific_webhook_secret: e.target.value }))} />}
          </Field>
        </div>
        {url && (
          <Field label="Webhook URL for Glific">
            {() => (
              <div className="flex gap-2 items-center">
                <code className="flex-1 min-w-0 truncate rounded-lg bg-sa-subtle border border-sa-border px-3 py-2 text-xs text-sa-text">{url}</code>
                <CopyButton text={url} />
              </div>
            )}
          </Field>
        )}
        <div className="flex justify-end">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save Glific settings</Button>
        </div>
      </div>
    </Card>
  )
}

// ── Tab ───────────────────────────────────────────────────────────────────────
export function OrgIntegrationsTab({ org, onOrgSaved }: { org: OrgRow; onOrgSaved: () => void }) {
  const [data, setData] = useState<OrgIntegrations | null>(null)
  const [platform, setPlatform] = useState<PlatformIntegrations | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    saApi<OrgIntegrations>(`/api/superadmin/org/${org.id}/integrations`).then(setData).catch(e => setError(errMsg(e)))
  }, [org.id])
  useEffect(() => {
    load()
    saApi<PlatformIntegrations>('/api/superadmin/platform/integrations').then(setPlatform).catch(() => {})
  }, [load])

  if (error) return <div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-4 py-3">{error}</div>
  if (!data) return <div className="grid grid-cols-1 xl:grid-cols-2 gap-4"><Skeleton className="h-96 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>

  return (
    <div className="flex flex-col gap-4">
      {data.migration_needed && (
        <div className="flex items-start gap-2 rounded-lg bg-sa-warning-soft text-sa-warning text-sm px-4 py-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Email settings need database migration 083 (org_integrations). WhatsApp and Sheets work without it.</span>
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {data.email
          ? <EmailCard org={org} cfg={data.email} log={data.email_log} platform={platform} onSaved={load} />
          : <Card title="Email"><p className="text-sm text-sa-muted">Available after migration 083 is run.</p></Card>}
        <WhatsAppCard org={org} cfg={data.whatsapp} platform={platform} onSaved={load} />
        <GlificCard org={org} platform={platform} onSaved={onOrgSaved} />
      </div>
      <Card title={<span className="flex items-center gap-2"><Sheet className="w-4 h-4" />Google Sheets</span>}
        description="Sheets are shared with one platform service account. Set the sheet links and test them on the Data sources tab."
        actions={<Button size="sm" onClick={() => navigate({ page: 'orgs', orgId: org.id, orgTab: 'data' })}>Open Data sources</Button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-sa-muted">Share sheets with</span>
          {data.sheets.service_account_email
            ? <><code className="rounded bg-sa-subtle border border-sa-border px-2 py-1 text-xs text-sa-text">{data.sheets.service_account_email}</code><CopyButton text={data.sheets.service_account_email} /></>
            : <Badge tone="danger">Service account not configured on the server</Badge>}
          <span className="ml-auto flex gap-2">
            <Badge tone={data.sheets.users_sheet_id ? 'success' : 'neutral'}>Users sheet {data.sheets.users_sheet_id ? 'set' : 'not set'}</Badge>
            <Badge tone={data.sheets.reports_sheet_id ? 'success' : 'neutral'}>Reports sheet {data.sheets.reports_sheet_id ? 'set' : 'not set'}</Badge>
          </span>
        </div>
      </Card>
    </div>
  )
}
