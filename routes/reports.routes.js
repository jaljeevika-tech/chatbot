// routes/reports.routes.js — AI report generation + Drive + social post + image proxy

import { Router } from 'express'
import { GEMINI_FLASH_URL, pickReportUrl, makeAbortSignal, setupSSE, sendSSE, pipeGeminiStream } from '../lib/gemini.js'
import { getOrg } from '../lib/org.js'
import { getOrgPrompt } from '../lib/promptStore.js'
import { analyzeFieldData } from '../lib/nlp.js'
import { getOrgSector } from '../lib/orgMetaCache.js'
import { sectorOverlay } from '../lib/prompts/sectorPrompts.js'
import { checkHallucination } from '../lib/dataCorrectness/hallucination.js'
import { trackAndCheck } from '../lib/orgLimits.js'
import { trackUsage } from '../lib/usageTracker.js'
import { getPool } from '../db/pool.js'

const router = Router()

// ── Prompt builder ────────────────────────────────────────────────────────────
// Only the most recent DETAIL_LIMIT records go in full detail; older ones are
// summarised to stay within token budgets.
const DETAIL_LIMIT     = 200   // max full-detail records per prompt
const DESC_WORD_LIMIT  = 200   // max words per description

function truncateWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return words.join(' ')
  return words.slice(0, maxWords).join(' ') + '…'
}

// Renders client-supplied reference data blocks ({ label, content }) into a
// prompt section, bounded so it never crowds out the field records.
function buildReferenceDataSection(supplementaryData) {
  if (!Array.isArray(supplementaryData) || supplementaryData.length === 0) return ''
  const MAX_TOTAL = 60_000  // defensive server-side ceiling on added bulk
  let used = 0
  const blocks = []
  for (const b of supplementaryData) {
    if (used >= MAX_TOTAL) break
    if (!b || typeof b.content !== 'string' || !b.content.trim()) continue
    const label = String(b.label || 'Reference Data').slice(0, 160)
    let content = b.content
    if (used + content.length > MAX_TOTAL) content = content.slice(0, MAX_TOTAL - used)
    if (!content.trim()) break
    blocks.push(`### ${label}\n${content}`)
    used += content.length
  }
  if (blocks.length === 0) return ''
  const hasPortfolio = supplementaryData.some(b => String(b?.label || '').startsWith('PROJECT PORTFOLIO'))
  const portfolioNote = hasPortfolio ? `
**Project Portfolio — how to use it:** Include a dedicated section titled "Project Portfolio Overview" (place it right after the overview/introduction section, and renumber any following numbered sections), containing a table built ONLY from the "PROJECT PORTFOLIO" block — one row per project with columns: Project | Donor | Region | Duration / End Date | Total Budget | Budget Utilised (%) | Locations — followed by 2-4 sentences of commentary on the portfolio as a whole (donor mix, geographic spread, budget size and utilisation). Also weave these portfolio figures into the Executive Summary and any financial / resource section. A "—" in that block means the value is not recorded: write "Not recorded", never guess it.
` : ''
  return `\n\n**Organizational & Project Reference Data (authoritative structured records — project portfolio, annual targets & progress, action plans, MIS indicators, budget/financial utilisation, compliance calendar, Document Vault & Media file lists, Impact Framework indicators, and beneficiary statistics for the projects in scope):**
Use these exact figures alongside the field activity records above. When the report cites donors, budgets, planned-vs-actual, targets, budget/expenditure/utilisation %, indicator achievement, compliance deadlines, or beneficiary counts by type, take them from here rather than estimating from the activity log. Document Vault and Media blocks list file NAMES only — you may mention that such documents/media exist, but never describe or quote their contents, and never embed them as photos (they are not public links). Do NOT fabricate any figure that is not present here or in the field data.
${portfolioNote}
${blocks.join('\n\n---\n\n')}`
}

