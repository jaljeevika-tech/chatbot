// NLP helpers: deterministic local modules (lib/ai/local/) first, Gemini only
// when local confidence is low or the task is generative.
// 9 s timeouts keep WhatsApp handling inside Meta's 20 s webhook limit.

import { createHash } from 'crypto'
import { getOrgSector } from './orgMetaCache.js'
import { sectorOverlay } from './prompts/sectorPrompts.js'

// API key goes in a header, never the URL
const GEMINI_FLASH_URL = (_key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`

// ── In-process result cache for analyzeFieldData ──────────────────────────────
const _analysisCache  = new Map()                 // key → { result, ts }
const _ANALYSIS_TTL   = 8 * 60 * 1000
const _ANALYSIS_LIMIT = 40

// Keyed by org + hash of the full payload so one tenant can never read or
// poison another tenant's cached analysis.
function _analysisKey(orgId, reports, instruction) {
  const h = createHash('sha256').update(JSON.stringify(reports)).update('\0').update(String(instruction)).digest('hex')
  return `${orgId || '-'}:${h}`
}

function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
}

/** Non-streaming Gemini call; jsonMode sets responseMimeType and returns the parsed object. */
export async function callGemini(prompt, systemPrompt, maxTokens = 256, jsonMode = false, timeoutMs = 9_000) {
  const key = apiKey()
  if (!key) return null

  const generationConfig = {
    maxOutputTokens: maxTokens,
    temperature:     jsonMode ? 0.05 : 0.75,
    ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
  }

  try {
    const res = await fetch(GEMINI_FLASH_URL(key), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents:         [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const data = await res.json()
    if (!res.ok) {
      console.warn('[nlp] Gemini error:', data?.error?.message)
      return null
    }

    const parts = data?.candidates?.[0]?.content?.parts || []
    const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('')
    if (!text) return null

    return jsonMode ? JSON.parse(text) : text
  } catch (e) {
    console.warn('[nlp] call failed:', e.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
/** Map a WhatsApp message to the best wa_flows row (local matching, then Gemini); null if none. */
export async function detectIntent(message, flows, orgId) {
  if (!flows?.length || !message?.trim()) return null
  const candidates = flows.filter(f => !f.is_default)
  if (!candidates.length) return null

  // ── Tier 1: local keyword + alias matching ───────────────────────────────
  try {
    const matcher = await import('./ai/local/intentMatcher.js')
    const localResult = await matcher.detectIntent(message, flows, orgId)
    if (localResult && localResult.confidence >= 0.7) return localResult
  } catch { /* local module unavailable — fall through */ }

  // ── Fallback: Gemini ─────────────────────────────────────────────────────
  const flowList = candidates
    .map(f => `"${f.name}": keywords=[${(f.trigger_keywords || []).join(', ')}], purpose="${f.description || 'field data collection'}"`)
    .join('\n')

  const result = await callGemini(
    `User message: "${message}"\n\nAvailable flows:\n${flowList}`,
    `You are an intent classifier for an NGO field-worker chatbot on WhatsApp.
Match the user's message to the most relevant flow, even if they paraphrase or write in a regional language.
Respond with JSON only: { "flow_name": "<exact name from list or null>", "confidence": 0.0-1.0 }
Set confidence >= 0.65 only when you're clearly sure. Otherwise set flow_name to null.`,
    96, true
  )

  if (!result || result.confidence < 0.65 || !result.flow_name) return null
  return flows.find(f => f.name === result.flow_name) || null
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Extract a slot value from free text (local extractor, then Gemini); null if unclear.
 * @param {string} fieldType  - "number" | "date" | "yesno" | "phone" | "text"
 * @param {string} [orgId]    - records Gemini fallbacks so the local module can learn them
 */
