// Story Finder
//
// POST /api/story-finder
//   Body: { reports[], userName, filters, mode: 'top5' | 'custom', customRequirement?, count? }
//   count — only used in mode='custom'; how many distinct stories to generate (default 1, max 10)
//   Returns: { stories: [{ id, title, narrative, hook_quote, source_report_ids,
//             primary_photo_url, location, project, period: {from, to},
//             quality_flag? }], grounding_score, cost_estimate_inr? }
//
// Pipeline: deterministic pre-rank (no LLM) → top 30 → one Gemini JSON call →
// per-story source resolution + hallucination guard → drop failures.
// Reports should arrive slimmed (slimReportsForApi); capped at 2000 regardless.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { getOrgPrompt } from '../lib/promptStore.js'
import { trackUsage } from '../lib/usageTracker.js'
import { checkHallucination } from '../lib/dataCorrectness/hallucination.js'
import { redact } from '../lib/contentModeration.js'

const router = Router()

const MAX_REPORTS = 2000
const PRE_RANK_TOP = 30
const STORY_FINDER_TIMEOUT_MS = 60_000

const GEMINI_FLASH_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

// ── Default system prompt (org-overridable via story_finder_system) ─────────
const DEFAULT_STORY_FINDER_PROMPT = `You are a nonprofit storytelling expert mining field-entry data for human-impact stories.

Output ONLY a single JSON object matching:
{
  "stories": [
    {
      "title": "<6-12 word headline>",
      "narrative": "<4-6 paragraph plain-text story, no markdown>",
      "hook_quote": "<one short quote, attributed by role like 'A field officer in Khagaria said …' — DO NOT use a beneficiary's name unless explicit consent is marked>",
      "source_report_ids": ["r1", "r3"],
      "location": "<village or district>",
      "project": "<project or null>",
      "period_from": "YYYY-MM-DD",
      "period_to": "YYYY-MM-DD"
    }
  ]
}

For mode='top5': return EXACTLY 5 stories ranked by storytelling impact.
For mode='custom': return EXACTLY the requested number of stories matching the user's requirement
(stated in the user prompt as "Return EXACTLY N distinct stories…"). If N > 1, each story must be
meaningfully distinct — different source reports, angles, locations, or workers where the data allows.
Never reuse the same source_report_ids across two stories in the same response unless the candidate
pool is too small to avoid it.

HARD RULES:
- Every source_report_ids entry must reference an ID present in the input ('r1', 'r2', etc.). Never invent IDs.
- Numbers, locations, and named workers must trace to the cited source rows. Use ⟨MISSING: …⟩ in the narrative if you'd otherwise need to invent.
- Beneficiary identity stays private — never write a beneficiary's name unless the source row contains it AND a consent flag.
- Hook quote must be PARAPHRASED from a real description; do not invent direct speech.
- Narrative arc: beginning (scene), middle (challenge), end (outcome). Use past tense.`

// ── Deterministic story-worthiness pre-rank ─────────────────────────────────
function _scoreStoryWorthiness(r) {
  let score = 0
  const desc = String(r.description || '')
  // Description richness (+1 per 50 chars, cap 5)
  score += Math.min(5, Math.floor(desc.length / 50))
  // Visual evidence
  if (r.attachmentUrl) score += 3
  // Concrete impact
  const benef = Number(r.beneficiaries)
  if (Number.isFinite(benef) && benef > 0) score += 2
  // Quote potential — first-person markers
  if (/\b(i |my |we |our )\b/i.test(desc)) score += 2
  if (/\b(मैं|मेरा|मेरी|हम|हमारा|हमारी)\b/.test(desc)) score += 2
  // Narrative arc — change verbs
  if (/\b(transformed|improved|learned|completed|first time|started|trained|built|launched|achieved)\b/i.test(desc)) score += 1
  if (/\b(पहली बार|शुरू|सीख|पूरा|प्रशिक्षण)\b/.test(desc)) score += 1
  return score
}

