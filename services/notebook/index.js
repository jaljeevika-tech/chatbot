// services/notebook/index.js — FieldFlow Notebook Microservice
// Extracted from the monolith via Strangler Fig Pattern.
// STATELESS: no database, no Firebase auth. Accepts requests from the monolith only
// (monolith verifies Firebase token, then proxies here with x-forwarded-by header).
// Deploy to Cloud Run: gcloud run deploy fieldflow-notebook --source . --region asia-south1

import express from 'express'
import { randomUUID } from 'crypto'
import { parseOffice } from 'officeparser'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

// Readability (Firefox Reader Mode's engine) picks out just the actual
// article from a page's HTML — drops nav bars, cookie banners, ads,
// sidebars — instead of the plain tag-stripping fallback below keeping every
// stray bit of chrome as "content". Mirrors lib/extractWebArticle.js in the
// monolith (kept as an inline copy here since this service deploys from its
// own directory).
function extractArticle(html, url) {
  try {
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    const text = article?.textContent?.replace(/\s{2,}/g, ' ').trim()
    return text ? { title: article.title?.trim() || null, text } : null
  } catch (e) {
    console.warn('[extractArticle]', e.message)
    return null
  }
}

// SSRF guard — mirrors routes/notebook.routes.js's isAllowedFetchUrl. This
// service previously had no such check even though the monolith's copy of
// this same route does; added for parity while touching this function anyway.
const BLOCKED_HOSTS_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|metadata\.google\.internal)/i
function isAllowedFetchUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (BLOCKED_HOSTS_RE.test(u.hostname)) return false
    return true
  } catch { return false }
}

// officeparser only understands the modern XML-based Office formats — legacy
// binary .doc/.xls/.ppt are NOT supported. Mirrors lib/extractDocumentText.js
// in the monolith (kept as an inline copy here since this service deploys
// from its own directory, not the monolith's lib/).
const EXT_TO_OFFICE_TYPE = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
  odt: 'odt', ods: 'ods', odp: 'odp',
  csv: 'csv', md: 'md', html: 'html', htm: 'html', rtf: 'rtf',
}

async function extractOfficeText(buf, name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase()
  const fileType = EXT_TO_OFFICE_TYPE[ext]
  if (!fileType) return null
  try {
    const ast = await parseOffice(buf, { fileType })
    const text = ast.toText().trim()
    return text.length > 0 ? text.slice(0, 500_000) : null
  } catch (e) {
    console.warn('[extractOfficeText]', e.message)
    return null
  }
}

const app  = express()
const PORT = process.env.PORT || 8081

app.use(express.json({ limit: '50mb' }))

// ── Correlation ID propagation ────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'notebook', version: '1.0.0' }))

