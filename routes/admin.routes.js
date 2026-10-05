// routes/admin.routes.js — Admin / superadmin utilities
//
// POST /api/admin/prompt-sheet/create   Create (or re-populate) the AI Prompt Library Google Sheet
// GET  /api/admin/prompt-sheet          Return the current sheet URL / ID
//
// All endpoints require a valid Firebase auth token AND superadmin role.
// The sheet is created by the GCP service account, then shared with the
// requesting user's email so they can open and edit it immediately.

import { Router } from 'express'
import { createSign } from 'crypto'
import { getPool } from '../db/pool.js'

const router = Router()

// ── Google token with both Sheets + Drive scopes ──────────────────────────────
async function getGoogleTokenFull() {
  const keyJson = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
  if (!keyJson) return null
  try {
    const sa  = JSON.parse(keyJson)
    const now = Math.floor(Date.now() / 1000)
    const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const pld = Buffer.from(JSON.stringify({
      iss:   sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now + 3600,
      iat:   now,
    })).toString('base64url')
    const signer = createSign('RSA-SHA256')
    signer.update(`${hdr}.${pld}`)
    const jwt = `${hdr}.${pld}.${signer.sign(sa.private_key, 'base64url')}`
    const tr  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    })
    const td = await tr.json()
    return td.access_token || null
  } catch (e) {
    console.error('[admin] token error:', e.message)
    return null
  }
}

// ── Check superadmin role ─────────────────────────────────────────────────────
function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' })
  }
  next()
}

