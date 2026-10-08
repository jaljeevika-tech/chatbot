// Report Writer AI routes (/api/rw/*): voice profiles, glossary, feedback and
// AI-assisted drafting. Storage is the RW_SHEET_ID Google Sheet. One copy, run in
// two places: in-process by the monolith (routes/report-writer.routes.js) and on
// Cloud Run (services/report-writer/index.js). Both set req.user.orgId first.
//
// GET  /api/rw/profile
// POST /api/rw/profile/save
// GET  /api/rw/glossary
// POST /api/rw/glossary/save
// GET  /api/rw/feedback
// POST /api/rw/draft/save
// POST /api/rw/refine/save
// POST /api/rw/learn         (SSE)
// POST /api/rw/draft         (SSE)
// POST /api/rw/refine        (SSE)
// POST /api/rw/reflect       (SSE)
// POST /api/rw/auto-polish   (SSE)

import { Router } from 'express'
import { getGoogleAccessToken } from '../../../lib/sheets.js'
import { setupSSE, sendSSE, callGeminiNotebook, makeAbortSignal } from '../../../lib/gemini.js'
import { trackUsage } from '../../../lib/usageTracker.js'
import { getOrgPrompt } from '../../../lib/promptStore.js'
import { buildOrgContext } from '../../../lib/aiContext.js'
import { getOrgSector } from '../../../lib/orgMetaCache.js'
import { sectorOverlay } from '../../../lib/prompts/sectorPrompts.js'

const router = Router()

const RW_SHEET_ID   = process.env.RW_SHEET_ID || ''
const RW_SHEET_NAME_PROFILES = 'rw_profiles'
const RW_SHEET_NAME_GLOSSARY = 'rw_glossary'
const RW_SHEET_NAME_FEEDBACK = 'rw_feedback'
const RW_SHEET_NAME_DRAFTS   = 'rw_drafts'

// ── Sheets helpers (Report Writer scope) ─────────────────────────────────────

async function rwGetToken()  { return getGoogleAccessToken() }

async function rwReadTab(token, tabName, range) {
  if (!RW_SHEET_ID) return []
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${encodeURIComponent(tabName)}!${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const d = await r.json()
  return d.values || []
}

async function rwAppendRow(token, tabName, values) {
  if (!RW_SHEET_ID) return
  const range = encodeURIComponent(`${tabName}!A:Z`)
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) }
  )
  if (!r.ok) console.error(`[rw] append failed ${r.status}:`, await r.text().catch(() => ''))
}

async function rwUpdateRow(token, tabName, rowIdx, values) {
  if (!RW_SHEET_ID) return
  const range = encodeURIComponent(`${tabName}!A${rowIdx}:Z${rowIdx}`)
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${RW_SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) }
  )
  if (!r.ok) console.error(`[rw] update failed ${r.status}:`, await r.text().catch(() => ''))
}

// The local fallback store is one Google Sheet shared by every tenant, so column A
// of every rw_* tab is org_id and every lookup must filter on it.
// `colIndex` is the field's index ignoring that column; it's read at colIndex + 1.
async function rwFindRow(token, tabName, colIndex, value, orgId) {
  const rows = await rwReadTab(token, tabName, 'A:Z')
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== String(orgId || '').trim()) continue
    if (String(rows[i][colIndex + 1] || '').trim() === String(value).trim()) return i + 1
  }
  return -1
}

// ── GET /api/rw/profile ───────────────────────────────────────────────────────
router.get('/rw/profile', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const contributor = String(req.query.contributor || '').trim()
  if (!contributor) return res.json({ profile: null })
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.json({ profile: null })
    const rowIdx = await rwFindRow(token, RW_SHEET_NAME_PROFILES, 0, contributor, req.user.orgId)
    if (rowIdx < 0) return res.json({ profile: null })
    const rows = await rwReadTab(token, RW_SHEET_NAME_PROFILES, `A${rowIdx}:E${rowIdx}`)
    const row = rows[0] || []
    const profile = row[3] ? JSON.parse(row[3]) : null
    res.json({ profile })
  } catch (e) { res.json({ profile: null }) }
})

