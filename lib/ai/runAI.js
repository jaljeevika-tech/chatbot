// Single AI gateway for all FieldFlow features
//
// Three-tier routing per task:
//   Tier 1  Local deterministic  rules, templates, scoring, extraction
//   Tier 2  Self-hosted model    Ollama / LM Studio / vLLM (OpenAI-compatible)
//   Tier 3  External Gemini      only when enabled + budget allows + task needs it
//
// Usage (non-streaming):
//   const { text, provider } = await runAI({ feature, operation, prompt, systemPrompt, orgId })
//
// Usage (SSE streaming):
//   const { text, provider } = await runAI.stream({ feature, operation, prompt, systemPrompt, orgId }, { res, signal })
//
// Task fields:
//   feature     'assistant' | 'notebook' | 'rw' | 'reports' | 'whatsapp'
//   operation   'chat' | 'draft' | 'analyze' | 'intent' | 'slot' | 'summary' | ...
//   prompt      string — user / assembled prompt text
//   systemPrompt string — system instruction
//   orgId       string
//   userId      string (optional)
//   context     {} — feature-specific structured data passed to local tier

import { getPool }        from '../../db/pool.js'
import { trackUsage }     from '../usageTracker.js'
import { CircuitBreaker } from '../circuitBreaker.js'

