// routes/prompts.routes.js — Per-organisation AI Prompt customisation
//
// GET    /api/prompts            — all 14 prompts merged with org overrides
// PUT    /api/prompts/:id        — save / update an org override
// DELETE /api/prompts/:id        — reset a prompt to system default
//
// Requires: admin or superadmin role.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { invalidateOrgPrompts } from '../lib/promptStore.js'

const router = Router()

// ── Auth guards ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' })
  next()
}

function requireAdmin(req, res, next) {
  const role = req.user?.role
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required to manage prompts.' })
  }
  next()
}

// ── Auto-migrate: ensure org_prompts table exists (idempotent) ───────────────
let _migrated = false
async function ensureTable(pool) {
  if (_migrated) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_prompts (
      id          SERIAL PRIMARY KEY,
      org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      prompt_id   TEXT        NOT NULL,
      prompt_text TEXT        NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'active',
      notes       TEXT        NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by  TEXT        NOT NULL DEFAULT '',
      UNIQUE (org_id, prompt_id)
    );
    CREATE INDEX IF NOT EXISTS org_prompts_org_idx ON org_prompts (org_id);
  `)
  _migrated = true
}

// ── System defaults catalogue ─────────────────────────────────────────────────
// Single source of truth for default prompt text.
export const SYSTEM_PROMPTS = {
  report_field_system: {
    feature:     'Field Report',
    type:        'system_instruction',
    description: 'System role for AI field report generation.',
    text:        'You are an expert field work analyst for a rural development NGO. Write clear, insightful reports that highlight impact and provide actionable recommendations. Always respond in well-structured Markdown.',
  },
  report_field_user: {
    feature:     'Field Report',
    type:        'user_prompt',
    description: 'User turn for field report. Injects filtered field data, audience guide, custom instruction.',
    text:        'You are generating content for {{userName}} from {{orgName}}.\n\n**Your Task:**\n{{instruction}}\n\n**Field Data Summary:**\n- Total Activities: {{count}}\n- Date Range: {{dateRange}}\n- Total Beneficiaries: {{total}}\n- States Covered: {{states}}\n- Areas of Intervention: {{areas}}\n\n**Individual Activity Records:**\n{{activities}}\n\n[Audience guide and language note injected at runtime]',
  },
  report_social_system: {
    feature:     'Social Post',
    type:        'system_instruction',
    description: 'System role for social media post generation.',
    text:        'You are a senior social media strategist for a leading rural development NGO in India. Output only the final post text — no preamble, no markdown formatting hints.',
  },
  report_social_user: {
    feature:     'Social Post',
    type:        'user_prompt',
    description: 'User turn for social post. Platform guide, tone, impact numbers.',
    text:        'Create a high-impact social media post for {{scope}}.\n\n**Platform:** {{platform}}\n**Tone:** {{tone}}\n**Format guidelines:** {{platformGuide}}\n\n**Impact Numbers:**\n- Total field reports: {{count}}\n- Beneficiaries reached: {{total}}\n- States covered: {{states}}\n\n**Highlight field activities:**\n{{highlights}}\n\nWrite a complete, ready-to-publish post. Lead with the most powerful number or human story.',
  },
  rw_learn_system: {
    feature:     'RW Learn (Voice Profile)',
    type:        'system_instruction',
    description: 'Writing analyst. Builds voice profile JSON from past writing samples.',
    text:        "You are a writing analyst for a rural development NGO. Build a voice profile from a contributor's past writing. Output ONLY a valid JSON object matching the specified schema. Never invent characteristics — every attribute must be grounded in the text.",
  },
  rw_learn_user: {
    feature:     'RW Learn (Voice Profile)',
    type:        'user_prompt',
    description: '9-field JSON voice profile from up to 3 writing samples.',
    text:        'CONTRIBUTOR: {{contributor}}\nEXISTING PROFILE: {{existingProfile}}\n\nPAST WRITING SAMPLES:\n{{srcBlock}}\n\nAnalyse the writing samples above and return a JSON object with exactly these fields:\n{\n  "avgSentenceLength": "short|medium|long",\n  "dominantTense": "past|present|mixed",\n  "formalityLevel": "high|medium|low",\n  "preferredConnectors": ["top 5 connecting words/phrases actually found in the text"],\n  "avoidedWords": ["NGO/donor jargon absent from the writing"],\n  "blindSpots": ["report sections consistently absent or thin"],\n  "anchorSentences": ["3 to 5 verbatim sentences that best represent this contributor\'s voice"],\n  "recurringPitfalls": [],\n  "lastLearnDate": "{{today}}"\n}\n\nRules: anchorSentences must be verbatim from the text. Output ONLY the JSON object.',
  },
  rw_draft_system: {
    feature:     'RW Draft',
    type:        'system_instruction',
    description: 'Field report writer. 6 hard rules — no fabrication, traceable numbers, verbatim quotes.',
    text:        "You are a field report writer for Jal Jeevika, a rural development NGO focused on inland fisheries, water stewardship, and livelihoods in India.\n\nHARD RULES:\n1. Never fabricate field details. Write ⟨MISSING: description⟩ for absent info.\n2. Every number must trace to source data.\n3. Quotes must appear verbatim from source text.\n4. Write in English. Regional terms in italics with gloss.\n5. No donor-speak.\n6. Follow template section order exactly. Use ## headings.",
  },
  rw_draft_user: {
    feature:     'RW Draft',
    type:        'user_prompt',
    description: 'Injects report type, voice profile, glossary, recent corrections, raw sources.',
    text:        'REPORT TYPE: {{reportType}}\nCONTRIBUTOR: {{contributor}}\n\n=== CONTRIBUTOR VOICE PROFILE ===\n{{profileBlock}}\n\n=== TEMPLATE — follow these sections in order ===\n{{sections}}\n\n=== CONFIRMED GLOSSARY (use these exact terms) ===\n{{glossary}}\n\n=== RECENT EDITOR CORRECTIONS (do not repeat these mistakes) ===\n{{recentLessons}}\n\n=== RAW SOURCE DATA ===\n{{srcBlock}}',
  },
  rw_refine_system: {
    feature:     'RW Refine',
    type:        'system_instruction',
    description: 'Writing coach. Compares draft vs final, extracts JSON lessons + profile updates.',
    text:        'You are a writing coach for an NGO field reporting system. Compare draft vs final, classify every meaningful change, extract lessons. Output the JSON array first, then PROFILE_UPDATES: followed by its JSON object. Nothing else.',
  },
  rw_refine_user: {
    feature:     'RW Refine',
    type:        'user_prompt',
    description: 'Draft vs final comparison — 5 categories: Voice/Structure/Vocabulary/Factual/Omission.',
    text:        'CONTRIBUTOR: {{contributor}}\nREPORT TYPE: {{reportType}}\n\n=== DRAFT (AI-generated) ===\n{{draftMd}}\n\n=== FINAL (contributor-edited) ===\n{{finalMd}}\n\nCompare the two versions. For each meaningful change:\n1. Identify before-text (draft) and after-text (final).\n2. Classify: Voice / Structure / Vocabulary / Factual / Omission\n3. Write one lesson: "In future: ..."\n\nReturn a JSON array FIRST, then PROFILE_UPDATES:\n[{"category":"...","beforeText":"...","afterText":"...","lesson":"In future: ..."}]\n\nPROFILE_UPDATES: {"avoidedWords":[],"blindSpots":[],"recurringPitfalls":[]}',
  },
  rw_reflect_system: {
    feature:     'RW Reflect',
    type:        'system_instruction',
    description: 'Learning system. Finds recurring patterns in correction history.',
    text:        "You are a learning system for an NGO field reporting tool. Find recurring patterns in a contributor's correction history and consolidate them into actionable profile updates. Output ONLY the specified JSON object.",
  },
  rw_reflect_user: {
    feature:     'RW Reflect',
    type:        'user_prompt',
    description: 'Last 30 corrections → top 3 pitfalls + glossary promotion candidates.',
    text:        'CONTRIBUTOR: {{contributor}}\nCURRENT PROFILE:\n{{profile}}\n\nRECENT CORRECTION HISTORY (last 4 weeks):\n{{feedbackBlock}}\n\nTasks:\n1. Identify the top 3 recurring pitfalls (patterns appearing in 2+ corrections).\n2. Identify glossary terms appearing consistently (3+ times) — candidates for promotion.\n3. Update the recurringPitfalls array.\n\nReturn ONLY this JSON object:\n{\n  "recurringPitfalls": ["..."],\n  "termPromotions": ["term1"],\n  "profileNote": "One paragraph summary of this contributor\'s patterns this period."\n}',
  },
  rw_polish_system: {
    feature:     'RW Auto-Polish',
    type:        'system_instruction',
    description: 'NGO report editor. Polishes draft while preserving voice.',
    text:        'You are an NGO report editor. Polish the draft to match the contributor voice profile. Output ONLY the final polished markdown.',
  },
  rw_polish_user: {
    feature:     'RW Auto-Polish',
    type:        'user_prompt',
    description: 'Resolves ⟨MISSING⟩ from sources, matches voice, fixes pitfalls. 5 hard rules.',
    text:        'Polish this NGO field report draft. Do NOT add any fact not in sources or draft.\n\nVOICE PROFILE:\n{{voiceBlock}}\n\nRULES:\n1. No invented facts, numbers, names, dates.\n2. Resolve ⟨MISSING: ...⟩ placeholders where the answer is in sources; otherwise leave them.\n3. Match contributor voice (length, tense, formality, connectors).\n4. Fix listed pitfalls.\n5. Output ONLY the polished markdown.\n\nREPORT TYPE: {{reportType}}\n\n=== DRAFT ===\n{{draftMd}}\n\n=== SOURCES (for resolving MISSING) ===\n{{srcBlock}}',
  },

  // ── Content Hub — Notebook ────────────────────────────────────────────────
  notebook_chat_system: {
    feature:     'Notebook Chat',
    type:        'system_instruction',
    description: 'Research assistant that answers questions using only the uploaded sources, with inline citations.',
    text:        'You are a research assistant. Answer ONLY using the provided sources. When you use information from a source, cite it as [Source: name]. Be concise and accurate.',
  },
  notebook_audio_system: {
    feature:     'Notebook Audio Overview',
    type:        'system_instruction',
    description: 'Podcast script writer. Produces a two-host dialogue — every line must start with "ALEX: " or "JORDAN: ".',
    text:        'You are a podcast script writer. Create natural, engaging dialogue. Every line MUST start with "ALEX: " (for the first host) or "JORDAN: " (for the second host). Hosts call each other by their names within the dialogue. No stage directions, no other formatting. Write exclusively in the requested language.',
  },
  notebook_video_system: {
    feature:     'Notebook Video Overview',
    type:        'system_instruction',
    description: 'Documentary narration writer for the Video Overview. Two narrators — every line must start with "ALEX: " or "JORDAN: ". (The "this is a video, never call it a podcast" rule is always added on top.)',
    text:        'You are a narration writer for short, grounded, information-rich videos with their own on-screen visuals. Write in the tone requested for each video (energetic explainer, calm documentary, news report, storytelling or inspiring), with a real fact in nearly every line and no hype or invented drama — and never call it a podcast, show or episode. ALEX is the male narrator, JORDAN the female field correspondent. Every line MUST start with "ALEX: [tone] " or "JORDAN: [tone] ". No stage directions beyond the bracketed tone cue, no other formatting, no emoji. Ground every claim in the provided sources. Write exclusively in the requested language.',
  },
  notebook_study_system: {
    feature:     'Notebook Study Guide',
    type:        'system_instruction',
    description: 'Research analyst that produces structured study materials (summary, FAQ, timeline, briefing) in Markdown.',
    text:        'You are a research analyst. Create clear, well-structured study materials in Markdown. Be thorough but concise.',
  },
  notebook_slides_system: {
    feature:     'Notebook Slide Deck',
    type:        'system_instruction',
    description: 'Presentation designer. Returns ONLY a valid JSON array of 10 slides — no markdown fences, no explanation.',
    text:        'You are a presentation designer. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON array. Never use literal newline characters inside JSON string values.',
  },
  notebook_slide_revise_system: {
    feature:     'Notebook Slide Revise',
    type:        'system_instruction',
    description: 'Presentation designer for single-slide revisions. Returns ONLY a valid JSON object for the updated slide.',
    text:        'You are a presentation designer. Return ONLY a single valid JSON object — no array, no markdown fences, no explanation. Never use literal newline characters inside JSON string values.',
  },

  // ── Content Hub — Report Instructions ────────────────────────────────────
  ch_self: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Monthly Activity Report for an individual staff member.',
    text:        `Generate a structured Monthly Activity Report for this staff member following this NGO reporting template:\n\n# Monthly Activity Report — [Staff Name] | [Month Year]\n\n## 1. Reporting Period Overview\n- Reporting Period: [date range from entries]\n- Geography Covered: [states and locations from data]\n- Total Field Days: [count unique dates]\n\n## 2. Objectives for the Month\nList objectives based on project and intervention area data. For each:\n- Objective statement\n- Status: Met / Partially Met / Not Met\n- Brief reason if not met\n\n## 3. Key Activities Undertaken\nFor each area of intervention:\n- Activity Name\n- Date(s) and Location / Village / District\n- What was done (from field descriptions)\n- Beneficiaries reached\n\n## 4. Outcomes & Results\n- Quantitative: beneficiaries reached, sessions held, households covered\n- Qualitative: observable changes, community response\n- Any unexpected positive results from the data\n\n## 5. Participant Engagement\n- Total beneficiaries engaged this month\n- Breakdown by project or intervention area\n- Notable participant observations from field descriptions\n\n## 6. Challenges Faced & Mitigation\n| Challenge | Impact | Action Taken / Proposed |\n|-----------|--------|-------------------------|\n\nInfer challenges from field data patterns, gaps, or descriptions.\n\n## 7. Financial Highlights\n- Activities conducted within resource constraints\n- Materials or inputs mentioned in field entries\n- Budget utilisation narrative (infer from activity scope)\n\n## 8. Learnings & Recommendations\n- What worked well this month\n- What could be improved\n- Recommendations for next month\n\n## 9. Plan for Next Month\n- Top 3 priority activities\n- Locations or communities to be visited\n- Support needed from management\n\n## 10. Additional Information for Stakeholders\n- Community events, government meetings, or partner interactions mentioned\n- Photos or documentation produced\n- Any urgent matters requiring attention\n\n---\n*Report generated from field entries. All figures and narratives are evidence-based from submitted field data.*`,
  },
  ch_team: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Monthly Team Activity Report covering all active staff.',
    text:        `Generate a structured Monthly Team Report following this NGO reporting template:\n\n# Monthly Team Activity Report | [Month Year]\n\n## 1. Reporting Period Overview\n- Reporting Period: [date range from entries]\n- Total Team Members Active: [count unique contributors]\n- States / Geographies Covered: [list]\n- Total Field Reports Submitted: [count]\n\n## 2. Team Objectives for the Month\nFor each project and intervention area:\n- Objective statement\n- Achievement Status: Met / Partially Met / Not Met\n- Evidence drawn from field data\n\n## 3. Individual Contributions Summary\n| Staff Name | Reports | Beneficiaries | Key Activities | Locations |\n|------------|---------|---------------|----------------|-----------|\n\nPopulate one row per team member, drawing from their field entries.\n\n## 4. Key Activities & Outcomes by Project\nFor each project, write a subsection:\n- Activities conducted (dates + locations)\n- Beneficiaries reached\n- Outcomes observed\n- Notable milestones or incidents\n\n## 5. Participant Engagement\n- Total beneficiaries reached by the team this period\n- Breakdown by project or intervention area\n- Engagement quality and community response observations\n\n## 6. Collective Impact Highlights\n- Cumulative beneficiary count\n- Geographic reach (states, districts, villages)\n- Cross-cutting themes across team activities\n- 1-paragraph standout success story from the data\n\n## 7. Challenges Faced & Team-Level Mitigation\n| Challenge | Who Affected | Impact Level | Resolution / Support Needed |\n|-----------|--------------|--------------|-----------------------------|\n\nInfer from data patterns, gaps in reporting, or field descriptions.\n\n## 8. Financial Highlights\n- Resource utilisation overview (infer from activity scope)\n- Resource gaps or constraints noted in field entries\n- Materials or inputs referenced across activities\n\n## 9. Collaboration & Coordination\n- Government or partner engagements mentioned in entries\n- Joint or cross-functional activities\n- Inter-team coordination evidence\n\n## 10. Learnings & Team Development\n- What worked well collectively\n- Skills or knowledge gaps observed\n- Training or capacity building needs identified\n\n## 11. Plan for Next Month\n- Team priorities for the coming period\n- Deployment plan overview\n- Management support required\n\n## 12. Additional Stakeholder Information\n- Documentation and photos produced\n- Compliance or regulatory matters\n- Urgent issues requiring leadership attention\n\n---\n*Team report generated from field entries across all active staff. All figures are evidence-based from submitted field data.*`,
  },
  ch_org: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Organization-wide MIS Report covering all projects, states, and impact — for board and senior leadership.',
    text:        `Generate this as a formal Organization Management Information System (MIS) Report — the professional document an NGO programme/MIS team would produce for the Board or senior leadership. The report's SUBJECT is the ENTIRE ORGANIZATION as a whole — every project, every state, and the collective work of every employee across the organization — never structure any section (including the Activity Log) as a per-person breakdown, ranking, or performance review of individuals. Use ONLY the data actually submitted by field staff across the organization, but always speak of "the organization" / "the field teams" as a group; individual names appear only once, together, in the Contributing Team roster below — nowhere else in the report.\n\n**Aggregation integrity — read before writing any number:** Check the "Project × Geography Overlap" data block below before presenting any beneficiary total that spans more than one project — if it lists overlapping locations, every such total (Executive Summary, KPI table, Portfolio Summary) must carry a one-line caveat naming the overlapping projects/locations and stating the figure is a simple sum, not a confirmed deduplicated unique reach; if the block reports no overlap, state totals plainly with no caveat needed. Never present an activity or beneficiary count as an "outcome," "impact," "income enhancement," or "productivity enhancement" — those require verified monitoring & evaluation data this pipeline does not currently supply, so describe only what the field data actually shows: activities conducted and beneficiaries reached (output-level, not outcome-level). If the Field Data Summary or per-project figures show clearly uneven data coverage across projects for this period (one project's entries spanning the full period while another's cover only part of it, or one project logging far fewer entries relative to its usual pace), say so explicitly rather than blending partial and full coverage into one uniform total.\n\n**Write descriptively, with real illustrations:** every narrative section (Executive Summary, the Section 6 area subheadings, Outcomes & Results, Key Learnings, Strategic Priorities) should read as a well-observed account with concrete, specific detail — named locations, activities, and community context drawn from the records — not generic fragments or thin bullet points. Descriptive means vivid and specific, never invented: ground every added detail in what the Individual Activity Records actually show. Spread real field photos through the body rather than confining them to one gallery — see the photo instructions inside Section 6 and Section 7 below.\n\n**Length and depth requirement:** This is a formal board document, not a summary — it must run to a minimum of 10-15 pages once rendered (roughly 4,000-6,000+ words). Every section below must be written in full detail rather than compressed into a few terse lines: expand each Section 6 area-of-intervention subheading into several well-developed paragraphs grounded in the Individual Activity Records for that area; give Sections 4, 8, 9, 11, 13, and 14 multi-paragraph treatment, not single sentences; and populate every table completely. If a section's underlying data is genuinely thin, say so explicitly rather than padding it with filler — but do not default to brevity where the data supports a fuller account. Treat page/word length as a floor, not a target to just barely clear.\n\nFollow this exact template:\n\n# Organization MIS Report — [Reporting Period]\n\n**Report Type:** Organization Management Information System (MIS) Report\n**Prepared By:** [the exact name given at the top of this prompt as the person generating this content — never invent, guess, or substitute a different name]\n**Prepared For:** Board / Senior Leadership\n\n## Executive Summary\nA 5-8 sentence descriptive brief covering total activities logged across the organization, total beneficiaries reached (with the overlap caveat applied if the Project × Geography Overlap block lists any overlapping locations), geography and projects covered, and overall organizational trajectory this period — written about the organization collectively, and grounded in enough specifics (naming at least one standout location, activity, or theme from the data) that it reads as a real account of the period, not a template with numbers dropped in.\n\n## 1. Organization Overview\n- Organization Name: [name from data]\n- Reporting Period: [date range from entries]\n- Projects Covered: [list every distinct project from data]\n- Geography Covered: [states, districts, locations from data]\n- Areas of Intervention: [list]\n\n## 2. Key Performance Indicators\n| Metric | Value |\n|--------|-------|\n| Total Activities Logged | |\n| Total Beneficiaries Reached | |\n| Active Projects | |\n| States / Locations Covered | |\n| Field Staff Contributing | |\n\nPopulate every row using the "Field Data Summary" and "All Contributors" data blocks provided (Field Staff Contributing = the contributor count given there) — these cover the full dataset. Never estimate, round, or recount from the Individual Activity Records list, which may not include every record. Add one caveat line directly beneath the table if the Project × Geography Overlap block lists any overlapping locations.\n\n## 3. Contributing Team\nUse the "All Contributors (full dataset, authoritative)" data block provided — list every name from it, once, as a single collective roster — e.g. "This period's work was delivered by a team of N field staff across the organization: Name1, Name2, Name3...". Do not describe, compare, rank, or attribute specific activities to any one of them elsewhere in the report — this is the only place individual names appear.\n\n## 4. Strategic Scope & Objectives\n- Overall organizational mandate, inferred from the intervention areas and activities present across all projects in the data\n- Key organization-wide objectives for the reporting period\n- Achievement status per objective: Met / Partially Met / Not Met, with supporting evidence\n\n## 5. Portfolio Summary by Project\nSummarise — do NOT list every individual activity row-by-row. A rollup table with one row per distinct Project, using figures aggregated from the full dataset provided — never recount from the Individual Activity Records list, which may omit older records outside its detail cap:\n| Project | Activities Conducted | Beneficiaries Reached | States / Locations Covered |\n|---------|-----------------------|------------------------|------------------------------|\n\nAdd a footnote beneath the table naming any project pairs flagged in the Project × Geography Overlap block, so a reader can see which project totals may overlap.\n\n## 6. Activity Summary by Area of Intervention\nA second rollup table with one row per distinct Area of Intervention: use the exact figures from the "Area of Intervention Breakdown (full dataset, authoritative)" data block provided — never recount from the Individual Activity Records list, which may omit older records outside its detail cap:\n| Area of Intervention | Activities Conducted | Beneficiaries Reached | Locations Covered |\n|----------------------|-----------------------|------------------------|--------------------|\n\nThen, beneath the table, one \`### <Area of Intervention>\` subheading per area with a descriptive 4-6 sentence narrative of what was done in that area across the organization during the period — name specific locations, notable activities, and outcomes so the reader gets a real sense of what happened on the ground, not a generic summary or a list of every date — grounded in the Individual Activity Records available for that area. Immediately beneath each subheading's narrative, if at least one Individual Activity Record for that area has a "Photo:" line, embed one representative photo inline on its own bare line: an exclamation mark, a caption naming the activity/location in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record's "Photo:" line — e.g. \`![Training session, Khagaria](https://drive.google.com/file/d/1AbCdEfGhIjK/view)\`. NEVER write a placeholder link in place of the real one, and never reuse the same photo under more than one area. Do NOT add a "Reported By" or similar per-activity attribution — this section describes what the organization collectively delivered in each area, not who delivered it or a date-by-date log.\n\n## 7. Field Documentation\nA supplementary gallery: 3-6 more significant activities that have a "Photo:" line in their record and were NOT already used as an area's representative photo in Section 6. Embed each real field photo the same way — on its own line, an exclamation mark, the caption in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record's "Photo:" line — e.g. \`![Community meeting, Supaul](https://drive.google.com/file/d/1AbCdEfGhIjK/view)\`. NEVER write the literal words "Photo URL" or any placeholder in place of the real link. If an activity has no "Photo:" line, skip it — do not fabricate one. Captions describe the activity/location, never the individual who reported it. If fewer than 3 additional, non-duplicate photos exist beyond Section 6, include as many as genuinely exist and say so rather than padding with repeats.\n\n## 8. Outcomes & Results\n- Quantitative: total beneficiaries reached, sessions/events held, households/villages/districts covered, across all projects\n- Qualitative: observable changes, community response, and notable shifts in the data — described specifically (what changed, where, among whom), not as generic statements\n\n## 9. Key Learnings\n- What worked well across the organization during the period\n- Unexpected insights surfaced by the field data\n- Practices worth replicating across projects\n\nGround each of the three points above in a specific example from the data (a location, activity, or project it was observed in) rather than stating it as a generic truism.\n\n## 10. Key Challenges\n| Challenge | Impact | Mitigation Taken / Needed |\n|-----------|--------|----------------------------|\n\nInfer challenges from data gaps, recurring issues, or explicit field descriptions.\n\n## 11. Resource & Financial Highlights\n- Resource utilisation narrative across the organization (infer from activity scope and materials/inputs mentioned)\n- Resource constraints or gaps noted in field entries\n\n## 12. Stakeholder & Partner Engagement\n- Government, community, or partner interactions mentioned in the data\n\n## 13. Strategic Priorities — Next Steps\n- Priority activities for the next reporting period\n- Projects, locations/communities to prioritise\n- Support or resources needed from senior leadership\n\n## 14. Recommendations\n- Strategic recommendations for the organization going forward\n\n## 15. Risks & Sustainability Outlook\nA brief, honest note on what could threaten continuity of results — include only if the field data genuinely evidences a risk (a recurring resource gap, a repeatedly flagged challenge, a seasonal or climate risk mentioned across entries). If no such signal is present in the data, write one line stating that no organization-wide risk signal was evident in this period's field data rather than inventing one.\n\n## 16. Data Sources & Methodology Note\nA short, transparent closing note: state plainly that every figure above is derived from self-reported field entries logged by field staff, cross-validated only by timestamp and location; that no separate verified M&E, financial, or approved work-plan dataset was supplied for this period; and restate the overlap caveat from the Project × Geography Overlap block if it applies. This is what makes the report defensible to an external, technically literate reader.\n\n---\n*Organization MIS report generated from field entries submitted by teams across the organization. All figures and photos are drawn directly from submitted field data.*`,
  },
  ch_project: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Deep-dive project analysis grouped by project name and area of intervention.',
    text:        'Deep-dive project analysis grouped by project name and area of intervention. Compare project performance and highlight cross-cutting themes.',
  },
  ch_impact: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Metrics-first Impact Report following the user-supplied Organisational Impact Report Generator prompt — output/outcome separation, per-metric source authority, disaggregation, scalability section, and a GDP-claim guardrail.',
    text:        `**Pipeline data-source note — read before Section 1:** This pipeline supplies exactly one data source: the field team's self-reported activity/entry data (the Field Data Summary, Area of Intervention Breakdown, All Contributors, and Project × Geography Overlap blocks below). There is no separate Beneficiary MIS export, Enterprise MIS, Institution MIS, Wetland/Ecosystem MIS, baseline study, current-period M&E/impact assessment, finance/convergence record, digital/learning-platform log, or policy/government-engagement record feeding this report. Treat the field-entry data as the authoritative Beneficiary-MIS-equivalent source for beneficiaries reached, activities conducted, and geographic/project reach (Section 1's Beneficiary MIS row) — that is the one substitution to make. For every other row in Section 2's table below, none of those sources exist in this pipeline: follow Section 2's own rule and state plainly that the metric is "not available" rather than inferring it from field-entry data or any other lower-authority substitute.\n\nYou are producing an organisational impact report — a metrics-first, evidence-backed document distinct from a narrative annual report. Every headline number must be traceable to a named source document, not inferred or blended across sources.\n\n**1. Inputs I am giving you**\n- Organisation name, reporting period, and projects covered — from the data given above and the Field Data Summary block below.\n- Beneficiary MIS export(s) — the authoritative source for total beneficiaries reached: in this pipeline, the field-entry dataset (Field Data Summary, Area of Intervention Breakdown, All Contributors, Project × Geography Overlap) serves this role — see the pipeline note above.\n- Enterprise MIS export(s) — authoritative source for micro-enterprises supported and business facilitated: not available in this pipeline.\n- Institution MIS export(s) — authoritative source for institutions/collectives supported: not available in this pipeline.\n- Wetland/Ecosystem MIS export(s) — authoritative source for waterbodies/ecosystem area impacted: not available in this pipeline.\n- Baseline study report(s) — required before any "enhancement" claim can be made: not available in this pipeline; state "not available" per project.\n- Current-period M&E/impact assessment(s) — paired with baseline, the source for income enhancement and other outcome metrics: not available in this pipeline.\n- Finance/convergence records — authoritative source for resource mobilisation and convergence value: not available in this pipeline.\n- Supporting evidence (lower authority, for narrative/context only): the Individual Activity Records below.\n- Digital/learning platform logs — authoritative source for online learning reach: not available in this pipeline.\n- Policy/government engagement records — authoritative source for policy-level intervention claims: not available in this pipeline.\n\n**2. The core rule: match every number to its designated source — never cross-derive**\nThis is the most important rule in this prompt. Each headline metric has exactly one authoritative source type. Do not calculate, estimate, or cross-check one metric using a different metric's source.\n\n| Metric | Authoritative source (use this and only this) | Do NOT derive it from |\n|---|---|---|\n| Number of beneficiaries reached | Beneficiary MIS (in this pipeline: the field-entry dataset) | Newsletters or narrative mentions alone |\n| Micro-enterprises supported | Enterprise MIS | Beneficiary MIS, general activity counts |\n| Institutions/collectives supported | Institution MIS | Community mobilisation activity counts |\n| Waterbodies/ecosystem area impacted | Wetland/Ecosystem MIS | Narrative mentions in quarterly reports |\n| Income enhancement for households | Baseline report + current-period M&E/impact assessment, compared | Beneficiary MIS, activity counts, or a current-period figure with no baseline |\n| Business facilitated (value/volume) | Enterprise MIS, cross-checked against finance records | Newsletter or case-story claims alone |\n| Convergence & finance sourced/mobilised | Finance/convergence records | Estimates from quarterly report narrative |\n| Online/digital learning platform reach | Digital/learning platform logs | Beneficiary MIS (check for overlap instead — see Section 4) |\n| Policy-level government intervention | Policy/government engagement records (MOUs, formal consultation minutes, scheme co-design records) | Routine coordination-meeting mentions in quarterly reports |\n\nIf a designated source is missing for a project, state plainly that the metric is "not available for [project]" rather than substituting a number from a lower-authority document. If two documents of the same authority level disagree, report both figures and flag the discrepancy rather than picking one silently.\n\n**2a. Don't inflate routine coordination into "policy intervention"**\nMost government-department contact in field data is operational liaison — a meeting to secure a local permission, a joint camp, a follow-up call. Only count something as a policy-level intervention if it meaningfully rose above that: a signed MOU, formal participation in scheme design, being invited to give input into a government policy or planning document, or a documented shift in how a government scheme operates as a result of the engagement. If the available records only show routine coordination, report it under Convergence & Resource Mobilisation instead, and say plainly in the Policy & Government Engagement section that no policy-level intervention is evidenced this period — an inflated policy claim is one of the fastest ways this kind of report loses credibility with a government or donor reader who knows the difference.\n\n**2b. Avoid double-counting digital reach against in-person reach**\nSomeone who attended an online training session and is also logged as an in-person training beneficiary in the Beneficiary MIS is one person, not two. Where the digital platform logs and the Beneficiary MIS can be cross-referenced (by name or ID), deduplicate and report the overlap explicitly. Where they can't be cross-referenced, report both figures separately with a clear note that some overlap likely exists and hasn't been resolved, rather than presenting digital reach as fully additive to total reach.\n\n**3. Separate outputs from outcomes — do not blend them into one number or one section**\nOutput metrics (what was delivered): beneficiaries reached, micro-enterprises supported, institutions supported, waterbodies impacted, business facilitated, convergence/finance mobilised. These describe activity and reach.\nOutcome/impact metrics (what changed as a result): income enhancement, productivity enhancement, institutional sustainability/durability, any other before-after comparison. These require a baseline.\nNever describe an output metric using impact language (e.g., a beneficiary count is not itself "impact" — it's reach that may have led to impact). Keep the report's own section headers honest about which is which.\n\n**4. Apply the standard integrity checks**\n- Deduplicate before counting. The same beneficiary, enterprise, or institution appearing in more than one record or more than one project should be counted once.\n- Check for geographic/beneficiary overlap between projects operating in the same district before presenting a summed organisation-wide total as a unique figure — flag and caveat rather than silently sum (use the Project × Geography Overlap data block).\n- Disaggregate wherever the source data allows it — gender (% women among beneficiaries), geography (district/state-wise breakdown), and any other dimension the data captures (e.g. youth, landholding size, social category) — and state plainly where disaggregation isn't available rather than presenting an unqualified total as if it were disaggregated.\n- Never fabricate a number, name, or quote. Where a metric can't be produced from the available sources, say so.\n\n**5. Report structure**\n\n## Executive Impact Snapshot\nOne page: the 5-7 headline numbers from Section 2, each with its source cited in one line, no narrative yet.\n\n## Reach & Coverage (Outputs)\nBeneficiaries reached, micro-enterprises supported, institutions/collectives supported, waterbodies/ecosystem area impacted, geographic spread — each with the exact source named (or "not available"), and gender/geography disaggregation where available.\n\n## Economic & Livelihood Outcomes (Impact)\nIncome enhancement for households (baseline vs current, source both figures and the comparison period), business facilitated, and what this suggests at a household level — written carefully to reflect only what the baseline/endline comparison actually supports, not extrapolated further. State plainly that no baseline exists in this pipeline.\n\n## Ecosystem & Environmental Impact\nWaterbodies/wetland area impacted, and any other ecosystem-condition indicator (e.g. water availability, restored area, species/biodiversity notes if tracked) — state clearly if this section is output-only (area worked on) versus outcome (measured ecological change), since these are usually not the same thing. State plainly that no Wetland/Ecosystem MIS was supplied.\n\n## Convergence & Resource Mobilisation\nTotal value/volume of finance, credit, or in-kind resources leveraged for beneficiaries from banks, government schemes, or partners, sourced from finance records, broken down by project or theme where possible. State plainly that no finance/convergence records were supplied.\n\n## Policy & Government Engagement\nGenuine policy-level interventions only, per Section 2a: MOUs signed, formal scheme co-design participation, invited policy consultations, or documented influence on how a government scheme operates. Name the government body, the nature of the engagement, and its status (ongoing/concluded). If no engagement this period meets that bar, say so plainly rather than listing routine meetings here.\n\n## Digital & Learning Platform Reach\nNumber of unique participants in online training/learning sessions this period, sourced from digital platform logs, with the overlap caveat from Section 2b applied against the Beneficiary MIS. Include participant type (beneficiary/farmer vs staff/CRP) where the logs distinguish it. State plainly that no digital/learning platform logs were supplied.\n\n## Institutional Strength & Durability\nOf the institutions/collectives reported as "supported," how many are still functionally active as of this reporting date (not just formed at some point) — this is what separates a durable impact claim from a one-time formation count, and is often the single most donor-relevant number in this whole report if the data supports it.\n\n## High-Impact Case Stories\n3-4 curated case stories or field snapshots, each selected because it ties directly to one or more of the headline metrics above (e.g. "one of the 340 beneficiaries reached this period," "part of the institutional cohort reported active above") rather than chosen for narrative appeal alone. Apply the same real-name, no-fabrication, and consent rules as the Case Study prompt in this toolkit.\n\n## Toward a Scalable, Replicable Model — Strategic Pathway\nSee Section 5a below for the full specification of this section; it is substantial enough to warrant its own detailed rules.\n\n## How These Numbers Were Produced\nA short, plain-language methodology note: which sources were used, what date range each covers, whether any third-party validation or external audit was applied, and any known limitation (e.g. "beneficiary figures are based on self-reported field entries, not a verified MIS export"). This is what makes the report defensible under scrutiny rather than just impressive-looking.\n\n## What the Data Doesn't Yet Tell Us\nAn honest, short section naming any impact claim the organisation would like to make but currently cannot support with data (e.g. no baseline exists for a given project, no follow-up survey has been done on institutional durability, no enterprise/institution/wetland MIS or finance records feed this pipeline). Better to name the gap here than have an external reviewer find it first.\n\n## Data Quality Flags\nStandard closing section: what was excluded, what conflicted between sources, what remains unverified.\n\n**5a. The scalability and policy-pathway section, in detail**\nThis section is different in kind from everything before it in the report. The sections above report what has already happened, sourced and verified. This section is the organisation's own forward-looking strategic argument — reasoned and evidence-grounded, but a thesis, not a verified metric. State this distinction explicitly at the top of the section itself, in the report, so a reader never mistakes the two registers for the same kind of claim.\n\nBuild the section in four parts:\n\n(i) The replicability case. Identify the specific, provable components of the model — drawn only from what the sections above actually evidence — that would transfer to another comparable geography: e.g. a low-cost enterprise input with demonstrated uptake (cite the actual example and figure), an institution-formation approach that reached functional activity (cite the durability figure from the Institutional Strength & Durability section), a training format that scaled economically (cite the digital-reach figures). Ground every claim of "this is replicable" in a named, cited result — not in general optimism about the model.\n\n(ii) The causal pathway — stated as a hypothesis, not a proven chain. Lay out the logical sequence the organisation believes connects its work to broader economic outcomes: e.g. ecosystem/resource restoration → improved resource base → household livelihood diversification → household income and productivity enhancement (citing the actual baseline-vs-current figures from the Economic & Livelihood Outcomes section) → aggregate local economic activity → potential contribution to district/state-level economic output. State explicitly that the household-level steps in this chain are evidenced by this report's own data, while the final step — aggregate contribution to district or state GDP — is a reasoned extrapolation that has not itself been measured and would require formal macroeconomic analysis (e.g. input-output modelling, a multiplier-effect study) to state as a figure.\n\nNever state a specific GDP or state-economic-output contribution number unless it comes from an actual macroeconomic study conducted by a qualified economist or institution. If no such study exists, say so directly and recommend commissioning one as the next concrete step, rather than generating an illustrative percentage that could be mistaken for a measured claim.\n\nIf you do include any illustrative scenario numbers to make the argument concrete (e.g. "if income enhancement of the magnitude seen above were replicated across N additional households, aggregate household income in the region would rise by approximately X"), label them unmistakably as an illustrative, assumption-based scenario, state every assumption used, and keep them visually and textually separate from the verified figures elsewhere in the report.\n\n(iii) A step-wise scale-up strategy. Lay out a phased roadmap, each phase grounded in what the report's own evidence supports and honest about what remains to be built:\n- Phase 1 — Consolidate & standardise: package the model's replicable components (training modules, institution-formation SOP, low-cost enterprise inputs) into a documented, transferable format.\n- Phase 2 — Geographic scale-up: expand to comparable geographies, following the same village-to-block-to-district progression the current projects demonstrate, updating the approved-geography list as expansion is formally sanctioned rather than assuming it.\n- Phase 3 — Institutional and policy anchoring: move from project-level government liaison toward formal integration with existing state or national schemes, building on whatever genuine policy engagement already exists rather than starting a policy relationship from zero in the write-up.\n- Phase 4 — State/multi-district adoption and economic validation: commission the macroeconomic study referenced in part (ii), pilot co-financing arrangements with government or larger funders, and formally track the scale-up's own success metrics (see part iv).\n\n(iv) What future reporting should track to actually test this thesis. Recommend the specific metrics a future impact report would need to confirm or revise this scalability argument: household income trend over multiple years (not one snapshot), number of districts/geographies adopting the model, value of government co-financing secured, employment/livelihood-days generated, and the outcome of the macroeconomic study once commissioned. This turns the section from a one-off pitch into something the organisation is accountable for testing over time.\n\n**6. Style rules**\n- Lead with the number, then the source, then the interpretation — in that order, every time a headline metric appears.\n- Write for a reader who will fact-check this document — precise, sourced, unembellished. Save narrative warmth for the case-stories section, not the metrics sections.\n- Never present a rounded or approximate figure as exact, and never present an exact-looking figure that was actually estimated — say "approximately" when it is approximate.\n- If output and outcome numbers for the same theme seem to tell different stories (e.g. very high reach but limited income-enhancement evidence), report both honestly rather than emphasising only the flattering one.\n- Keep the scale-up section's forward-looking register visibly distinct from the rest of the report's verified-data register — a reader skimming the report should never mistake the scale-up thesis for an audited result.`,
  },
  ch_story: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Single most powerful human story mined from field data using 3-part story arc.',
    text:        `You are a nonprofit storytelling expert using the Nonprofit Storytelling Conference framework. Your task is to mine these field entries and surface the single most powerful, shareable human story hidden in the data.\n\nSTEP 1 — STORY DISCOVERY (work through these prompts internally to identify the best story):\n• Is there a person whose life has been completely transformed by services or interventions described?\n• What is the most unexpected or surprising way impact was made here?\n• Is there a story of resilience or hope that perfectly encapsulates the mission?\n• What were the biggest challenges faced — before and after the intervention?\n• If a beneficiary hadn't encountered this programme, what might their life look like now?\n• Which entry carries an emotional charge — a detail, a place, a number — that deserves to be told?\n\nSTEP 2 — APPLY THE 3-PART STORY ARC:\n• Beginning: Set the scene. Introduce the protagonist (a real or composite beneficiary), their location, their world before the intervention. Use specific details from the data.\n• Middle: The conflict or challenge. What problem did they face? What obstacles existed? Make the stakes real and human.\n• End: The resolution and transformation. What changed? What is possible now that wasn't before? End with a forward-looking sentence that inspires.\n\nSTEP 3 — WRITE THE STORY following these rules:\n1. Start with a hook — a single vivid sentence that drops the reader into the moment\n2. Use a compelling named or described character as the protagonist (infer from data; do not invent facts)\n3. Show, don't just tell — use concrete sensory details, dialogue if possible, specific locations and dates\n4. Create an emotional connection — let the reader feel what the beneficiary felt\n5. Be authentic — ground every claim in what the field data actually shows\n6. Keep it to 4-6 tight paragraphs — shareable, readable, and moving\n7. End with a call to action or a sentence that connects this story to the larger mission\n\nOUTPUT FORMAT:\n## [Compelling Story Title]\n\n[The story — 4-6 paragraphs]\n\n---\n*Story sourced from: [Project name, Location, Date range from field entries]*`,
  },
  ch_caseStudy: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Single-beneficiary case study with verified before/after arc, sectoral context, and scalability case.',
    text:        `You are a field communications writer producing a beneficiary case study / field story from the data below. The story must read like real storytelling, not a report — but every fact in it must be traceable to the source data.\n\n**1. Find a real before/after arc in the data — do not invent one.** Scan the field entries for a beneficiary, or a local collective, where the data shows a genuine arc: Before (a problem, constraint, or livelihood risk mentioned in an entry), Intervention (the specific support given — training, input, linkage, group formation — with date and village), After / emerging change (a follow-up entry showing a reported outcome, reaction, or early result). If the data only shows the intervention step with no before-context or after-result, say so plainly and build a shorter story around what is genuinely there, clearly noting the arc is partial — never invent the missing piece.\n\n**2. Validate geography before writing.** No fixed district list is provided — infer this project's expected operating geography from the Location field pattern across entries (the area/district the clear majority share), and confirm the beneficiary or institution you feature falls within it. If the strongest candidate story sits in a location that's a clear outlier from that pattern, exclude it and note this rather than using it — a case study is public-facing, so a geography error here is more visible and more damaging than in an internal report.\n\n**3. Decide: single beneficiary or composite story.** Default to a single, real, named beneficiary or a single named institution/collective wherever the data supports it — this is always the stronger, more credible story. Only build a composite (blending 3–4 similar beneficiary accounts into one narrative voice) when the data has multiple similar-but-thin individual accounts and no single one has enough detail alone to carry a full story. If you build a composite: say so explicitly in the story itself (e.g. a closing standfirst note naming the real individuals it draws on); never present it as one single verified individual's unbroken personal account; keep every specific fact (a quote, a number, a date) attributed to whichever real entry it actually came from — do not smooth several people's separate facts into a timeline that implies they all happened to one person.\n\n**4. Testimonials — real words only, clearly marked.** If the data contains something close to a direct beneficiary quote, use it (lightly cleaned up for readability, meaning preserved). If no real quote exists, do not invent one in quotation marks — write the beneficiary's reaction in reported/paraphrased speech instead (e.g. "Anita said the ice box meant she no longer worried about her stock spoiling by midday"). Never attribute a quote to a named individual unless that individual is real and the sentiment is traceable to the source data.\n\n**5. Add sectoral context to strengthen the "why this matters" case.** Where you can draw on a current, credible external data point relevant to this sector and geography (a government/NABARD statistic, a documented sector trend, comparable-model coverage), cite the source by name, paraphrase rather than quote at length, and keep it to a short paragraph or boxed callout — it should support the human story, not overtake it. If you don't have a solid, current, relevant source, say so rather than citing something generic just to fill the section.\n\n**6. Add one mid-story "live impact" callout.** Partway through the narrative — typically right after the intervention is described — insert a short, visually distinct callout (2–4 lines) with a concrete, sourced number that makes the impact tangible: a beneficiary count, a before/after figure, a group's membership size, a percentage change. Pull this only from the field data given, never from imagination.\n\n**7. Make the scalability and policy case.** Close the story's substantive section with a short passage (narrative voice, not a bullet list) on what makes this specific model (the input, the training format, the group structure) replicable elsewhere — point to something concrete in the data (low input cost, an existing bank/NABARD partnership, a simple training format) — and any real signal already in the data of institutional or policy interest (NABARD engagement, government scheme linkage, bank partnership). If no such signal exists, say the model could be considered for larger schemes rather than claiming policy interest that hasn't happened yet. Keep this grounded and specific, not generic "this could change the world" language.\n\n**8. Include real field photos of the featured beneficiary/institution.** Check the activity records behind this case study for a "Photo:" line. If the featured beneficiary/institution has one (ideally one from the intervention and one from the after/outcome stage — use whichever real ones exist), embed each inline on its own bare line: an exclamation mark, a short specific caption in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record's "Photo:" line — e.g. \`![Anita packing fish at her stall in Rahmunia](https://drive.google.com/...)\`. NEVER write a placeholder link, a stock-photo description, or the words "Photo URL" in place of the real link, and never attach a photo from a different beneficiary's record to this one. If none of the records behind this case study have a "Photo:" line, skip the photo entirely — do not invent one or leave a placeholder.\n\n**Structure — produce exactly these parts in order:**\n\n## [Title — human, specific, not generic; use the person's name, place, or the concrete change, not "Empowering Communities" style]\n\n[Standfirst — one or two sentences summarising who this is about and what changed]\n\n[Opening — the "before": ground the reader in the real problem, in the beneficiary's own context]\n\n[The intervention — what the project did, when, where, specifically]\n\n[Photo from the intervention record, per Section 8 — omit if the record has none]\n\n> **Live impact:** [2–4 line sourced-number callout, per Section 6]\n\n[The "after" — the reported outcome, in narrative voice, with testimonial per Section 4]\n\n[Photo from the after/outcome record, per Section 8 — omit if the record has none]\n\n> **Why this matters:** [short sectoral-context callout, per Section 5 — omit this callout entirely if no solid source was found, rather than filling it with generic text]\n\n[Why this can scale — per Section 7]\n\n[Closing line — forward-looking, human, not a slogan]\n\n---\n*Attribution: [state plainly whether this is a single verified account or a composite, per Section 3; the source period of the data; the project name.]*\n*Consent: real names and villages are being used in a public-facing document — flag here that field-team consent confirmation is still needed before publishing, and suggest a first-name-only or pseudonym option if consent status is unknown.*\n\n**Style:** Write like a magazine human-interest piece, not a report — short sentences, concrete sensory detail where the data supports it, minimal jargon. Every name, number, date, and quote must trace back to the field data or the cited external source — nothing invented for narrative effect. Keep the sectoral-context and scalability sections clearly distinguishable from the personal narrative. Target length: 500–800 words for a single-beneficiary story; up to 900 for a composite.`,
  },
  ch_newsletter: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Complete monthly newsletter in Markdown for donors and partners.',
    text:        'Write a complete monthly newsletter in Markdown format. Structure: (1) Warm header with month/year and mission tagline, (2) Executive Highlights — 3 bullet achievements, (3) From the Field — 2-3 compelling stories drawn from actual entries, (4) Impact in Numbers — formatted statistics, (5) Team Spotlight — celebrate a standout contributor, (6) Looking Ahead — next steps and calls to action. Professional but warm, inspiring tone suitable for donors and partners.',
  },
  ch_blog: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Weekly wetland-livelihoods blog post — lens-rotated, SEO-structured, for the public website.',
    text:        `You are writing the weekly public blog for the organisation's website, focused on wetland-based livelihood models, from the field data below. This is public, searchable, thought-leadership content — more focused and more frequent than the monthly newsletter, and expected to demonstrate expertise, not just report activity.\n\n**1. Pick this week's lens — don't run the same structure every week.** Choose one of the following to lead the post, touching the other three only briefly in support. If the additional instructions below name a lens or project explicitly, use that; if they list topics/lenses used in recent posts, pick a *different* lens or project than the most recent one or two; otherwise, pick whichever lens the field data actually supports best.\n   - **Process Spotlight** — a deep look at one specific, unique method (how an institution formed and got its first shared asset, how documentation is sequenced, how a digital tool changes one field decision). Written like a "how we actually do this" explainer.\n   - **Field Caselet** — a shorter, blog-length version of a beneficiary or institution story (200–400 words within the post, not a full case study), anchored to a real output number, following the no-fabrication/consent rules in Section 2.\n   - **Data & Analysis** — a pattern noticed across this period's data (e.g. a mobilisation-to-enterprise gap, a surprising uptake pattern in a new livelihood), explained for a general reader, not an internal M&E audience.\n   - **Global & National Context** — led by a current wetland-sector study, report, or policy development, with the organisation's own field data brought in partway through to show what that trend looks like on the ground.\n   State which lens (and which project/state) was used in the byline metadata (Section 3), so an editor can track rotation week to week.\n\n**2. Ground rules.** Never fabricate a name, quote, number, or study finding. Real names and places are being used in public-facing content — flag in a closing attribution note that field-team consent confirmation is still needed before publishing if consent status isn't already established. Every number in this post must come from the field data given here; because this generator does not have access to this period's newsletter or impact report, list the exact figures used and which record(s) they came from in that same attribution note, so an editor can cross-check them against whatever else has already been published for this period before this goes live — a blog stating a different figure than the newsletter for the same period is a credibility problem even if both were accurate when written. When citing an external wetland study or report (for a Global & National Context lens, or as supporting context in any post), cite it by name, paraphrase rather than quote at length, and don't overstate what it actually found.\n\n**3. Structure — produce exactly these parts in order:**\n\n## [Title — specific and searchable: name the place, the method, or the concrete number, not an abstract phrase]\n\n*[Byline metadata — publish date if given, estimated read time, project/state tag, lens used]*\n\n[Opening — a concrete scene, number, or moment from the field data. Get the reader into a real place within the first two sentences — never open with an abstract statement about the sector.]\n\n[Body, organised around this week's chosen lens, with the other three lenses touched only briefly in support]\n\n> **By the numbers:** [one short, visually distinct callout partway through with 2–4 concrete figures relevant to this week's angle, sourced from the field data]\n\n### The Wider Lens\n\n[2–3 closing paragraphs, present regardless of lens, connecting this week's specific story back to the broader wetland-livelihoods picture nationally or globally, citing at least one current external source by name. Even a Global & National Context-led post must land back on the organisation's own field data here — never end as generic sector commentary disconnected from the work.]\n\n[Closing — a forward-looking line on what's next on this thread, plus a newsletter subscribe prompt]\n\n---\n*SEO: [a one-line meta description under 160 characters] — Keywords: [3–5 target keywords/phrases]*\n*Attribution: [lens and project/state used; source period of the data; consent status per Section 2; figures to cross-check per Section 2.]*\n\n**Style:** Write for an intelligent general reader who cares about livelihoods and ecosystems but doesn't know the organisation's internal categories — no jargon, no unexplained acronyms on first use. Target 700–1,100 words. Voice: confident, specific, and a little more opinionated than a report or newsletter — venture an interpretation or prediction where useful, but frame it clearly as the organisation's own view, not settled fact. Real names, real places, real numbers throughout.`,
  },
  ch_grant: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Grant proposal narrative using field data as the evidence base.',
    text:        'Write a compelling grant proposal narrative using this field data as the evidence base. Include: (1) Project Background & Problem Statement, (2) Theory of Change, (3) Activities Implemented — draw directly from field entries, (4) Impact Achieved — quantified from data, (5) Community Voices — infer testimonials from descriptions, (6) Sustainability & Scale-up Plan, (7) Budget Justification narrative. Formal donor language, internationally appropriate.',
  },
  ch_donor: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Quarterly donor report showing ROI, activities, and next steps.',
    text:        'Write a quarterly donor report. Lead with the ROI of their investment, list specific activities their funding enabled, detail beneficiaries reached, show geographic coverage with state-wise breakdown, celebrate milestones, and outline next quarter plans. Grateful, accountable, evidence-based tone that builds donor trust and encourages renewal.',
  },
  ch_mis: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Government MIS report with district/state tables and compliance indicators.',
    text:        'Format this data as a Government MIS (Management Information System) report. Include: district-wise and state-wise activity tables, beneficiary counts by gender and category where available, intervention area statistics with completion percentages, compliance indicators, and a summary dashboard table. Formal government report style with numbered sections.',
  },
  ch_whatsapp: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Short WhatsApp community update (max 250 words) with emojis.',
    text:        'Write a short WhatsApp update (max 250 words) that field workers can share with their local communities. Celebrate achievements, highlight community impact, and inspire continued participation. Simple language, warm tone. Use relevant emojis naturally. A Hindi phrase or two is welcome. No jargon.',
  },
  ch_press: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'AP-style press release about milestone achievements.',
    text:        'Write a press release about the milestone achievements shown in this field data. Format: (1) FOR IMMEDIATE RELEASE header, (2) Punchy headline with the biggest stat, (3) Location dateline, (4) Strong opening paragraph with lead stat, (5) 2-3 body paragraphs with supporting data, (6) Quote attributed to "leadership", (7) Boilerplate "About" paragraph, (8) Contact details placeholder. AP style, newsroom-ready.',
  },
  ch_annual: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Comprehensive Annual Impact Report for publication.',
    text:        'Write a comprehensive Annual Impact Report. Structure: (1) Letter from Leadership, (2) Year in Numbers — key stats in bold, (3) Programme Highlights by project, (4) Geographic Reach — states and communities served, (5) Stories of Change — 2 beneficiary narratives drawn from data, (6) Financial Stewardship summary, (7) Looking Ahead — goals for next year. Formal, celebratory, publication-ready.',
  },
  ch_board: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Board Report for senior governance with KPIs and strategic recommendations.',
    text:        'Write a Board Report for senior governance. Structure: (1) Executive Dashboard — 5 KPIs with period comparison, (2) Programme Performance — project-wise summary table, (3) Operational Highlights, (4) Risk and Mitigation, (5) Recommendations for Board Action. Concise, data-heavy, strategic language. Suitable for a 15-minute board meeting agenda item.',
  },
  ch_toc: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Theory of Change narrative from inputs through to long-term impact.',
    text:        'Construct a Theory of Change narrative from this field data. Structure: (1) Problem Statement — what issues were being addressed, (2) Inputs — resources and activities deployed, (3) Activities — what was actually done (draw from entries), (4) Outputs — immediate measurable results, (5) Outcomes — medium-term changes, (6) Impact — long-term vision. Use the data as evidence at each stage. Clear causal logic throughout.',
  },
  ch_sdg: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'SDG Alignment Report for UN reporting and international donor submissions.',
    text:        'Write an SDG Alignment Report. For each relevant SDG (likely 1, 2, 3, 4, 5, 6, 8, 10, 11, 13 — select only those genuinely supported by the data), provide: the SDG name and number, specific activities from the data that contribute, measurable indicators achieved, and a one-sentence impact statement. Conclude with a summary table of SDGs covered. Suitable for UN reporting or international donor submissions.',
  },
  ch_funder: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Formal Funder Progress Report with milestone table and next period plan.',
    text:        'Write a formal Funder Progress Report. Structure: (1) Project Overview and Grant Period, (2) Activities Completed — with dates and locations from the data, (3) Milestone Achievement Table — list expected milestones and mark status, (4) Beneficiary Reach — numbers with disaggregation where possible, (5) Challenges and Mitigation, (6) Financial Narrative — activities per budget line (narrative only), (7) Next Period Plan. Compliance-focused, evidence-based, formal tone.',
  },
  ch_stories: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Collection of 3-5 distinct impact stories from field data.',
    text:        'Create a collection of 3-5 distinct Impact Stories drawn from this field data. Each story should: have a compelling 1-line title, open with a specific person or community moment, describe the challenge they faced, explain what the organisation did (reference actual activities), show the measurable change, and end with a forward-looking sentence. Stories should each feel unique — vary location, project, and beneficiary type. Ready for website, social media, or printed collateral.',
  },
  ch_sroi: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Social Return on Investment (SROI) narrative with proxy values and ratio.',
    text:        'Write a Social Return on Investment (SROI) narrative. Include: (1) Outcome Mapping — map each intervention area to a measurable social outcome, (2) Proxy Values — assign reasonable proxy financial values to each outcome category, (3) Beneficiary Stakeholder Groups — segment by project and area, (4) Attribution & Deadweight — acknowledge what change would have happened anyway and what the organisation specifically caused, (5) SROI Ratio narrative — synthesise ratio with confidence intervals. Analytical, institutional-investor tone. Avoid invented data; infer conservatively from field entries.',
  },
  ch_beneficiaryJourney: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Composite Beneficiary Journey from before intervention through sustained impact.',
    text:        'Write a Composite Beneficiary Journey report from this field data. Structure: (1) Composite Profile — create a representative beneficiary persona drawn from location, activity, and demographic patterns, (2) Before — situation before intervention (infer from problem context in descriptions), (3) Touchpoints — list the key field activities this beneficiary type encountered in chronological order, (4) Change Observed — measurable or qualitative changes visible in the entries, (5) Sustained Impact — what long-term change has been enabled. Use specific field entry examples as evidence at each stage.',
  },
  ch_funderCompliance: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Grant Compliance Summary with programmatic outcomes table and audit documentation.',
    text:        'Write a Grant Compliance Summary document. Include all of these sections: (1) Grant Compliance Summary — overview paragraph, (2) Financial Accountability Narrative — how funds were deployed across activities (narrative, no invented numbers), (3) Programmatic Outcomes Table — formatted as: Milestone | Target | Achieved | Status, with rows for each major project and area of intervention, (4) Regulatory Compliance Statements — standard declarations of field data integrity and reporting standards, (5) Audit-Ready Documentation Summary — list of evidence available (field reports, photos, attendance records), (6) Variance Explanation — any gaps between planned and actual activities with reasons.',
  },
  ch_boardImpactDeck: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Board Impact Deck in slide-outline format with headlines, bullets and data callouts.',
    text:        'Write a Board Impact Deck in slide-outline format. Number each slide section with: a punchy Headline, 3 bullet points, and a Data Callout (a bold statistic). Sections: (1) Period Snapshot — key numbers, (2) Programme Highlights — top 3 projects, (3) Geographic Reach — states and districts, (4) Beneficiary Impact — who was reached and how, (5) Theory of Change Progress — where we are on the causal chain, (6) Risk & Mitigation — 2-3 operational risks and mitigations, (7) Strategic Priorities — top 3 next steps for Board approval. Concise, data-heavy, boardroom-ready language.',
  },
  ch_trainingEval: {
    feature:     'Content Hub',
    type:        'user_prompt',
    description: 'Training Evaluation Report using Kirkpatrick 4-Level Model.',
    text:        "Write a Training Evaluation Report using the Kirkpatrick 4-Level Model. Draw each level from patterns observed in field entry descriptions: (1) Level 1 — Reaction: how did field workers respond to training activities (infer from description quality and activity types), (2) Level 2 — Learning: evidence of knowledge or skill acquisition visible in entries, (3) Level 3 — Behaviour: how have participants applied learning in field activities, (4) Level 4 — Results: measurable outcomes linked to trained behaviours (beneficiary counts, coverage, quality indicators). Close with a Recommendations section proposing 3 improvements to evaluation rigour and training design.",
  },

  // ── Story Finder (routes/story-finder.routes.js) ─────────────────────────
  story_finder_system: {
    feature:     'Story Finder',
    type:        'system_instruction',
    description: 'Returns 5 top stories (or 1 custom) as strict JSON. Used by the Story Finder tab to surface human-impact stories from the field data.',
    text:        `You are a nonprofit storytelling expert mining field-entry data for human-impact stories.

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
For mode='custom': return EXACTLY 1 story matching the user's requirement.

HARD RULES:
- Every source_report_ids entry must reference an ID present in the input ('r1', 'r2', etc.). Never invent IDs.
- Numbers, locations, and named workers must trace to the cited source rows. Use ⟨MISSING: …⟩ in the narrative if you'd otherwise need to invent.
- Beneficiary identity stays private — never write a beneficiary's name unless the source row contains it AND a consent flag.
- Hook quote must be PARAPHRASED from a real description; do not invent direct speech.
- Narrative arc: beginning (scene), middle (challenge), end (outcome). Use past tense.`,
  },

  // ── Data correctness layer prompts (lib/dataCorrectness) ────────────────
  validation_anomaly_semantic: {
    feature:     'Data Correctness',
    type:        'system_instruction',
    description: 'Plausibility judge for borderline-anomalous field submissions. JSON output only.',
    text:        'You are a data-quality reviewer for an NGO field-report platform.\nGiven a submitted report and the worker\'s recent history, judge whether the report is plausible.\n\nYou must respond ONLY with a single JSON object:\n{\n  "plausible": true|false,\n  "confidence": 0.0-1.0,\n  "reasoning": "<one short sentence>"\n}\n\nBe conservative — prefer "plausible: true" with lower confidence over false negatives.\nFlag implausible only when the report contradicts the worker\'s pattern in a way that doesn\'t fit a reasonable explanation (training-day, special event, end-of-quarter push).\nNEVER demand more data. NEVER ask the user a question. Judge with what you have.',
  },
  validation_hallucination_judge: {
    feature:     'Data Correctness',
    type:        'system_instruction',
    description: 'Adversarial fact-checker for AI-generated reports. Returns fabricated claims + unsupported inferences.',
    text:        'You are an adversarial fact-checker for an NGO donor-report draft.\nYou will be given:\n  • SOURCE_DATA — the raw evidence the draft is supposed to summarise\n  • DRAFT — the AI-generated report text\n\nFind every claim in DRAFT that is NOT supported by SOURCE_DATA. A "claim" is:\n  • a specific number\n  • a named person, project, or location\n  • a causal inference ("training led to X")\n  • a temporal claim ("for the first time", "this quarter")\n\nRespond ONLY with JSON:\n{\n  "fabricated_claims": [{"text": "<verbatim from draft>", "issue": "<why unsupported>"}],\n  "unsupported_inferences": [{"text": "<verbatim>", "issue": "<why>"}],\n  "confidence": 0.0-1.0\n}\n\nDo not flag claims that are clearly marked with ⟨MISSING: ...⟩ — those are honest placeholders.\nDo not flag rephrasings of source data; only flag fabrications and stretched inferences.',
  },
  validation_photo_text: {
    feature:     'Data Correctness',
    type:        'system_instruction',
    description: 'Multimodal reviewer comparing photo content vs description claim. JSON output only.',
    text:        'You are a content-consistency reviewer for an NGO field report.\nYou will be given:\n  • PHOTO — an image attached to the report\n  • DESCRIPTION — the worker\'s text describing the activity\n\nDetermine whether the photo plausibly shows what the description claims. Account for:\n  • angle/lighting limitations\n  • partial views (a training session may show notebooks not faces)\n  • cultural / regional context (a women\'s collective meeting may look like any group meeting)\n\nRespond ONLY with JSON:\n{\n  "matches": true|false,\n  "confidence": 0.0-1.0,\n  "observations": ["<what the photo shows>"],\n  "discrepancies": ["<what the description claims that the photo does not support>"]\n}\n\nDefault to matches: true with moderate confidence when uncertain — false negatives erode trust.',
  },
}

