// src/components/finance-mgmt/FinanceSettingsPanel.tsx
// Admin-only: who is in the Finance team (approves, pays, reviews bills,
// answers ledger requests), each person's alert email, and the org's
// notification channels + expense categories.

import { useEffect, useMemo, useState } from 'react'
import { Search, Save, Mail, MessageCircle, Users } from 'lucide-react'
import { FF } from '../../theme/colors'
import { useFm } from './fmContext'
import { fmGet, fmPatch, fmPut } from './fmApi'
import { Btn, Card, ErrorBox, Field, LoadingRow, inputCls, inputStyle, tdCls, thCls, useFmLoad } from './fmUi'

interface Person {
  id: string; name: string; role: string; designation: string | null
  email: string | null; is_finance: boolean; manager_name: string | null; active: boolean
}
interface Settings {
  email_enabled: boolean; whatsapp_enabled: boolean; whatsapp_template: string; whatsapp_approval_template?: string; whatsapp_lang: string; expense_categories: string[]
}

function PersonRow({ p, onSaved, canSetFinance }: { p: Person; onSaved: () => void; canSetFinance: boolean }) {
  const [email, setEmail] = useState(p.email || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setEmail(p.email || ''), [p.email])

  async function save(patch: Partial<Pick<Person, 'is_finance' | 'email'>>) {
    setBusy(true); setError(null)
    try { await fmPatch(`/people/${p.id}`, patch); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <tr className="border-t" style={{ borderColor: FF.borderFaint, opacity: p.active ? 1 : 0.55 }}>
      <td className={tdCls}>
        <div className="font-medium" style={{ color: FF.tealDark }}>{p.name}{!p.active && ' (inactive)'}</div>
        <div className="text-xs" style={{ color: FF.textFaint }}>
          {p.designation || <span className="capitalize">{p.role}</span>}{p.manager_name ? ` · reports to ${p.manager_name}` : ''}
        </div>
      </td>
      <td className={tdCls}>
        <input type="email" className={`${inputCls} min-w-[200px]`} style={inputStyle} value={email} placeholder="name@org.org" disabled={busy}
          aria-label={`Email for ${p.name}`}
          onChange={e => setEmail(e.target.value)}
          onBlur={() => { if (email.trim() !== (p.email || '')) save({ email: email.trim() || null }) }} />
        {error && <div className="text-xs mt-1" style={{ color: FF.red }}>{error}</div>}
      </td>
      <td className={`${tdCls} text-center`}>
        <input type="checkbox" className="w-4 h-4 accent-[#341272] disabled:opacity-60" checked={p.is_finance} disabled={busy || !canSetFinance}
          title={canSetFinance ? undefined : 'Only admins can change who is in the Finance team'}
          aria-label={`${p.name} is in the Finance team`} onChange={e => save({ is_finance: e.target.checked })} />
      </td>
    </tr>
  )
}

export function FinanceSettingsPanel() {
  const { me, changed, version } = useFm()
  const people = useFmLoad(() => fmGet<{ people: Person[] }>('/people'), [version])
  const settingsLoad = useFmLoad(() => fmGet<{ settings: Settings; smtp_configured: boolean }>('/settings'), [])
  const [q, setQ] = useState('')
  const [form, setForm] = useState<Settings | null>(null)
  const [catsText, setCatsText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settingsLoad.data) return
    setForm(settingsLoad.data.settings)
    setCatsText(settingsLoad.data.settings.expense_categories.join('\n'))
  }, [settingsLoad.data])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (people.data?.people || []).filter(p => !needle || [p.name, p.email, p.designation, p.role].some(v => v?.toLowerCase().includes(needle)))
  }, [people.data, q])
  const financeCount = (people.data?.people || []).filter(p => p.is_finance && p.active).length

  async function saveSettings() {
    if (!form) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const { settings } = await fmPut<{ settings: Settings }>('/settings', {
        ...form, expense_categories: catsText.split('\n').map(s => s.trim()).filter(Boolean),
      })
      setForm(settings); setCatsText(settings.expense_categories.join('\n')); setSaved(true)
      changed()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 items-start">
      <Card className="xl:col-span-3">
        <div className="p-4 border-b space-y-3" style={{ borderColor: FF.borderFaint }}>
          <div className="flex items-start gap-2">
            <Users className="w-4 h-4 mt-0.5" style={{ color: FF.purple }} />
            <div>
              <div className="font-semibold text-sm" style={{ color: FF.tealDark }}>Finance team &amp; alert emails</div>
              <div className="text-xs" style={{ color: FF.textMuted }}>
                Ticked people approve advances after the manager, record payments, review bills and answer ledger requests.
                {!me.me.is_admin && ' Only admins can change who is ticked.'}
                {' '}<b style={{ color: financeCount ? FF.green : FF.red }}>{financeCount} active member{financeCount === 1 ? '' : 's'}.</b>
              </div>
            </div>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: FF.textFaint }} />
            <input className={`${inputCls} pl-9`} style={inputStyle} placeholder="Search people…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </div>
        {people.error ? <div className="p-4"><ErrorBox message={people.error} /></div> : people.loading && !people.data ? <LoadingRow /> : (
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0" style={{ background: FF.bg, color: FF.textMuted }}>
                <tr><th className={thCls}>Person</th><th className={thCls}>Alert email</th><th className={`${thCls} text-center`}>Finance team</th></tr>
              </thead>
              <tbody>{list.map(p => <PersonRow key={p.id} p={p} onSaved={changed} canSetFinance={me.me.is_admin} />)}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="xl:col-span-2 p-4 space-y-4">
        <div className="font-semibold text-sm" style={{ color: FF.tealDark }}>Notifications &amp; categories</div>
        {settingsLoad.error ? <ErrorBox message={settingsLoad.error} /> : !form ? <LoadingRow /> : (
          <>
            <label className="flex items-start gap-2.5">
              <input type="checkbox" className="mt-1 w-4 h-4 accent-[#341272]" checked={form.email_enabled} onChange={e => setForm({ ...form, email_enabled: e.target.checked })} />
              <span>
                <span className="text-sm font-semibold inline-flex items-center gap-1.5" style={{ color: FF.tealDark }}><Mail className="w-3.5 h-3.5" />Email alerts</span>
                <span className="block text-xs" style={{ color: settingsLoad.data?.smtp_configured ? FF.textMuted : FF.amber }}>
                  {settingsLoad.data?.smtp_configured
                    ? 'Sent to each person’s alert email when something needs them.'
                    : 'Mail server not configured yet — set SMTP_USER and SMTP_PASS (Workspace app password) on the server. In-app alerts still work.'}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5">
              <input type="checkbox" className="mt-1 w-4 h-4 accent-[#341272]" checked={form.whatsapp_enabled} onChange={e => setForm({ ...form, whatsapp_enabled: e.target.checked })} />
              <span>
                <span className="text-sm font-semibold inline-flex items-center gap-1.5" style={{ color: FF.tealDark }}><MessageCircle className="w-3.5 h-3.5" />WhatsApp alerts</span>
                <span className="block text-xs" style={{ color: FF.textMuted }}>
                  Uses your WhatsApp number from the WhatsApp tab. Needs a Meta-approved <b>Utility</b> template whose body has a single
                  {' '}<code>{'{{1}}'}</code> variable, e.g. “FieldFlow Finance: {'{{1}}'}”.
                </span>
              </span>
            </label>
            {form.whatsapp_enabled && (
              <div className="grid grid-cols-3 gap-3 pl-6">
                <Field label="Template name" className="col-span-2">
                  <input className={inputCls} style={inputStyle} value={form.whatsapp_template} placeholder="finance_update"
                    onChange={e => setForm({ ...form, whatsapp_template: e.target.value.trim() })} />
                </Field>
                <Field label="Language">
                  <input className={inputCls} style={inputStyle} value={form.whatsapp_lang} placeholder="en"
                    onChange={e => setForm({ ...form, whatsapp_lang: e.target.value.trim() })} />
                </Field>
                <Field label="Approval template (optional)" className="col-span-3"
                  hint="Same {{1}} body plus one Quick reply button “Approve”. Advances and settlements waiting for someone then get an Approve button on WhatsApp.">
                  <input className={inputCls} style={inputStyle} value={form.whatsapp_approval_template ?? ''} placeholder="finance_approval"
                    onChange={e => setForm({ ...form, whatsapp_approval_template: e.target.value.trim() })} />
                </Field>
              </div>
            )}

            <Field label="Expense categories" hint="One per line. Staff pick these on each bill when settling an advance.">
              <textarea className={inputCls} style={inputStyle} rows={8} value={catsText} onChange={e => setCatsText(e.target.value)} />
            </Field>

            <ErrorBox message={error} />
            <div className="flex items-center gap-3">
              <Btn variant="primary" busy={saving} onClick={saveSettings}><Save className="w-3.5 h-3.5" />Save settings</Btn>
              {saved && <span className="text-xs font-semibold" style={{ color: FF.green }}>Saved</span>}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