function buildReportPrompt(userName, reportsRaw, filters, instruction, audience, language, orgName = 'the organisation', nlpContext = {}, staffProfile = null, subjects = [], kind = 'self', subjectProfiles = [], supplementaryData = []) {
  // Compute stats from the FULL dataset (for accurate numbers in the summary header)
  const totalBeneficiaries = reportsRaw.reduce((sum, r) => {
    const n = typeof r.beneficiaries === 'number' ? r.beneficiaries : parseInt(String(r.beneficiaries ?? '0'), 10)
    return sum + (isNaN(n) ? 0 : n)
  }, 0)

  const fullDateRange = reportsRaw.length > 0
    ? `${String(reportsRaw[0].timestamp).slice(0, 10)} to ${String(reportsRaw[reportsRaw.length - 1].timestamp).slice(0, 10)}`
    : 'N/A'

  // Detailed records: most recent DETAIL_LIMIT only
  const reports   = reportsRaw.length > DETAIL_LIMIT ? reportsRaw.slice(-DETAIL_LIMIT) : reportsRaw
  const omitted   = reportsRaw.length - reports.length

  // Compact summary of omitted older records (preserves context without token cost)
  let historySummary = ''
  if (omitted > 0) {
    const older      = reportsRaw.slice(0, omitted)
    const olderBenef = older.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
    const olderProj  = [...new Set(older.map(r => r.project).filter(Boolean))]
    const olderStates = [...new Set(older.map(r => r.state).filter(Boolean))]
    historySummary = `\n\n**Earlier Records Summary (${omitted} entries, pre-${String(reports[0].timestamp).slice(0,10)}):**
- Projects: ${olderProj.join(', ') || 'N/A'}
- States: ${olderStates.join(', ') || 'N/A'}
- Beneficiaries: ${olderBenef.toLocaleString('en-IN')}
(Pre-analysed insights above capture narrative intelligence from the full dataset.)`
  }

  const activities = reports.map((r, i) => [
    `ID: r${i + 1}`,
    `Date: ${new Date(String(r.timestamp)).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    `Location: ${r.location}, ${r.state}`,
    `Project: ${r.project || 'N/A'}`,
    `Area: ${r.areaOfIntervention}`,
    `Reported By: ${r.name || 'N/A'}`,
    `Beneficiaries: ${r.beneficiaries ?? '0'}`,
    `Description: ${truncateWords(r.description, DESC_WORD_LIMIT)}`,
    r.attachmentUrl ? `Photo: ${r.attachmentUrl}` : null,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n')

  const filterContext = [
    Array.isArray(filters.project)    && filters.project.length    > 0 && `Projects: ${filters.project.join(', ')}`,
    Array.isArray(filters.state)      && filters.state.length      > 0 && `States: ${filters.state.join(', ')}`,
    Array.isArray(filters.area)       && filters.area.length       > 0 && `Areas: ${filters.area.join(', ')}`,
    Array.isArray(filters.location)   && filters.location.length   > 0 && `Locations: ${filters.location.join(', ')}`,
    Array.isArray(filters.workerName) && filters.workerName.length > 0 && `Workers: ${filters.workerName.join(', ')}`,
    (filters.dateFrom || filters.dateTo) && `Period: ${filters.dateFrom || 'start'} to ${filters.dateTo || 'end'}`,
  ].filter(Boolean).join(' | ')

  const areasBreakdown = [...new Set(reportsRaw.map(r => r.areaOfIntervention).filter(Boolean))].join(', ') || 'N/A'

  // Computed over reportsRaw (not truncated by DETAIL_LIMIT) so per-area and
  // per-contributor counts stay correct on large record sets.
  const areaStatsMap = new Map()
  for (const r of reportsRaw) {
    const area = String(r.areaOfIntervention || '').trim() || 'Unspecified'
    const entry = areaStatsMap.get(area) ?? { count: 0, beneficiaries: 0, locations: new Set() }
    entry.count += 1
    entry.beneficiaries += (parseInt(String(r.beneficiaries ?? 0), 10) || 0)
    if (r.location) entry.locations.add(r.location)
    areaStatsMap.set(area, entry)
  }
  const areaBreakdownStats = [...areaStatsMap.entries()]
    .map(([area, s]) => `- ${area}: ${s.count} activities, ${s.beneficiaries.toLocaleString('en-IN')} beneficiaries reached, ${s.locations.size} unique location${s.locations.size === 1 ? '' : 's'}`)
    .join('\n')

  const allContributors = [...new Set(reportsRaw.map(r => r.name).filter(Boolean))]
  const areaAndContributorSection = (areaStatsMap.size > 0 || allContributors.length > 0)
    ? `\n\n**Area of Intervention Breakdown (full dataset, authoritative — use these exact figures for any per-area rollup or summary table; do not recount rows yourself, since older records beyond the detail cap below are not shown individually):**\n${areaBreakdownStats || 'N/A'}\n\n**All Contributors (full dataset, authoritative — every distinct "Reported By" name; use this exact list/count for any team roster or "field staff contributing" figure):**\n${allContributors.join(', ') || 'N/A'} (${allContributors.length} total)`
    : ''

  // Flags locations reported under more than one project so cross-project
  // beneficiary sums can be caveated for double-counting.
  const locationProjectsMap = new Map()
  for (const r of reportsRaw) {
    const loc = String(r.location || '').trim()
    const proj = String(r.project || '').trim()
    if (!loc || !proj) continue
    const set = locationProjectsMap.get(loc) ?? new Set()
    set.add(proj)
    locationProjectsMap.set(loc, set)
  }
  const overlappingLocations = [...locationProjectsMap.entries()]
    .filter(([, projects]) => projects.size > 1)
    .map(([loc, projects]) => `- ${loc}: ${[...projects].join(', ')}`)
  const overlapSection = overlappingLocations.length > 0
    ? `\n\n**Project × Geography Overlap (full dataset, authoritative — locations where more than one project reported activity; treat any beneficiary total spanning these projects as an unverified sum, not a confirmed deduplicated unique count):**\n${overlappingLocations.join('\n')}`
    : `\n\n**Project × Geography Overlap (full dataset, authoritative):** No location was reported under more than one project this period — beneficiary totals across projects carry no known double-counting risk.`

  const audienceGuides = {
    board: `AUDIENCE: Board of Directors
Tone: Strategic, authoritative, evidence-dense.
Lead with outcome metrics and KPIs. Frame every finding in terms of organisational risk or opportunity.
Use a board-level lens: governance, scale, sustainability, accountability.
Tables and structured breakdowns are welcome. Avoid field-level anecdotes unless they directly illustrate a strategic point.`,

    teamleader: `AUDIENCE: Team Leader / Programme Manager
Tone: Operational, direct, action-oriented.
Lead with what was accomplished on the ground this period. Be specific about locations, people, and challenges.
Highlight team performance, field gaps, and concrete next steps.
Think: "what does this manager need to brief their team and plan the next sprint?"`,

    funder: `AUDIENCE: Grant Funder / Foundation
Tone: Formal, compliance-focused, evidence-based.
Demonstrate milestone achievement with precision. Tie every activity to funded outcomes.
Show geographic reach, beneficiary counts, and indicator progress.
Build confidence that funds were used effectively and that scale is possible.`,

    community: `AUDIENCE: Local Community Members & Field Stakeholders
Tone: Warm, simple, celebratory — never jargon-heavy.
Write in plain, accessible language a village-level reader can understand and feel proud of.
Lead with the human impact. Use specific locations and relatable examples.
Avoid acronyms, technical terms, or bureaucratic framing entirely.`,

    media: `AUDIENCE: Journalists & Media
Tone: Punchy, newsworthy, human-centred.
Lead with the single most striking statistic or human moment.
Use an inverted-pyramid structure: the most important fact first.
Every paragraph should earn its place — no filler, no bureaucratic background.
Include at least one vivid, quotable sentence.`,
  }

  // Inject NLP pre-analysis narrative intelligence if available
  let nlpSection = ''
  if (nlpContext && Object.keys(nlpContext).length > 0) {
    const parts = []
    if (nlpContext.emotional_core)
      parts.push(`**Narrative Core:** ${nlpContext.emotional_core}`)
    if (nlpContext.geographic_highlights)
      parts.push(`**Geographic Reach:** ${nlpContext.geographic_highlights}`)
    if (nlpContext.key_patterns?.length)
      parts.push(`**Key Patterns:** ${nlpContext.key_patterns.join(' • ')}`)
    if (nlpContext.standout_numbers?.length)
      parts.push(`**Standout Numbers:** ${nlpContext.standout_numbers.map(n => `${n.stat} (${n.context})`).join(' | ')}`)
    if (nlpContext.top_stories?.length) {
      parts.push(`**Narrative Stories to Draw From:**`)
      for (const s of nlpContext.top_stories)
        parts.push(`  • ${s.headline} — ${s.detail} [${s.location}; impact: ${s.impact}]`)
    }
    if (parts.length)
      nlpSection = `\n\n**Pre-Analyzed Intelligence (use to enrich your writing):**\n${parts.join('\n')}`
  }

  const audienceNote = audience && audienceGuides[audience] ? `\n\n---\n${audienceGuides[audience]}` : ''
  const languageNote = language ? `\n\n**Output Language:** Write the entire response in ${language}.` : ''

  // Build verified staff profile block (injected when DB record found)
  let staffProfileBlock = ''
  if (staffProfile) {
    const profileParts = [
      `Name: ${staffProfile.name}`,
      staffProfile.designation ? `Designation: ${staffProfile.designation}` : null,
      staffProfile.project_ids?.length
        ? `Assigned Projects: ${Array.isArray(staffProfile.project_ids) ? staffProfile.project_ids.join(', ') : staffProfile.project_ids}`
        : null,
      staffProfile.manager_name ? `Reports To: ${staffProfile.manager_name}` : null,
      staffProfile.employee_id  ? `Employee ID: ${staffProfile.employee_id}` : null,
    ].filter(Boolean).join(' | ')

    staffProfileBlock = `
**Staff Profile (verified — use exactly as given):**
${profileParts}

**DATA INTEGRITY RULES:**
- Use the Staff Profile name, designation, projects, and manager exactly as given above — never substitute, guess, or infer a different person.
- Village/location visited (from field entries) is the activity site — it is distinct from the project's headquarters.
- Do not fabricate photos, quotes, or beneficiary names not present in the field data.
- Case studies must feature the Staff Profile person as the field worker unless another specific worker is named in the data.
- Do NOT add case studies to MIS, Government, or Compliance report types unless the user explicitly requests one.
`
  }

  // Resolved display name — prefer verified DB record over unverified frontend value
  const displayName = staffProfile?.name ?? userName

  // Selected contributors become the report's subjects (third person); the
  // logged-in user is the generator.
  const hasSubjects = Array.isArray(subjects) && subjects.length > 0 && kind !== 'self'
  let subjectsBlock = ''
  let perspectiveBlock = ''
  if (hasSubjects) {
    const subjectLines = subjects.map((s, i) => {
      const p = subjectProfiles[i]
      const bits = [
        `Name: ${s.name}`,
        p?.designation ? `Designation: ${p.designation}` : null,
        p?.project_ids?.length
          ? `Assigned Projects: ${Array.isArray(p.project_ids) ? p.project_ids.join(', ') : p.project_ids}`
          : null,
        p?.manager_name ? `Reports To: ${p.manager_name}` : null,
        p?.employee_id  ? `Employee ID: ${p.employee_id}` : null,
      ].filter(Boolean).join(' | ')
      return `  - ${bits}`
    }).join('\n')

    subjectsBlock = `
**Subjects of This Report (verified — describe in third person):**
${subjectLines}

**Report Generated By (the writer, not the subject):**
${displayName}${staffProfile?.designation ? ` — ${staffProfile.designation}` : ''}

**HARD RULE — Generator vs. Subject:** Never confuse the generator with the subject. ${displayName} is writing this report ABOUT the named subject${subjects.length > 1 ? 's' : ''}; ${displayName} is NOT the subject. Use third person for subjects throughout. Never write "I trained 25 women" when the field data was logged by a subject — instead write "${subjects[0].name} trained 25 women".
`
    const intro = subjects.length === 1
      ? `You are generating a performance / activity report about ${subjects[0].name} from ${orgName}.`
      : `You are generating a team performance / activity report about ${subjects.length} employees (${subjects.map(s => s.name).join(', ')}) from ${orgName}.`
    perspectiveBlock = `${intro}\nThe report writer is ${displayName} (logged in as the report's generator).\n`
  }

  const header = hasSubjects
    ? perspectiveBlock
    : `You are generating content for ${displayName} from ${orgName}.\n`

  return `${header}${filterContext ? `Active Filters: ${filterContext}.` : ''}
${staffProfileBlock}${subjectsBlock}

**Your Task:**
${instruction || 'Write a comprehensive executive-style field work report with sections: Executive Summary, Field Observations, Analysis by Category, Impact & Beneficiaries, and Strategic Recommendations.'}

**Field Data Summary (full dataset):**
- Total Activities: ${reportsRaw.length}
- Date Range: ${fullDateRange}
- Total Beneficiaries Reached: ${totalBeneficiaries.toLocaleString('en-IN')}
- Unique Projects: ${[...new Set(reportsRaw.map(r => r.project).filter(Boolean))].join(', ') || 'N/A'}
- States Covered: ${[...new Set(reportsRaw.map(r => r.state).filter(Boolean))].join(', ') || 'N/A'}
- Areas of Intervention: ${areasBreakdown}
- Data Methodology: Self-reported field entries, cross-validated by timestamp and location
${areaAndContributorSection}${overlapSection}
${nlpSection}${buildReferenceDataSection(supplementaryData)}

**Individual Activity Records (${reports.length} most recent of ${reportsRaw.length} total):**
${activities}${historySummary}${audienceNote}${languageNote}`
}

// ── POST /api/get-ai-report (SSE) ─────────────────────────────────────────────
router.post('/get-ai-report', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' })
    return
  }

  // Cap to prevent runaway token usage from oversized payloads
  const MAX_REPORTS = 2000
  const {
    reports: _reports, userName, filters, instruction, audience, language,
    subjects: _subjects, kind: _kind, supplementaryData: _supplementaryData,
  } = req.body || {}
  const reports = Array.isArray(_reports) ? _reports.slice(0, MAX_REPORTS) : _reports
  // Structured project/beneficiary reference data gathered client-side
  // (gatherContentHubReferenceData). Cap the count defensively; each block's
  // size is further bounded when rendered into the prompt.
  const supplementaryData = Array.isArray(_supplementaryData) ? _supplementaryData.slice(0, 100) : []
  if (!reports || !userName) {
    res.status(400).json({ error: 'Missing required fields: reports, userName' })
    return
  }

  // Subjects: array of { id, name } — when present, "Generate Report for Other".
  // Cap at 20 to keep prompt size sane.
  const subjects = Array.isArray(_subjects)
    ? _subjects.filter(s => s && (s.id || s.name)).slice(0, 20)
    : []
  const kind = _kind === 'for_other' || _kind === 'team' || _kind === 'self'
    ? _kind
    : (subjects.length > 1 ? 'team' : subjects.length === 1 ? 'for_other' : 'self')

  let orgName = 'the organisation'
  let staffProfile = null
  let subjectProfiles = []
  if (req.user?.orgId) {
    const subjectIds = subjects.map(s => s.id).filter(Boolean)
    const [org, profileResult, subjResult] = await Promise.all([
      getOrg(req.user.orgId).catch(() => null),
      // Look up verified staff profile from DB using firebase_uid
      req.user.uid
        ? getPool().query(
            `SELECT u.name, u.designation, u.project_ids, u.employee_id,
                    m.name AS manager_name
             FROM users u
             LEFT JOIN users m ON m.id = u.manager_id
             WHERE u.org_id = $1 AND u.firebase_uid = $2
             LIMIT 1`,
            [req.user.orgId, req.user.uid]
          ).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
      // Look up verified subject profiles by id when provided
      subjectIds.length > 0
        ? getPool().query(
            `SELECT u.id, u.name, u.designation, u.project_ids, u.employee_id,
                    m.name AS manager_name
             FROM users u
             LEFT JOIN users m ON m.id = u.manager_id
             WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])`,
            [req.user.orgId, subjectIds]
          ).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
    ])
    if (org) orgName = org.name
    staffProfile = profileResult.rows[0] ?? null
    // Preserve the order of `subjects[]` so the i-th profile lines up with the i-th subject.
    const byId = new Map(subjResult.rows.map(r => [r.id, r]))
    subjectProfiles = subjects.map(s => byId.get(s.id) || null)
  }

  setupSSE(res)
  const send   = (payload) => sendSSE(res, payload)
  const signal = makeAbortSignal(req)   // abort Gemini stream when client disconnects

  try {
    send({ text: '⚙️ *Connecting to AI...*\n\n' })

    const DEFAULT_SYS = `You are a masterful field report writer and human-centred storyteller for an Indian rural development NGO.

Your writing must be:
- Intellectually rigorous AND emotionally resonant — weave data and human narratives together naturally
- Specific over generic: use real locations, actual dates, and concrete numbers from the data
- Active, confident voice — avoid passive constructions and bureaucratic filler phrases
- Structured with clear hierarchy (headings, subheadings, tables where they reveal patterns)
- Honest about gaps: if data is incomplete, say so briefly and move on

When the task involves storytelling or public-facing content:
  → Let a specific person, village, or moment carry the data — make readers feel the impact
When the task is for board, funder, or compliance audiences:
  → Prioritise evidence density, strategic framing, and milestone clarity

DATA INTEGRITY (mandatory — no exceptions):
- If a Staff Profile block appears in the prompt, use that person's name, designation, projects, and manager verbatim. Never substitute, guess, or infer a different person.
- The village or location from a field entry is the activity site where work was done — it is NOT the project headquarters or the NGO office.
- Photos and visual documentation must only be referenced if explicitly provided in the input data. Do not suggest or imply photos exist unless the data includes attachment URLs.
- When an Individual Activity Record includes a "Photo:" line, that line's value is a real link starting with "https://drive.google.com/" or "https://lh3.googleusercontent.com/". You may embed that photo inline, alone on its own line, as: an exclamation mark, then the caption in square brackets, then in parentheses the ACTUAL LINK COPIED CHARACTER-FOR-CHARACTER from that "Photo:" line — for example: an image line whose parenthesised part is exactly https://drive.google.com/file/d/1AbCdEfGhIjK/view (not a description of it). NEVER write the literal words "Photo URL" or "[link]" or any other placeholder in place of the real link — if you cannot see a real https:// link for that record, do not add an image line at all. Spread 3–6 of the most representative photos across the report rather than embedding every single one, and never embed a photo for a record that has no "Photo:" line.
- Each Individual Activity Record includes a "Reported By" field naming the field worker who logged it, available for grounding/traceability. Whether the report names individuals or speaks only collectively about "the team"/"the project" is governed by the specific task instruction above — follow that framing exactly and do not default to per-activity individual attribution unless the instruction explicitly asks for it.
- Case studies and human stories must be grounded in the actual field entries. Do not invent beneficiaries, dialogue, or outcomes not evidenced in the data.
- Do NOT add unsolicited case studies to MIS, Board, Government, or Compliance report types.
- Never fabricate statistics, percentages, or beneficiary counts. If a number is not in the data, say so.

Always ask: "what does this number mean for a real person in the field?"
Respond in well-structured Markdown.`

    // ── Run NLP analysis + system-prompt fetch IN PARALLEL ────────────────────
    send({ text: '🧠 *Analysing field data...*\n\n' })
    const [nlpContext, sysBase, sector] = await Promise.all([
      analyzeFieldData(reports, instruction, req.user?.orgId).catch(() => ({})),
      getOrgPrompt(req.user?.orgId, 'report_field_system', DEFAULT_SYS),
      getOrgSector(req.user?.orgId),
    ])
    // Apply sector overlay (fisheries / education / health / etc.) so the
    // model uses domain vocabulary, donor conventions, and safeguarding rules.
    const overlay = sectorOverlay(sector, 'report_field_system')
    const sysText = overlay ? `${sysBase}\n\n${overlay}` : sysBase

    send({ text: '📝 *Writing your report...*\n\n' })

    // ── Smart model selection + per-org daily rate limiting ───────────────────
    const wantsPro = pickReportUrl(instruction || '', apiKey) !== GEMINI_FLASH_URL(apiKey)
    const { downgraded } = trackAndCheck(req.user?.orgId, wantsPro ? 'pro' : 'flash')
    if (downgraded) send({ text: '⚡ *Flash model (daily Pro quota reached)...*\n\n' })

    const reportUrl  = (wantsPro && !downgraded) ? pickReportUrl(instruction || '', apiKey) : GEMINI_FLASH_URL(apiKey)
    const reportPrompt = buildReportPrompt(userName, reports, filters, instruction, audience, language, orgName, nlpContext, staffProfile, subjects, kind, subjectProfiles, supplementaryData)
    const actualTier   = (wantsPro && !downgraded) ? 'pro' : 'flash'

    // 65536 is the model's own output ceiling; lower limits silently cut long
    // donor/MIS reports off mid-report.
    const REPORT_MAX_OUTPUT_TOKENS = 65536

    // Track cost — fire-and-forget, never blocks
    trackUsage(req.user?.orgId, {
      service:         'report_ai',
      model:           actualTier,
      inputLength:     reportPrompt.length + sysText.length,
      maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
      wasDowngraded:   downgraded,
    })

    const geminiRes = await fetch(reportUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: reportPrompt }] }],
        systemInstruction: {
          parts: [{ text: sysText }],
        },
        generationConfig: { maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS, temperature: 0.72 },
      }),
    })

    if (!geminiRes.ok || !geminiRes.body) {
      const errText = await geminiRes.text()
      console.error(`[gemini] HTTP ${geminiRes.status}:`, errText.slice(0, 500))
      let hint = ''
      if (geminiRes.status === 400 && errText.includes('API_KEY_INVALID')) hint = '\n\n**Hint:** API key is invalid.'
      if (geminiRes.status === 403) hint = '\n\n**Hint:** API key may be invalid or lacks Gemini API access.'
      if (geminiRes.status === 429) hint = '\n\n**Hint:** Rate limit hit — wait a minute and try again.'
      if (geminiRes.status === 404) hint = '\n\n**Hint:** Model not found.'
      send({ text: `### Gemini API Error (${geminiRes.status})\n\n\`\`\`\n${errText.slice(0, 800)}\n\`\`\`${hint}` })
      res.end(); return
    }

    // Capture the streamed output so we can run a post-flight grounding check.
    // Deterministic-only (fast, no extra LLM cost). The full LLM judge runs
    // when the user saves the report via POST /api/saved-reports.
    let captured = ''
    const captureSend = (chunk) => {
      if (typeof chunk?.text === 'string') captured += chunk.text
      send(chunk)
    }
    await pipeGeminiStream(geminiRes, res, captureSend, signal)

    if (captured && Array.isArray(reports) && reports.length > 0 && !signal?.aborted) {
      try {
        // Ground against the reference blocks too, otherwise correct figures taken
        // from them get flagged as unsourced. Each block becomes a pseudo-row.
        const groundingSources = [
          ...reports,
          ...supplementaryData
            .filter(b => b && typeof b.content === 'string' && b.content.trim())
            .map(b => ({ project: String(b.label || ''), description: b.content })),
        ]
        const verdict = await checkHallucination(captured, groundingSources, {
          orgId: req.user?.orgId,
          kind: 'report_stream',
        })
        if (verdict.severity === 'high' || verdict.severity === 'medium') {
          send({
            text: `\n\n---\n\n> ⚠️ **Grounding check** — ${verdict.reasons.slice(0, 3).join(' · ')}. Review flagged figures before sharing externally.`,
          })
        }
      } catch { /* never break the stream */ }
    }

  } catch (e) {
    if (!signal?.aborted) {
      sendSSE(res, { error: e instanceof Error ? e.message : 'Unknown error' })
    }
    res.end()
  }
})

