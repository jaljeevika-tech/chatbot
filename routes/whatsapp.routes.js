// Optional Glific connector (Meta direct in wa-platform.routes.js is the default).
// Glific's data-collection flow POSTs the
// collected fields to /api/whatsapp/webhook, which appends a row to the org's
// reports sheet and returns a confirmation for the worker.

import { Router }              from 'express'
import { getOrg }              from '../lib/org.js'
import { getPool }             from '../db/pool.js'
import { verifyGlificSignature } from '../lib/glific.js'
import { readMetaSecret }      from '../lib/secretMeta.js'
import { getGoogleAccessToken, normPhone } from '../lib/sheets.js'
import { extractReportHeuristics } from '../lib/memoryExtractor.js'

const router = Router()

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Append one row to a Google Sheet via the Sheets API */
async function appendSheetRow(token, sheetId, values) {
  const range = encodeURIComponent("'Daily Reports'!A1:K1")
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Sheets append failed ${res.status}: ${body}`)
  }
  return await res.json()
}

/** Format ISO date string as DD/MM/YYYY HH:mm for Sheets, in IST */
function formatTimestamp(dt = new Date()) {
  // Server runs UTC — shift by +5:30 and read the UTC fields as IST.
  const d = new Date((dt instanceof Date ? dt : new Date(dt)).getTime() + 330 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** Extract a result value from Glific's @results structure */
function pick(results, ...keys) {
  for (const k of keys) {
    const val = results?.[k]?.input ?? results?.[k]?.category ?? results?.[k]
    if (val && String(val).trim()) return String(val).trim()
  }
  return ''
}

// ── GET /api/whatsapp/health ─────────────────────────────────────────────────
router.get('/whatsapp/health', (_req, res) => {
  res.json({ status: 'ok', service: 'fieldflow-whatsapp-webhook', timestamp: new Date().toISOString() })
})

// ── POST /api/whatsapp/webhook ───────────────────────────────────────────────
//
// Expected Glific webhook payload:
// {
//   "contact": { "phone": "919876543210", "name": "Raj Kumar", "fields": { "org_code": "abc" } },
//   "results": {
//     "project":      { "input": "Kosi Sahajeevan" },
//     "state":        { "input": "Bihar" },
//     "location":     { "input": "Madhubani" },
//     "area":         { "input": "Community Mobilization" },
//     "beneficiaries":{ "input": "45" },
//     "description":  { "input": "Held community water meeting" },
//     "photo_url":    { "input": "https://drive.google.com/file/d/..." }
//   },
//   "org_code": "abc"      ← used to find org if contact.fields.org_code missing
// }
//
// Response (used by Glific flow to confirm to the worker):
// { "success": true, "message": "Saved ✓", "date": "10/05/2026" }
// or
// { "success": false, "error": "Org not found" }

router.post('/whatsapp/webhook', async (req, res) => {
  const rawBody   = req.rawBody || JSON.stringify(req.body) // raw body for signature check
  const signature = req.headers['x-glific-signature'] || req.headers['x-signature'] || ''
  const payload   = req.body

  console.log('[whatsapp] webhook received', { phone: payload?.contact?.phone })

  // ── 1. Identify org ────────────────────────────────────────────────────────
  // Org code comes from contact field or top-level payload field
  const orgCode = payload?.contact?.fields?.org_code
    || payload?.org_code
    || payload?.contact?.fields?.['org-code']
    || ''

  if (!orgCode) {
    console.warn('[whatsapp] missing org_code in payload')
    return res.status(400).json({ success: false, error: 'org_code required in payload or contact.fields.org_code' })
  }

  const pool = getPool()
  const orgRow = await pool.query(
    `SELECT id, slug, name, metadata FROM organizations WHERE slug = $1 OR metadata->>'glific_org_code' = $1`,
    [orgCode]
  ).then(r => r.rows[0]).catch(() => null)

  if (!orgRow) {
    console.warn('[whatsapp] org not found for code:', orgCode)
    return res.status(404).json({ success: false, error: 'Organisation not found' })
  }

  // ── 2. Verify Glific signature — fail closed ──────────────────────────────
  // orgCode comes from a public request body and picks which org gets written to;
  // slugs aren't secret, so unsigned requests are refused in production (as in
  // wa-platform.routes.js). Secret is stored encrypted (lib/secretMeta.js).
  const glificSecret = readMetaSecret(orgRow.metadata, 'glific_webhook_secret')
  if (glificSecret) {
    // Secret is configured — signature MUST be present and valid
    if (!signature) {
      console.warn('[whatsapp] missing signature for org:', orgRow.slug)
      return res.status(401).json({ success: false, error: 'Webhook signature required' })
    }
    const valid = verifyGlificSignature(rawBody, signature, glificSecret)
    if (!valid) {
      console.warn('[whatsapp] invalid signature for org:', orgRow.slug)
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' })
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[whatsapp] webhook signature NOT verifiable (no glific_webhook_secret configured) — REFUSING in prod. Set organizations.metadata.glific_webhook_secret for org:', orgRow.slug)
    return res.status(401).json({ success: false, error: 'Webhook not configured for signature verification' })
  } else {
    console.warn('[whatsapp] signature check skipped (no secret in dev mode) for org:', orgRow.slug)
  }

  // ── 3. Extract collected fields ────────────────────────────────────────────
  const contact = payload.contact || {}
  const results = payload.results || {}

  const phone        = normPhone(contact.phone || '')
  const workerName   = pick(results, 'worker_name', 'name') || contact.name || contact.fields?.name || 'Unknown'
  const project      = pick(results, 'project')
  const state        = pick(results, 'state')
  const location     = pick(results, 'location', 'village', 'block')
  const area         = pick(results, 'area', 'area_of_intervention', 'activity_type')
  const beneficiaries = pick(results, 'beneficiaries', 'beneficiary_count', 'count')
  const description  = pick(results, 'description', 'activity', 'notes', 'summary')
  const photoUrl     = pick(results, 'photo_url', 'photo', 'image_url', 'attachment')

  if (!project && !description) {
    return res.status(400).json({ success: false, error: 'At least project or description must be present' })
  }

  // ── 4. Append to Google Sheet ──────────────────────────────────────────────
  const sheetId = orgRow.metadata?.data_sources?.reports_sheet_id
  if (!sheetId) {
    console.error('[whatsapp] no reports_sheet_id in org metadata for:', orgRow.slug)
    return res.status(500).json({ success: false, error: 'Sheet not configured for this org' })
  }

  let sheetsToken
  try {
    sheetsToken = await getGoogleAccessToken()
    if (!sheetsToken) throw new Error('Could not obtain Google token')
  } catch (e) {
    console.error('[whatsapp] Google auth error:', e.message)
    return res.status(500).json({ success: false, error: 'Failed to authenticate with Google Sheets' })
  }

  const timestamp = formatTimestamp(new Date())

  // Row order must match the sheet column order:
  // Timestamp | Name | Phone | State | Location | Project | Area of Intervention | Description | Beneficiaries | Attachment (Drive URL)
  const row = [
    timestamp,
    workerName,
    phone,
    state,
    location,
    project,
    area,
    description,
    beneficiaries,
    photoUrl,
    'whatsapp', // source column
  ]

  try {
    await appendSheetRow(sheetsToken, sheetId, row)
    console.log('[whatsapp] row appended for', phone, 'org:', orgRow.slug)
  } catch (e) {
    console.error('[whatsapp] sheet append error:', e.message)
    return res.status(500).json({ success: false, error: 'Failed to save to Google Sheet' })
  }

  // ── 5. Log to whatsapp_submissions table (audit trail) ────────────────────
  try {
    await pool.query(
      `INSERT INTO whatsapp_submissions
         (org_id, phone, worker_name, project, state, location, area, beneficiaries, description, photo_url, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgRow.id, phone, workerName, project, state, location, area, beneficiaries || null, description, photoUrl || null, JSON.stringify(payload)]
    )
  } catch (e) {
    console.warn('[whatsapp] audit log failed (non-fatal):', e.message)
  }

  // ── 6. Extract AI memories (fire-and-forget) ──
  // apiKey lets the periodic re-seed (every 25 reports) run.
  const _apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  extractReportHeuristics(orgRow.id, { workerName, project, state, location, area, description, beneficiaries }, _apiKey)

  // ── 7. Respond to Glific ───────────────────────────────────────────────────
  // Glific can echo these in later flow messages (@results.webhook.date etc.)
  const [day, month, year] = timestamp.split(' ')[0].split('/')
  res.json({
    success:     true,
    message:     `Report saved ✓`,
    project:     project || 'N/A',
    date:        `${day}/${month}/${year}`,
    worker_name: workerName,
    org_name:    orgRow.name,
  })
})

// ── POST /api/whatsapp/inbound ───────────────────────────────────────────────
// Raw inbound message hook — placeholder, just acknowledges
router.post('/whatsapp/inbound', (req, res) => {
  const { contact, message } = req.body || {}
  console.log('[whatsapp] inbound from', contact?.phone, ':', message?.body?.slice(0, 80))
  res.json({ status: 'received' })
})

export default router
