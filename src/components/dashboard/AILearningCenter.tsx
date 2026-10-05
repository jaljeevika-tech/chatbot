// Admin panel for the local-first AI layer: Overview, Settings, Learning, Rules.
// Superadmins pick an org (sent as ?orgId= / body orgId); with none selected they see all-orgs aggregates.

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Globe, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  ThumbsUp, ThumbsDown, ChevronDown, ChevronUp,
  RotateCcw, Loader2, Zap, DollarSign, BarChart3,
  Wifi, WifiOff, Settings2, FlaskConical, BookOpen, Building2,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

const C = {
  brand:   '#341272',
  brandBg: '#FBF9F4',   // FF.bgWarm
  green:   '#3F7D5C',   // FF.green
  greenBg: '#E4EFE7',   // FF.greenBg
  amber:   '#B8862E',   // FF.amber
  amberBg: '#F5EBD3',   // FF.amberBg
  red:     '#B0473C',   // FF.red
  redBg:   '#F5E1DD',   // FF.redBg
  blue:    '#1D4ED8',
  blueBg:  '#EFF6FF',
  muted:   '#5C7378',   // FF.textMuted
}

type SubSection = 'overview' | 'settings' | 'learning' | 'rules'

// ── Types ──
interface OrgSummary {
  id:          string
  name:        string
  slug:        string
  requests:    string
  cost_usd:    string
  last_active: string | null
}

interface ProviderState { state: string; failures: number }
interface HealthData {
  gemini:      ProviderState & { ok?: boolean; latencyMs?: number | null }
  self_hosted: ProviderState & { ok?: boolean; latencyMs?: number | null; models?: string[] }
  timestamp:   string
}

interface StatsRow {
  provider:       string
  requests:       string
  avg_latency_ms: string
  total_cost_usd: string
  avg_confidence: string
  thumbs_up:      string
  thumbs_down:    string
}

interface Stats {
  period:      string
  scope:       string
  total:       number
  localSaved:  number
  savingsPct:  number
  breakdown:   StatsRow[]
}

interface AISettings {
  external_enabled:   boolean
  local_model_url:    string | null
  local_model_name:   string | null
  budget_usd_daily:   number
  feature_policies:   Record<string, { tier1_only?: boolean; allow_self_hosted?: boolean; allow_external?: boolean }>
}

interface Candidate {
  id:              number
  org_id:          string | null
  type:            string
  feature:         string
  proposed_change: Record<string, any>
  eval_score:      number | null
  evidence_count:  number
  created_at:      string
}

interface RuleVersion {
  id:           number
  org_id:       string | null
  org_name?:    string
  feature:      string
  rule_type:    string
  version:      number
  config:       Record<string, any>
  active:       boolean
  promoted_by:  string | null
  activated_at: string | null
}

// ── Helpers ──

function oqs(orgId: string | null | undefined): string {
  return orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
}

