// Adapter for self-hosted OpenAI-compatible models (Ollama, LM Studio, vLLM, LocalAI).

import { checkPublicUrl } from '../../ssrfGuard.js'

// The model URL is org-editable and fetched by the server, so in production it
// must be a public host. Local dev may point at Ollama on localhost/LAN.
export async function checkModelUrl(url) {
  if (process.env.NODE_ENV === 'production') return checkPublicUrl(url)
  try {
    const u = new URL(String(url))
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'only http/https allowed'
  } catch { return 'invalid URL' }
}

async function assertModelUrl(url) {
  const reason = await checkModelUrl(url)
  if (reason) throw new Error(`Self-hosted model URL rejected: ${reason}`)
}

// ── Health check ──────────────────────────────────────────────────────────────
export async function checkHealth(baseUrl) {
  if (!baseUrl) return { ok: false, models: [], latencyMs: null, error: 'No URL configured' }
  const reason = await checkModelUrl(baseUrl)
  if (reason) return { ok: false, models: [], latencyMs: null, error: `URL rejected: ${reason}` }
  const t0 = Date.now()
  try {
    // Try /v1/models (standard OpenAI endpoint) with a short timeout
    const res = await fetch(`${baseUrl}/v1/models`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { ok: false, models: [], latencyMs: Date.now()-t0, error: `HTTP ${res.status}` }
    const data   = await res.json()
    const models = (data?.data || []).map(m => m.id)
    return { ok: true, models, latencyMs: Date.now()-t0 }
  } catch (e) {
    // Ollama uses GET /api/tags as an alternative
    try {
      const res2 = await fetch(`${baseUrl}/api/tags`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
      if (res2.ok) {
        const data   = await res2.json()
        const models = (data?.models || []).map(m => m.name)
        return { ok: true, models, latencyMs: Date.now()-t0 }
      }
    } catch { /* ignore */ }
    return { ok: false, models: [], latencyMs: Date.now()-t0, error: e.message }
  }
}

// ── Context length adaptation ─────────────────────────────────────────────────
// Small (7B) models often have 4K-8K context, so long prompts are truncated.
export function adaptContext(prompt, systemPrompt, maxContextChars = 12_000) {
  const combined = (systemPrompt || '').length + (prompt || '').length
  if (combined <= maxContextChars) return { prompt, systemPrompt }

  // Shorten the prompt first, preserving system instructions
  const sysLen      = Math.min((systemPrompt || '').length, maxContextChars * 0.3)
  const promptAlloc = maxContextChars - sysLen - 200  // safety margin
  return {
    systemPrompt: (systemPrompt || '').slice(0, sysLen),
    prompt:       (prompt || '').slice(0, promptAlloc),
  }
}

// ── JSON (non-streaming) call ─────────────────────────────────────────────────
export async function callJSON(baseUrl, model, prompt, systemPrompt, {
  maxTokens = 2048, temperature = 0.3, signal,
} = {}) {
  await assertModelUrl(baseUrl)
  const { prompt: p, systemPrompt: sp } = adaptContext(prompt, systemPrompt)
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'default',
      messages: [
        { role: 'system', content: sp || '' },
        { role: 'user',   content: p  || '' },
      ],
      max_tokens:  maxTokens,
      temperature,
      stream:      false,
    }),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Self-hosted ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

// ── SSE streaming call ────────────────────────────────────────────────────────
/**
 * Stream a self-hosted model response to res as FieldFlow SSE frames (SSE already set up).
 * @param {function} onChunk  — called with { text } or { error } frames
 * @returns {Promise<string>} full accumulated text
 */
export async function callStream(baseUrl, model, prompt, systemPrompt, res, onChunk, signal, {
  maxTokens = 2048, temperature = 0.7,
} = {}) {
  await assertModelUrl(baseUrl)
  const { prompt: p, systemPrompt: sp } = adaptContext(prompt, systemPrompt)
  const fetchRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'default',
      messages: [
        { role: 'system', content: sp || '' },
        { role: 'user',   content: p  || '' },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  })

  if (!fetchRes.ok || !fetchRes.body) {
    const errBody = await fetchRes.text().catch(() => '')
    throw new Error(`Self-hosted stream ${fetchRes.status}: ${errBody.slice(0, 200)}`)
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
        } catch { /* skip malformed frames */ }
      }
    }
  } catch (e) {
    onChunk({ error: `Self-hosted stream error: ${e.message}` })
  }

  return full
}
