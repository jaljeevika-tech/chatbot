// Gemini streaming helpers shared by the notebook and report AI routes.
//
// Model tiers (cost vs quality):
//   Pro   — complex org/grant/annual/board reports; ~7× more expensive than Flash
//   Flash — everything else: field reports, social posts, notebook, analytics, NLP

const GEMINI_PRO_MODEL      = 'gemini-2.5-pro'
const GEMINI_FLASH_MODEL    = 'gemini-2.5-flash'

// Alias for existing GEMINI_MODEL imports
export const GEMINI_MODEL   = GEMINI_PRO_MODEL

// API key goes in the x-goog-api-key header, never the URL
export const GEMINI_URL = (_key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_PRO_MODEL}:streamGenerateContent?alt=sse`

export const GEMINI_FLASH_URL = (_key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:streamGenerateContent?alt=sse`

// Smart model picker: only route to Pro when the content genuinely needs it
export function pickReportUrl(instruction = '', apiKey) {
  const PRO_KEYWORDS = /\b(board of directors|grant proposal|annual report|donor report|management information system|MIS report|press release|SROI|theory of change|funder compliance|national scale|governance|sustainability indicator|SDG|quarterly donor|boilerplate|AP style|newsroom)\b/i
  return PRO_KEYWORDS.test(instruction) ? GEMINI_URL(apiKey) : GEMINI_FLASH_URL(apiKey)
}

const GEMINI_NOTEBOOK_URL = GEMINI_FLASH_URL  // Notebook always uses Flash

/** AbortController that cancels the Gemini stream when the client disconnects. */
export function makeAbortSignal(req) {
  const ctrl = new AbortController()
  // Listen on the response: since Node 16 req emits 'close' as soon as the body
  // is read, which would abort every call immediately.
  const res = req.res
  if (res) res.on('close', () => { if (!res.writableFinished) ctrl.abort() })
  else req.on('close', () => ctrl.abort())
  return ctrl.signal
}

/** Set SSE response headers */
export function setupSSE(res) {
  res.statusCode = 200
  res.setHeader('Content-Type',                'text/event-stream')
  res.setHeader('Cache-Control',               'no-cache, no-transform')
  res.setHeader('Connection',                  'keep-alive')
  res.setHeader('X-Accel-Buffering',           'no')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()
}

/** Write one SSE data frame */
export function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Pipe a Gemini SSE stream to the client; `signal` (makeAbortSignal) cancels the reader. */
export async function pipeGeminiStream(geminiRes, res, sendFn, signal = null) {
  const reader  = geminiRes.body.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   anyTextSent  = false
  let   blockReason  = null   // promptFeedback.blockReason, if Gemini blocked the whole request
  let   finishReason = null   // candidate finishReason, e.g. 'SAFETY' / 'RECITATION'
  let   hitMaxTokens = false  // true if generation was cut off by the output token cap

  if (signal) signal.addEventListener('abort', () => reader.cancel('client_disconnect'), { once: true })

  function _handleChunk(raw) {
    try {
      const chunk = JSON.parse(raw)
      const candidates = chunk?.candidates || chunk?.result?.candidates
      if (chunk?.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason
      const reason = candidates?.[0]?.finishReason
      if (reason === 'MAX_TOKENS') hitMaxTokens = true
      if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') finishReason = reason
      // Skip gemini-2.5-pro thinking parts (thought:true)
      const parts = candidates?.[0]?.content?.parts || []
      const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('')
      if (text) { sendFn({ text }); anyTextSent = true }
    } catch { /* skip invalid JSON */ }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || signal?.aborted) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const raw = trimmed.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        _handleChunk(raw)
      }
    }

    // Flush any remaining buffer
    if (buffer.startsWith('data: ')) {
      const raw = buffer.slice(6).trim()
      if (raw && raw !== '[DONE]') _handleChunk(raw)
    }

    // No text at all because of a block or safety/recitation stop: say so, don't
    // complete with a blank result.
    if (!anyTextSent && (blockReason || finishReason)) {
      sendFn({ error: `Gemini did not return content (${blockReason || finishReason}). Try rephrasing the request.` })
    }

    // Partial text cut off by the token cap would otherwise look complete.
    if (hitMaxTokens) {
      sendFn({ text: '\n\n---\n\n> ⚠️ **This report was cut off** — it reached the maximum output length for a single generation. Narrow the date range or project scope and regenerate, or ask to continue from where it stopped.' })
    }
  } catch (e) {
    sendFn({ error: `Stream Error: ${e instanceof Error ? e.message : 'Unknown'}` })
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

export async function callGeminiNotebook(
  apiKey, prompt, systemPrompt, res,
  maxTokens = 4096, temperature = 0.7,
  responseMimeType = null, thinkingBudget = 0,
  signal = null           // AbortSignal from makeAbortSignal(req)
) {
  const send = (payload) => sendSSE(res, payload)
  const generationConfig = { maxOutputTokens: maxTokens, temperature }
  if (responseMimeType)   generationConfig.responseMimeType = responseMimeType
  if (thinkingBudget !== null) generationConfig.thinkingConfig = { thinkingBudget }  // 0 = disabled

  const geminiRes = await fetch(GEMINI_NOTEBOOK_URL(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig,
    }),
    signal,   // propagate abort signal to the fetch itself
  })

  if (!geminiRes.ok || !geminiRes.body) {
    const errBody = await geminiRes.text()
    console.error(`[callGeminiNotebook] HTTP ${geminiRes.status}:`, errBody.slice(0, 600))
    send({ error: `Gemini error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  await pipeGeminiStream(geminiRes, res, send, signal)
}