// ── Gemini helpers ────────────────────────────────────────────────────────────
// Must match the monolith, which serves notebook endpoints on Flash
// (lib/gemini.js: "Notebook always uses Flash"). Running Pro here made the
// proxied path ~7x more expensive, slower (frequent >120s timeouts on
// study-guide), and different in tone/length than the identical request served
// locally — a silent divergence whenever NOTEBOOK_SERVICE_URL is set.
const GEMINI_MODEL = 'gemini-2.5-flash'
// API key goes in the x-goog-api-key header, not the URL query string —
// query-string keys end up in proxy/access logs and Referer headers.
const GEMINI_URL   = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`

// Bound prompt size to prevent runaway token bills / input-limit failures when
// users attach large PDFs. Mirrors the monolith's capSources (routes/notebook.
// routes.js) — the standalone service previously joined ALL sources at FULL
// length for chat/audio/video-slides/study-guide/slide-deck, so the identical
// request cost 10-50x more (or failed) when proxied here vs served locally.
function capSources(sources, { maxPerSource = 20_000, maxSources = 4 } = {}) {
  return (sources || [])
    .slice(0, maxSources)
    .map(s => `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, maxPerSource)}\n---`)
    .join('\n\n')
}

function setupSSE(res) {
  res.statusCode = 200
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
}

function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function pipeGeminiStream(geminiRes, res, sendFn) {
  const reader  = geminiRes.body.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  // Surface generation-level failures the same way the monolith's
  // lib/gemini.js does — a safety block or a MAX_TOKENS truncation otherwise
  // ends the stream silently, leaving JSON-mode endpoints (slide-deck, mindmap,
  // flashcards, video-slides) with unparseable, half-finished output and no
  // explanation shown to the user.
  let blockReason = null
  let finishReason = null
  const handleChunk = (raw) => {
    try {
      const chunk = JSON.parse(raw)
      if (chunk?.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason
      const candidates = chunk?.candidates || chunk?.result?.candidates
      if (candidates?.[0]?.finishReason) finishReason = candidates[0].finishReason
      // gemini emits thinking/reasoning parts marked thought:true —
      // skip those or raw chain-of-thought leaks into user-visible output
      const parts = candidates?.[0]?.content?.parts || []
      const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('')
      if (text) sendFn({ text })
    } catch { /* skip invalid JSON */ }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const raw = trimmed.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        handleChunk(raw)
      }
    }
    if (buffer.startsWith('data: ')) handleChunk(buffer.slice(6).trim())
    if (blockReason) {
      sendFn({ error: `Generation blocked by safety filter (${blockReason}). Try rephrasing or different sources.` })
    } else if (finishReason === 'MAX_TOKENS') {
      sendFn({ error: 'Output was cut off (hit the length limit). Try fewer/shorter sources or a narrower request.' })
    }
  } catch (e) {
    sendFn({ error: `Stream Error: ${e.message}` })
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

async function callGemini(apiKey, prompt, systemPrompt, res, maxTokens = 4096, temperature = 0.7, responseMimeType = null) {
  const send = (p) => sendSSE(res, p)
  const generationConfig = { maxOutputTokens: maxTokens, temperature }
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType

  const geminiRes = await fetch(GEMINI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig,
    }),
  })

  if (!geminiRes.ok || !geminiRes.body) {
    const errBody = await geminiRes.text()
    send({ error: `Gemini error ${geminiRes.status}: ${errBody.slice(0, 300)}` })
    res.end(); return
  }
  await pipeGeminiStream(geminiRes, res, send)
}

function getApiKey() {
  const key = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!key) throw new Error('GEMINI_API_KEY not set')
  return key
}

// ── Routes ────────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024   // 20 MB decoded — matches the monolith

app.post('/api/notebook/upload', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const { name, type, dataBase64 } = req.body || {}
    if (!dataBase64) { res.json({ error: 'dataBase64 is required' }); return }
    // Check decoded size BEFORE allocating the buffer (matches the monolith's
    // MED-6 guard) — the proxy skips the monolith's check for /upload, so
    // without this the proxied path would accept files well over the 20MB cap.
    const decodedSize = Math.floor((dataBase64.length * 3) / 4)
    if (decodedSize > MAX_UPLOAD_BYTES) {
      res.json({ error: `File too large (${(decodedSize / 1024 / 1024).toFixed(1)}MB). Max 20MB.` }); return
    }
    const buf = Buffer.from(dataBase64, 'base64')
    if (type === 'txt') {
      const content = buf.toString('utf-8').slice(0, 200_000)
      res.json({ id: randomUUID(), name, type: 'txt', content, charCount: content.length })
    } else {
      const text = await extractOfficeText(buf, name)
      if (!text) { res.json({ error: `Unsupported or unreadable file: ${name}` }); return }
      const content = text.slice(0, 200_000)
      res.json({ id: randomUUID(), name, type, content, charCount: content.length })
    }
  } catch (e) { res.json({ error: e.message }) }
})

app.post('/api/notebook/fetch-url', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const { url } = req.body || {}
    if (!url) { res.json({ error: 'url is required' }); return }
    if (!isAllowedFetchUrl(url)) { res.status(403).json({ error: 'URL not permitted' }); return }
    const pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotebookBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pageRes.ok) { res.json({ error: `HTTP ${pageRes.status}` }); return }
    const html = await pageRes.text()
    const hostname = new URL(url).hostname
    const article = extractArticle(html, url)
    const text = (article?.text || html
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s{2,}/g, ' ').trim()
    ).slice(0, 100_000)
    res.json({ id: randomUUID(), name: article?.title || hostname, type: 'url', content: text, charCount: text.length })
  } catch (e) { res.json({ error: e.message }) }
})

app.post('/api/notebook/chat', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, message, history } = req.body || {}
    // Numbered so the model cites [1]/[2]/... matching each source's position —
    // the client maps that number back to the same array index for clickable
    // citation chips (see src/components/notebook/ChatPanel.tsx).
    const srcBlock  = (sources || []).slice(0, 4).map((s, i) => `[${i + 1}] ${s.name}\n${String(s.content || '').slice(0, 15_000)}\n---`).join('\n\n')
    const histBlock = (history || []).slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')
    const prompt = `Sources:\n${srcBlock}\n\n${histBlock ? `Conversation so far:\n${histBlock}\n\n` : ''}User: ${message}`
    await callGemini(apiKey, prompt, 'You are a research assistant. Answer ONLY using the provided sources. Cite with a bracketed number matching the source position — [1] for the first source, [2] for the second, etc. — right after the claim it supports. Never invent a citation number that has no matching source.', res, 2048, 0.6)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

// /audio, /video-slides (podcast + video scripts, incl. the documentary
// rules), /tts and /tts-multi are served by the monolith only — never proxied
// here (routes/notebook.routes.js LOCAL_ONLY) — so there is one copy to keep current.

app.post('/api/notebook/study-guide', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, format, customPrompt = '' } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 20_000, maxSources: 4 })
    const formatPrompts = {
      summary: 'Write a comprehensive executive summary with key themes, main findings, and important conclusions. Use ## headings and bullet points. Pull out specific numbers, names, dates, and quotes from the sources rather than generic statements.',
      faq:     'Generate the top 10 most important Q&A, each answer grounded in specific facts from the sources (with figures/quotes where available). Format as ## Q: ... then **A:** ...',
      timeline:'Extract and list all chronological events as a numbered timeline, each entry citing the specific date/period and source detail it came from.',
      briefing:'Write a one-page briefing: Context, Key Points, Implications, Recommended Actions — each section grounded in concrete details (figures, names, quotes) from the sources, not generic filler.',
    }
    const prompt = `${formatPrompts[format] || formatPrompts.summary}${customPrompt ? `\n\nAdditional instructions: ${customPrompt}` : ''}\n\nSources:\n${srcBlock}`
    const system = `You are a research analyst producing NotebookLM-style study materials in Markdown. Ground every claim in the provided sources — cite the source name in parentheses, e.g. (Source: name), whenever you state a specific fact, figure, or quote. Never invent information not present in the sources; if the sources are thin on a point, say so explicitly rather than filling in generic content. Be thorough and specific, not vague.`
    // Was capped at 8192 — too low for a comprehensive guide over a large
    // source, cutting generation off mid-section. See routes/notebook.routes.js's
    // matching change for the full rationale.
    await callGemini(apiKey, prompt, system, res, 24_576, 0.55)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

app.post('/api/notebook/slide-deck', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, mode = 'detailed', customPrompt = '', fieldPhotoCaptions = [] } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 18_000, maxSources: 3 })
    const photoMatchInstruction = fieldPhotoCaptions.length > 0
      ? `\n\nHere are captions of real field photos available (each is a verbatim field report description):\n${fieldPhotoCaptions.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nFor each slide, if — and only if — one of these captions describes the SAME specific event/activity as that slide, add a "matchedCaption" field to that slide's JSON containing that caption copied EXACTLY as given above (verbatim, no edits). Leave "matchedCaption" out entirely for any slide with no genuinely matching caption — do not force a loose or generic match.`
      : ''
    // Honor the Presenter/Detailed toggle the frontend sends (SlideDeck.tsx) —
    // was previously destructured but ignored, so Presenter mode produced
    // identical output to Detailed on the proxied path.
    const modeInstructions = mode === 'presenter'
      ? 'Each slide: 3-4 concise bullets (max 12 words each) and a 1-sentence speaker note. Minimal text, visual-first.'
      : 'Each slide: 5-6 detailed bullets and comprehensive 2-3 sentence speaker notes with supporting detail.'
    // User's custom instructions go FIRST as top priority so they're actually
    // applied (buried at the end they were often ignored).
    const customBlock = customPrompt
      ? `TOP PRIORITY — the user's specific instructions for this deck (follow these over the general guidance below, except never break the JSON format or invent facts):\n"${customPrompt}"\n\n`
      : ''
    const prompt = `${customBlock}Create a 10-slide presentation from the sources below. ${modeInstructions}
Hard rules for a professional, clean deck: titles max 8 words and specific; MAXIMUM 6 bullets per slide, each ONE short line (max ~14 words, never a paragraph — overflow looks unprofessional, move detail to speakerNotes); lead each bullet with the concrete fact/figure/name. Each bullet must state SPECIFIC facts, figures, names, or findings drawn from the sources — never generic filler like "various improvements were made". Return ONLY valid JSON array:\n[{"title":"...","bullets":["..."],"speakerNotes":"..."}]${photoMatchInstruction}\n\nSources:\n${srcBlock}`
    const system = `You are a presentation designer producing a polished, data-grounded slide deck for a professional/donor audience. Return ONLY valid JSON — no markdown fences, no explanation. Never use literal newlines inside JSON strings. Keep every bullet to a single short line (never a paragraph) and at most 6 bullets per slide so nothing overflows the slide. Every bullet must be traceable to something actually stated in the sources; do not pad with vague, generic statements. When the user gives specific instructions, follow them. Never use emoji anywhere in the title, bullets, or speaker notes — write like a professional analyst, not a social post.`
    await callGemini(apiKey, prompt, system, res, 8192, 0.55)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

app.post('/api/notebook/slide-revise', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, slide, instruction, index, total } = req.body || {}
    const srcBlock = (sources || []).map(s => `[SOURCE: ${s.name}]\n${s.content.slice(0, 20000)}\n---`).join('\n\n')
    const prompt = `Revising slide ${index + 1} of ${total}.\nTitle: ${slide.title}\nBullets: ${(slide.bullets||[]).join(' | ')}\nInstruction: "${instruction}"\n\nKeep bullets grounded in specific facts/figures from the sources — no generic filler. Return ONLY JSON: {"title":"...","bullets":["..."],"speakerNotes":"..."}\n\nSources:\n${srcBlock}`
    await callGemini(apiKey, prompt, 'Return ONLY a single valid JSON object. No array, no markdown fences. Never use emoji anywhere in the title, bullets, or speaker notes.', res, 2048, 0.55)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

app.post('/api/notebook/mindmap', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, customPrompt = '' } = req.body || {}
    const srcBlock = (sources || []).slice(0, 4).map(s => `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 18_000)}\n---`).join('\n\n')
    const prompt = `Build a hierarchical mind map of the key topics in these sources, like NotebookLM's mind map feature.

Return ONLY a valid JSON object (no markdown fences, no explanation) with this shape:
{"label": "Central topic (2-5 words)", "children": [{"label": "Theme (2-6 words)", "children": [{"label": "Sub-point (2-8 words)", "children": []}]}]}

Rules:
- Root node: one short label naming the overall subject of the sources.
- 3-6 second-level theme nodes, each grounded in something actually discussed in the sources.
- Each theme may have 2-5 third-level sub-point nodes with more specific facts/names/figures from the sources.
- Sub-points are leaves — "children" must be [] at the deepest level.
- Every label must be traceable to the sources; never invent a topic that isn't discussed.
- Keep the whole tree to at most ~20 nodes total.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Sources:
${srcBlock}`
    await callGemini(apiKey, prompt, 'You are producing a mind map data structure. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON object. Never use literal newline characters inside JSON string values.', res, 4096, 0.5)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

app.post('/api/notebook/flashcards-quiz', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources, customPrompt = '' } = req.body || {}
    const srcBlock = (sources || []).slice(0, 4).map(s => `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 18_000)}\n---`).join('\n\n')
    const prompt = `Build study material from these sources: a flashcard deck and a multiple-choice quiz, like a training/learning aid for staff studying this material.

Return ONLY a valid JSON object (no markdown fences, no explanation) with this shape:
{
  "flashcards": [{"front": "A specific question or term", "back": "The specific answer or definition"}],
  "quiz": [{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "Why that's correct, citing the source detail"}]
}

Rules:
- Exactly 12 flashcards and 8 quiz questions.
- Every flashcard and question must be grounded in a specific fact, figure, name, or finding actually stated in the sources — never generic filler.
- Each quiz question has exactly 4 options, all plausible, only one correct (correctIndex is 0-3).
- explanation is 1 short sentence grounding the correct answer in the sources.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Sources:
${srcBlock}`
    await callGemini(apiKey, prompt, 'You are producing a flashcard deck and quiz data structure for a training aid. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON object. Never use literal newline characters inside JSON string values. Every card and question must be traceable to something actually stated in the sources.', res, 4096, 0.6)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

app.post('/api/notebook/guide', async (req, res) => {
  setupSSE(res)
  try {
    const apiKey = getApiKey()
    const { sources } = req.body || {}
    const srcBlock = (sources || []).slice(0, 4).map(s => `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 18_000)}\n---`).join('\n\n')
    const prompt = `Sources:\n${srcBlock}\n\nWrite a short landing overview for this notebook: one tight paragraph (2-4 sentences) summarizing what these sources cover, grounded in specific facts from them. Then on a new line write "## Suggested questions" followed by exactly 4 bullet points, each a specific question a reader could ask that these sources can actually answer (not generic ones). Format:\n\n<paragraph>\n\n## Suggested questions\n- Question 1\n- Question 2\n- Question 3\n- Question 4`
    await callGemini(apiKey, prompt, 'You are writing a short, specific landing summary for a research notebook. Ground every claim in the provided sources. Never invent information not present in the sources. Return plain text in exactly the requested format — no extra commentary.', res, 1024, 0.5)
  } catch (e) { sendSSE(res, { error: e.message }); res.end() }
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[notebook-service] running on port ${PORT}`))