// ── Feature policy defaults ────────────────────────────────────────────────────
// Each feature has a three-flag policy:
//   tier1_only       — never call any model (local deterministic output only)
//   allow_self_hosted — may call the org's self-hosted model endpoint
//   allow_external   — may call Gemini (subject to budget + org toggle)
export const FEATURE_POLICY_DEFAULTS = {
  whatsapp:   { tier1_only: true,  allow_self_hosted: false, allow_external: false },
  reports:    { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
  notebook:   { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
  rw:         { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
  assistant:  { tier1_only: false, allow_self_hosted: false, allow_external: true  },
  validation: { tier1_only: false, allow_self_hosted: true,  allow_external: true  },
  annual_progress: { tier1_only: false, allow_self_hosted: true, allow_external: true },
  budget_utilisation: { tier1_only: false, allow_self_hosted: true, allow_external: true },
  action_plan: { tier1_only: false, allow_self_hosted: true, allow_external: true },
  beneficiaries: { tier1_only: false, allow_self_hosted: true, allow_external: true },
  project_dashboard: { tier1_only: false, allow_self_hosted: true, allow_external: true },
}

// Unknown/misspelled `feature` never calls a model, so a typo can't bypass a
// stricter policy (e.g. 'whatsapp-bulk' sending PII to Gemini).
const UNKNOWN_FEATURE_POLICY = { tier1_only: true, allow_self_hosted: false, allow_external: false }

// ── Circuit breakers ───────────────────────────────────────────────────────────
const _geminiCB   = new CircuitBreaker('gemini',     { threshold: 3, timeout: 60_000 })
const _selfHostCB = new CircuitBreaker('self_hosted', { threshold: 5, timeout: 30_000 })

// ── Policy cache ──────────────────────────────────────────────────────────────
const _policyCache = new Map()   // orgId → { ...policy, ts }
const POLICY_TTL   = 5 * 60_000

async function _getOrgPolicy(orgId) {
  const cached = _policyCache.get(orgId)
  if (cached && Date.now() - cached.ts < POLICY_TTL) return cached

  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT external_enabled, local_model_url, local_model_name,
              budget_usd_daily, feature_policies
       FROM ai_settings WHERE org_id = $1`,
      [orgId]
    )
    const row = rows[0] || {}
    const fp  = row.feature_policies || {}
    const policy = {
      externalEnabled: row.external_enabled  ?? true,
      localModelUrl:   row.local_model_url   ?? null,
      localModelName:  row.local_model_name  ?? null,
      budgetDailyUsd:  parseFloat(row.budget_usd_daily ?? 5),
      featurePolicies: {
        ...FEATURE_POLICY_DEFAULTS,
        ...Object.fromEntries(
          Object.entries(fp).map(([k, v]) => [k, { ...(FEATURE_POLICY_DEFAULTS[k] || {}), ...v }])
        ),
      },
      ts: Date.now(),
    }
    _policyCache.set(orgId, policy)
    return policy
  } catch {
    return {
      externalEnabled: true, localModelUrl: null, localModelName: null,
      budgetDailyUsd: 5, featurePolicies: { ...FEATURE_POLICY_DEFAULTS }, ts: Date.now(),
    }
  }
}

export function invalidateOrgPolicy(orgId) { _policyCache.delete(orgId) }

// ── Daily budget guard ────────────────────────────────────────────────────────
// budgetUsd: negative = unlimited, 0 = hard stop (admin-disabled), positive = daily cap.
async function _withinBudget(orgId, budgetUsd) {
  if (budgetUsd < 0) return true
  if (budgetUsd === 0) return false
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent
       FROM ai_interactions
       WHERE org_id = $1 AND provider = 'gemini'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [orgId]
    )
    return parseFloat(rows[0]?.spent ?? 0) < budgetUsd
  } catch { return true }  // fail-open on DB error
}

// ── Interaction row helpers ───────────────────────────────────────────────────
async function _createRecord(orgId, feature, operation, userMsg) {
  if (!orgId) return null
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO ai_interactions (org_id, feature, user_message, route_used)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, feature, userMsg ?? '', `${feature}:${operation}`]
    )
    return rows[0]?.id ?? null
  } catch { return null }
}

async function _finalizeRecord(id, { text = '', provider = 'gemini', confidence = null,
  latencyMs = 0, costUsd = 0, fallbackReason = null, tokensUsed = 0 } = {}) {
  if (!id) return
  try {
    const pool = getPool()
    await pool.query(
      `UPDATE ai_interactions
       SET ai_response=$1, provider=$2, confidence=$3,
           latency_ms=$4, cost_usd=$5, fallback_reason=$6, tokens_used=$7
       WHERE id=$8`,
      [text, provider, confidence, latencyMs, costUsd, fallbackReason, tokensUsed, id]
    )
  } catch { /* non-fatal */ }
}

// ── Privacy redaction ─────────────────────────────────────────────────────────
function _redact(str) {
  if (!str) return str
  return String(str)
    .replace(/\+?[0-9]{10,15}/g, '[PHONE]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[TOKEN]')
    .replace(/AIza[A-Za-z0-9_-]{35}/g, '[KEY]')
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[TOKEN]')
}

// ── Gemini endpoints ──────────────────────────────────────────────────────────
const GEMINI_FLASH_JSON = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
const GEMINI_FLASH_SSE  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
const GEMINI_PRO_SSE    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'

function _apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
}

async function _geminiJSON(prompt, systemPrompt, { maxTokens = 2048, temperature = 0.3,
  jsonMode = false, signal } = {}) {
  const key = _apiKey()
  if (!key) throw new Error('GEMINI_API_KEY not configured')
  const gc = { maxOutputTokens: maxTokens, temperature, thinkingConfig: { thinkingBudget: 0 } }
  if (jsonMode) gc.responseMimeType = 'application/json'
  const res = await fetch(GEMINI_FLASH_JSON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: gc,
    }),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`)
  }
  const data  = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('')
  return jsonMode ? JSON.parse(text) : text
}

// ── Self-hosted JSON call ─────────────────────────────────────────────────────
async function _selfHostJSON(baseUrl, model, prompt, systemPrompt,
  { maxTokens = 2048, temperature = 0.3, signal } = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'default',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
      ],
      max_tokens: maxTokens, temperature, stream: false,
    }),
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Self-hosted ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function _sse(res, payload) {
  if (!res?.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function _pipeGeminiSSE(geminiRes, res, onChunk, signal) {
  const reader  = geminiRes.body.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   full    = ''

  if (signal) signal.addEventListener('abort', () => reader.cancel(), { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || signal?.aborted) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data: ')) continue
        const raw = t.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const chunk = JSON.parse(raw)
          const text  = (chunk?.candidates?.[0]?.content?.parts || [])
            .filter(p => !p.thought).map(p => p.text || '').join('')
          if (text) { full += text; onChunk({ text }) }
        } catch { /* skip */ }
      }
    }
    // flush tail
    if (buffer.startsWith('data: ')) {
      try {
        const chunk = JSON.parse(buffer.slice(6).trim())
        const text  = (chunk?.candidates?.[0]?.content?.parts || [])
          .filter(p => !p.thought).map(p => p.text || '').join('')
        if (text) { full += text; onChunk({ text }) }
      } catch { /* ignore */ }
    }
  } catch (e) { onChunk({ error: `Stream error: ${e.message}` }) }

  if (!res?.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
  return full
}