export async function extractSlotValue(message, fieldName, fieldType = 'text', orgId = null) {
  // ── Tier 1: deterministic local extractor ────────────────────────────────
  try {
    const extractor = await import('./ai/local/slotExtractor.js')
    const localResult = extractor.extract(message, fieldName, fieldType)
    if (localResult !== null && localResult !== undefined) return localResult
  } catch { /* local module unavailable — fall through */ }

  // ── Fallback: Gemini ─────────────────────────────────────────────────────
  const result = await callGemini(
    `Field: "${fieldName}" (expected type: ${fieldType})\nUser said: "${message}"`,
    `Extract the value the user is providing for the named field.
Rules:
  - number → return only the numeric value as a string (no units, no words)
  - date   → return ISO-8601 date string (YYYY-MM-DD)
  - text   → return clean, normalized text in English if possible
Respond with JSON only: { "value": <extracted | null>, "confidence": 0.0-1.0 }
confidence >= 0.75 means you are quite sure.`,
    64, true
  )

  if (!result || result.value === null || result.value === undefined) return null
  if (result.confidence < 0.75) return null

  if (orgId && result.value !== null) {
    try {
      const { recordSlotFallback } = await import('./ai/learning/learningCollector.js')
      recordSlotFallback(orgId, message, fieldType, result.value).catch(() => {})
    } catch { /* non-fatal */ }
  }

  return String(result.value)
}

// ─────────────────────────────────────────────────────────────────────────────
/** Friendly reply (in the user's language) when no flow intent matches. */
export async function generateFallbackResponse(userMessage, contactName, orgName, flows, orgId = null) {
  const featureHints = (flows || [])
    .filter(f => !f.is_default && (f.trigger_keywords || []).length > 0)
    .slice(0, 5)
    .map(f => `• *${(f.trigger_keywords || [])[0]}* — ${f.name}`)
    .join('\n')

  const org    = orgName   || 'the organisation'
  const person = contactName ? contactName.split(' ')[0] : 'there'
  const safeFallback = `Hi ${person}! 😊 I didn't quite catch that. You can type one of these to get started:\n${featureHints || 'No flows active yet.'}`

  // ── Tier 1: deterministic template (used for tier1_only policy or no Gemini) ──
  let templateResponse = null
  try {
    const tw = await import('./ai/local/templateWriter.js')
    templateResponse = tw.buildFallbackResponse(contactName, orgName, flows)
  } catch { /* module unavailable */ }

  // Default WhatsApp policy is tier1_only: never call Gemini, even if the
  // template failed to build.
  try {
    const { FEATURE_POLICY_DEFAULTS } = await import('./ai/runAI.js')
    const policy = FEATURE_POLICY_DEFAULTS.whatsapp
    if (policy?.tier1_only) return templateResponse || safeFallback
  } catch { /* can't determine policy — proceed to Gemini */ }

  const sector = orgId ? await getOrgSector(orgId).catch(() => null) : null
  const overlay = sector ? sectorOverlay(sector, 'wa_nlu_fallback') : ''

  const response = await callGemini(
    `User message: "${userMessage}"\nUser first name: ${person}\nOrganisation: ${org}`,
    `You are a warm, empathetic AI assistant for ${org} on WhatsApp, supporting NGO field workers.
The user sent a message that didn't match a known command. Write a short, human reply (2-3 sentences max) that:
1. Acknowledges what the user said with genuine warmth — never repeat it robotically.
2. Briefly explains what you can help with.
3. If their intent is close to a feature, suggest it by keyword naturally.
Write in the EXACT SAME LANGUAGE as the user's message.
Tone: friendly, encouraging, human — never robotic or bureaucratic.
Do NOT use asterisks for formatting if the response is short.
${featureHints ? `Features available:\n${featureHints}` : ''}${overlay ? `\n\n${overlay}` : ''}`,
    220
  )

  return response?.trim() || templateResponse || safeFallback
}