// ── POST /api/prewarm ─────────────────────────────────────────────────────────
// Fire-and-forget: seeds the analyzeFieldData cache BEFORE the user clicks
// Generate. Frontend calls this when ContentHub opens; response is instant.
router.post('/prewarm', async (req, res) => {
  res.json({ ok: true })                                // respond immediately
  const { reports: _prewarmReports, instruction = '' } = req.body || {}
  // Rate limiting for this route is applied in server.js
  const prewarmReports = Array.isArray(_prewarmReports) ? _prewarmReports.slice(0, 2000) : []
  if (prewarmReports.length > 0) {
    analyzeFieldData(prewarmReports, instruction, req.user?.orgId).catch(() => {})   // async, no-op on error
  }
})

// ── POST /api/drive-folder ────────────────────────────────────────────────────
router.post('/drive-folder', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')

  try {
    const apiKey = (process.env.GOOGLE_DRIVE_API_KEY || process.env.GEMINI_API_KEY || '')
      .trim().replace(/^["']|["']$/g, '')

    if (!apiKey) {
      res.end(JSON.stringify({ error: 'Set GEMINI_API_KEY (or GOOGLE_DRIVE_API_KEY) as an environment variable.' }))
      return
    }

    const { folderId } = req.body || {}
    if (!folderId) { res.end(JSON.stringify({ error: 'folderId is required' })); return }

    const q   = encodeURIComponent(`'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/')`)
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&key=${apiKey}&fields=files(id,name,mimeType,createdTime,thumbnailLink)&pageSize=200&orderBy=createdTime+desc`

    const driveRes = await fetch(url)
    const data     = await driveRes.json()

    if (!driveRes.ok || data.error) {
      const reason = data?.error?.details?.[0]?.reason || ''
      if (reason === 'API_KEY_SERVICE_BLOCKED' || data?.error?.code === 403) {
        res.end(JSON.stringify({
          error: 'Google Drive API is not enabled on this API key.\n\nEnable it at:\nhttps://console.cloud.google.com/apis/library/drive.googleapis.com',
        }))
        return
      }
      res.end(JSON.stringify({ error: data?.error?.message || `Drive API error ${driveRes.status}` }))
      return
    }

    const files = (data.files || []).map(f => ({
      id:          f.id,
      name:        f.name,
      mimeType:    f.mimeType,
      createdTime: f.createdTime,
      thumb:       `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`,
      full:        `https://lh3.googleusercontent.com/d/${f.id}`,
      drive:       `https://drive.google.com/file/d/${f.id}/view`,
    }))

    res.end(JSON.stringify({ files }))

  } catch (e) {
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }))
  }
})