async function _pipeSelfHostSSE(baseUrl, model, prompt, systemPrompt, res, onChunk, signal,
  { maxTokens = 2048, temperature = 0.7 } = {}) {
  const fetchRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'default',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      max_tokens: maxTokens, temperature, stream: true,
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  })
  if (!fetchRes.ok || !fetchRes.body) {
    const body = await fetchRes.text().catch(() => '')
    throw new Error(`Self-hosted stream ${fetchRes.status}: ${body.slice(0, 200)}`)
  }

  const reader  = fetchRes.body.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   full    = ''

  if (signal) signal.addEventListener('abort', () => reader.cancel(), { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || signal?.aborted) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
        try {
          const chunk = JSON.parse(t.slice(6))
          const text  = chunk?.choices?.[0]?.delta?.content ?? ''
          if (text) { full += text; onChunk({ text }) }
        } catch { /* skip */ }
      }
    }
  } catch (e) { onChunk({ error: `Self-hosted stream error: ${e.message}` }) }

  if (!res?.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
  return full
}

// Only a missing module means "not built yet"; anything else is a real bug and must surface.
function _isModuleNotFound(e) {
  return e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
}

// ── Tier 1: local deterministic ───────────────────────────────────────────────
// Returns { handled: true, text, confidence } or { handled: false }
async function _tryLocal(task) {
  const { feature, operation, context, orgId, prompt } = task

  // WhatsApp / intent detection — lib/ai/local/intentMatcher.js
  if (feature === 'whatsapp' && operation === 'detect_intent') {
    try {
      const m = await import('./local/intentMatcher.js')
      if (m?.detectIntent) {
        const r = await m.detectIntent(prompt, context?.flows, orgId)
        if (r) return { handled: true, text: JSON.stringify(r), confidence: r.confidence ?? 0.9 }
      }
    } catch (e) { if (!_isModuleNotFound(e)) console.error('[runAI._tryLocal] detect_intent threw:', e) }
  }

  // WhatsApp / slot extraction — lib/ai/local/slotExtractor.js
  if (feature === 'whatsapp' && operation === 'extract_slot') {
    try {
      const m = await import('./local/slotExtractor.js')
      if (m?.extract) {
        const r = await m.extract(prompt, context?.fieldName, context?.fieldType)
        if (r !== null && r !== undefined) return { handled: true, text: String(r), confidence: 0.85 }
      }
    } catch (e) { if (!_isModuleNotFound(e)) console.error('[runAI._tryLocal] extract_slot threw:', e) }
  }

  // WhatsApp / fallback response — lib/ai/local/templateWriter.js
  if (feature === 'whatsapp' && operation === 'fallback_response') {
    try {
      const m = await import('./local/templateWriter.js')
      if (m?.buildFallbackResponse) {
        const r = m.buildFallbackResponse(context?.contactName, context?.orgName, context?.flows)
        if (r) return { handled: true, text: r, confidence: 0.7 }
      }
    } catch (e) { if (!_isModuleNotFound(e)) console.error('[runAI._tryLocal] fallback_response threw:', e) }
  }

  // Reports / pre-analysis — lib/ai/local/reportAnalyzer.js
  if (feature === 'reports' && operation === 'analyze') {
    try {
      const m = await import('./local/reportAnalyzer.js')
      if (m?.analyze) {
        const r = await m.analyze(context?.reports, context?.instruction, orgId)
        if (r && Object.keys(r).length > 0) return { handled: true, text: JSON.stringify(r), confidence: 0.95 }
      }
    } catch (e) { if (!_isModuleNotFound(e)) console.error('[runAI._tryLocal] reports.analyze threw:', e) }
  }

  // Report Writer / template draft — lib/ai/local/templateWriter.js
  if (feature === 'rw' && operation === 'draft_template') {
    try {
      const m = await import('./local/templateWriter.js')
      if (m?.draftTemplate) {
        const r = m.draftTemplate(context?.reportType, context?.sources, context?.voiceProfile, orgId)
        if (r) return { handled: true, text: r, confidence: 0.75 }
      }
    } catch (e) { if (!_isModuleNotFound(e)) console.error('[runAI._tryLocal] draft_template threw:', e) }
  }

  return { handled: false }
}

// ── Cost estimation (rough) ───────────────────────────────────────────────────
function _estimateCost(promptLen, maxTokens) {
  // Gemini 2.5 Flash: ~$0.15/M input tokens, ~$0.60/M output tokens
  return (promptLen / 4 * 0.00000015) + (maxTokens * 0.0000006)
}