// ── POST /api/rw/profile/save ─────────────────────────────────────────────────
router.post('/rw/profile/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { profile } = req.body || {}
  if (!profile?.id) return res.status(400).json({ error: 'profile.id required' })
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'RW_SHEET_ID or service account not configured' })
    const rowIdx = await rwFindRow(token, RW_SHEET_NAME_PROFILES, 0, profile.id, req.user.orgId)
    const row = [req.user.orgId, profile.id, profile.contributorName, JSON.stringify(profile), new Date().toISOString()]
    if (rowIdx < 0) await rwAppendRow(token, RW_SHEET_NAME_PROFILES, row)
    else await rwUpdateRow(token, RW_SHEET_NAME_PROFILES, rowIdx, row)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Error' }) }
})

// ── GET /api/rw/glossary ──────────────────────────────────────────────────────
router.get('/rw/glossary', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.json({ terms: [] })
    const rows = await rwReadTab(token, RW_SHEET_NAME_GLOSSARY, 'A:F')
    const terms = rows.slice(1)
      .filter(r => r[0] === req.user.orgId && r[1])
      .map(r => ({
        term: r[1] || '', definition: r[2] || '', status: r[3] || 'provisional',
        domain: r[4] || '', firstSeenDate: r[5] || '',
      }))
    res.json({ terms })
  } catch (e) { res.json({ terms: [] }) }
})

// ── POST /api/rw/glossary/save ────────────────────────────────────────────────
router.post('/rw/glossary/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { term, action } = req.body || {}
  if (!term?.term) return res.status(400).json({ error: 'term.term required' })
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'RW_SHEET_ID not configured' })
    if (action === 'promote') {
      const rowIdx = await rwFindRow(token, RW_SHEET_NAME_GLOSSARY, 0, term.term, req.user.orgId)
      if (rowIdx > 0) {
        const rows = await rwReadTab(token, RW_SHEET_NAME_GLOSSARY, `A${rowIdx}:F${rowIdx}`)
        const r = rows[0] || []
        await rwUpdateRow(token, RW_SHEET_NAME_GLOSSARY, rowIdx, [r[0], r[1], r[2], 'confirmed', r[4], r[5]])
      }
    } else {
      const exists = await rwFindRow(token, RW_SHEET_NAME_GLOSSARY, 0, term.term, req.user.orgId)
      if (exists < 0) await rwAppendRow(token, RW_SHEET_NAME_GLOSSARY, [req.user.orgId, term.term, term.definition, term.status || 'provisional', term.domain || '', term.firstSeenDate || new Date().toISOString().slice(0, 10)])
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Error' }) }
})

// ── GET /api/rw/feedback ──────────────────────────────────────────────────────
router.get('/rw/feedback', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const contributor = String(req.query.contributor || '').trim()
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100)
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.json({ entries: [] })
    const rows = await rwReadTab(token, RW_SHEET_NAME_FEEDBACK, 'A:H')
    const entries = rows.slice(1)
      .filter(r => r[0] === req.user.orgId)
      .filter(r => !contributor || String(r[2] || '').trim() === contributor)
      .slice(-limit)
      .map((r, i) => ({
        id: `fb_${i}`, date: r[1] || '', contributor: r[2] || '', reportType: r[3] || '',
        category: r[4] || '', beforeText: r[5] || '', afterText: r[6] || '', lesson: r[7] || '',
      }))
    res.json({ entries })
  } catch (e) { res.json({ entries: [] }) }
})

// ── POST /api/rw/draft/save ───────────────────────────────────────────────────
router.post('/rw/draft/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { draft } = req.body || {}
  if (!draft?.contributor) return res.status(400).json({ error: 'draft.contributor required' })
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'RW_SHEET_ID not configured' })
    const id = draft.id || `draft_${Date.now()}`
    await rwAppendRow(token, RW_SHEET_NAME_DRAFTS, [
      req.user.orgId, id, draft.contributor, draft.reportType, new Date().toISOString(),
      (draft.draftMd || '').slice(0, 49000), '', 'draft',
    ])
    res.json({ success: true, id })
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Error' }) }
})

