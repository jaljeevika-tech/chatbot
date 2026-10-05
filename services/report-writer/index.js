// services/report-writer/index.js — FieldFlow Report Writer Microservice
// Extracted from monolith via Strangler Fig Pattern (Phase 2).
// Bounded Context: Report Writer — owns contributor voice profiles, glossary,
// drafts, feedback, and AI-assisted report generation.
//
// Auth: requests come from monolith only (x-forwarded-by header).
//       org isolation via RLS (SET LOCAL app.current_org_id).
//
// Deploy: gcloud run deploy fieldflow-report-writer --source . --region asia-south1

import express from 'express'
import pg from 'pg'
import { randomUUID, createSign } from 'crypto'

const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 8082

app.use(express.json({ limit: '50mb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'report-writer', version: '1.0.0' }))

// ── DB Pool (rw_service role — restricted to rw_* tables only) ───────────────
// Use Unix socket on both App Engine and Cloud Run (K_SERVICE is set on Cloud Run)
const useCloudSQLSocket = !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
let _pool = null
function getPool() {
  if (_pool) return _pool
  _pool = new Pool(useCloudSQLSocket
    ? {
        host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.RW_DB_USER  || 'rw_service',
        password: process.env.RW_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.RW_DB_USER  || 'fieldflow_app',
        password: process.env.DB_PASSWORD || '',
        ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[rw-db] Pool error:', err.message))
  return _pool
}

/** Execute a query with org-level RLS set */
async function orgQuery(orgId, text, values = []) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    // Parameterized set_config instead of string-interpolating orgId (sourced from
    // the x-org-id request header) into a raw SET LOCAL statement — this is the
    // RLS trust boundary for every tenant-scoped query in this service.
    // BEGIN/COMMIT is required: set_config(..., true) is transaction-local and
    // node-postgres autocommits each statement, so without it the setting was
    // gone before the real query ran (RLS saw '' and matched nothing).
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(orgId)])
    const result = await client.query(text, values)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Gemini helpers ────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-2.5-pro'
// API key goes in the x-goog-api-key header, not the URL query string —
// query-string keys end up in proxy/access logs and Referer headers.
const GEMINI_URL   = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`

function setupSSE(res) {
  res.statusCode = 200
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
}
function sendSSE(res, payload) { res.write(`data: ${JSON.stringify(payload)}\n\n`) }

async function pipeGeminiStream(geminiRes, res, sendFn) {
  const reader = geminiRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
        try {
          const chunk = JSON.parse(raw)
          // gemini-2.5-pro emits thinking/reasoning parts marked thought:true —
          // skip those or raw chain-of-thought leaks into user-visible output
          const parts = chunk?.candidates?.[0]?.content?.parts || []
          const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('')
          if (text) sendFn({ text })
        } catch { /* skip */ }
      }
    }
  } catch (e) { sendFn({ error: e.message }) }
  finally { res.write('data: [DONE]\n\n'); res.end() }
}

async function callGemini(apiKey, prompt, systemPrompt, res, maxTokens = 4096, temperature = 0.7, mimeType = null) {
  const send = (p) => sendSSE(res, p)
  const cfg = { maxOutputTokens: maxTokens, temperature }
  if (mimeType) cfg.responseMimeType = mimeType
  const geminiRes = await fetch(GEMINI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: cfg,
    }),
  })
  if (!geminiRes.ok || !geminiRes.body) {
    const err = await geminiRes.text()
    send({ error: `Gemini error ${geminiRes.status}: ${err.slice(0, 300)}` })
    res.end(); return
  }
  await pipeGeminiStream(geminiRes, res, send)
}

// ── Google Sheets fallback (for orgs still using Sheets) ─────────────────────
async function getGoogleAccessToken() {
  const keyJson = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
  if (!keyJson) return null
  try {
    const sa = JSON.parse(keyJson)
    const now = Math.floor(Date.now() / 1000)
    const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const pld = Buffer.from(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
    })).toString('base64url')
    const signer = createSign('RSA-SHA256')
    signer.update(`${hdr}.${pld}`)
    const jwt = `${hdr}.${pld}.${signer.sign(sa.private_key, 'base64url')}`
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    })
    const td = await tr.json()
    return td.access_token || null
  } catch (e) { console.error('[rw] token error:', e); return null }
}

const RW_SHEET_ID = process.env.RW_SHEET_ID || ''

async function sheetRead(token, tab, range) {
  if (!RW_SHEET_ID) return []
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${encodeURIComponent(tab)}!${range}`, { headers: { Authorization: `Bearer ${token}` } })
  return (await r.json()).values || []
}
async function sheetAppend(token, tab, values) {
  if (!RW_SHEET_ID) return
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${encodeURIComponent(tab)}!A:Z:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) })
}
async function sheetUpdate(token, tab, rowIdx, values) {
  if (!RW_SHEET_ID) return
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${encodeURIComponent(tab)}!A${rowIdx}:Z${rowIdx}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) })
}
async function sheetFindRow(token, tab, colIdx, value) {
  const rows = await sheetRead(token, tab, 'A:Z')
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][colIdx] || '').trim() === String(value).trim()) return i + 1
  }
  return -1
}