// ═══════════════════════════════════════════════════════════════════════════════
// runAI — non-streaming (JSON) path
// ═══════════════════════════════════════════════════════════════════════════════
export async function runAI(task = {}, opts = {}) {
  const {
    feature = 'assistant', operation = 'chat',
    prompt = '', systemPrompt = '', orgId, userId,
  } = task

  const {
    signal, maxTokens = 2048, temperature = 0.7,
    jsonMode = false, interactionId: callerIntId = null,
  } = opts

  const t0         = Date.now()
  const orgPolicy  = await _getOrgPolicy(orgId)
  const policy     = orgPolicy.featurePolicies[feature] ?? UNKNOWN_FEATURE_POLICY

  const intId = callerIntId ?? await _createRecord(orgId, feature, operation, prompt)

  let provider       = 'gemini'
  let fallbackReason = null
  let result         = null
  let confidence     = null

  try {
    // ── Tier 1 ─────────────────────────────────────────────────────────────
    const local = await _tryLocal({ ...task, orgId })
    if (local.handled) {
      provider   = 'local'
      confidence = local.confidence
      result     = local.text
    }

    // ── Tier 2: self-hosted ─────────────────────────────────────────────────
    if (!result && !policy.tier1_only && policy.allow_self_hosted
        && orgPolicy.localModelUrl && !_selfHostCB.isOpen) {
      try {
        result = await _selfHostCB.call(() =>
          _selfHostJSON(orgPolicy.localModelUrl, orgPolicy.localModelName,
            _redact(prompt), _redact(systemPrompt), { maxTokens, temperature, signal })
        )
        provider = 'self_hosted'; confidence = 0.75
      } catch (e) {
        fallbackReason = `self_hosted:${e.message.slice(0, 80)}`
      }
    }

    // ── Tier 3: Gemini ──────────────────────────────────────────────────────
    if (!result) {
      if (policy.tier1_only) {
        fallbackReason = 'policy:tier1_only'; provider = 'local'
      } else if (!orgPolicy.externalEnabled || !(policy.allow_external ?? true)) {
        fallbackReason = 'policy:external_disabled'; provider = 'local'
      } else if (!(await _withinBudget(orgId, orgPolicy.budgetDailyUsd))) {
        fallbackReason = 'budget_exceeded'; provider = 'local'
      } else if (_geminiCB.isOpen) {
        fallbackReason = 'circuit_open:gemini'; provider = 'local'
      } else {
        try {
          result = await _geminiCB.call(() =>
            _geminiJSON(_redact(prompt), _redact(systemPrompt),
              { maxTokens, temperature, jsonMode, signal })
          )
          provider = 'gemini'; confidence = 1.0
        } catch (e) {
          fallbackReason = `gemini:${e.message.slice(0, 80)}`; provider = 'local'
        }
      }
    }
  } finally {
    const latencyMs = Date.now() - t0
    const costUsd   = provider === 'gemini' ? _estimateCost(prompt.length, maxTokens) : 0
    await _finalizeRecord(intId, {
      text: result ?? '', provider, confidence, latencyMs, costUsd,
      fallbackReason, tokensUsed: provider === 'gemini' ? Math.ceil(prompt.length / 4) + maxTokens : 0,
    })
    if (provider === 'gemini' && orgId) {
      trackUsage(orgId, { service: `${feature}_${operation}`, model: 'flash',
        inputLength: prompt.length + systemPrompt.length, maxOutputTokens: maxTokens })
    }
  }

  return { text: result, provider, confidence, fallbackReason, interactionId: intId }
}