// ── POST /api/generate-social-post (SSE) ─────────────────────────────────────
router.post('/generate-social-post', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' })

    return
  }

  setupSSE(res)
  const send   = (payload) => sendSSE(res, payload)
  const signal = makeAbortSignal(req)

  try {
    // The client sends pre-aggregated stats, not raw reports: the raw array is
    // large enough to hit 413 for big orgs.
    const {
      reportCount, totalBenef = 0, states = [], projects = [], areas = [], highlights = '',
      platform, tone, scope, scopeName, language, selectedPhotos, variantHint,
    } = req.body || {}

    if (!Number.isFinite(reportCount) || reportCount <= 0) {
      send({ error: 'No field reports available to base a post on. Adjust your filters and try again.' })
      res.end(); return
    }

    // Fetch up to 4 thumbnails at w320 as base64 for Gemini vision (keeps token
    // spend down). photoContext below must describe only this same set.
    const imageParts = []
    const photosToFetch = (selectedPhotos || []).filter(p => p.thumb).slice(0, 4)
    await Promise.all(
      photosToFetch.map(async (photo, idx) => {
        try {
          // Downsize Drive thumbnail: replace any sz=wNNN with sz=w320
          const thumbUrl = String(photo.thumb).replace(/sz=w\d+/i, 'sz=w320')
          // Client-supplied URL fetched server-side — same host allowlist as
          // /proxy-image, and no redirects (a 30x could bounce to an internal
          // address shared by every tenant's requests).
          const imgRes = await fetchAllowedImage(thumbUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal:  AbortSignal.timeout(8_000),
          })
          if (!imgRes?.ok) return
          const buf    = await imgRes.arrayBuffer()
          const b64    = Buffer.from(buf).toString('base64')
          const mime   = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0]
          imageParts[idx] = { inline_data: { mime_type: mime, data: b64 } }
        } catch { /* skip failed images silently */ }
      })
    )
    // Compact out any gaps from failed fetches
    const fetchedImageParts = imageParts.filter(Boolean)

    // Scoped to photosToFetch so the prompt never describes a photo the model wasn't shown.
    const photoContext = photosToFetch.length > 0
      ? photosToFetch
          .map((p, i) => {
            const date = p.date ? new Date(String(p.date)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
            return `  Photo ${i + 1}: ${p.location || 'field location'}${p.project ? ` · ${p.project}` : ''}${date ? ` · ${date}` : ''}${p.source === 'drive' ? ' (curated)' : ''}`
          })
          .join('\n')
      : null

    const platformGuide = {
      instagram: 'Instagram caption: Open with a strong hook in the first line. 3-5 short paragraphs, emoji-rich, ends with 15-20 relevant hashtags. Hard limit: the ENTIRE caption (including hashtags) must be under 2200 characters.',
      facebook:  'Facebook post: Story-driven, 2-3 paragraphs, conversational and warm. End with a soft call-to-action and 5-8 relevant hashtags.',
      twitter:   'Twitter/X post: Punchy, 1-2 emojis, 2-3 hashtags. Hard limit: the ENTIRE post (including hashtags) must be under 280 characters — count carefully and cut content to fit, never truncate mid-sentence.',
      linkedin:  'LinkedIn post: Professional, insight-driven. 3-4 short paragraphs. Include 5 hashtags.',
    }
    const DEFAULT_PLATFORM_GUIDE = 'Write a clear, engaging social media post appropriate for a general audience.'

    const toneGuide = {
      inspiring:    'Inspiring and uplifting — celebrate human stories and transformation.',
      celebratory:  'Celebratory and proud — milestone achievement tone.',
      professional: 'Professional and data-driven — for stakeholders, donors, and partners.',
      urgent:       'Urgent and action-oriented — calling for support or attention.',
    }
    const DEFAULT_TONE_GUIDE = 'Warm, genuine, and grounded in real field detail.'

    const prompt = `Create a high-impact social media post for ${scope === 'organization' ? 'our entire organization' : `the "${scopeName}" project`}.

**Platform:** ${platform}
**Tone:** ${toneGuide[tone] || DEFAULT_TONE_GUIDE}
**Format guidelines:** ${platformGuide[platform] || DEFAULT_PLATFORM_GUIDE}

**Impact Numbers:**
- Total field reports: ${reportCount}
- Beneficiaries reached: ${Number(totalBenef).toLocaleString('en-IN')}
- States covered: ${states.length} (${states.slice(0, 5).join(', ')}${states.length > 5 ? '…' : ''})
- Active projects: ${projects.length}
- Intervention areas: ${areas.slice(0, 5).join(', ')}

**Highlight field activities:**
${highlights || '(no individual activity highlights available)'}
${fetchedImageParts.length > 0 ? `
**${fetchedImageParts.length} real field photo${fetchedImageParts.length > 1 ? 's' : ''} are attached above (inline images).** These are the exact photos the user has selected to post on social media.
Study what you see in each image — the people, activities, expressions, landscapes, and human moments — and let those real visual details drive the post.
${photoContext ? `Photo metadata:\n${photoContext}` : ''}
The post should feel like it was written by someone who was there and can describe what is in these photos.
` : photoContext ? `\n**Photos selected by the user:**\n${photoContext}\nWrite the post grounded in these specific moments.\n` : ''}
Write a complete, ready-to-publish post. Lead with the most powerful number or human story.
${language ? `\n**Output Language:** Please write the entire post in ${language}.` : ''}
${variantHint ? `\n**Note:** ${variantHint}` : ''}`

    const socialSysText = await getOrgPrompt(
      req.user?.orgId,
      'report_social_system',
      `You are a senior social media strategist and human storyteller for a rural development NGO in India.
Your posts must feel authentically human — not AI-generated or corporate.
Lead with a specific moment, person, or village that makes the reader feel something real.
Use numbers to surprise, not to impress — one well-placed stat beats a list of five.
Output ONLY the final post text, ready to publish. No preamble, no formatting notes, no markdown hints.`
    )

    // Build multimodal parts: images first (context), then text prompt
    const userParts = [
      ...fetchedImageParts,   // inline_data image parts (may be empty)
      { text: prompt },
    ]

    // Track cost — fire-and-forget
    trackUsage(req.user?.orgId, {
      service:         'social_post',
      model:           'flash',
      inputLength:     prompt.length + socialSysText.length,
      maxOutputTokens: 1024,
    })

    // Social posts use Flash — creative writing doesn't need Pro reasoning (saves ~85% cost)
    const geminiRes = await fetch(GEMINI_FLASH_URL(apiKey), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify({
        contents: [{ role: 'user', parts: userParts }],
        systemInstruction: {
          parts: [{ text: socialSysText }],
        },
        generationConfig: { maxOutputTokens: 1024, temperature: 0.85 },
      }),
    })

    if (!geminiRes.ok || !geminiRes.body) {
      const errText = await geminiRes.text()
      send({ error: `Gemini error ${geminiRes.status}: ${errText.slice(0, 300)}` })
      res.end(); return
    }

    await pipeGeminiStream(geminiRes, res, send, signal)

  } catch (e) {
    if (!signal?.aborted) {
      sendSSE(res, { error: e instanceof Error ? e.message : 'Unknown error' })
    }
    res.end()
  }
})