// ── Storage strategy: try DB first, fall back to Sheets ──────────────────────
// When rw_* tables exist and org is DB-enabled, use DB (RLS isolated).
// Otherwise use Google Sheets (legacy mode).

async function useDB(orgId) {
  if (!orgId) return false
  try {
    await orgQuery(orgId, 'SELECT 1 FROM rw_profiles LIMIT 1')
    return true
  } catch { return false }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/rw/profile
app.get('/api/rw/profile', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const contributor = String(req.query.contributor || '').trim()
  const orgId = req.headers['x-org-id'] || ''
  if (!contributor) return res.json({ profile: null })
  try {
    if (await useDB(orgId)) {
      const { rows } = await orgQuery(orgId,
        'SELECT voice_profile FROM rw_profiles WHERE org_id = $1 AND contributor_id = $2',
        [orgId, contributor])
      return res.json({ profile: rows[0]?.voice_profile || null })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.json({ profile: null })
    const rowIdx = await sheetFindRow(token, 'rw_profiles', 0, contributor)
    if (rowIdx < 0) return res.json({ profile: null })
    const rows = await sheetRead(token, 'rw_profiles', `A${rowIdx}:D${rowIdx}`)
    const profile = rows[0]?.[2] ? JSON.parse(rows[0][2]) : null
    res.json({ profile })
  } catch (e) { res.json({ profile: null }) }
})

// POST /api/rw/profile/save
app.post('/api/rw/profile/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { profile } = req.body || {}
  const orgId = req.headers['x-org-id'] || ''
  if (!profile?.id) return res.status(400).json({ error: 'profile.id required' })
  try {
    if (await useDB(orgId)) {
      await orgQuery(orgId,
        `INSERT INTO rw_profiles (org_id, contributor_id, contributor_name, voice_profile, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (org_id, contributor_id) DO UPDATE SET voice_profile=$4, updated_at=now()`,
        [orgId, profile.id, profile.contributorName || '', profile])
      return res.json({ success: true })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'Storage not configured' })
    const rowIdx = await sheetFindRow(token, 'rw_profiles', 0, profile.id)
    const row = [profile.id, profile.contributorName, JSON.stringify(profile), new Date().toISOString()]
    if (rowIdx < 0) await sheetAppend(token, 'rw_profiles', row)
    else await sheetUpdate(token, 'rw_profiles', rowIdx, row)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/rw/glossary
app.get('/api/rw/glossary', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const orgId = req.headers['x-org-id'] || ''
  try {
    if (await useDB(orgId)) {
      const { rows } = await orgQuery(orgId,
        'SELECT term, definition, status, domain, first_seen_date FROM rw_glossary WHERE org_id = $1',
        [orgId])
      return res.json({ terms: rows.map(r => ({ term: r.term, definition: r.definition, status: r.status, domain: r.domain, firstSeenDate: r.first_seen_date })) })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.json({ terms: [] })
    const rows = await sheetRead(token, 'rw_glossary', 'A:E')
    const terms = rows.slice(1).filter(r => r[0]).map(r => ({
      term: r[0] || '', definition: r[1] || '', status: r[2] || 'provisional',
      domain: r[3] || '', firstSeenDate: r[4] || '',
    }))
    res.json({ terms })
  } catch (e) { res.json({ terms: [] }) }
})

// POST /api/rw/glossary/save
app.post('/api/rw/glossary/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { term, action } = req.body || {}
  const orgId = req.headers['x-org-id'] || ''
  if (!term?.term) return res.status(400).json({ error: 'term.term required' })
  try {
    if (await useDB(orgId)) {
      if (action === 'promote') {
        await orgQuery(orgId, `UPDATE rw_glossary SET status='confirmed' WHERE org_id=$1 AND term=$2`, [orgId, term.term])
      } else {
        await orgQuery(orgId,
          `INSERT INTO rw_glossary (org_id, term, definition, status, domain, first_seen_date)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (org_id, term) DO NOTHING`,
          [orgId, term.term, term.definition || '', term.status || 'provisional', term.domain || '', term.firstSeenDate || new Date().toISOString().slice(0,10)])
      }
      return res.json({ success: true })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'Storage not configured' })
    if (action === 'promote') {
      const rowIdx = await sheetFindRow(token, 'rw_glossary', 0, term.term)
      if (rowIdx > 0) {
        const rows = await sheetRead(token, 'rw_glossary', `A${rowIdx}:E${rowIdx}`)
        const r = rows[0] || []
        await sheetUpdate(token, 'rw_glossary', rowIdx, [r[0], r[1], 'confirmed', r[3], r[4]])
      }
    } else {
      const exists = await sheetFindRow(token, 'rw_glossary', 0, term.term)
      if (exists < 0) await sheetAppend(token, 'rw_glossary', [term.term, term.definition, term.status || 'provisional', term.domain || '', term.firstSeenDate || new Date().toISOString().slice(0, 10)])
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/rw/feedback
app.get('/api/rw/feedback', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const contributor = String(req.query.contributor || '').trim()
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100)
  const orgId = req.headers['x-org-id'] || ''
  try {
    if (await useDB(orgId)) {
      const { rows } = await orgQuery(orgId,
        `SELECT id, entry_date, contributor_id, report_type, category, before_text, after_text, lesson
         FROM rw_feedback WHERE org_id=$1 ${contributor ? 'AND contributor_id=$2' : ''}
         ORDER BY entry_date DESC LIMIT $${contributor ? 3 : 2}`,
        contributor ? [orgId, contributor, limit] : [orgId, limit])
      return res.json({ entries: rows.map(r => ({ id: r.id, date: r.entry_date, contributor: r.contributor_id, reportType: r.report_type, category: r.category, beforeText: r.before_text, afterText: r.after_text, lesson: r.lesson })) })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.json({ entries: [] })
    const rows = await sheetRead(token, 'rw_feedback', 'A:G')
    const entries = rows.slice(1)
      .filter(r => !contributor || String(r[1] || '').trim() === contributor)
      .slice(-limit)
      .map((r, i) => ({ id: `fb_${i}`, date: r[0] || '', contributor: r[1] || '', reportType: r[2] || '', category: r[3] || '', beforeText: r[4] || '', afterText: r[5] || '', lesson: r[6] || '' }))
    res.json({ entries })
  } catch (e) { res.json({ entries: [] }) }
})

// POST /api/rw/draft/save
app.post('/api/rw/draft/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { draft } = req.body || {}
  const orgId = req.headers['x-org-id'] || ''
  if (!draft?.contributor) return res.status(400).json({ error: 'draft.contributor required' })
  try {
    if (await useDB(orgId)) {
      const id = draft.id || randomUUID()
      await orgQuery(orgId,
        `INSERT INTO rw_drafts (id, org_id, contributor_id, report_type, draft_md, status)
         VALUES ($1,$2,$3,$4,$5,'draft')`,
        [id, orgId, draft.contributor, draft.reportType || '', (draft.draftMd || '').slice(0, 100000)])
      return res.json({ success: true, id })
    }
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'Storage not configured' })
    const id = draft.id || `draft_${Date.now()}`
    await sheetAppend(token, 'rw_drafts', [id, draft.contributor, draft.reportType, new Date().toISOString(), (draft.draftMd || '').slice(0, 49000), '', 'draft'])
    res.json({ success: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/rw/refine/save
app.post('/api/rw/refine/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { draftId, finalMd, feedback, updatedProfile } = req.body || {}
  const orgId = req.headers['x-org-id'] || ''
  try {
    if (await useDB(orgId)) {
      for (const fb of (feedback || [])) {
        await orgQuery(orgId,
          `INSERT INTO rw_feedback (org_id, contributor_id, report_type, category, before_text, after_text, lesson, entry_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, fb.contributor, fb.reportType, fb.category, (fb.beforeText||'').slice(0,1000), (fb.afterText||'').slice(0,1000), fb.lesson||'', fb.date || new Date().toISOString().slice(0,10)])
      }
      if (draftId) {
        await orgQuery(orgId, `UPDATE rw_drafts SET final_md=$1, status='refined', updated_at=now() WHERE id=$2 AND org_id=$3`, [(finalMd||'').slice(0,100000), draftId, orgId])
      }
      if (updatedProfile?.id) {
        await orgQuery(orgId,
          `INSERT INTO rw_profiles (org_id, contributor_id, contributor_name, voice_profile, updated_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (org_id, contributor_id) DO UPDATE SET voice_profile=$4, updated_at=now()`,
          [orgId, updatedProfile.id, updatedProfile.contributorName || '', updatedProfile])
      }
      return res.json({ success: true })
    }
    // Sheets fallback
    const token = await getGoogleAccessToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'Storage not configured' })
    for (const fb of (feedback || [])) {
      await sheetAppend(token, 'rw_feedback', [fb.date||new Date().toISOString().slice(0,10), fb.contributor, fb.reportType, fb.category, (fb.beforeText||'').slice(0,1000), (fb.afterText||'').slice(0,1000), fb.lesson||''])
    }
    if (draftId) {
      const rowIdx = await sheetFindRow(token, 'rw_drafts', 0, draftId)
      if (rowIdx > 0) {
        const rows = await sheetRead(token, 'rw_drafts', `A${rowIdx}:G${rowIdx}`)
        const r = rows[0] || []
        await sheetUpdate(token, 'rw_drafts', rowIdx, [r[0],r[1],r[2],r[3],r[4],(finalMd||'').slice(0,49000),'refined'])
      }
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/rw/learn (SSE)
app.post('/api/rw/learn', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const { sources, contributor, existingProfile } = req.body || {}
    const srcBlock = (sources || []).slice(0, 3).map(s => `[SOURCE: ${s.name}]\n${String(s.content||'').slice(0,15000)}\n---`).join('\n\n')
    const prompt = `CONTRIBUTOR: ${contributor}\nEXISTING PROFILE: ${existingProfile ? JSON.stringify(existingProfile.voiceProfile, null, 2) : 'None'}\n\nPAST WRITING SAMPLES:\n${srcBlock}\n\nReturn JSON with: avgSentenceLength, dominantTense, formalityLevel, preferredConnectors[], avoidedWords[], blindSpots[], anchorSentences[], recurringPitfalls[], lastLearnDate. Output ONLY the JSON.`
    await callGemini(apiKey, prompt, 'You are a writing analyst. Output ONLY a valid JSON object.', res, 8192, 0.3, 'application/json')
  } catch (e) { send({ error: e.message }); res.end() }
})

// POST /api/rw/draft (SSE)
app.post('/api/rw/draft', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const { sources, contributor, reportType, profile, glossary, recentFeedback } = req.body || {}
    const templateMap = {
      'field-visit-report': { label: 'Field Visit Report', sections: ['Purpose of Visit','Location & Date','Staff Present','Community / Beneficiaries Observed','Activities Conducted','Beneficiaries Reached','Key Observations','Challenges & Risks','Photographs / Attachments','Follow-up Actions'], hint: 'Use past tense.' },
      'training-report':    { label: 'Training Report', sections: ['Training Title','Date & Venue','Facilitators','Participants','Training Objectives','Session Summary','Key Learning Outcomes','Participant Feedback','Materials Distributed','Follow-up & Gaps'], hint: 'Summarise what happened.' },
      'me-monthly-report':  { label: 'M&E Monthly Report', sections: ['Reporting Period','Project','Indicators Tracked','Beneficiary Data','Qualitative Progress','Deviations','Budget Utilisation','Risks','Lessons Learned','Plan for Next Month'], hint: 'Every number must trace to source.' },
    }
    const tpl = templateMap[reportType] || templateMap['field-visit-report']
    const vp = profile?.voiceProfile
    const confirmedTerms = (glossary || []).filter(g => g.status === 'confirmed').slice(0, 20)
    const srcBlock = (sources || []).map(s => `[SOURCE: ${s.name}]\n${String(s.content||'').slice(0,20000)}\n---`).join('\n\n')
    const profileBlock = vp ? `Sentence length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Formality: ${vp.formalityLevel}\nVoice anchors:\n${(vp.anchorSentences||[]).join('\n')}` : '(no profile)'
    const prompt = `REPORT TYPE: ${tpl.label}\nCONTRIBUTOR: ${contributor}\n\nVOICE PROFILE:\n${profileBlock}\n\nTEMPLATE:\n${tpl.sections.map((s,i)=>`${i+1}. ${s}`).join('\n')}\nNote: ${tpl.hint}\n\nGLOSSARY:\n${confirmedTerms.map(g=>`${g.term} — ${g.definition}`).join('\n')||'(none)'}\n\nRECENT CORRECTIONS:\n${(recentFeedback||[]).slice(-5).map(f=>`• ${f.lesson}`).join('\n')||'(none)'}\n\nSOURCE DATA:\n${srcBlock}`
    await callGemini(apiKey, prompt, 'You are a field report writer. Never fabricate details. Write ⟨MISSING: description⟩ for absent info. Follow template sections with ## headings.', res, 4096, 0.5)
  } catch (e) { send({ error: e.message }); res.end() }
})

// POST /api/rw/refine (SSE)
app.post('/api/rw/refine', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const { draftMd, finalMd, contributor, reportType } = req.body || {}
    const prompt = `CONTRIBUTOR: ${contributor}\nREPORT TYPE: ${reportType}\n\nDRAFT:\n${String(draftMd||'').slice(0,8000)}\n\nFINAL:\n${String(finalMd||'').slice(0,8000)}\n\nCompare versions. For each meaningful change: category (Voice/Structure/Vocabulary/Factual/Omission), beforeText, afterText, lesson ("In future: ...").\n\nReturn JSON array then PROFILE_UPDATES: {avoidedWords:[],blindSpots:[],recurringPitfalls:[]}`
    await callGemini(apiKey, prompt, 'Compare draft vs final. Output JSON array then PROFILE_UPDATES: followed by JSON object.', res, 2048, 0.4)
  } catch (e) { send({ error: e.message }); res.end() }
})

// POST /api/rw/reflect (SSE)
app.post('/api/rw/reflect', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const { contributor, profile, recentFeedback } = req.body || {}
    const feedbackBlock = (recentFeedback || []).slice(-30).map(f => `[${f.date}] [${f.category}] "${String(f.beforeText||'').slice(0,120)}" → "${String(f.afterText||'').slice(0,120)}" LESSON: ${f.lesson}`).join('\n')
    const prompt = `CONTRIBUTOR: ${contributor}\nPROFILE:\n${JSON.stringify(profile?.voiceProfile||{},null,2)}\n\nCORRECTION HISTORY:\n${feedbackBlock||'(none)'}\n\nReturn JSON: {recurringPitfalls:[], termPromotions:[], profileNote:""}`
    await callGemini(apiKey, prompt, 'Find recurring patterns. Output ONLY the specified JSON object.', res, 1024, 0.4)
  } catch (e) { send({ error: e.message }); res.end() }
})

// POST /api/rw/auto-polish (SSE)
app.post('/api/rw/auto-polish', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const { draftMd, sources, profile, reportType } = req.body || {}
    const vp = profile?.voiceProfile
    const srcBlock = (sources||[]).slice(0,3).map(s=>`[SOURCE: ${s.name}]\n${String(s.content||'').slice(0,15000)}\n---`).join('\n\n')
    const voiceBlock = vp ? `Length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Avoid: ${(vp.avoidedWords||[]).join(', ')||'none'}\nAnchors:\n${(vp.anchorSentences||[]).join('\n')}` : '(no profile)'
    const prompt = `Polish this NGO field report draft. RULES: No invented facts. Resolve ⟨MISSING⟩ from sources. Match contributor voice. Output ONLY polished markdown.\n\nVOICE:\n${voiceBlock}\n\nREPORT TYPE: ${reportType}\n\nDRAFT:\n${String(draftMd||'').slice(0,8000)}\n\nSOURCES:\n${srcBlock}`
    await callGemini(apiKey, prompt, 'You are an NGO report editor. Output ONLY the final polished markdown.', res, 4096, 0.4)
  } catch (e) { send({ error: e.message }); res.end() }
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[report-writer-service] running on port ${PORT}`))