// ═══════════════════════════════════════════════════════════════════════════════
// runAI.stream — SSE streaming path
// opts.res    Express Response (required)
// opts.usePro boolean — use Gemini Pro instead of Flash
// ═══════════════════════════════════════════════════════════════════════════════
runAI.stream = async function streamAI(task = {}, opts = {}) {
  const {
    feature = 'assistant', operation = 'chat',
    prompt = '', systemPrompt = '', orgId, userId,
  } = task

  const {
    res, signal, maxTokens = 2048, temperature = 0.7,
    usePro = false, interactionId: callerIntId = null,
  } = opts

  if (!res) throw new Error('[runAI.stream] opts.res is required')

  const t0        = Date.now()
  const orgPolicy = await _getOrgPolicy(orgId)
  const policy    = orgPolicy.featurePolicies[feature] ?? UNKNOWN_FEATURE_POLICY
  const intId     = callerIntId ?? await _createRecord(orgId, feature, operation, prompt)

  let provider       = 'gemini'
  let fallbackReason = null
  let fullText       = ''
  let confidence     = null

  // ── Tier 1 (synchronous — emit as single SSE frame) ───────────────────────
  const local = await _tryLocal({ ...task, orgId })
  if (local.handled) {
    provider = 'local'; confidence = local.confidence; fullText = local.text
    _sse(res, { text: fullText })
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
  } else {
    // ── Tier 2: self-hosted stream ────────────────────────────────────────
    let usedSelfHost = false
    if (!policy.tier1_only && policy.allow_self_hosted
        && orgPolicy.localModelUrl && !_selfHostCB.isOpen) {
      try {
        fullText = await _selfHostCB.call(() =>
          _pipeSelfHostSSE(orgPolicy.localModelUrl, orgPolicy.localModelName,
            _redact(prompt), _redact(systemPrompt), res, p => _sse(res, p), signal,
            { maxTokens, temperature })
        )
        provider = 'self_hosted'; confidence = 0.75; usedSelfHost = true
      } catch (e) {
        fallbackReason = `self_hosted:${e.message.slice(0, 80)}`
      }
    }

    // ── Tier 3: Gemini stream ─────────────────────────────────────────────
    if (!usedSelfHost) {
      if (policy.tier1_only) {
        fallbackReason = 'policy:tier1_only'; provider = 'local'
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      } else if (!orgPolicy.externalEnabled || !(policy.allow_external ?? true)) {
        fallbackReason = 'policy:external_disabled'; provider = 'local'
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      } else if (!(await _withinBudget(orgId, orgPolicy.budgetDailyUsd))) {
        fallbackReason = 'budget_exceeded'; provider = 'local'
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      } else if (_geminiCB.isOpen) {
        fallbackReason = 'circuit_open:gemini'; provider = 'local'
        _sse(res, { error: 'AI service temporarily unavailable — please try again in a minute.' })
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      } else {
        const key    = _apiKey()
        const sseUrl = usePro ? GEMINI_PRO_SSE : GEMINI_FLASH_SSE
        try {
          const geminiRes = await _geminiCB.call(() =>
            fetch(sseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: _redact(prompt) }] }],
                systemInstruction: { parts: [{ text: _redact(systemPrompt) }] },
                generationConfig: { maxOutputTokens: maxTokens, temperature },
              }),
              signal: signal ?? AbortSignal.timeout(120_000),
            })
          )
          if (!geminiRes.ok || !geminiRes.body) {
            const errBody = await geminiRes.text().catch(() => '')
            _sse(res, { error: `AI error ${geminiRes.status}: ${errBody.slice(0, 200)}` })
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
            fallbackReason = `gemini_http_${geminiRes.status}`
          } else {
            provider   = usePro ? 'gemini_pro' : 'gemini'
            confidence = 1.0
            fullText   = await _pipeGeminiSSE(geminiRes, res, p => _sse(res, p), signal)
          }
        } catch (e) {
          fallbackReason = `gemini:${e.message.slice(0, 80)}`
          if (!res.writableEnded) {
            _sse(res, { error: e.message })
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }
      }
    }
  }

  // ── Observability ─────────────────────────────────────────────────────────
  const latencyMs = Date.now() - t0
  const costUsd   = provider.startsWith('gemini') ? _estimateCost(prompt.length, maxTokens) : 0
  await _finalizeRecord(intId, {
    text: fullText, provider, confidence, latencyMs, costUsd, fallbackReason,
    tokensUsed: provider.startsWith('gemini') ? Math.ceil(prompt.length / 4) + maxTokens : 0,
  })
  if (provider.startsWith('gemini') && orgId) {
    trackUsage(orgId, { service: `${feature}_${operation}`,
      model: usePro ? 'pro' : 'flash',
      inputLength: prompt.length + systemPrompt.length, maxOutputTokens: maxTokens })
  }

  return { text: fullText, provider, fallbackReason, interactionId: intId }
}

// ── Provider health ───────────────────────────────────────────────────────────
export function getProviderHealth() {
  return {
    gemini:     { state: _geminiCB.state,    failures: _geminiCB.failureCount },
    self_hosted: { state: _selfHostCB.state, failures: _selfHostCB.failureCount },
  }
}
