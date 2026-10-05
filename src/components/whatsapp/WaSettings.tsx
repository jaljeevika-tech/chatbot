// WhatsApp API credentials settings.

import { useState, useEffect } from 'react'
import { Save, CheckCircle2, AlertCircle, Loader2, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

interface WaConfigForm {
  phone_number_id: string
  access_token:    string
  webhook_secret:  string
  app_secret:      string
  business_id:     string
  display_phone:   string
  enabled:         boolean
}

const EMPTY: WaConfigForm = {
  phone_number_id: '',
  access_token:    '',
  webhook_secret:  '',
  app_secret:      '',
  business_id:     '',
  display_phone:   '',
  enabled:         false,
}

export function WaSettings() {
  const [form, setForm]       = useState<WaConfigForm>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')
  const [showToken, setShowToken] = useState(false)

  useEffect(() => {
    apiFetch('/api/wa/config')
      .then(r => r.json())
      .then(d => {
        setForm({
          phone_number_id: d.phone_number_id || '',
          access_token:    '',  // never returned from server
          webhook_secret:  '',  // never returned from server
          app_secret:      '',  // never returned from server
          business_id:     d.business_id || '',
          display_phone:   d.display_phone || '',
          enabled:         d.enabled ?? false,
        })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const res = await apiFetch('/api/wa/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Save failed') }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const webhookUrl = `${window.location.origin}/api/wa/webhook`

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* Webhook URL info card */}
      <div className="rounded-xl p-5 border border-blue-100" style={{ background: '#EFF6FF' }}>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
            <RefreshCw className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <div className="font-semibold text-blue-900 text-sm mb-1">Webhook URL</div>
            <p className="text-xs text-blue-700 mb-2">Configure this URL in your Meta App → WhatsApp → Configuration</p>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-blue-800 select-all break-all">
                {webhookUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
                className="text-xs text-blue-600 hover:underline whitespace-nowrap"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-blue-600 mt-2">
              Verify Token = your <strong>Webhook Secret</strong> value below
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-white border border-[#D9E6E8] overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">API Credentials</h3>
          <p className="text-xs text-gray-500 mt-0.5">From Meta Business → WhatsApp → API Setup</p>
        </div>
        <div className="p-6 space-y-4">

          <Field label="Phone Number ID" required>
            <input
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="e.g. 1234567890123456"
              value={form.phone_number_id}
              onChange={e => setForm(f => ({ ...f, phone_number_id: e.target.value }))}
            />
          </Field>

          <Field label="Permanent Access Token" required>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                placeholder="EAAxxxxx... (leave blank to keep current)"
                value={form.access_token}
                onChange={e => setForm(f => ({ ...f, access_token: e.target.value }))}
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">Leave blank to keep the existing token</p>
          </Field>

          <Field label="App Secret">
            <input
              type="password"
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="From Meta App → Settings → Basic → App Secret (leave blank to keep)"
              value={form.app_secret}
              onChange={e => setForm(f => ({ ...f, app_secret: e.target.value }))}
            />
            <p className="text-[10px] text-gray-400 mt-1">Used to verify incoming webhook signatures. Found in Meta Developer Console → App → Settings → Basic.</p>
          </Field>

          <Field label="Webhook Verify Token" required>
            <input
              type="password"
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="Your secret (used both as verify token & HMAC key)"
              value={form.webhook_secret}
              onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Business Account ID">
              <input
                className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                placeholder="Optional"
                value={form.business_id}
                onChange={e => setForm(f => ({ ...f, business_id: e.target.value }))}
              />
            </Field>
            <Field label="Display Phone Number">
              <input
                className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                placeholder="+91 98765 43210"
                value={form.display_phone}
                onChange={e => setForm(f => ({ ...f, display_phone: e.target.value }))}
              />
            </Field>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              />
              <div className="w-10 h-6 bg-gray-200 rounded-full peer peer-checked:bg-purple-600 transition-colors" />
              <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
            </label>
            <span className="text-sm font-medium text-gray-700">Enable WhatsApp Integration</span>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <div>
            {error && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4" /> {error}
              </div>
            )}
            {saved && (
              <div className="flex items-center gap-2 text-green-600 text-sm">
                <CheckCircle2 className="w-4 h-4" /> Saved successfully
              </div>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-60"
            style={{ background: '#341272' }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Quick-start guide */}
      <div className="rounded-xl bg-white border border-[#D9E6E8] p-6">
        <h3 className="font-bold text-gray-900 mb-3">Quick Start Guide</h3>
        <ol className="space-y-2.5 text-sm text-gray-600">
          {[
            'Create a Meta Business account at business.facebook.com',
            'Go to developers.facebook.com → Create App → Business type',
            'Add WhatsApp product → Get Phone Number ID & Access Token',
            'Paste the Webhook URL above into WhatsApp → Configuration → Webhook',
            'Use your Webhook Secret as both the verify token and HMAC secret',
            'Subscribe to the "messages" webhook field',
            'Come back, enter your credentials, and enable the integration',
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-purple-100 text-purple-700 text-[10px] font-black flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Field({ label, required, children }: {
  label: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1.5">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      {children}
    </div>
  )
}
