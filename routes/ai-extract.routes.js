// "Upload any format" for the Action Plan, Budget Utilisation and Annual Progress
// modals: text is extracted (lib/extractDocumentText.js) and Gemini restructures it
// into the same JSON each modal's template parser produces, so the rest of the flow
// is unchanged. Uploads never go through XLSX.read (docs/Technical.md §7.11).
//
//   POST /api/ai-extract/action-plan         — { name, file_type, data } -> ParsedPlan
//   POST /api/ai-extract/budget-utilisation  — { name, file_type, data } -> { rows, months }
//   POST /api/ai-extract/annual-progress     — { name, file_type, data } -> { rows, locationNames }

import { Router } from 'express'
import { requireEditor } from '../lib/routeGuards.js'
import { extractText } from '../lib/extractDocumentText.js'
import { runAI } from '../lib/ai/runAI.js'

const router = Router()

// Keeps the prompt comfortably within Flash's context even for a long report.
const MAX_TEXT_CHARS = 60_000
const UNREADABLE_MSG = 'Could not read any text from this file. Scanned/image-only PDFs and legacy .doc/.xls/.ppt files aren\'t supported — try a text-based PDF, Word, or Excel file, or use the template instead.'

/** Splits a `data:<mime>;base64,<payload>` URL into { mimeType, buffer }. Throws on malformed input. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]*);base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  if (!match) throw new Error('data must be a base64 data URL')
  return { mimeType: match[1] || null, buffer: Buffer.from(match[2], 'base64') }
}

/** Decodes the upload and extracts plain text, or writes an error response and returns null. */
async function extractOrRespondError(req, res) {
  const { name, file_type, data } = req.body || {}
  if (!name || !data) { res.status(400).json({ error: 'name and data (base64) are required' }); return null }
  let buffer, mimeType
  try {
    ({ buffer, mimeType } = decodeDataUrl(data))
  } catch (e) {
    res.status(400).json({ error: e.message }); return null
  }
  const text = await extractText(buffer, file_type || mimeType, name)
  if (!text) { res.status(422).json({ error: UNREADABLE_MSG }); return null }
  return text.slice(0, MAX_TEXT_CHARS)
}

/** Runs the extracted text through Gemini (via runAI) and parses its JSON response. */
async function extractStructured({ feature, name, text, systemPrompt, maxTokens, orgId, userId }) {
  const { text: out, fallbackReason } = await runAI(
    {
      feature, operation: 'ai_extract', orgId, userId,
      prompt: `Filename: "${name}"\n\nDocument content (may be truncated):\n"""${text}"""`,
      systemPrompt,
    },
    { jsonMode: true, maxTokens, temperature: 0.1, signal: AbortSignal.timeout(90_000) }
  )
  if (!out) throw new Error(fallbackReason ? `AI extraction unavailable right now (${fallbackReason}). Try again shortly, or use the template instead.` : 'AI extraction returned nothing — try the template instead.')
  // jsonMode returns parsed JSON from Gemini but a raw string from the self-hosted tier.
  return typeof out === 'string' ? JSON.parse(out) : out
}

const MONTH_KEYS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']