// ── All 14 prompts ────────────────────────────────────────────────────────────
function getPromptRows() {
  return [
    // ── Field Report ─────────────────────────────────────────────────────────
    {
      id:          'report_field_system',
      feature:     'Field Report',
      type:        'system_instruction',
      description: 'System role for AI field report generation. Sets the analyst persona, output format, and quality bar.',
      current:     'You are an expert field work analyst for a rural development NGO. Write clear, insightful reports that highlight impact and provide actionable recommendations. Always respond in well-structured Markdown.',
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/get-ai-report. Temp: 0.7, maxTokens: 8192.',
    },
    {
      id:          'report_field_user',
      feature:     'Field Report',
      type:        'user_prompt',
      description: 'User turn for field report. Injects filtered field data, audience guide, and custom instruction. Built by buildReportPrompt().',
      current:     'You are generating content for {userName} from {orgName}.\nActive Filters: {filterContext}.\n\n**Your Task:**\n{instruction | default: "Write a comprehensive executive-style field work report with sections: Executive Summary, Field Observations, Analysis by Category, Impact & Beneficiaries, and Strategic Recommendations."}\n\n**Field Data Summary:**\n- Total Activities: {count}\n- Date Range: {dateRange}\n- Total Beneficiaries: {total}\n- Unique Projects: {projects}\n- States Covered: {states}\n- Areas of Intervention: {areas}\n- Data Methodology: Self-reported field entries, cross-validated by timestamp and location\n\n**Individual Activity Records:**\n{activities}\n\n[AUDIENCE GUIDE]\n[LANGUAGE NOTE]',
      improvement: '',
      status:      'active',
      notes:       'Variables in {} are filled at runtime. Truncated to 300 records max. Audience guides: board/donor/funder/community/media.',
    },

    // ── Social Post ───────────────────────────────────────────────────────────
    {
      id:          'report_social_system',
      feature:     'Social Post',
      type:        'system_instruction',
      description: 'System role for social media post generation. Strips markdown formatting from output.',
      current:     'You are a senior social media strategist for a leading rural development NGO in India. Output only the final post text — no preamble, no markdown formatting hints.',
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/generate-social-post. Temp: 0.85, maxTokens: 2048.',
    },
    {
      id:          'report_social_user',
      feature:     'Social Post',
      type:        'user_prompt',
      description: 'User turn for social post. Injects impact numbers, platform guide (Instagram/Facebook/Twitter/LinkedIn), tone, and highlighted field activities.',
      current:     'Create a high-impact social media post for {scope}.\n\n**Platform:** {platform}\n**Tone:** {toneGuide}\n**Format guidelines:** {platformGuide}\n\n**Impact Numbers:**\n- Total field reports: {count}\n- Beneficiaries reached: {total}\n- States covered: {states}\n- Active projects: {projects}\n- Intervention areas: {areas}\n\n**Highlight field activities:**\n{highlights}\n\nWrite a complete, ready-to-publish post. Lead with the most powerful number or human story.\n[LANGUAGE NOTE]',
      improvement: '',
      status:      'active',
      notes:       'Platform guides: instagram/facebook/twitter/linkedin. Tone guides: inspiring/celebratory/professional/urgent.',
    },

    // ── RW Learn (Voice Profile) ──────────────────────────────────────────────
    {
      id:          'rw_learn_system',
      feature:     'RW Learn (Voice Profile)',
      type:        'system_instruction',
      description: 'System role for writing analyst. Builds a contributor voice profile from past writing samples. JSON-only output enforced.',
      current:     "You are a writing analyst for a rural development NGO. Build a voice profile from a contributor's past writing. Output ONLY a valid JSON object matching the specified schema. Never invent characteristics — every attribute must be grounded in the text.",
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/rw/learn. Temp: 0.3, maxTokens: 8192, responseMimeType: application/json.',
    },
    {
      id:          'rw_learn_user',
      feature:     'RW Learn (Voice Profile)',
      type:        'user_prompt',
      description: 'User turn for voice profile generation. Provides up to 3 writing samples and requests structured JSON output with 9 voice characteristics.',
      current:     'CONTRIBUTOR: {contributor}\nEXISTING PROFILE: {existingProfile | "None — this is the first analysis."}\n\nPAST WRITING SAMPLES:\n{srcBlock}\n\nAnalyse the writing samples above and return a JSON object with exactly these fields:\n{\n  "avgSentenceLength": "short|medium|long",\n  "dominantTense": "past|present|mixed",\n  "formalityLevel": "high|medium|low",\n  "preferredConnectors": ["top 5 connecting words/phrases actually found in the text"],\n  "avoidedWords": ["NGO/donor jargon absent from the writing"],\n  "blindSpots": ["report sections consistently absent or thin"],\n  "anchorSentences": ["3 to 5 verbatim sentences that best represent this contributor\'s voice"],\n  "recurringPitfalls": {existingPitfalls | []},\n  "lastLearnDate": "{today}"\n}\n\nRules: anchorSentences must be verbatim from the text. Output ONLY the JSON object.',
      improvement: '',
      status:      'active',
      notes:       'Up to 3 sources, each capped at 15,000 chars. If existing profile exists, pitfalls are preserved and merged.',
    },

    // ── RW Draft ─────────────────────────────────────────────────────────────
    {
      id:          'rw_draft_system',
      feature:     'RW Draft',
      type:        'system_instruction',
      description: 'System role for report drafting. Includes 6 hard rules: no fabrication, traceable numbers, verbatim quotes, English + regional terms, no donor-speak, strict template section order.',
      current:     "You are a field report writer for Jal Jeevika, a rural development NGO focused on inland fisheries, water stewardship, and livelihoods in India.\n\nHARD RULES:\n1. Never fabricate field details. Write ⟨MISSING: description⟩ for absent info.\n2. Every number must trace to source data.\n3. Quotes must appear verbatim from source text.\n4. Write in English. Regional terms in italics with gloss.\n5. No donor-speak.\n6. Follow template section order exactly. Use ## headings.",
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/rw/draft. Temp: 0.5, maxTokens: 4096. ⟨MISSING⟩ placeholders used for absent data — resolved by auto-polish.',
    },
    {
      id:          'rw_draft_user',
      feature:     'RW Draft',
      type:        'user_prompt',
      description: 'User turn for draft generation. Injects report type (field-visit/training/me-monthly), contributor voice profile, confirmed glossary terms, recent editor corrections, and raw source data.',
      current:     'REPORT TYPE: {tpl.label}\nCONTRIBUTOR: {contributor}\n\n=== CONTRIBUTOR VOICE PROFILE ===\n{profileBlock}\n\n=== TEMPLATE — follow these sections in order ===\n{sections numbered list}\nNote: {tpl.hint}\n\n=== CONFIRMED GLOSSARY (use these exact terms) ===\n{glossaryBlock}\n\n=== RECENT EDITOR CORRECTIONS (do not repeat these mistakes) ===\n{recentLessons}\n\n=== RAW SOURCE DATA ===\n{srcBlock}',
      improvement: '',
      status:      'active',
      notes:       'Template types: field-visit-report / training-report / me-monthly-report. Sources capped at 20,000 chars each. Top 20 confirmed glossary terms injected.',
    },

    // ── RW Refine (Draft vs Final comparison) ────────────────────────────────
    {
      id:          'rw_refine_system',
      feature:     'RW Refine',
      type:        'system_instruction',
      description: 'System role for writing coach. Compares AI draft vs contributor-edited final, extracts lessons as JSON, then outputs profile updates.',
      current:     'You are a writing coach for an NGO field reporting system. Compare draft vs final, classify every meaningful change, extract lessons. Output the JSON array first, then PROFILE_UPDATES: followed by its JSON object. Nothing else.',
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/rw/refine. Temp: 0.4, maxTokens: 2048. Output format: JSON array + "PROFILE_UPDATES:" section.',
    },
    {
      id:          'rw_refine_user',
      feature:     'RW Refine',
      type:        'user_prompt',
      description: 'User turn for draft-vs-final comparison. Provides both versions, requests JSON feedback array classified by Voice/Structure/Vocabulary/Factual/Omission, plus profile update suggestions.',
      current:     'CONTRIBUTOR: {contributor}\nREPORT TYPE: {reportType}\n\n=== DRAFT (AI-generated) ===\n{draftMd (max 8000 chars)}\n\n=== FINAL (contributor-edited) ===\n{finalMd (max 8000 chars)}\n\nCompare the two versions. For each meaningful change:\n1. Identify before-text (draft) and after-text (final).\n2. Classify: Voice / Structure / Vocabulary / Factual / Omission\n3. Write one lesson: "In future: ..."\n\nReturn a JSON array FIRST, then PROFILE_UPDATES: followed by a JSON object.\n\nJSON array format:\n[{"category":"Voice|Structure|Vocabulary|Factual|Omission","beforeText":"...","afterText":"...","lesson":"In future: ..."}]\n\nPROFILE_UPDATES: {"avoidedWords":[],"blindSpots":[],"recurringPitfalls":[]}',
      improvement: '',
      status:      'active',
      notes:       'Feedback is saved to rw_feedback sheet tab. Profile updates merged into contributor profile.',
    },

    // ── RW Reflect (Pattern analysis) ────────────────────────────────────────
    {
      id:          'rw_reflect_system',
      feature:     'RW Reflect',
      type:        'system_instruction',
      description: 'System role for the learning system. Consolidates correction history into actionable profile updates. JSON-only output.',
      current:     "You are a learning system for an NGO field reporting tool. Find recurring patterns in a contributor's correction history and consolidate them into actionable profile updates. Output ONLY the specified JSON object.",
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/rw/reflect. Temp: 0.4, maxTokens: 1024.',
    },
    {
      id:          'rw_reflect_user',
      feature:     'RW Reflect',
      type:        'user_prompt',
      description: 'User turn for pattern analysis. Reviews last 30 correction records, identifies top 3 recurring pitfalls, finds glossary promotion candidates (3+ occurrences), and writes a profile note.',
      current:     'CONTRIBUTOR: {contributor}\nCURRENT PROFILE:\n{profile.voiceProfile as JSON}\n\nRECENT CORRECTION HISTORY (last 4 weeks):\n{feedbackBlock — last 30 entries: [date][category] BEFORE: "..." → AFTER: "..." LESSON: ...}\n\nTasks:\n1. Identify the top 3 recurring pitfalls (patterns appearing in 2+ corrections).\n2. Identify glossary terms appearing consistently (3+ times) — candidates for promotion.\n3. Update the recurringPitfalls array.\n\nReturn ONLY this JSON object:\n{\n  "recurringPitfalls": ["..."],\n  "termPromotions": ["term1"],\n  "profileNote": "One paragraph summary of this contributor\'s patterns this period."\n}',
      improvement: '',
      status:      'active',
      notes:       'Runs periodically or on-demand. Results merged into voice profile. termPromotions used to auto-promote glossary terms.',
    },

    // ── RW Auto-Polish ────────────────────────────────────────────────────────
    {
      id:          'rw_polish_system',
      feature:     'RW Auto-Polish',
      type:        'system_instruction',
      description: 'System role for NGO report editor. Polishes draft while strictly preserving voice and prohibiting invented facts.',
      current:     'You are an NGO report editor. Polish the draft to match the contributor voice profile. Output ONLY the final polished markdown.',
      improvement: '',
      status:      'active',
      notes:       'Used in POST /api/rw/auto-polish. Temp: 0.4, maxTokens: 4096.',
    },
    {
      id:          'rw_polish_user',
      feature:     'RW Auto-Polish',
      type:        'user_prompt',
      description: 'User turn for auto-polish. Injects voice profile, 5 hard rules (no invented facts, resolve MISSING from sources, match voice, fix pitfalls), and the draft + source data.',
      current:     'Polish this NGO field report draft. Do NOT add any fact not in sources or draft.\n\nVOICE PROFILE:\n{voiceBlock}\n\nRULES:\n1. No invented facts, numbers, names, dates.\n2. Resolve ⟨MISSING: ...⟩ placeholders where the answer is in sources; otherwise leave them.\n3. Match contributor voice (length, tense, formality, connectors).\n4. Fix listed pitfalls.\n5. Output ONLY the polished markdown.\n\nREPORT TYPE: {reportType}\n\n=== DRAFT ===\n{draftMd (max 8000 chars)}\n\n=== SOURCES (for resolving MISSING) ===\n{srcBlock (up to 3 sources, 15000 chars each)}',
      improvement: '',
      status:      'active',
      notes:       '⟨MISSING⟩ placeholders from draft step are resolved here where possible. Falls back gracefully if sources do not contain the answer.',
    },
  ]
}