function StatCard({ icon: Icon, label, value, sub, color = C.brand, bg = C.brandBg }:
  { icon: any; label: string; value: string | number; sub?: string; color?: string; bg?: string }) {
  return (
    <div className="rounded-2xl p-4 flex items-start gap-3" style={{ background: '#fff', border: '1px solid #F3F4F6' }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="text-2xl font-serif font-semibold text-gray-900 leading-tight">{value}</p>
        {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function ProviderChip({ name, state, ok, latencyMs }: {
  name: string; state: string; ok?: boolean; latencyMs?: number | null
}) {
  const isOpen  = state === 'OPEN'
  const isHalf  = state === 'HALF_OPEN'
  const color   = isOpen ? C.red : isHalf ? C.amber : C.green
  const bg      = isOpen ? C.redBg : isHalf ? C.amberBg : C.greenBg
  const Icon    = isOpen ? WifiOff : isHalf ? AlertTriangle : Wifi
  const label   = isOpen ? 'Circuit open' : isHalf ? 'Retrying…' : ok === false ? 'Not configured' : 'Healthy'
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl" style={{ background: bg }}>
      <Icon className="w-4 h-4 shrink-0" style={{ color }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold" style={{ color }}>{name}</p>
        <p className="text-[11px] text-gray-500">{label}{latencyMs != null ? ` · ${latencyMs}ms` : ''}</p>
      </div>
      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: color + '22', color }}>
        {state}
      </span>
    </div>
  )
}

function OrgSelector({ orgs, selectedOrgId, onChange }: {
  orgs: OrgSummary[]
  selectedOrgId: string | null
  onChange: (id: string | null) => void
}) {
  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-purple-50">
      <Building2 className="w-4 h-4 shrink-0" style={{ color: C.brand }} />
      <span className="text-xs font-bold text-gray-500 shrink-0">Viewing org:</span>
      <select
        value={selectedOrgId ?? ''}
        onChange={e => onChange(e.target.value || null)}
        className="flex-1 text-sm font-semibold border-0 bg-transparent focus:outline-none cursor-pointer"
        style={{ color: C.brand }}
      >
        <option value="">— All organisations —</option>
        {orgs.map(o => (
          <option key={o.id} value={o.id}>
            {o.name}{o.requests !== '0' ? ` (${parseInt(o.requests).toLocaleString()} reqs)` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Overview ──
function Overview({ orgId }: { orgId?: string | null }) {
  const [health,  setHealth]  = useState<HealthData | null>(null)
  const [stats,   setStats]   = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [days,    setDays]    = useState(7)
  // Drop responses for an org the admin has since switched away from.
  const latestOrgId = useRef(orgId)

  const load = useCallback(async () => {
    const requestOrgId = orgId
    latestOrgId.current = requestOrgId
    setLoading(true)
    try {
      const qs = orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''
      const [hRes, sRes] = await Promise.all([
        apiFetch(`/api/ai/health${oqs(orgId)}`).then(r => r.json()),
        apiFetch(`/api/ai/stats?days=${days}${qs}`).then(r => r.json()),
      ])
      if (latestOrgId.current !== requestOrgId) return
      setHealth(hRes)
      setStats(sRes)
    } catch { /* ignore */ } finally {
      if (latestOrgId.current === requestOrgId) setLoading(false)
    }
  }, [days, orgId])

  useEffect(() => { load() }, [load])

  const providerColor = (p: string) => {
    if (p === 'local')          return { color: C.green, bg: C.greenBg  }
    if (p === 'self_hosted')    return { color: C.blue,  bg: C.blueBg   }
    if (p?.startsWith('gemini')) return { color: C.amber, bg: C.amberBg }
    return { color: C.muted, bg: '#F3F4F6' }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-6 h-6 animate-spin text-gray-300" />
    </div>
  )

  return (
    <div className="space-y-6 p-5">
      {stats?.scope === 'all_orgs' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold"
          style={{ background: C.brandBg, color: C.brand }}>
          <Building2 className="w-3.5 h-3.5 shrink-0" />
          Showing aggregate across all organisations — select an org above for org-specific data.
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={BarChart3} label="Total requests" value={stats.total.toLocaleString()} sub={stats.period} />
          <StatCard icon={Zap}        label="Local tier saved" value={`${stats.savingsPct}%`}
            sub={`${stats.localSaved} calls`} color={C.green} bg={C.greenBg} />
          <StatCard icon={DollarSign} label="Gemini spend"
            value={`$${(stats.breakdown.find(r => r.provider?.startsWith('gemini'))?.total_cost_usd ?? '0.00')}`}
            sub={stats.period} color={C.amber} bg={C.amberBg} />
          <StatCard icon={RefreshCw}  label="Avg latency"
            value={`${stats.breakdown[0]?.avg_latency_ms ?? '—'}ms`}
            sub="across all providers" />
        </div>
      )}

      {health && (
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Provider health</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ProviderChip name="Gemini" state={health.gemini.state} />
            <ProviderChip name="Self-hosted model"
              state={health.self_hosted.state}
              ok={health.self_hosted.ok}
              latencyMs={health.self_hosted.latencyMs} />
          </div>
          {health.self_hosted.models?.length ? (
            <p className="text-[11px] text-gray-400 mt-1.5">
              Available models: {health.self_hosted.models.join(', ')}
            </p>
          ) : null}
        </div>
      )}

      {stats?.breakdown?.length ? (
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Breakdown by provider</p>
          <div className="rounded-xl overflow-hidden border border-gray-100 overflow-x-auto">
            <div className="grid grid-cols-6 px-4 py-2 bg-gray-50 text-[10px] font-bold text-gray-400 uppercase tracking-wide min-w-[480px]">
              <span className="col-span-2">Provider</span>
              <span className="text-right">Requests</span>
              <span className="text-right">Avg latency</span>
              <span className="text-right">Cost</span>
              <span className="text-right">👍 / 👎</span>
            </div>
            {stats.breakdown.map(row => {
              const { color, bg } = providerColor(row.provider)
              return (
                <div key={row.provider} className="grid grid-cols-6 px-4 py-3 border-t border-gray-50 items-center min-w-[480px]">
                  <div className="col-span-2 flex items-center gap-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: bg, color }}>
                      {row.provider}
                    </span>
                  </div>
                  <span className="text-right text-sm font-bold text-gray-900">{parseInt(row.requests).toLocaleString()}</span>
                  <span className="text-right text-xs text-gray-500">{row.avg_latency_ms ? `${row.avg_latency_ms}ms` : '—'}</span>
                  <span className="text-right text-xs font-semibold" style={{ color: C.amber }}>
                    ${parseFloat(row.total_cost_usd || '0').toFixed(4)}
                  </span>
                  <span className="text-right text-xs text-gray-500">
                    {row.thumbs_up} / {row.thumbs_down}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className="px-3 py-1 rounded-lg text-xs font-semibold transition border"
            style={days === d
              ? { background: C.brand, color: '#fff', borderColor: C.brand }
              : { background: '#F9F9F9', color: C.muted, borderColor: '#E5E7EB' }
            }>
            {d}d
          </button>
        ))}
        <button onClick={load} className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-gray-500 border border-gray-200 hover:bg-gray-50 transition">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
    </div>
  )
}

// ── Settings ──
const FEATURE_LABELS: Record<string, string> = {
  whatsapp:  'WhatsApp flows',
  reports:   'Report generation',
  notebook:  'Notebook / Study guide',
  rw:        'Report Writer',
  assistant: 'AI Assistant (chat)',
}

function AISettingsSection({ orgId, isSuperAdmin }: { orgId?: string | null; isSuperAdmin?: boolean }) {
  const [settings, setSettings] = useState<AISettings>({
    external_enabled: true, local_model_url: '', local_model_name: '',
    budget_usd_daily: 5, feature_policies: {},
  })
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const [error,   setError]   = useState('')
  // Drop responses for an org the admin has since switched away from.
  const latestOrgId = useRef(orgId)

  useEffect(() => {
    const requestOrgId = orgId
    latestOrgId.current = requestOrgId
    setLoading(true)
    apiFetch(`/api/ai/settings${oqs(orgId)}`).then(r => r.json())
      .then(d => {
        if (latestOrgId.current !== requestOrgId) return
        if (d.all) {
          // Superadmin with no org selected: placeholder values
          setSettings({ external_enabled: true, local_model_url: '', local_model_name: '', budget_usd_daily: 5, feature_policies: {} })
        } else {
          setSettings({
            external_enabled:  d.external_enabled  ?? true,
            local_model_url:   d.local_model_url   ?? '',
            local_model_name:  d.local_model_name  ?? '',
            budget_usd_daily:  parseFloat(d.budget_usd_daily ?? 5),
            feature_policies:  d.feature_policies  ?? {},
          })
        }
      })
      .catch(() => {})
      .finally(() => { if (latestOrgId.current === requestOrgId) setLoading(false) })
  }, [orgId])

  function policyFor(feature: string) {
    const DEFAULTS: Record<string, any> = {
      whatsapp:  { tier1_only: true,  allow_self_hosted: false, allow_external: false },
      reports:   { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
      notebook:  { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
      rw:        { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
      assistant: { tier1_only: false, allow_self_hosted: false, allow_external: true  },
    }
    return { ...DEFAULTS[feature], ...(settings.feature_policies[feature] || {}) }
  }

  function setPolicyFlag(feature: string, flag: string, val: boolean) {
    setSettings(prev => ({
      ...prev,
      feature_policies: {
        ...prev.feature_policies,
        [feature]: { ...policyFor(feature), [flag]: val },
      },
    }))
  }

  const canSave = !isSuperAdmin || !!orgId

  async function handleSave() {
    if (!canSave) { setError('Select an organisation first'); return }
    setSaving(true); setError('')
    try {
      const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
      const res = await apiFetch(`/api/ai/settings${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          external_enabled:  settings.external_enabled,
          local_model_url:   settings.local_model_url   || null,
          local_model_name:  settings.local_model_name  || null,
          budget_usd_daily:  settings.budget_usd_daily,
          feature_policies:  settings.feature_policies,
        }),
      })
      const data = await res.json()
      if (data.error) { setError(data.error); return }
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setError(e?.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-gray-300" /></div>

  return (
    <div className="space-y-6 p-5">
      {isSuperAdmin && !orgId && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold"
          style={{ background: C.amberBg, color: C.amber }}>
          <Building2 className="w-3.5 h-3.5 shrink-0" />
          Select an organisation above to view or edit its AI settings.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm" style={{ background: C.redBg, color: C.red }}>
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex items-center justify-between p-4 rounded-xl border border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.amberBg }}>
            <Globe className="w-4 h-4" style={{ color: C.amber }} />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">External AI (Gemini)</p>
            <p className="text-[11px] text-gray-400">Allow any feature to call the Gemini API</p>
          </div>
        </div>
        <button
          onClick={() => setSettings(p => ({ ...p, external_enabled: !p.external_enabled }))}
          disabled={!canSave}
          className="relative w-11 h-6 rounded-full transition-colors duration-200 disabled:opacity-40"
          style={{ background: settings.external_enabled ? C.green : '#D1D5DB' }}
        >
          <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
            style={{ transform: settings.external_enabled ? 'translateX(20px)' : 'translateX(0)' }} />
        </button>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Self-hosted model (optional)</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Endpoint URL</label>
            <input
              type="text"
              value={settings.local_model_url ?? ''}
              onChange={e => setSettings(p => ({ ...p, local_model_url: e.target.value }))}
              disabled={!canSave}
              placeholder="http://localhost:11434"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400 transition disabled:opacity-40"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Model name</label>
            <input
              type="text"
              value={settings.local_model_name ?? ''}
              onChange={e => setSettings(p => ({ ...p, local_model_name: e.target.value }))}
              disabled={!canSave}
              placeholder="llama3.2:3b"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400 transition disabled:opacity-40"
            />
          </div>
        </div>
        <p className="text-[11px] text-gray-400">Works with Ollama, LM Studio, vLLM, LocalAI — any OpenAI-compatible /v1/chat/completions endpoint.</p>
      </div>

      <div>
        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1.5">Daily Gemini budget (USD)</label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            step={0.5}
            value={settings.budget_usd_daily}
            onChange={e => setSettings(p => ({ ...p, budget_usd_daily: parseFloat(e.target.value) || 0 }))}
            disabled={!canSave}
            className="w-28 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400 transition disabled:opacity-40"
          />
          <p className="text-xs text-gray-400">Set to 0 for unlimited. When daily spend exceeds this, Gemini calls are paused until midnight UTC.</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Per-feature routing policies</p>
        <div className="rounded-xl border border-gray-100 overflow-hidden overflow-x-auto">
          <div className="grid px-4 py-2 bg-gray-50 text-[10px] font-bold text-gray-400 uppercase tracking-wide min-w-[420px]"
            style={{ gridTemplateColumns: '1fr 90px 90px 90px' }}>
            <span>Feature</span>
            <span className="text-center">Local only</span>
            <span className="text-center">Self-hosted</span>
            <span className="text-center">External AI</span>
          </div>
          {Object.keys(FEATURE_LABELS).map(feature => {
            const pol = policyFor(feature)
            return (
              <div key={feature} className="grid px-4 py-3 border-t border-gray-50 items-center min-w-[420px]"
                style={{ gridTemplateColumns: '1fr 90px 90px 90px' }}>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{FEATURE_LABELS[feature]}</p>
                </div>
                <div className="flex justify-center">
                  <input type="checkbox" checked={!!pol.tier1_only} disabled={!canSave}
                    onChange={e => setPolicyFlag(feature, 'tier1_only', e.target.checked)}
                    className="w-4 h-4 accent-purple-600 cursor-pointer disabled:opacity-40" />
                </div>
                <div className="flex justify-center">
                  <input type="checkbox" checked={!!pol.allow_self_hosted} disabled={!!pol.tier1_only || !canSave}
                    onChange={e => setPolicyFlag(feature, 'allow_self_hosted', e.target.checked)}
                    className="w-4 h-4 accent-blue-600 cursor-pointer disabled:opacity-30" />
                </div>
                <div className="flex justify-center">
                  <input type="checkbox" checked={!!pol.allow_external} disabled={!!pol.tier1_only || !canSave}
                    onChange={e => setPolicyFlag(feature, 'allow_external', e.target.checked)}
                    className="w-4 h-4 accent-amber-600 cursor-pointer disabled:opacity-30" />
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">
          "Local only" disables all model calls for that feature — deterministic templates only.
        </p>
      </div>

      <button
        onClick={handleSave}
        disabled={saving || !canSave}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition disabled:opacity-60"
        style={{ background: saved ? C.green : C.brand }}
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : null}
        {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Settings'}
      </button>
    </div>
  )
}

// ── Learning ──
const TYPE_LABELS: Record<string, string> = {
  intent_alias:      'Intent alias',
  slot_pattern:      'Slot pattern',
  template_section:  'Template edit',
  negative_feedback: 'Negative feedback',
  scoring_weight:    'Scoring weight',
}

function CandidateCard({ c, onApprove, onReject }: {
  c: Candidate
  onApprove: (id: number) => Promise<void>
  onReject:  (id: number) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [working,  setWorking]  = useState(false)

  async function act(fn: () => Promise<void>) {
    setWorking(true)
    try { await fn() } finally { setWorking(false) }
  }

  const scoreColor = c.eval_score == null ? C.muted
    : c.eval_score >= 0.7 ? C.green
    : c.eval_score >= 0.45 ? C.amber : C.red

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: C.brandBg, color: C.brand }}>
              {TYPE_LABELS[c.type] ?? c.type}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-500">
              {c.feature}
            </span>
            {c.org_id && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-purple-50 text-purple-600">
                {c.org_id}
              </span>
            )}
            <span className="text-[10px] text-gray-400">{c.evidence_count} example{c.evidence_count !== 1 ? 's' : ''}</span>
          </div>
          <p className="text-sm text-gray-700 mt-1.5 truncate">
            {c.type === 'intent_alias' && c.proposed_change.suggestedAlias
              ? `"${c.proposed_change.suggestedAlias}" → ${c.proposed_change.correctFlow}`
              : c.type === 'negative_feedback'
                ? `Poor response to: "${(c.proposed_change.userMessage ?? '').slice(0, 60)}"`
                : c.type === 'template_section'
                  ? `Edit: removed ${(c.proposed_change.removed ?? []).length}, added ${(c.proposed_change.added ?? []).length} lines`
                  : JSON.stringify(c.proposed_change).slice(0, 80)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {c.eval_score != null && (
            <span className="text-xs font-bold" style={{ color: scoreColor }}>
              {Math.round(c.eval_score * 100)}%
            </span>
          )}
          <button onClick={() => setExpanded(e => !e)} className="p-1 text-gray-300 hover:text-gray-500">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button onClick={() => act(() => onReject(c.id))} disabled={working}
            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 disabled:opacity-30 transition">
            <ThumbsDown className="w-4 h-4" />
          </button>
          <button onClick={() => act(() => onApprove(c.id))} disabled={working}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white transition disabled:opacity-40 flex items-center gap-1.5"
            style={{ background: working ? '#86A0A5' : C.green }}>
            {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
            Approve
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-50">
          <pre className="text-[11px] text-gray-500 bg-gray-50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(c.proposed_change, null, 2)}
          </pre>
          <p className="text-[10px] text-gray-400 mt-1.5">
            Created {new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </p>
        </div>
      )}
    </div>
  )
}

function LearningSection({ orgId, isSuperAdmin }: { orgId?: string | null; isSuperAdmin?: boolean }) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading,    setLoading]    = useState(true)
  const [running,    setRunning]    = useState(false)
  // Drop responses for an org the admin has since switched away from.
  const latestOrgId = useRef(orgId)

  async function load() {
    const requestOrgId = orgId
    latestOrgId.current = requestOrgId
    setLoading(true)
    try {
      const data = await apiFetch(`/api/ai/learning/candidates${oqs(orgId)}`).then(r => r.json())
      if (latestOrgId.current !== requestOrgId) return
      setCandidates(data.candidates ?? [])
    } catch { /* ignore */ } finally {
      if (latestOrgId.current === requestOrgId) setLoading(false)
    }
  }

  useEffect(() => { load() }, [orgId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApprove(id: number) {
    // Send orgId so a superadmin can approve global candidates (null org_id).
    const body: Record<string, any> = {}
    if (orgId) body.orgId = orgId
    await apiFetch(`/api/ai/learning/candidates/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setCandidates(p => p.filter(c => c.id !== id))
  }

  async function handleReject(id: number) {
    await apiFetch(`/api/ai/learning/candidates/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Rejected by admin' }),
    })
    setCandidates(p => p.filter(c => c.id !== id))
  }

  async function runBatch() {
    if (isSuperAdmin && !orgId) {
      alert('Select an organisation before running the batch analyser.')
      return
    }
    setRunning(true)
    try {
      const body: Record<string, any> = {}
      if (orgId) body.orgId = orgId
      await apiFetch('/api/ai/learning/run-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await load()
    } catch { /* ignore */ } finally { setRunning(false) }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-gray-300" /></div>

  return (
    <div className="space-y-4 p-5">
      {isSuperAdmin && !orgId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold"
          style={{ background: C.brandBg, color: C.brand }}>
          <Building2 className="w-3.5 h-3.5 shrink-0" />
          Showing candidates across all organisations.
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-gray-900">Pending Improvements</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            These patterns were learned from user corrections and failed interactions.
            Approve to apply, or reject to discard.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={runBatch} disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 text-gray-500 hover:bg-gray-50 transition disabled:opacity-50">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />}
            Run analysis
          </button>
          <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 text-gray-500 hover:bg-gray-50 transition">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <FlaskConical className="w-10 h-10 mx-auto mb-3 text-gray-200" />
          <p className="font-semibold text-gray-500">No pending improvements</p>
          <p className="text-sm mt-1">As users interact with the AI, patterns will appear here for review.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map(c => (
            <CandidateCard key={c.id} c={c} onApprove={handleApprove} onReject={handleReject} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Rules ──
function RulesSection({ orgId }: { orgId?: string | null }) {
  const [versions, setVersions] = useState<RuleVersion[]>([])
  const [loading,  setLoading]  = useState(true)
  const [rolling,  setRolling]  = useState<number | null>(null)
  const [msg,      setMsg]      = useState('')
  // Drop responses for an org the admin has since switched away from.
  const latestOrgId = useRef(orgId)

  async function loadVersions() {
    const requestOrgId = orgId
    latestOrgId.current = requestOrgId
    setLoading(true)
    apiFetch(`/api/ai/rule-versions${oqs(orgId)}`).then(r => r.json())
      .then(d => {
        if (latestOrgId.current !== requestOrgId) return
        setVersions(d.versions ?? [])
      })
      .catch(() => {})
      .finally(() => { if (latestOrgId.current === requestOrgId) setLoading(false) })
  }

  useEffect(() => { loadVersions() }, [orgId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRollback(v: RuleVersion) {
    if (!confirm(`Roll back ${v.feature} / ${v.rule_type} to version ${v.version - 1}?`)) return
    setRolling(v.id)
    try {
      const body: Record<string, any> = { feature: v.feature, rule_type: v.rule_type }
      // Superadmins roll back against the rule's own org
      if (v.org_id) body.orgId = v.org_id
      const res = await apiFetch('/api/ai/learning/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok)    { setMsg(`Rolled back to v${data.rolledBackTo}`); setTimeout(() => setMsg(''), 3000) }
      if (data.error) { setMsg(`Error: ${data.error}`); setTimeout(() => setMsg(''), 4000) }
      await loadVersions()
    } catch (e: any) { setMsg(`Error: ${e?.message}`) }
    finally { setRolling(null) }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-gray-300" /></div>

  const active  = versions.filter(v => v.active)
  const history = versions.filter(v => !v.active)

  return (
    <div className="space-y-5 p-5">
      {msg && (
        <div className="px-4 py-3 rounded-xl text-sm font-semibold"
          style={{ background: msg.startsWith('Error') ? C.redBg : C.greenBg,
                   color:      msg.startsWith('Error') ? C.red   : C.green   }}>
          {msg}
        </div>
      )}

      <div>
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Active rule versions</p>
        {active.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No custom rules yet — defaults in effect.</p>
        ) : (
          <div className="space-y-2">
            {active.map(v => (
              <div key={v.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-gray-700">{v.feature} / {v.rule_type}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: C.greenBg, color: C.green }}>
                      v{v.version}
                    </span>
                    {v.org_name && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-purple-50 text-purple-600">
                        {v.org_name}
                      </span>
                    )}
                  </div>
                  {v.promoted_by && (
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      Promoted by {v.promoted_by}
                      {v.activated_at ? ` · ${new Date(v.activated_at).toLocaleDateString('en-IN')}` : ''}
                    </p>
                  )}
                </div>
                {v.version > 1 && (
                  <button onClick={() => handleRollback(v)} disabled={rolling === v.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition disabled:opacity-40">
                    {rolling === v.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    Rollback
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Version history</p>
          <div className="space-y-1.5">
            {history.slice(0, 10).map(v => (
              <div key={v.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-50">
                <span className="text-xs text-gray-400">
                  {v.org_name ? `${v.org_name} · ` : ''}{v.feature} / {v.rule_type} v{v.version}
                </span>
                <span className="ml-auto text-[10px] text-gray-300">inactive</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main ──
const SUB_TABS: { id: SubSection; icon: any; label: string }[] = [
  { id: 'overview',  icon: BarChart3,    label: 'Overview'  },
  { id: 'settings',  icon: Settings2,    label: 'Settings'  },
  { id: 'learning',  icon: FlaskConical, label: 'Learning'  },
  { id: 'rules',     icon: BookOpen,     label: 'Rules'     },
]

export function AILearningCenter({ isSuperAdmin }: { isSuperAdmin?: boolean }) {
  const [sub,           setSub]           = useState<SubSection>('overview')
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null)
  const [orgs,          setOrgs]          = useState<OrgSummary[]>([])

  useEffect(() => {
    if (!isSuperAdmin) return
    apiFetch('/api/ai/orgs').then(r => r.json())
      .then(d => setOrgs(d.orgs ?? []))
      .catch(() => {})
  }, [isSuperAdmin])

  // superadmin: selected org (null = all orgs); admin: undefined, so the backend uses req.user.orgId
  const orgId = isSuperAdmin ? selectedOrgId : undefined

  return (
    <div className="flex flex-col">
      {isSuperAdmin && (
        <OrgSelector
          orgs={orgs}
          selectedOrgId={selectedOrgId}
          onChange={setSelectedOrgId}
        />
      )}

      <div className="flex items-center gap-1 px-4 pt-4 pb-2 border-b border-gray-100 overflow-x-auto no-scrollbar">
        {SUB_TABS.map(({ id, icon: Icon, label }) => {
          const active = sub === id
          return (
            <button key={id} onClick={() => setSub(id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition shrink-0"
              style={active
                ? { background: C.brand, color: '#fff' }
                : { color: C.muted, background: 'transparent' }
              }>
              <Icon className="w-3 h-3" />
              {label}
            </button>
          )
        })}
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 340px)' }}>
        {sub === 'overview'  && <Overview        orgId={orgId} />}
        {sub === 'settings'  && <AISettingsSection orgId={orgId} isSuperAdmin={isSuperAdmin} />}
        {sub === 'learning'  && <LearningSection  orgId={orgId} isSuperAdmin={isSuperAdmin} />}
        {sub === 'rules'     && <RulesSection     orgId={orgId} />}
      </div>
    </div>
  )
}