// ── POST /api/analyze-report-impact ──────────────────────────────────────────
// Theory of Change attribution + vernacular idiom decoder; returns structured JSON.
// gemini-2.5-flash may emit thought parts (part.thought === true); those are skipped.
const GEMINI_JSON_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

// Strip markdown code fences that some model versions add despite responseMimeType
function extractJson(raw) {
  if (!raw) return null
  // Try direct parse first
  const trimmed = raw.trim()
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  // Strip ```json ... ``` or ``` ... ``` wrappers
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try { return JSON.parse(fenced) } catch { /* fall through */ }
  // Last resort: extract first {...} block
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch { /* fall through */ }
  }
  return null
}

router.post('/analyze-report-impact', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' })

  const { description, location, state } = req.body || {}
  if (!description?.trim()) return res.status(400).json({ error: 'description is required' })

  const locationCtx = [location, state].filter(Boolean).join(', ')

  const prompt = `You are an expert in development sector Theory of Change (ToC) frameworks and rural Indian socio-linguistic analysis.

Analyse the following field activity report entry${locationCtx ? ` from ${locationCtx}` : ''} and return a JSON object with exactly these keys:

1. "toc_category": exactly one of: "Activity", "Output", "Outcome", or "Impact"
   Activity=action taken | Output=countable direct result | Outcome=behaviour change | Impact=systemic change

2. "toc_justification": ONE sentence only — why this tier fits.

3. "translated_description": max 3 sentences — professional English rewrite decoding any Hindi/regional idioms. Preserve all facts.

4. "vernacular_idioms": array of {original, meaning} — only genuine idioms/metaphors, max 3. Empty array [] if none.

5. "systemic_barriers": array of short strings, max 3. Empty array [] if none evident.

Field Report Entry:
"${description.trim()}"

Return ONLY the JSON object. No markdown fences, no prose outside JSON.`

  try {
    const geminiRes = await fetch(GEMINI_JSON_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens:  2048,
          temperature:      0.3,
          thinkingConfig:   { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!geminiRes.ok) {
      const errText = await geminiRes.text()
      console.error('[analyze-report-impact] Gemini HTTP error:', geminiRes.status, errText.slice(0, 400))
      return res.status(502).json({ error: `AI service error (${geminiRes.status})` })
    }

    const data = await geminiRes.json()

    // Log finish reason so we can see blocks / truncations in prod logs
    const finishReason = data?.candidates?.[0]?.finishReason
    if (finishReason && finishReason !== 'STOP') {
      console.warn('[analyze-report-impact] finishReason:', finishReason,
        JSON.stringify(data?.promptFeedback || {}).slice(0, 200))
    }

    // Skip thought parts (internal reasoning); concatenating them corrupts the JSON.
    const parts = data?.candidates?.[0]?.content?.parts || []
    const raw   = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()

    const analysis = extractJson(raw)
    if (!analysis) {
      console.error('[analyze-report-impact] JSON extraction failed. raw:', raw.slice(0, 300))
      return res.status(502).json({ error: 'AI returned malformed response' })
    }

    // Validate shape — fill defaults for any missing keys
    const result = {
      toc_category:           String(analysis.toc_category || 'Activity'),
      toc_justification:      String(analysis.toc_justification || ''),
      translated_description: String(analysis.translated_description || description),
      vernacular_idioms:      Array.isArray(analysis.vernacular_idioms) ? analysis.vernacular_idioms : [],
      systemic_barriers:      Array.isArray(analysis.systemic_barriers) ? analysis.systemic_barriers : [],
    }

    // Track usage — fire-and-forget
    trackUsage(req.user?.orgId, {
      service:         'report_toc_analysis',
      model:           'flash',
      inputLength:     prompt.length,
      maxOutputTokens: 1024,
    })

    res.json(result)
  } catch (e) {
    console.error('[analyze-report-impact]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/analyze-toc-aggregate ──────────────────────────────────────────
// Aggregate Theory of Change analysis backed by quantitative data.
// Pre-computes accurate breakdown tables (by project, area, state, month) and
// passes them to Gemini so the narrative cites real numbers, not estimates.

// Helper: group reports and sum beneficiaries, return sorted array
function groupBy(reports, keyFn) {
  const map = new Map()
  for (const r of reports) {
    const k = keyFn(r)
    if (!k) continue
    const e = map.get(k) || { count: 0, benef: 0 }
    e.count++
    e.benef += parseInt(String(r.beneficiaries ?? 0)) || 0
    map.set(k, e)
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.benef - a.benef)
}

router.post('/analyze-toc-aggregate', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' })

  const { reports: _reports, scopeLabel = 'the organisation' } = req.body || {}
  if (!Array.isArray(_reports) || _reports.length === 0)
    return res.status(400).json({ error: 'reports array is required' })

  const all        = _reports.slice(0, 5000)
  const totalBenef = all.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
  const avgBenef   = all.length ? Math.round(totalBenef / all.length) : 0
  const dateRange  = all.length > 0
    ? `${String(all[0].timestamp).slice(0, 10)} to ${String(all[all.length - 1].timestamp).slice(0, 10)}`
    : 'N/A'

  // ── Pre-compute breakdowns ────────────────────────────────────────────────
  const byProject = groupBy(all, r => r.project)
  const byArea    = groupBy(all, r => r.areaOfIntervention)
  const byState   = groupBy(all, r => r.state)

  // Monthly trend (last 12 months)
  const byMonth = new Map()
  for (const r of all) {
    const m = String(r.timestamp).slice(0, 7)   // YYYY-MM
    if (!m || m.length < 7) continue
    const e = byMonth.get(m) || { count: 0, benef: 0 }
    e.count++
    e.benef += parseInt(String(r.beneficiaries ?? 0)) || 0
    byMonth.set(m, e)
  }
  const monthlyTrend = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, v]) => ({ month, ...v }))

  // Compact table formatter for prompt
  const tableLines = (rows, limit = 10) =>
    rows.slice(0, limit)
      .map(r => `  ${r.name}: ${r.count} reports, ${r.benef.toLocaleString('en-IN')} beneficiaries`)
      .join('\n')

  // Full descriptions — no truncation so Gemini can read every report carefully.
  // gemini-2.5-flash has a 1M-token input context; even 2000 reports at ~150 words
  // each is ~300k tokens, well within limit.
  const reportLines = all.map((r, i) =>
    `${i + 1}.[${String(r.timestamp).slice(0, 10)}, ${r.location ?? ''}, ${r.state ?? ''}, ${r.areaOfIntervention ?? ''}] ${String(r.description || '').trim()}`
  ).join('\n')

  const prompt = `You are a senior development-sector M&E strategist specialising in Theory of Change (ToC) for rural India programmes.

Read every field report description below carefully and in full before forming any conclusions. The descriptions are the primary evidence; the quantitative summary provides verified counts to cite.

═══ QUANTITATIVE SUMMARY (pre-computed, use these exact numbers) ═══
Scope: ${scopeLabel}
Total Reports: ${all.length}
Total Beneficiaries: ${totalBenef.toLocaleString('en-IN')}
Average Beneficiaries/Report: ${avgBenef}
Date Range: ${dateRange}

By Area of Intervention (top 10):
${tableLines(byArea)}

By Project (top 10):
${tableLines(byProject)}

By State:
${tableLines(byState, 15)}

Monthly Trend (last 12 months):
${monthlyTrend.map(m => `  ${m.month}: ${m.count} reports, ${m.benef.toLocaleString('en-IN')} beneficiaries`).join('\n')}

═══ FIELD REPORT DESCRIPTIONS (read each one in full) ═══
Format: [date, location, state, area] description
${reportLines}

After reading all ${all.length} reports, return a JSON object with exactly these keys in this order:

1. "toc_distribution": {Activity, Output, Outcome, Impact} — integers summing to 100. Classify each report by reading what actually happened: Activity=action/process, Output=countable direct result, Outcome=behaviour/attitude change in beneficiaries, Impact=systemic/policy-level change.

2. "quantitative_insights": array of 4–8 strings — as many as the data genuinely supports. Each must cite a specific number from the summary AND a pattern you read in the descriptions. Do not pad with generic observations; only include real insights.

3. "change_pathway": array of exactly 5 strings — the actual logical chain you see in this data, from inputs to impact. Max 8 words each.

4. "key_themes": array of exactly 5 strings, 3–5 words each — themes that recur across multiple descriptions.

5. "top_barriers": array of 4–8 objects {barrier: string (max 6 words), note: string (max 20 words), suggestion: string (max 25 words — a concrete, actionable recommendation to overcome this specific barrier)} — every distinct systemic barrier you observed. Include all that are genuinely evidenced.

6. "key_issues": array of 4–8 objects identifying operational or programmatic problems visible in the reports:
   {
     "issue": string (max 6 words — the issue title),
     "evidence": string (max 25 words — what in the descriptions reveals this issue),
     "severity": "high" | "medium" | "low",
     "suggestion": string (max 30 words — specific, practical action to address it)
   }
   These are distinct from systemic barriers — focus on implementation gaps, data quality problems, coverage inequities, or missed ToC connections you see in the reports.

7. "common_idioms": array of up to 4 {original, meaning} objects — Hindi/regional idioms or metaphors actually present in the descriptions. Empty array [] if none.

8. "toc_narrative": string — 3 paragraphs (max 180 words total) grounded in what you read. Cite real examples from specific reports where possible. Paragraphs separated by \\n\\n.

Return ONLY the JSON object. No markdown fences.`

  try {
    const geminiRes = await fetch(GEMINI_JSON_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens:  8192,
          temperature:      0.4,
          // Thinking tokens count against maxOutputTokens here and can leave
          // nothing for the JSON, so disable thinking.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!geminiRes.ok) {
      const errText = await geminiRes.text()
      console.error('[analyze-toc-aggregate] Gemini HTTP error:', geminiRes.status, errText.slice(0, 300))
      return res.status(502).json({ error: `AI service error (${geminiRes.status})` })
    }

    const data = await geminiRes.json()

    const finishReason = data?.candidates?.[0]?.finishReason
    if (finishReason && finishReason !== 'STOP') {
      console.warn('[analyze-toc-aggregate] finishReason:', finishReason)
    }

    const parts = data?.candidates?.[0]?.content?.parts || []
    const raw   = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()

    const analysis = extractJson(raw)
    if (!analysis) {
      console.error('[analyze-toc-aggregate] JSON extraction failed. raw:', raw.slice(0, 300))
      return res.status(502).json({ error: 'AI returned malformed response' })
    }

    const dist = analysis.toc_distribution || {}
    const result = {
      toc_distribution: {
        Activity: Number(dist.Activity ?? 0),
        Output:   Number(dist.Output   ?? 0),
        Outcome:  Number(dist.Outcome  ?? 0),
        Impact:   Number(dist.Impact   ?? 0),
      },
      quantitative_insights: Array.isArray(analysis.quantitative_insights) ? analysis.quantitative_insights : [],
      change_pathway:        Array.isArray(analysis.change_pathway)        ? analysis.change_pathway        : [],
      key_themes:            Array.isArray(analysis.key_themes)            ? analysis.key_themes            : [],
      top_barriers:          Array.isArray(analysis.top_barriers)          ? analysis.top_barriers          : [],
      key_issues:            Array.isArray(analysis.key_issues)            ? analysis.key_issues            : [],
      common_idioms:         Array.isArray(analysis.common_idioms)         ? analysis.common_idioms         : [],
      toc_narrative:         String(analysis.toc_narrative || ''),
      // Pre-computed breakdowns returned as-is (accurate, no AI estimation)
      breakdowns: {
        by_area:    byArea.slice(0, 12),
        by_project: byProject.slice(0, 12),
        by_state:   byState.slice(0, 15),
        by_month:   monthlyTrend,
      },
      meta: {
        total_reports: all.length,
        total_benef:   totalBenef,
        avg_benef:     avgBenef,
        scope_label:   scopeLabel,
        date_range:    dateRange,
      },
    }

    trackUsage(req.user?.orgId, {
      service:         'toc_aggregate_analysis',
      model:           'flash',
      inputLength:     prompt.length,
      maxOutputTokens: 2048,
    })

    res.json(result)
  } catch (e) {
    console.error('[analyze-toc-aggregate]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Only allow fetching from known safe image hosts.
const ALLOWED_IMAGE_HOSTS = new Set([
  'lh3.googleusercontent.com',
  'drive.google.com',
  'storage.googleapis.com',
  'docs.google.com',
])

function isAllowedImageUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    // Allow exact match or subdomain of allowed hosts
    return [...ALLOWED_IMAGE_HOSTS].some(h => host === h || host.endsWith('.' + h))
  } catch { return false }
}

// Fetch an allowlisted image URL, following up to 3 redirects manually and
// re-checking every hop against the allowlist (Drive thumbnails 302 to
// googleusercontent; an unchecked auto-follow could land on an internal host).
async function fetchAllowedImage(url, opts = {}) {
  let current = url
  for (let hop = 0; hop <= 3; hop++) {
    if (!isAllowedImageUrl(current)) return null
    const r = await fetch(current, { ...opts, redirect: 'manual' })
    if (r.status < 300 || r.status >= 400) return r
    const loc = r.headers.get('location')
    if (!loc) return null
    current = new URL(loc, current).toString()
  }
  return null
}

// ── GET /api/proxy-image?url=... ──────────────────────────────────────────────
router.get('/proxy-image', async (req, res) => {
  const url = req.query.url
  if (!url || typeof url !== 'string') { res.status(400).end('Missing url parameter'); return }
  if (!isAllowedImageUrl(url)) {
    res.status(403).end('URL not permitted')
    return
  }
  try {
    const imgRes = await fetchAllowedImage(url, {
      // A bare UA-only request occasionally gets a non-image response back
      // from Drive's thumbnail endpoint (an HTML interstitial instead of
      // image bytes) — a fuller browser-like header set is more reliable.
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://drive.google.com/',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!imgRes) { res.status(403).end('URL not permitted'); return }
    if (!imgRes.ok) {
      console.error(`proxy-image: upstream ${imgRes.status} for`, url)
      res.status(imgRes.status).end()
      return
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg'
    if (!contentType.startsWith('image/')) {
      console.error(`proxy-image: non-image content-type "${contentType}" for`, url)
      res.status(415).end('Not an image')
      return
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    const buffer = await imgRes.arrayBuffer()
    res.end(Buffer.from(buffer))
  } catch (e) {
    console.error('proxy-image: fetch failed for', url, e)
    res.status(500).end('Failed to fetch image')
  }
})

export default router