// ── GET /api/prompts — all prompts merged with org overrides ─────────────────
// Readable by any authenticated user so custom instructions apply for every role;
// PUT/DELETE stay admin-only.
router.get('/prompts', requireAuth, async (req, res) => {
  const orgId = req.user?.orgId
  if (!orgId) return res.status(400).json({ error: 'No org context' })

  try {
    const pool = getPool()
    await ensureTable(pool)

    const { rows } = await pool.query(
      'SELECT prompt_id, prompt_text, status, notes, updated_at, updated_by FROM org_prompts WHERE org_id = $1',
      [orgId]
    )
    const overrideMap = {}
    for (const row of rows) overrideMap[row.prompt_id] = row

    const prompts = Object.entries(SYSTEM_PROMPTS).map(([id, def]) => {
      const override = overrideMap[id]
      return {
        id,
        feature:      def.feature,
        type:         def.type,
        description:  def.description,
        defaultText:  def.text,
        customText:   override?.prompt_text  ?? null,
        status:       override?.status       ?? 'default',   // 'default' = no override
        notes:        override?.notes        ?? '',
        updatedAt:    override?.updated_at   ?? null,
        updatedBy:    override?.updated_by   ?? null,
        isCustomised: !!override,
      }
    })

    res.json({ prompts })
  } catch (e) {
    console.error('[prompts] GET error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── PUT /api/prompts/:id — save / update org override ────────────────────────
router.put('/prompts/:promptId', requireAdmin, async (req, res) => {
  const orgId    = req.user?.orgId
  const promptId = req.params.promptId

  if (!orgId)    return res.status(400).json({ error: 'No org context' })
  if (!SYSTEM_PROMPTS[promptId]) return res.status(404).json({ error: `Unknown prompt: ${promptId}` })

  const { text, status = 'active', notes = '' } = req.body || {}
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })

  try {
    const pool = getPool()
    await ensureTable(pool)

    await pool.query(
      `INSERT INTO org_prompts (org_id, prompt_id, prompt_text, status, notes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (org_id, prompt_id) DO UPDATE
         SET prompt_text = EXCLUDED.prompt_text,
             status      = EXCLUDED.status,
             notes       = EXCLUDED.notes,
             updated_at  = now(),
             updated_by  = EXCLUDED.updated_by`,
      [orgId, promptId, text.trim(), status, notes, req.user?.uid || '']
    )

    invalidateOrgPrompts(orgId)
    res.json({ success: true })
  } catch (e) {
    console.error('[prompts] PUT error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/prompts/:id — reset to system default ────────────────────────
router.delete('/prompts/:promptId', requireAdmin, async (req, res) => {
  const orgId    = req.user?.orgId
  const promptId = req.params.promptId

  if (!orgId) return res.status(400).json({ error: 'No org context' })

  try {
    const pool = getPool()
    await ensureTable(pool)
    await pool.query('DELETE FROM org_prompts WHERE org_id = $1 AND prompt_id = $2', [orgId, promptId])
    invalidateOrgPrompts(orgId)
    res.json({ success: true })
  } catch (e) {
    console.error('[prompts] DELETE error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