// ── Action Plan ──────────────────────────────────────────────────────────────
router.post('/ai-extract/action-plan', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const text = await extractOrRespondError(req, res)
    if (text == null) return
    const parsed = await extractStructured({
      feature: 'action_plan', name: req.body.name, text,
      orgId: req.user.orgId, userId: req.user.uid,
      maxTokens: 8192,
      systemPrompt: `You convert an NGO project's Action Plan document (any layout — a narrative plan, a differently-shaped spreadsheet, a Word doc, a scanned table transcribed to text, etc.) into strict JSON matching this exact shape:
{
  "name": string (the plan/project's name),
  "year": number|null (the plan's starting calendar year, e.g. 2025),
  "start_month": number (1-12, calendar month the plan's year starts — default 4 for April if not stated),
  "locations": string[] (every distinct village/site/location the plan covers),
  "activities": [{
    "sn": number (1-based row order),
    "activity": string (the activity's name/title),
    "category": one of "capacity"|"livelihood"|"enterprise"|"community"|"technology" (your best guess if not explicit),
    "unit": string (e.g. "households", "training sessions" — "" if unknown),
    "times": string (frequency, e.g. "Monthly" — "" if unknown),
    "responsibility": string (who's responsible — "" if unknown),
    "description": string ("" if unknown),
    "process": string ("" if unknown),
    "locations": [{
      "location": string (must be one of the top-level "locations" values),
      "monthly": { "Apr": {"target": number|null, "achieved": number|null}, "May": {...}, "Jun": {...}, "Jul": {...}, "Aug": {...}, "Sep": {...}, "Oct": {...}, "Nov": {...}, "Dec": {...}, "Jan": {...}, "Feb": {...}, "Mar": {...} } (all 12 keys must be present even when null)
    }]
  }]
}
Only fill in a target/achieved number you can actually find or reliably infer from the text — use null rather than guessing. Return ONLY the JSON object, no markdown fences, no commentary.`,
    })
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.activities) || !parsed.activities.length) {
      return res.status(422).json({ error: 'AI could not find a usable Action Plan structure in this file. Try the Excel template instead.' })
    }
    // Never trust the model's output verbatim
    const locations = Array.isArray(parsed.locations) ? parsed.locations.filter(l => typeof l === 'string' && l.trim()) : []
    const activities = parsed.activities.map((a, i) => ({
      sn: Number.isFinite(a?.sn) ? a.sn : i + 1,
      activity: String(a?.activity || '').trim(),
      category: ['capacity','livelihood','enterprise','community','technology'].includes(a?.category) ? a.category : 'capacity',
      unit: String(a?.unit || ''),
      times: String(a?.times || ''),
      responsibility: String(a?.responsibility || ''),
      description: String(a?.description || ''),
      process: String(a?.process || ''),
      locations: Array.isArray(a?.locations) ? a.locations.map(l => ({
        location: String(l?.location || '').trim(),
        monthly: Object.fromEntries(MONTH_KEYS.map(m => [m, {
          target: Number.isFinite(l?.monthly?.[m]?.target) ? l.monthly[m].target : null,
          achieved: Number.isFinite(l?.monthly?.[m]?.achieved) ? l.monthly[m].achieved : null,
        }])),
      })).filter(l => l.location) : [],
    })).filter(a => a.activity)
    if (!activities.length) return res.status(422).json({ error: 'AI could not find any activity rows in this file. Try the Excel template instead.' })
    res.json({
      name: String(parsed.name || req.body.name || 'Untitled Plan').trim(),
      year: Number.isFinite(parsed.year) ? parsed.year : null,
      start_month: Number.isFinite(parsed.start_month) && parsed.start_month >= 1 && parsed.start_month <= 12 ? parsed.start_month : 4,
      locations,
      activities,
    })
  } catch (e) {
    console.error('[ai-extract action-plan]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Budget Utilisation (Financial Tracker) ────────────────────────────────────
router.post('/ai-extract/budget-utilisation', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const text = await extractOrRespondError(req, res)
    if (text == null) return
    const parsed = await extractStructured({
      feature: 'budget_utilisation', name: req.body.name, text,
      orgId: req.user.orgId, userId: req.user.uid,
      maxTokens: 8192,
      systemPrompt: `You convert an NGO project's Financial Tracker / Budget Utilisation document (a budget/expense report in any layout — narrative, a transcribed table, a differently-shaped spreadsheet, etc.) into strict JSON matching this exact shape:
{
  "months": ["YYYY-MM-01", ...] (every distinct calendar month that has a real expense/plan figure anywhere in the document, sorted ascending, day always "01" — do not invent months with no data),
  "rows": [{
    "section": string (a top-level budget category, e.g. "PERSONNEL", "PROGRAM COST" — use "General" if the document has no sections),
    "subsection": string|null,
    "sr_no": string (the row's own serial/item number as text, or a 1-based index if none is given),
    "budget_head": string (the line item's name),
    "budget": number|null (this line item's own total sanctioned/allocated budget, if stated),
    "monthly": [{"period_month": "YYYY-MM-01", "expenses": number|null, "planned_expenses": number|null}, ... one entry for every month listed in the top-level "months" array, in the same order]
  }]
}
Use null for any figure you can't find — never invent numbers. Return ONLY the JSON object, no markdown fences, no commentary.`,
    })
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows) || !parsed.rows.length) {
      return res.status(422).json({ error: 'AI could not find a usable Budget Utilisation structure in this file. Try the Excel template instead.' })
    }
    const months = Array.isArray(parsed.months) ? [...new Set(parsed.months.filter(m => /^\d{4}-\d{2}-01$/.test(m)))].sort() : []
    if (!months.length) return res.status(422).json({ error: 'AI could not find any month-level figures in this file. Try the Excel template instead.' })
    const rows = parsed.rows.map((r, i) => ({
      section: String(r?.section || 'General').trim() || 'General',
      subsection: r?.subsection ? String(r.subsection).trim() : null,
      sr_no: r?.sr_no != null && String(r.sr_no).trim() ? String(r.sr_no).trim() : String(i + 1),
      budget_head: String(r?.budget_head || '').trim(),
      budget: Number.isFinite(r?.budget) ? r.budget : null,
      monthly: months.map(period_month => {
        const m = Array.isArray(r?.monthly) ? r.monthly.find(x => x?.period_month === period_month) : null
        return {
          period_month,
          expenses: Number.isFinite(m?.expenses) ? m.expenses : null,
          planned_expenses: Number.isFinite(m?.planned_expenses) ? m.planned_expenses : null,
        }
      }),
    })).filter(r => r.budget_head)
    if (!rows.length) return res.status(422).json({ error: 'AI could not find any line items in this file. Try the Excel template instead.' })
    res.json({ rows, months })
  } catch (e) {
    console.error('[ai-extract budget-utilisation]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Annual Progress Report ────────────────────────────────────────────────────
router.post('/ai-extract/annual-progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const text = await extractOrRespondError(req, res)
    if (text == null) return
    const parsed = await extractStructured({
      feature: 'annual_progress', name: req.body.name, text,
      orgId: req.user.orgId, userId: req.user.uid,
      maxTokens: 6144,
      systemPrompt: `You convert an NGO project's Annual Progress Report snapshot (a target-vs-achievement document in any layout) into strict JSON matching this exact shape:
{
  "locationNames": string[] (every distinct village/site/location broken out in the document),
  "rows": [{
    "sn": number (1-based row order),
    "activity": string (the activity/deliverable name),
    "target": number|null (the overall target for this activity, if stated),
    "achievement_total": number|null (the overall total achieved so far, if stated),
    "locations": { "<location name>": number|null, ... one key per value in "locationNames", the achieved figure for that location },
    "related_link": string|null (a URL/reference if one is given),
    "remark": string|null
  }]
}
Use null for any figure you can't find — never invent numbers. Return ONLY the JSON object, no markdown fences, no commentary.`,
    })
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows) || !parsed.rows.length) {
      return res.status(422).json({ error: 'AI could not find a usable Annual Progress structure in this file. Try the Excel template instead.' })
    }
    const locationNames = Array.isArray(parsed.locationNames) ? parsed.locationNames.filter(l => typeof l === 'string' && l.trim()) : []
    const rows = parsed.rows.map((r, i) => ({
      sn: Number.isFinite(r?.sn) ? r.sn : i + 1,
      activity: String(r?.activity || '').trim(),
      target: Number.isFinite(r?.target) ? r.target : null,
      achievement_total: Number.isFinite(r?.achievement_total) ? r.achievement_total : null,
      locations: Object.fromEntries(locationNames.map(l => [l, Number.isFinite(r?.locations?.[l]) ? r.locations[l] : null])),
      related_link: r?.related_link ? String(r.related_link).trim() : null,
      remark: r?.remark ? String(r.remark).trim() : null,
    })).filter(r => r.activity)
    if (!rows.length) return res.status(422).json({ error: 'AI could not find any activity rows in this file. Try the Excel template instead.' })
    res.json({ rows, locationNames })
  } catch (e) {
    console.error('[ai-extract annual-progress]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