// ── POST /api/admin/prompt-sheet/create ──────────────────────────────────────
router.post('/admin/prompt-sheet/create', requireSuperadmin, async (req, res) => {
  const token = await getGoogleTokenFull()
  if (!token) {
    return res.status(503).json({
      error: 'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON env var.',
    })
  }

  const userEmail = req.user?.email || ''
  const today = new Date().toISOString().slice(0, 10)

  try {
    // 1. Create the spreadsheet ───────────────────────────────────────────────
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title: `FieldFlow AI Prompt Library — ${today}` },
        sheets: [
          {
            properties: { title: 'ai_prompts', sheetId: 0 },
          },
          {
            properties: { title: 'improvement_log', sheetId: 1 },
          },
          {
            properties: { title: 'test_results', sheetId: 2 },
          },
        ],
      }),
    })
    if (!createRes.ok) {
      const err = await createRes.json()
      return res.status(500).json({ error: 'Failed to create sheet: ' + (err?.error?.message || createRes.status) })
    }
    const { spreadsheetId, spreadsheetUrl } = await createRes.json()

    // 2. Build the data rows ──────────────────────────────────────────────────
    const prompts = getPromptRows()

    const HEADERS = [
      'Prompt ID',
      'Feature',
      'Type',
      'Description',
      'Current Prompt',
      'Proposed Improvement',
      'Status',
      'Last Updated',
      'Notes / Test Results',
    ]

    const rows = prompts.map(p => [
      p.id,
      p.feature,
      p.type,
      p.description,
      p.current,
      p.improvement,
      p.status,
      today,
      p.notes,
    ])

    const IMPROVEMENT_HEADERS = [
      'Date',
      'Prompt ID',
      'Feature',
      'Proposed Change (summary)',
      'Before',
      'After',
      'Tested?',
      'Result / Notes',
      'Applied?',
      'Applied On',
      'Applied By',
    ]

    const TEST_HEADERS = [
      'Date',
      'Prompt ID',
      'Feature',
      'Test Input (summary)',
      'Expected Output',
      'Actual Output (summary)',
      'Pass / Fail',
      'Tester',
      'Notes',
    ]

    // 3. Populate ai_prompts tab ──────────────────────────────────────────────
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/ai_prompts!A1:I${rows.length + 1}?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [HEADERS, ...rows] }),
      }
    )

    // 4. Populate improvement_log tab ─────────────────────────────────────────
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/improvement_log!A1:K1?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [IMPROVEMENT_HEADERS] }),
      }
    )

    // 5. Populate test_results tab ────────────────────────────────────────────
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/test_results!A1:I1?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [TEST_HEADERS] }),
      }
    )

    // 6. Format: freeze header row + bold + column widths ────────────────────
    const formatRequests = [
      // Freeze row 1 in ai_prompts
      { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // Freeze row 1 in improvement_log
      { updateSheetProperties: { properties: { sheetId: 1, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // Freeze row 1 in test_results
      { updateSheetProperties: { properties: { sheetId: 2, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // Bold header row in ai_prompts
      {
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.196, green: 0.38, blue: 0.361 }, // #315F5C dark teal
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: 'userEnteredFormat(textFormat,backgroundColor,foregroundColor)',
        },
      },
      // Bold header in improvement_log
      {
        repeatCell: {
          range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.196, green: 0.38, blue: 0.361 }, foregroundColor: { red: 1, green: 1, blue: 1 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor,foregroundColor)',
        },
      },
      // Bold header in test_results
      {
        repeatCell: {
          range: { sheetId: 2, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.196, green: 0.38, blue: 0.361 }, foregroundColor: { red: 1, green: 1, blue: 1 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor,foregroundColor)',
        },
      },
      // Wrap text in Current Prompt column (E = col 4)
      {
        repeatCell: {
          range: { sheetId: 0, startColumnIndex: 4, endColumnIndex: 6 },
          cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
          fields: 'userEnteredFormat.wrapStrategy',
        },
      },
      // Column widths in ai_prompts: ID(120), Feature(130), Type(150), Desc(200), Prompt(350), Improvement(350), Status(90), Date(100), Notes(250)
      ...[ [0,120],[1,130],[2,150],[3,200],[4,350],[5,350],[6,90],[7,100],[8,250] ].map(([col, px]) => ({
        updateDimensionProperties: {
          range: { sheetId: 0, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize',
        },
      })),
      // Alternate row colors in ai_prompts (light teal for even rows)
      {
        addBanding: {
          bandedRange: {
            bandedRangeId: 1,
            range: { sheetId: 0, startRowIndex: 1, endRowIndex: rows.length + 1 },
            rowProperties: {
              headerColor:       { red: 0.196, green: 0.38,  blue: 0.361 },
              firstBandColor:    { red: 1,     green: 1,     blue: 1     },
              secondBandColor:   { red: 0.91,  green: 0.965, blue: 0.961 },
            },
          },
        },
      },
    ]

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requests: formatRequests }),
      }
    )

    // 7. Share with the requesting user ───────────────────────────────────────
    let shareWarning = null
    if (userEmail) {
      const shareRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`,
        {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'user', role: 'writer', emailAddress: userEmail }),
        }
      )
      if (!shareRes.ok) {
        shareWarning = `Could not auto-share with ${userEmail} — open the URL and request access manually.`
      }
    }

    // 8. Store sheet ID in DB (superadmin org metadata) ───────────────────────
    try {
      const pool = getPool()
      await pool.query(
        `UPDATE organizations
            SET metadata = jsonb_set(COALESCE(metadata,'{}'), '{prompt_sheet_id}', $1::jsonb, true)
          WHERE id = $2`,
        [JSON.stringify(spreadsheetId), req.user.orgId]
      )
    } catch (dbErr) {
      console.warn('[admin] could not store prompt_sheet_id in DB:', dbErr.message)
    }

    return res.json({
      success:      true,
      sheetId:      spreadsheetId,
      url:          spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      promptCount:  prompts.length,
      shareWarning: shareWarning || null,
      message:      `✅ Created AI Prompt Library with ${prompts.length} prompts across 3 tabs (ai_prompts, improvement_log, test_results). Set PROMPT_SHEET_ID=${spreadsheetId} in your app.yaml for prompt-store integration.`,
    })

  } catch (e) {
    console.error('[admin] prompt-sheet/create error:', e)
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' })
  }
})

// ── GET /api/admin/prompt-sheet ───────────────────────────────────────────────
router.get('/admin/prompt-sheet', requireSuperadmin, async (req, res) => {
  // Try DB first, then env var
  let sheetId = process.env.PROMPT_SHEET_ID || ''
  try {
    if (!sheetId && req.user?.orgId) {
      const pool = getPool()
      const { rows } = await pool.query(
        `SELECT metadata->>'prompt_sheet_id' AS sid FROM organizations WHERE id = $1`,
        [req.user.orgId]
      )
      sheetId = rows[0]?.sid || ''
    }
  } catch { /* ignore */ }

  if (!sheetId) {
    return res.json({ sheetId: null, url: null, message: 'No prompt sheet configured. Call POST /api/admin/prompt-sheet/create to create one.' })
  }

  return res.json({
    sheetId,
    url:     `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    message: 'Prompt sheet found.',
  })
})

export default router