// ─────────────────────────────────────────────────────────────────────────────
/** Extract { location, beneficiaries, activity, issues, confidence } from a free-text field update. */
export async function parseFieldUpdate(message) {
  const result = await callGemini(
    `Field worker message: "${message}"`,
    `You are an NLP parser for NGO field reports. Extract entities from the message.
Return JSON: {
  "location":     "<village/district or null>",
  "beneficiaries": <number or null>,
  "activity":     "<brief activity description or null>",
  "issues":       "<any challenge mentioned or null>",
  "confidence":   0.0-1.0
}
Only populate a field if clearly mentioned. Use null otherwise.`,
    128, true
  )
  return result || { location: null, beneficiaries: null, activity: null, issues: null, confidence: 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
const VAULT_CATEGORIES = ['legal', 'financial', 'progress', 'knowledge']

/** Suggest a Document Vault tab ({ category, confidence }) from filename and extracted text. */
export async function suggestVaultCategory(name, text) {
  const snippet = (text || '').slice(0, 4000)
  const result = await callGemini(
    `Document filename: "${name}"\n\nDocument content (may be truncated):\n"""${snippet || '(no extractable text — classify from filename only)'}"""`,
    `You are a document classifier for an NGO project's document vault. Categorize the document into exactly one of these four tabs:
- "legal": contracts, MOUs, registrations, compliance certificates, licenses, agreements, NOCs
- "financial": budgets, invoices, receipts, financial statements, audit reports, grant disbursements, expense records
- "progress": field reports, monitoring/evaluation reports, activity updates, milestone reports, beneficiary data
- "knowledge": training materials, guides, research, case studies, presentations, reference documents

Respond with JSON only: { "category": "legal"|"financial"|"progress"|"knowledge", "confidence": 0.0-1.0 }
Set confidence below 0.5 if the document doesn't clearly fit any category.`,
    64, true
  )
  if (!result || !VAULT_CATEGORIES.includes(result.category)) return { category: null, confidence: 0 }
  return { category: result.category, confidence: typeof result.confidence === 'number' ? result.confidence : 0.5 }
}

const DEFAULT_REPORT_CATEGORIES = [
  'Financial Report', 'Progress Report', 'Compliance Report', 'Audit Report',
  'M&E Report', 'Training Report', 'Assessment Report', 'Other',
]

/**
 * Suggest a report category (from the org's list) and free-form tags for a Document
 * Vault upload → { reportCategory, tags, confidence }.
 */
export async function suggestReportMetadata(name, text, categories) {
  const categoryList = Array.isArray(categories) && categories.length ? categories : DEFAULT_REPORT_CATEGORIES
  const snippet = (text || '').slice(0, 4000)
  const result = await callGemini(
    `Document filename: "${name}"\n\nDocument content (may be truncated):\n"""${snippet || '(no extractable text — infer from filename only)'}"""`,
    `You are a document classifier and tagger for an NGO project's document vault.

1. Pick exactly one report category from this list (case-sensitive, verbatim): ${categoryList.map(c => `"${c}"`).join(', ')}
2. Generate 3-6 short, lowercase, descriptive tags (single words or short phrases, no hashtags) capturing the document's topic, project area, time period, or document type — useful for search/filtering later.

Respond with JSON only: { "reportCategory": "<one of the list above>", "tags": ["tag1", "tag2", ...], "confidence": 0.0-1.0 }
Set confidence below 0.5 if the document doesn't clearly fit any category.`,
    128, true
  )
  if (!result || !categoryList.includes(result.reportCategory)) return { reportCategory: null, tags: [], confidence: 0 }
  const tags = Array.isArray(result.tags) ? result.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase()).slice(0, 6) : []
  return { reportCategory: result.reportCategory, tags, confidence: typeof result.confidence === 'number' ? result.confidence : 0.5 }
}

// Larger files are classified from the filename only.
const MAX_INLINE_MEDIA_BYTES = 15 * 1024 * 1024

/**
 * Suggest a Media Library category → { category, confidence }. Image/video/audio/pdf
 * under MAX_INLINE_MEDIA_BYTES are sent inline for content classification; others
 * fall back to the filename.
 */
export async function suggestMediaCategory(name, mimeType, buffer, categories) {
  const categoryList = Array.isArray(categories) && categories.length ? categories : DEFAULT_REPORT_CATEGORIES
  const key = apiKey()
  if (!key) return { category: null, confidence: 0 }

  const mt = (mimeType || '').split(';')[0].trim()
  const inlineable = /^(image|video|audio)\//.test(mt) || mt === 'application/pdf'
  const canInline = inlineable && !!buffer && buffer.length > 0 && buffer.length <= MAX_INLINE_MEDIA_BYTES

  const promptText = `Filename: "${name}"` + (canInline ? '' : ' (file content not analyzed — classify from filename only)')
  const systemPrompt = `You are a media classifier for an NGO project's media library.
Pick exactly one category from this list (case-sensitive, verbatim): ${categoryList.map(c => `"${c}"`).join(', ')}
Respond with JSON only: { "category": "<one of the list above>", "confidence": 0.0-1.0 }
Set confidence below 0.5 if the media doesn't clearly fit any category.`

  const parts = canInline
    ? [{ inlineData: { mimeType: mt, data: buffer.toString('base64') } }, { text: promptText }]
    : [{ text: promptText }]

  try {
    const res = await fetch(GEMINI_FLASH_URL(key), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents:         [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 64, temperature: 0.05, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) {
      console.warn('[nlp] media category Gemini error:', data?.error?.message)
      return { category: null, confidence: 0 }
    }
    const textParts = data?.candidates?.[0]?.content?.parts || []
    const text = textParts.filter(p => !p.thought).map(p => p.text || '').join('')
    const result = text ? JSON.parse(text) : null
    if (!result || !categoryList.includes(result.category)) return { category: null, confidence: 0 }
    return { category: result.category, confidence: typeof result.confidence === 'number' ? result.confidence : 0.5 }
  } catch (e) {
    console.warn('[nlp] suggestMediaCategory failed:', e.message)
    return { category: null, confidence: 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Pre-analyse field reports with Flash before the Pro writing model runs; splitting
 * analysis from writing gives richer reports. Returns { top_stories, key_patterns,
 * standout_numbers, geographic_highlights, emotional_core }.
 */
export async function analyzeFieldData(reports, instruction = '', orgId = null) {
  if (!reports?.length) return {}

  // ── Cache check ────────────────────────────────────────────────────────────
  const cKey   = _analysisKey(orgId, reports, instruction)
  const cached = _analysisCache.get(cKey)
  if (cached && Date.now() - cached.ts < _ANALYSIS_TTL) return cached.result

  // Sample up to 60 reports to bound token count
  const sample = reports.slice(0, 60).map((r, i) => {
    const date = r.timestamp ? new Date(String(r.timestamp)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A'
    return `[${i + 1}] ${date} | ${r.location || ''}, ${r.state || ''} | ${r.project || 'N/A'} | ${r.beneficiaries ?? 0} beneficiaries\n"${String(r.description || '').slice(0, 220)}"`
  }).join('\n\n')

  const result = await callGemini(
    `Report task: "${instruction.slice(0, 120) || 'general field activity report'}"\nTotal records: ${reports.length}\n\nSample field entries:\n${sample}`,
    `You are a senior NGO data analyst. Mine these field records for narrative intelligence that will power a high-quality AI-generated report.

Return ONLY valid JSON matching this schema exactly:
{
  "top_stories": [
    { "headline": "one compelling sentence", "detail": "2-3 sentence human story grounded in the data", "location": "village/district", "impact": "specific measurable change" }
  ],
  "key_patterns": ["pattern 1", "pattern 2", "pattern 3"],
  "standout_numbers": [
    { "stat": "e.g. 1,240 women", "context": "why this number matters" }
  ],
  "geographic_highlights": "one sentence on geographic spread and reach",
  "emotional_core": "the single most powerful, human insight from the entire dataset — what makes this work meaningful"
}

Rules:
- top_stories: 2-3 entries, each grounded in ACTUAL data from the records
- key_patterns: 3 genuine trends or observations
- standout_numbers: 3 striking quantitative facts
- Never fabricate details — infer only from what is visible in the data`,
    600, true
  )

  const final = result || {}

  // ── Cache store ────────────────────────────────────────────────────────────
  _analysisCache.set(cKey, { result: final, ts: Date.now() })
  if (_analysisCache.size > _ANALYSIS_LIMIT) {
    _analysisCache.delete(_analysisCache.keys().next().value)   // evict oldest
  }

  return final
}