// ── POST /api/rw/refine/save ──────────────────────────────────────────────────
router.post('/rw/refine/save', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const { draftId, finalMd, feedback, updatedProfile } = req.body || {}
  try {
    const token = await rwGetToken()
    if (!token || !RW_SHEET_ID) return res.status(503).json({ error: 'RW_SHEET_ID not configured' })
    for (const fb of (feedback || [])) {
      await rwAppendRow(token, RW_SHEET_NAME_FEEDBACK, [
        req.user.orgId,
        fb.date || new Date().toISOString().slice(0, 10),
        fb.contributor, fb.reportType, fb.category,
        (fb.beforeText || '').slice(0, 1000), (fb.afterText || '').slice(0, 1000), fb.lesson || '',
      ])
    }
    if (draftId) {
      const rowIdx = await rwFindRow(token, RW_SHEET_NAME_DRAFTS, 0, draftId, req.user.orgId)
      if (rowIdx > 0) {
        const rows = await rwReadTab(token, RW_SHEET_NAME_DRAFTS, `A${rowIdx}:H${rowIdx}`)
        const r = rows[0] || []
        await rwUpdateRow(token, RW_SHEET_NAME_DRAFTS, rowIdx, [r[0],r[1],r[2],r[3],r[4],r[5],(finalMd||'').slice(0,49000),'refined'])
      }
    }
    if (updatedProfile?.id) {
      const rowIdx = await rwFindRow(token, RW_SHEET_NAME_PROFILES, 0, updatedProfile.id, req.user.orgId)
      const row = [req.user.orgId, updatedProfile.id, updatedProfile.contributorName, JSON.stringify(updatedProfile), new Date().toISOString()]
      if (rowIdx < 0) await rwAppendRow(token, RW_SHEET_NAME_PROFILES, row)
      else await rwUpdateRow(token, RW_SHEET_NAME_PROFILES, rowIdx, row)
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Error' }) }
})

// ── POST /api/rw/learn (SSE) ──────────────────────────────────────────────────
router.post('/rw/learn', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { sources, contributor, existingProfile } = req.body || {}
    // 10 KB per source is enough to detect style
    const srcBlock = (sources || []).slice(0, 3).map(s =>
      `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 10_000)}\n---`
    ).join('\n\n')
    const prompt = `CONTRIBUTOR: ${contributor}
EXISTING PROFILE: ${existingProfile ? JSON.stringify(existingProfile.voiceProfile, null, 2) : 'None — this is the first analysis.'}

PAST WRITING SAMPLES:
${srcBlock}

Analyse the writing samples above and return a JSON object with exactly these fields:
{
  "avgSentenceLength": "short|medium|long",
  "dominantTense": "past|present|mixed",
  "formalityLevel": "high|medium|low",
  "preferredConnectors": ["top 5 connecting words/phrases actually found in the text"],
  "avoidedWords": ["NGO/donor jargon absent from the writing"],
  "blindSpots": ["report sections consistently absent or thin"],
  "anchorSentences": ["3 to 5 verbatim sentences that best represent this contributor's voice"],
  "recurringPitfalls": ${existingProfile ? JSON.stringify(existingProfile?.voiceProfile?.recurringPitfalls || []) : '[]'},
  "lastLearnDate": "${new Date().toISOString().slice(0,10)}"
}

Rules: anchorSentences must be verbatim from the text. Output ONLY the JSON object.`

    const [learnSysBase, learnSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'rw_learn_system',
        'You are a writing analyst for a rural development NGO. Build a voice profile from a contributor\'s past writing. Output ONLY a valid JSON object matching the specified schema. Never invent characteristics — every attribute must be grounded in the text.'),
      getOrgSector(req.user?.orgId),
    ])
    const learnSys = [learnSysBase, sectorOverlay(learnSector, 'rw_learn_system')].filter(Boolean).join('\n\n')
    // Voice profile JSON is ~400 tokens
    trackUsage(req.user?.orgId, { service: 'rw_learn',  model: 'flash', inputLength: prompt.length + learnSys.length,  maxOutputTokens: 1024 })
    await callGeminiNotebook(apiKey, prompt, learnSys, res, 1024, 0.3, 'application/json', null, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

// ── POST /api/rw/draft (SSE) ──────────────────────────────────────────────────
router.post('/rw/draft', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { sources, contributor, reportType, profile, glossary, recentFeedback } = req.body || {}

    const templateMap = {
      'field-visit-report': { label: 'Field Visit Report', sections: ['Purpose of Visit','Location & Date','Staff Present','Community / Beneficiaries Observed','Activities Conducted','Beneficiaries Reached','Key Observations','Challenges & Risks','Photographs / Attachments','Follow-up Actions'], hint: 'Use past tense. Every number must trace to source data.' },
      'training-report':    { label: 'Training Report', sections: ['Training Title','Date & Venue','Facilitators','Participants (gender breakdown)','Training Objectives','Session Summary','Key Learning Outcomes','Participant Feedback','Materials Distributed','Follow-up & Gaps'], hint: 'Summarise what actually happened, not the planned curriculum.' },
      'me-monthly-report':  { label: 'M&E Monthly Report', sections: ['Reporting Period','Project / Programme','Indicators Tracked','Beneficiary Data','Qualitative Progress','Deviations from Plan','Budget Utilisation','Risks & Mitigation','Lessons Learned','Plan for Next Month'], hint: 'Every number must trace to source. Format Indicators as a table.' },
    }
    const tpl = templateMap[reportType] || templateMap['field-visit-report']
    const vp  = profile?.voiceProfile
    const confirmedTerms = (glossary || []).filter(g => g.status === 'confirmed').slice(0, 20)
    const recentLessons  = (recentFeedback || []).slice(-5).map(f => `• ${f.lesson}`).join('\n')
    // 12 KB per source balances context against cost
    const srcBlock = (sources || []).map(s => `[SOURCE: ${s.name}]\n${String(s.content||'').slice(0,12_000)}\n---`).join('\n\n')
    const glossaryBlock = confirmedTerms.length > 0 ? confirmedTerms.map(g => `${g.term} — ${g.definition}`).join('\n') : '(none yet)'
    const profileBlock  = vp ? `Sentence length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Formality: ${vp.formalityLevel}
Preferred connectors: ${(vp.preferredConnectors||[]).join(', ')||'not known'}
Words to avoid: ${(vp.avoidedWords||[]).join(', ')||'none identified'}
Pitfalls to avoid: ${(vp.recurringPitfalls||[]).join('; ')||'none yet'}
Voice anchor sentences:
${(vp.anchorSentences||[]).join('\n')}` : '(no profile yet — use plain professional English)'

    const prompt = `REPORT TYPE: ${tpl.label}
CONTRIBUTOR: ${contributor}

=== CONTRIBUTOR VOICE PROFILE ===
${profileBlock}

=== TEMPLATE — follow these sections in order ===
${tpl.sections.map((s,i)=>`${i+1}. ${s}`).join('\n')}
Note: ${tpl.hint}

=== CONFIRMED GLOSSARY (use these exact terms) ===
${glossaryBlock}

=== RECENT EDITOR CORRECTIONS (do not repeat these mistakes) ===
${recentLessons || '(none yet)'}

=== RAW SOURCE DATA ===
${srcBlock}`

    const [draftSysBase, orgCtx, sector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'rw_draft_system',
        'You are a field report writer for Jal Jeevika, a rural development NGO focused on inland fisheries, water stewardship, and livelihoods in India.\n\n' +
        'HARD RULES:\n1. Never fabricate field details. Write ⟨MISSING: description⟩ for absent info.\n2. Every number must trace to source data.\n3. Quotes must appear verbatim from source text.\n4. Write in English. Regional terms in italics with gloss.\n5. No donor-speak.\n6. Follow template section order exactly. Use ## headings.'),
      buildOrgContext(req.user?.orgId),
      getOrgSector(req.user?.orgId),
    ])
    const overlay = sectorOverlay(sector, 'rw_draft_system')
    const draftSys = [draftSysBase, orgCtx, overlay].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'rw_draft',  model: 'flash', inputLength: prompt.length + draftSys.length,  maxOutputTokens: 4096 })
    await callGeminiNotebook(apiKey, prompt, draftSys, res, 4096, 0.5, null, null, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

// ── POST /api/rw/refine (SSE) ─────────────────────────────────────────────────
router.post('/rw/refine', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { draftMd, finalMd, contributor, reportType } = req.body || {}
    const prompt = `CONTRIBUTOR: ${contributor}
REPORT TYPE: ${reportType}

=== DRAFT (AI-generated) ===
${String(draftMd||'').slice(0,8000)}

=== FINAL (contributor-edited) ===
${String(finalMd||'').slice(0,8000)}

Compare the two versions. For each meaningful change:
1. Identify before-text (draft) and after-text (final).
2. Classify: Voice / Structure / Vocabulary / Factual / Omission
3. Write one lesson: "In future: ..."

Return a JSON array FIRST, then PROFILE_UPDATES: followed by a JSON object.

JSON array format:
[{"category":"Voice|Structure|Vocabulary|Factual|Omission","beforeText":"...","afterText":"...","lesson":"In future: ..."}]

PROFILE_UPDATES: {"avoidedWords":[],"blindSpots":[],"recurringPitfalls":[]}`

    const [refineSysBase, refineSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'rw_refine_system',
        'You are a writing coach for an NGO field reporting system. Compare draft vs final, classify every meaningful change, extract lessons. Output the JSON array first, then PROFILE_UPDATES: followed by its JSON object. Nothing else.'),
      getOrgSector(req.user?.orgId),
    ])
    const refineSys = [refineSysBase, sectorOverlay(refineSector, 'rw_refine_system')].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'rw_refine', model: 'flash', inputLength: prompt.length + refineSys.length, maxOutputTokens: 2048 })
    await callGeminiNotebook(apiKey, prompt, refineSys, res, 2048, 0.4, null, null, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

// ── POST /api/rw/reflect (SSE) ────────────────────────────────────────────────
router.post('/rw/reflect', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { contributor, profile, recentFeedback } = req.body || {}
    const feedbackBlock = (recentFeedback || []).slice(-30).map(f =>
      `[${f.date}] [${f.category}] BEFORE: "${String(f.beforeText||'').slice(0,120)}" → AFTER: "${String(f.afterText||'').slice(0,120)}" LESSON: ${f.lesson}`
    ).join('\n')

    const prompt = `CONTRIBUTOR: ${contributor}
CURRENT PROFILE:
${JSON.stringify(profile?.voiceProfile || {}, null, 2)}

RECENT CORRECTION HISTORY (last 4 weeks):
${feedbackBlock || '(no corrections recorded yet)'}

Tasks:
1. Identify the top 3 recurring pitfalls (patterns appearing in 2+ corrections).
2. Identify glossary terms appearing consistently (3+ times) — candidates for promotion.
3. Update the recurringPitfalls array.

Return ONLY this JSON object:
{
  "recurringPitfalls": ["..."],
  "termPromotions": ["term1"],
  "profileNote": "One paragraph summary of this contributor's patterns this period."
}`

    const [reflectSysBase, reflectSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'rw_reflect_system',
        'You are a learning system for an NGO field reporting tool. Find recurring patterns in a contributor\'s correction history and consolidate them into actionable profile updates. Output ONLY the specified JSON object.'),
      getOrgSector(req.user?.orgId),
    ])
    const reflectSys = [reflectSysBase, sectorOverlay(reflectSector, 'rw_reflect_system')].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'rw_reflect', model: 'flash', inputLength: prompt.length + reflectSys.length, maxOutputTokens: 1024 })
    await callGeminiNotebook(apiKey, prompt, reflectSys, res, 1024, 0.4, null, null, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

// ── POST /api/rw/auto-polish (SSE) ───────────────────────────────────────────
router.post('/rw/auto-polish', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { draftMd, sources, profile, reportType } = req.body || {}
    const vp = profile?.voiceProfile
    // Only needs enough context to resolve ⟨MISSING⟩
    const srcBlock = (sources || []).slice(0, 3).map(s =>
      `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 8_000)}\n---`
    ).join('\n\n')
    const voiceBlock = vp
      ? `Length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Formality: ${vp.formalityLevel}
Avoid: ${(vp.avoidedWords||[]).join(', ')||'none'}
Pitfalls: ${(vp.recurringPitfalls||[]).join('; ')||'none'}
Voice anchors:\n${(vp.anchorSentences||[]).join('\n')}`
      : '(no voice profile — preserve original voice)'
    const prompt = `Polish this NGO field report draft. Do NOT add any fact not in sources or draft.

VOICE PROFILE:\n${voiceBlock}

RULES:
1. No invented facts, numbers, names, dates.
2. Resolve ⟨MISSING: ...⟩ placeholders where the answer is in sources; otherwise leave them.
3. Match contributor voice (length, tense, formality, connectors).
4. Fix listed pitfalls.
5. Output ONLY the polished markdown.

REPORT TYPE: ${reportType}

=== DRAFT ===\n${String(draftMd||'').slice(0,8000)}

=== SOURCES (for resolving MISSING) ===\n${srcBlock}`
    const polishSys = await getOrgPrompt(req.user?.orgId, 'rw_polish_system',
      'You are an NGO report editor. Polish the draft to match the contributor voice profile. Output ONLY the final polished markdown.')
    trackUsage(req.user?.orgId, { service: 'rw_polish', model: 'flash', inputLength: prompt.length + polishSys.length, maxOutputTokens: 4096 })
    await callGeminiNotebook(apiKey, prompt, polishSys, res, 4096, 0.4, null, null, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

export default router