function _preRank(reports, topN = PRE_RANK_TOP) {
  return [...reports]
    .map(r => ({ r, score: _scoreStoryWorthiness(r) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(x => x.r)
}

// ── Build a compact prompt context ──────────────────────────────────────────
function _buildPromptContext(candidates, mode, customRequirement, userName, filters, count) {
  const filtersBlock = []
  if (filters?.project?.length)    filtersBlock.push(`Projects: ${filters.project.join(', ')}`)
  if (filters?.state?.length)      filtersBlock.push(`States: ${filters.state.join(', ')}`)
  if (filters?.area?.length)       filtersBlock.push(`Areas: ${filters.area.join(', ')}`)
  if (filters?.workerName?.length) filtersBlock.push(`Workers: ${filters.workerName.join(', ')}`)

  const recordBlock = candidates.map((r, i) => {
    const date = r.timestamp ? String(r.timestamp).slice(0, 10) : 'unknown'
    return [
      `ID: r${i + 1}`,
      `Date: ${date}`,
      `Worker: ${r.name || 'unknown'}`,
      `Location: ${r.location || ''}${r.state ? ', ' + r.state : ''}`,
      `Project: ${r.project || 'N/A'}`,
      `Area: ${r.areaOfIntervention || 'N/A'}`,
      `Beneficiaries: ${r.beneficiaries ?? '0'}`,
      `Has Photo: ${r.attachmentUrl ? 'yes' : 'no'}`,
      // DPDP: redact Aadhaar/PAN/mobile/bank/email/card numbers before Gemini
      // (lib/contentModeration.js, as extractQuotes does).
      `Description: ${redact(String(r.description || '').slice(0, 600))}`,
    ].join('\n')
  }).join('\n\n---\n\n')

  const intro = mode === 'custom'
    ? `User (${userName}) wants ${count} ${count === 1 ? 'story' : 'distinct stories'} matching this requirement:\n\n"${customRequirement}"\n\nReturn EXACTLY ${count} distinct ${count === 1 ? 'story' : 'stories'} matching this brief.${count > 1 ? ' Each story should draw on a different set of source reports / angle where the data supports it — avoid near-duplicate stories.' : ''}`
    : `Surface EXACTLY 5 stories with the strongest storytelling potential from the records below.`

  return `${intro}
${filtersBlock.length ? `\nActive filters: ${filtersBlock.join(' · ')}` : ''}

=== CANDIDATE RECORDS (${candidates.length} pre-ranked by story-worthiness) ===
${recordBlock}`
}

// ── Gemini JSON call ────────────────────────────────────────────────────────
async function _callGemini(systemPrompt, userPrompt, apiKey, signal, maxOutputTokens = 8192) {
  const res = await fetch(GEMINI_FLASH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0.55,
        maxOutputTokens,
        responseMimeType: 'application/json',
      },
    }),
    signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`)
  }
  const data  = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts.map(p => p.text || '').join('')
}

function _safeJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

function _shortId() {
  return Math.random().toString(36).slice(2, 10)
}

// ── Per-story validator ────────────────────────────────────────────────────
async function _validateStory(story, candidates, orgId) {
  // Resolve source IDs ('r1', 'r3', …) against candidate index
  const sourceRows = []
  const sourceIdsOut = []
  for (const ref of (story.source_report_ids || [])) {
    const m = String(ref).match(/^r?(\d+)$/i)
    if (!m) continue
    const idx = parseInt(m[1], 10) - 1
    if (idx < 0 || idx >= candidates.length) continue
    sourceRows.push(candidates[idx])
    sourceIdsOut.push(candidates[idx].id || ref)
  }
  if (sourceRows.length === 0) {
    // No valid source citations — drop the story
    console.warn('[story-finder] dropped — no valid source_report_ids:', JSON.stringify(story.source_report_ids), 'title:', story.title)
    return null
  }

  // Hallucination guard against ONLY the cited rows
  let groundingScore = 1.0
  let qualityFlag = null
  try {
    const verdict = await checkHallucination(story.narrative, sourceRows, {
      orgId,
      kind: 'story_finder',
    })
    groundingScore = verdict.grounding_score ?? 1.0
    if (verdict.severity === 'high') {
      console.warn('[story-finder] dropped — severity high:', story.title, 'reasons:', JSON.stringify(verdict.reasons))
      return null
    }
    if (verdict.severity === 'medium' || verdict.severity === 'low') {
      qualityFlag = 'low_confidence'
    }
  } catch (e) {
    // Guard unavailable: don't block, but flag for manual review rather than
    // treating it as fully grounded.
    console.warn('[story-finder] hallucination check threw:', e.message, 'title:', story.title)
    groundingScore = 0
    qualityFlag = 'low_confidence'
  }

  // Pick a primary photo from the first cited source row that has one
  const primary = sourceRows.find(r => r.attachmentUrl)
  return {
    id: _shortId(),
    title: String(story.title || '').slice(0, 200),
    narrative: String(story.narrative || ''),
    hook_quote: String(story.hook_quote || '').slice(0, 400),
    source_report_ids: sourceIdsOut,
    primary_photo_url: primary?.attachmentUrl || null,
    location: String(story.location || sourceRows[0].location || ''),
    project: String(story.project || sourceRows[0].project || ''),
    period: {
      from: String(story.period_from || sourceRows[0].timestamp || '').slice(0, 10),
      to:   String(story.period_to   || sourceRows[sourceRows.length - 1].timestamp || '').slice(0, 10),
    },
    quality_flag: qualityFlag,
    grounding_score: groundingScore,
  }
}

// ── POST /api/story-finder ──────────────────────────────────────────────────
router.post('/story-finder', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' })
  }

  const { reports: _reports, userName, filters = {}, mode: _mode, customRequirement, count: _count } = req.body || {}
  const reports = Array.isArray(_reports) ? _reports.slice(0, MAX_REPORTS) : []
  const mode = _mode === 'custom' ? 'custom' : 'top5'
  // Custom mode can request more than the default 1 story; clamp to a sane range.
  const count = mode === 'custom'
    ? Math.min(10, Math.max(1, parseInt(_count, 10) || 1))
    : 5

  if (!reports.length) {
    return res.status(400).json({ error: 'reports[] required' })
  }
  if (mode === 'custom' && (!customRequirement || customRequirement.trim().length < 3)) {
    return res.status(400).json({ error: 'customRequirement required for mode=custom (min 3 chars)' })
  }

  const orgId = req.user?.orgId
  // Widen the candidate pool for more stories to avoid near-duplicates.
  const preRankTop = mode === 'custom' ? Math.min(MAX_REPORTS, Math.max(PRE_RANK_TOP, count * 8)) : PRE_RANK_TOP
  const candidates = _preRank(reports, preRankTop)
  if (candidates.length < 3) {
    return res.json({
      stories: [],
      grounding_score: 0,
      note: 'Not enough story-worthy records — try expanding the date range or removing filters.',
    })
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), STORY_FINDER_TIMEOUT_MS)

  try {
    const systemPrompt = await getOrgPrompt(orgId, 'story_finder_system', DEFAULT_STORY_FINDER_PROMPT)
    const userPrompt   = _buildPromptContext(candidates, mode, customRequirement, userName, filters, count)

    // ~600-1200 output tokens per story; scale the budget with count.
    const maxOutputTokens = mode === 'custom' ? Math.min(32768, 2048 + count * 1800) : 8192

    // Track approx cost (input chars / 4 ≈ tokens)
    trackUsage(orgId, {
      service: 'story_finder',
      model: 'flash',
      inputLength: userPrompt.length + systemPrompt.length,
      maxOutputTokens,
    })

    const rawJson = await _callGemini(systemPrompt, userPrompt, apiKey, controller.signal, maxOutputTokens)
    const parsed = _safeJson(rawJson)
    if (!parsed || !Array.isArray(parsed.stories)) {
      console.warn('[story-finder] LLM returned unparseable output:', String(rawJson).slice(0, 300))
      return res.status(502).json({ error: 'AI returned an unparseable response. Try again.' })
    }

    const validated = []
    for (const s of parsed.stories) {
      const v = await _validateStory(s, candidates, orgId)
      if (v) validated.push(v)
    }

    if (validated.length === 0) {
      return res.json({
        stories: [],
        grounding_score: 0,
        note: 'All AI-generated stories failed grounding validation. Try again or expand the data set.',
      })
    }

    const groundingScore = validated.reduce((s, v) => s + (v.grounding_score || 0), 0) / validated.length
    const droppedCount   = parsed.stories.length - validated.length

    res.json({
      stories: validated,
      grounding_score: Math.round(groundingScore * 100) / 100,
      dropped: droppedCount > 0 ? droppedCount : undefined,
    })
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ error: 'AI request timed out — try again with fewer records.' })
    }
    console.error('[story-finder] error:', e)
    res.status(500).json({ error: e.message || 'Internal error' })
  } finally {
    clearTimeout(timeoutId)
  }
})

export default router
