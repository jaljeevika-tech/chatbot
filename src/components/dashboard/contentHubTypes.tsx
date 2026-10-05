// Content Hub tile catalogue + default role permissions. A leaf module so
// ContentHubModal and ContentHubSettings can both import it without a cycle.
import { FileText, Newspaper, BookOpen, Heart, Users, Globe, MessageSquare, Megaphone, TrendingUp, Building2, Search, Award, Target, GitBranch, Flag, BarChart2, BookMarked, Quote } from 'lucide-react'
import type { TranslationKeys } from '../../i18n/translations'

export type Role = 'admin' | 'manager' | 'employee'
export type PermissionsMap = Record<string, Role[]>

// Default permissions (fallback when the org has none saved)
export const DEFAULT_PERMISSIONS: PermissionsMap = {
  self:               ['admin', 'manager', 'employee'],
  team:               ['admin', 'manager', 'employee'],
  org:                ['admin', 'manager', 'employee'],
  project:            ['admin', 'manager', 'employee'],
  impact:             ['admin', 'manager', 'employee'],
  story:              ['admin', 'manager', 'employee'],
  caseStudy:          ['admin', 'manager', 'employee'],
  newsletter:         ['admin', 'manager', 'employee'],
  blog:               ['admin', 'manager', 'employee'],
  grant:              ['admin', 'manager', 'employee'],
  donor:              ['admin', 'manager', 'employee'],
  mis:                ['admin', 'manager', 'employee'],
  whatsapp:           ['admin', 'manager', 'employee'],
  press:              ['admin', 'manager', 'employee'],
  annual:             ['admin', 'manager', 'employee'],
  board:              ['admin', 'manager', 'employee'],
  toc:                ['admin', 'manager', 'employee'],
  sdg:                ['admin', 'manager', 'employee'],
  funder:             ['admin', 'manager', 'employee'],
  stories:            ['admin', 'manager', 'employee'],
  sroi:               ['admin', 'manager', 'employee'],
  beneficiaryJourney: ['admin', 'manager', 'employee'],
  funderCompliance:   ['admin', 'manager', 'employee'],
  boardImpactDeck:    ['admin', 'manager', 'employee'],
  trainingEval:       ['admin', 'manager', 'employee'],
  _social:            ['admin', 'manager'],   // special key for social section
}

export interface ContentType {
  id: string
  icon: React.ReactNode
  title: string
  description: string
  category: 'report' | 'content' | 'social'
  color: string
  bg: string
  border: string
  roles: ('admin' | 'manager' | 'employee')[]
  instruction: string
  phase: 1 | 2   // legacy grouping only — visibility is driven entirely by effectivePerm()
}

export function getContentTypes(t: TranslationKeys): ContentType[] {
  return [
  // ── Reports ──────────────────────────────────────────────────────
  {
    id: 'self',
    icon: <FileText className="w-5 h-5" />,
    title: t.ctSelfTitle,
    description: t.ctSelfDesc,
    category: 'report',
    color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'You are an M&E/HR analyst producing an individual staff activity report. Generate an Individual Field Staff Monthly Report for this staff member, built entirely from their own field entries for this period (already filtered to only this person\'s submissions).\n\nGROUND RULES — apply before classifying anything:\n- Use only entries authored by or attributed to this staff member. If an entry is ambiguous about who did it, exclude it and note the exclusion rather than guessing.\n- Exclude and flag any entry outside this project\'s approved operating geography, or dated outside the stated reporting period — do not silently include or "correct" it.\n- Deduplicate before counting anything. If the same activity/date/location appears more than once (resubmitted or logged twice), count it once. If the same village is visited on multiple dates, count it once under "Places Visited" but preserve each visit as a separate activity in the matrix if they were substantively different activities.\n- Never invent an entry, a number, or a location. If a category genuinely has no activity this period, say so plainly rather than filling it with generic text.\n\nCLASSIFY every activity into exactly these nine categories (assign each to its single best-fit category; never double-count):\n1. Community Engagement & Field Trips — mobilisation visits, village meetings, door-to-door outreach, general field travel for engagement purposes.\n2. Institution Development — work supporting formation, strengthening, or documentation of community institutions (committees, producer groups, SHGs, cooperatives).\n3. Professional Development — any training, course, reading, certification, or self-learning the staff member undertook themselves (not training they delivered to beneficiaries).\n4. Enterprise Development Support — helping a beneficiary or group with input distribution, financial linkage, or business/livelihood-unit setup.\n5. Camps & Convergence Support — coordination or joint activity with government departments, banks, research institutions, or other external stakeholders.\n6. Community Events — celebrations, observance days, festivals, launch events, or felicitations the staff member organised or supported.\n7. Training & Capacity Building (delivered) — sessions, demonstrations, or exposure visits the staff member conducted or facilitated for beneficiaries or peers.\n8. Documentation & MIS Work — register updates, report writing, data entry, photo/evidence compilation, travel logs, bill/advance processing.\n9. Other Significant Tasks (uncategorised) — anything real and substantive that doesn\'t fit categories 1–8. If this category exceeds roughly 15% of total logged activities, flag it explicitly at the end as a tagging gap needing attention — a large "Other" bucket is a data-quality problem, not a neutral finding.\n\nProduce the report in this exact structure:\n\n# Individual Monthly Report — [Staff Name] | [Project] | [Reporting Period]\n\n## 1. Header\nStaff name, project, reporting period, approved district(s)/geography, total days with at least one logged entry (out of total working days in the period, if determinable).\n\n## 2. Categorised Task Summary (2.1–2.9)\nOne subsection per category above. For each: a brief narrative (2–4 sentences) of what was actually done, naming real places, people, or institutions from the data, followed by a compact bullet list of the individual activities in that category (date — place — one-line description). If a category has no activity this period, state that plainly in one line rather than omitting the section. Write this in plain, direct prose — this is an internal working report, not a donor-facing story, so it can be concise.\n\n## 3. Consolidated Intervention Matrix\nOne table, rows = the nine categories, columns = Activities Count / Key Locations (unique count) / Notable Output (beneficiaries reached, institutions touched, sessions delivered — whatever the data actually records). Include a TOTAL row. Numbers here must match the counts used in Section 2 — no separate, uncrosschecked tally.\n\n## 4. Places Visited\nA deduplicated list of every unique village/location visited during the period, each with the number of distinct visit-days (not activity count) against it, so repeat visits to the same place are visible without inflating the location total.\n\n## 5. Learnings During This Period\n2–4 bullet points, each 2–3 lines, drawn from what this staff member\'s own entries reveal: what worked, what was difficult, any notable insight or beneficiary reaction they recorded. Do not invent insight beyond what the entries actually show.\n\n## 6. Strategic Plan for Next Month\nGrouped as Planned priority activities / Planned locations / Support needed, drawn from anything the entries themselves flag as pending, upcoming, or blocked. If the raw data gives no forward-looking signal at all, say so and offer this as a gap to raise with the staff member directly rather than fabricating a plan on their behalf.\n\n## 7. Areas for Improved Delivery\n2–4 constructive, evidence-based observations drawn strictly from patterns visible in this individual\'s own reporting — activity concentrated in very few categories or places, low documentation frequency relative to field activity, gaps of several days with no logged entry, thin or vague activity descriptions, or an "Other" bucket large enough to obscure real work. Each observation should name the specific evidence behind it (e.g. "12 of 30 calendar days in this period have no logged entry") and suggest one concrete, practical fix — never speculate about motivation, effort, or attitude; describe only what the data shows and what would make it more complete or useful going forward.\n\n---\nStyle: keep the tone factual and constructive throughout, especially in Section 7 — this report may be read by the staff member themselves or their manager, so observations should read as coaching, not criticism. Every number in the matrix, every place name, and every "learning" must be traceable to a specific entry in the raw data. Where the data is genuinely thin for a section, say so directly ("No professional development activity was logged this period") rather than padding with generic language.\n*Report generated from field entries. All figures and narratives are evidence-based from submitted field data.*',
  },
  {
    id: 'team',
    icon: <Users className="w-5 h-5" />,
    title: t.ctTeamTitle,
    description: t.ctTeamDesc,
    category: 'report',
    color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Generate a structured Monthly Team Report following this NGO reporting template:\n\n# Monthly Team Activity Report | [Month Year]\n\n## 1. Reporting Period Overview\n- Reporting Period: [date range from entries]\n- Total Team Members Active: [count unique contributors]\n- States / Geographies Covered: [list]\n- Total Field Reports Submitted: [count]\n\n## 2. Team Objectives for the Month\nFor each project and intervention area:\n- Objective statement\n- Achievement Status: Met / Partially Met / Not Met\n- Evidence drawn from field data\n\n## 3. Individual Contributions Summary\n| Staff Name | Reports | Beneficiaries | Key Activities | Locations |\n|------------|---------|---------------|----------------|-----------|\n\nPopulate one row per team member, drawing from their field entries.\n\n## 4. Key Activities & Outcomes by Project\nFor each project, write a subsection:\n- Activities conducted (dates + locations)\n- Beneficiaries reached\n- Outcomes observed\n- Notable milestones or incidents\n\n## 5. Participant Engagement\n- Total beneficiaries reached by the team this period\n- Breakdown by project or intervention area\n- Engagement quality and community response observations\n\n## 6. Collective Impact Highlights\n- Cumulative beneficiary count\n- Geographic reach (states, districts, villages)\n- Cross-cutting themes across team activities\n- 1-paragraph standout success story from the data\n\n## 7. Challenges Faced & Team-Level Mitigation\n| Challenge | Who Affected | Impact Level | Resolution / Support Needed |\n|-----------|--------------|--------------|-----------------------------|\n\nInfer from data patterns, gaps in reporting, or field descriptions.\n\n## 8. Financial Highlights\n- Resource utilisation overview (infer from activity scope)\n- Resource gaps or constraints noted in field entries\n- Materials or inputs referenced across activities\n\n## 9. Collaboration & Coordination\n- Government or partner engagements mentioned in entries\n- Joint or cross-functional activities\n- Inter-team coordination evidence\n\n## 10. Learnings & Team Development\n- What worked well collectively\n- Skills or knowledge gaps observed\n- Training or capacity building needs identified\n\n## 11. Plan for Next Month\n- Team priorities for the coming period\n- Deployment plan overview\n- Management support required\n\n## 12. Additional Stakeholder Information\n- Documentation and photos produced\n- Compliance or regulatory matters\n- Urgent issues requiring leadership attention\n\n---\n*Team report generated from field entries across all active staff. All figures are evidence-based from submitted field data.*',
  },
  {
    id: 'org',
    icon: <Building2 className="w-5 h-5" />,
    title: t.ctOrgTitle,
    description: t.ctOrgDesc,
    category: 'report',
    color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Generate this as a formal Organization Management Information System (MIS) Report — the professional document an NGO programme/MIS team would produce for the Board or senior leadership. The report\'s SUBJECT is the ENTIRE ORGANIZATION as a whole — every project, every state, and the collective work of every employee across the organization — never structure any section (including the Activity Log) as a per-person breakdown, ranking, or performance review of individuals. Use ONLY the data actually submitted by field staff across the organization, but always speak of "the organization" / "the field teams" as a group; individual names appear only once, together, in the Contributing Team roster below — nowhere else in the report.\n\n**Aggregation integrity — read before writing any number:** Check the "Project × Geography Overlap" data block below before presenting any beneficiary total that spans more than one project — if it lists overlapping locations, every such total (Executive Summary, KPI table, Portfolio Summary) must carry a one-line caveat naming the overlapping projects/locations and stating the figure is a simple sum, not a confirmed deduplicated unique reach; if the block reports no overlap, state totals plainly with no caveat needed. Never present an activity or beneficiary count as an "outcome," "impact," "income enhancement," or "productivity enhancement" — those require verified monitoring & evaluation data this pipeline does not currently supply, so describe only what the field data actually shows: activities conducted and beneficiaries reached (output-level, not outcome-level). If the Field Data Summary or per-project figures show clearly uneven data coverage across projects for this period (one project\'s entries spanning the full period while another\'s cover only part of it, or one project logging far fewer entries relative to its usual pace), say so explicitly rather than blending partial and full coverage into one uniform total.\n\n**Write descriptively, with real illustrations:** every narrative section (Executive Summary, the Section 6 area subheadings, Outcomes & Results, Key Learnings, Strategic Priorities) should read as a well-observed account with concrete, specific detail — named locations, activities, and community context drawn from the records — not generic fragments or thin bullet points. Descriptive means vivid and specific, never invented: ground every added detail in what the Individual Activity Records actually show. Spread real field photos through the body rather than confining them to one gallery — see the photo instructions inside Section 6 and Section 7 below.\n\nFollow this exact template:\n\n# Organization MIS Report — [Reporting Period]\n\n**Report Type:** Organization Management Information System (MIS) Report\n**Prepared By:** [the exact name given at the top of this prompt as the person generating this content — never invent, guess, or substitute a different name]\n**Prepared For:** Board / Senior Leadership\n\n## Executive Summary\nA 5-8 sentence descriptive brief covering total activities logged across the organization, total beneficiaries reached (with the overlap caveat applied if the Project × Geography Overlap block lists any overlapping locations), geography and projects covered, and overall organizational trajectory this period — written about the organization collectively, and grounded in enough specifics (naming at least one standout location, activity, or theme from the data) that it reads as a real account of the period, not a template with numbers dropped in.\n\n## 1. Organization Overview\n- Organization Name: [name from data]\n- Reporting Period: [date range from entries]\n- Projects Covered: [list every distinct project from data]\n- Geography Covered: [states, districts, locations from data]\n- Areas of Intervention: [list]\n\n## 2. Key Performance Indicators\n| Metric | Value |\n|--------|-------|\n| Total Activities Logged | |\n| Total Beneficiaries Reached | |\n| Active Projects | |\n| States / Locations Covered | |\n| Field Staff Contributing | |\n\nPopulate every row using the "Field Data Summary" and "All Contributors" data blocks provided (Field Staff Contributing = the contributor count given there) — these cover the full dataset. Never estimate, round, or recount from the Individual Activity Records list, which may not include every record. Add one caveat line directly beneath the table if the Project × Geography Overlap block lists any overlapping locations.\n\n## 3. Contributing Team\nUse the "All Contributors (full dataset, authoritative)" data block provided — list every name from it, once, as a single collective roster — e.g. "This period\'s work was delivered by a team of N field staff across the organization: Name1, Name2, Name3...". Do not describe, compare, rank, or attribute specific activities to any one of them elsewhere in the report — this is the only place individual names appear.\n\n## 4. Strategic Scope & Objectives\n- Overall organizational mandate, inferred from the intervention areas and activities present across all projects in the data\n- Key organization-wide objectives for the reporting period\n- Achievement status per objective: Met / Partially Met / Not Met, with supporting evidence\n\n## 5. Portfolio Summary by Project\nSummarise — do NOT list every individual activity row-by-row. A rollup table with one row per distinct Project, using figures aggregated from the full dataset provided — never recount from the Individual Activity Records list, which may omit older records outside its detail cap:\n| Project | Activities Conducted | Beneficiaries Reached | States / Locations Covered |\n|---------|-----------------------|------------------------|------------------------------|\n\nAdd a footnote beneath the table naming any project pairs flagged in the Project × Geography Overlap block, so a reader can see which project totals may overlap.\n\n## 6. Activity Summary by Area of Intervention\nA second rollup table with one row per distinct Area of Intervention: use the exact figures from the "Area of Intervention Breakdown (full dataset, authoritative)" data block provided — never recount from the Individual Activity Records list, which may omit older records outside its detail cap:\n| Area of Intervention | Activities Conducted | Beneficiaries Reached | Locations Covered |\n|----------------------|-----------------------|------------------------|--------------------|\n\nThen, beneath the table, one `### <Area of Intervention>` subheading per area with a descriptive 4-6 sentence narrative of what was done in that area across the organization during the period — name specific locations, notable activities, and outcomes so the reader gets a real sense of what happened on the ground, not a generic summary or a list of every date — grounded in the Individual Activity Records available for that area. Immediately beneath each subheading\'s narrative, if at least one Individual Activity Record for that area has a "Photo:" line, embed one representative photo inline on its own bare line: an exclamation mark, a caption naming the activity/location in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record\'s "Photo:" line — e.g. `![Training session, Khagaria](https://drive.google.com/file/d/1AbCdEfGhIjK/view)`. NEVER write a placeholder link in place of the real one, and never reuse the same photo under more than one area. Do NOT add a "Reported By" or similar per-activity attribution — this section describes what the organization collectively delivered in each area, not who delivered it or a date-by-date log.\n\n## 7. Field Documentation\nA supplementary gallery: 3-6 more significant activities that have a "Photo:" line in their record and were NOT already used as an area\'s representative photo in Section 6. Embed each real field photo the same way — on its own line, an exclamation mark, the caption in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record\'s "Photo:" line — e.g. `![Community meeting, Supaul](https://drive.google.com/file/d/1AbCdEfGhIjK/view)`. NEVER write the literal words "Photo URL" or any placeholder in place of the real link. If an activity has no "Photo:" line, skip it — do not fabricate one. Captions describe the activity/location, never the individual who reported it. If fewer than 3 additional, non-duplicate photos exist beyond Section 6, include as many as genuinely exist and say so rather than padding with repeats.\n\n## 8. Outcomes & Results\n- Quantitative: total beneficiaries reached, sessions/events held, households/villages/districts covered, across all projects\n- Qualitative: observable changes, community response, and notable shifts in the data — described specifically (what changed, where, among whom), not as generic statements\n\n## 9. Key Learnings\n- What worked well across the organization during the period\n- Unexpected insights surfaced by the field data\n- Practices worth replicating across projects\n\nGround each of the three points above in a specific example from the data (a location, activity, or project it was observed in) rather than stating it as a generic truism.\n\n## 10. Key Challenges\n| Challenge | Impact | Mitigation Taken / Needed |\n|-----------|--------|----------------------------|\n\nInfer challenges from data gaps, recurring issues, or explicit field descriptions.\n\n## 11. Resource & Financial Highlights\n- Resource utilisation narrative across the organization (infer from activity scope and materials/inputs mentioned)\n- Resource constraints or gaps noted in field entries\n\n## 12. Stakeholder & Partner Engagement\n- Government, community, or partner interactions mentioned in the data\n\n## 13. Strategic Priorities — Next Steps\n- Priority activities for the next reporting period\n- Projects, locations/communities to prioritise\n- Support or resources needed from senior leadership\n\n## 14. Recommendations\n- Strategic recommendations for the organization going forward\n\n## 15. Risks & Sustainability Outlook\nA brief, honest note on what could threaten continuity of results — include only if the field data genuinely evidences a risk (a recurring resource gap, a repeatedly flagged challenge, a seasonal or climate risk mentioned across entries). If no such signal is present in the data, write one line stating that no organization-wide risk signal was evident in this period\'s field data rather than inventing one.\n\n## 16. Data Sources & Methodology Note\nA short, transparent closing note: state plainly that every figure above is derived from self-reported field entries logged by field staff, cross-validated only by timestamp and location; which structured datasets were ALSO used, naming each one exactly as it appears in the Organizational & Project Reference Data section (e.g. Project Portfolio, Action Plan, Annual Targets & Progress, Budget & Financial Utilisation, MIS Indicators, Compliance Calendar, Impact Framework, Beneficiary Statistics) and which figures in the report came from them — or, if that section is absent from this prompt, that no separate M&E, financial, or approved work-plan dataset was supplied for this period; and restate the overlap caveat from the Project × Geography Overlap block if it applies. This is what makes the report defensible to an external, technically literate reader.\n\n---\n*Organization MIS report generated from field entries submitted by teams across the organization. All figures and photos are drawn directly from submitted field data.*',
  },
  {
    id: 'project',
    icon: <TrendingUp className="w-5 h-5" />,
    title: t.ctProjectTitle,
    description: t.ctProjectDesc,
    category: 'report',
    color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: `Generate this as a comprehensive Donor-Grade Project Report — the rigorous, evidence-based document a programme/MIS team would produce for donors, the Board, or funders, following standard NGO donor-reporting practice for classification, data-quality control, and narrative depth. The report's SUBJECT is the PROJECT as a whole and the COLLECTIVE work of the field team — never structure any section as a per-person ranking or performance review. Use ONLY the data actually submitted for this project.

If a "Verified Headline Figures" data block appears below, those numbers (Total Activities Logged, Total Beneficiaries Reached, Locations Covered, Field Staff) are authoritative — from the organisation's deduplicated Excel/MIS export of DAILY FIELD ACTIVITY — and MUST be used exactly as given for the KPI Snapshot and the Quantitative Intervention Summary's TOTAL row. Never recompute or override them from the Individual Activity Records. If that block is absent (or a figure in it is blank), compute that particular figure from the Field Data Summary / Individual Activity Records instead, and add one line noting it is derived from field records rather than a verified MIS export.

If an "Annual Progress Report" data block also appears below, treat it as a COMPLETELY SEPARATE data source — it tracks the project's own deliverable Target vs. Achievement from an independent Excel upload, not daily field activity, and must never be mixed into the KPI Snapshot, the Quantitative Intervention Summary, or its theme totals above. Render it as its own standalone table in Section 4 (Progress Report) exactly as instructed there, and reference only its headline achievement figure — as prose, not a recomputed table entry — in the Reflective Analysis section. If this block is absent, keep Section 4's heading but write one line noting no Annual Progress Report data was available for this period — never remove or renumber the section.

No fixed district list is provided — infer this project's expected operating geography yourself from the data. Look at the Location field (not the State field, which is usually too coarse to be useful) across all Individual Activity Records, identify the location(s)/area that the clear majority of entries share, and treat that as this project's established geography. Flag any activity whose Location is a clear outlier relative to that pattern — it may be a misreport or a cross-post from a different project — by excluding it from all totals, themes, case studies, and events, and listing it under Data Quality Flags instead. Do not flag genuine variation between villages/Panchayats within the same recognisable area; only flag a location that is clearly disconnected from where the rest of this project's activity is concentrated.

**STEP 1 — Classify every activity into exactly these seven themes** (assign each to its single best-fit theme by primary purpose; never double-count):
1. Community Engagement — mobilisation, village meetings, awareness campaigns, demand-letter collection, conservation/outreach events.
2. Capacity Building & Training — trainings, demonstrations, exposure visits, staff/CRP skill-building.
3. Convergence & Camps — coordination meetings, joint camps, or liaison with government departments, Panchayats, research institutions, or other external stakeholders.
4. Enterprise Development — input distribution, financial linkage, livelihood-unit setup, anything that moves a beneficiary toward running an income-generating activity.
5. Gender Integration — activities explicitly targeting women's participation, safety, or leadership (women-only cohorts, SHG linkage, gender-disaggregated outreach).
6. Resilient Livelihood Enhancement — climate-adaptive or ecosystem-linked livelihoods specifically (SRI farming, aquaculture, apiculture, ecosystem restoration). Treat this as a cross-cutting TAG, not a separate count — flag which activities also carry this tag without adding them to any theme's total.
7. Collective & Institution Development — formation, registration, or strengthening of community institutions (committees, cooperatives, SHGs), documentation, MIS/data upkeep.
If a theme has little or no real data, say so explicitly rather than inferring or padding.

**STEP 2 — Screen for field-reporting errors** before including any entry: duplicate or repeated entries (read the Description field, not just the date/village — the same activity may be reported twice in slightly different wording, possibly by two staff, or resubmitted; count it once and note the repeat in Data Quality Flags), implausible beneficiary/activity counts (an outlier far above the typical pattern in the rest of the data — flag as needing field verification, don't include at face value), missing or ambiguous dates (exclude from period figures, note), inconsistent name spellings for the same village/person (merge, use the most complete/correct spelling), and entries lacking a clear category tag (classify conservatively, note the source entry lacked a tag). Never fabricate numbers — if you must estimate, label it clearly as an estimate and state your assumption.

**STEP 3 — Ground everything in real names.** Pull actual village/Panchayat names, beneficiary/farmer names, staff names, and institution names directly from the Individual Activity Records and use them throughout the thematic sections, case studies, and events section — never write generically ("a village in the district," "a local farmer"). If a name isn't available in the data for a given claim, describe the activity without inventing one.

This report should be comprehensive and thorough, not compressed. Do not artificially cap any section to a fixed small number of paragraphs, bullets, or words merely for brevity — write as much depth as the underlying data genuinely supports. Where a section below gives a minimum, treat it as a floor, not a target: cover every distinct theme, activity, event, insight, or case worth mentioning rather than picking one representative example and stopping. Length should be driven by the richness of the data, never squeezed to fit a short word count.

**Produce the report in this exact structure:**

# Project Report — [Project Name] | [Reporting Period]

## 1. Header
Project name, reporting period, geography, field staff count, one-line data source note.

## 2. KPI Snapshot
Total Activities, Total Beneficiaries, Total Locations Covered, Field Staff Involved — per the authority rule above.

## 3. Quantitative Intervention Summary
One table: rows = the seven themes, columns = What It Covers This Period / Activities / Beneficiaries / Unique Locations. Locations counted as unique places, not repeat mentions — never present "number of times a place was mentioned" as "number of locations covered." The TOTAL row must match the Verified Headline Figures (daily field activity) from the rule above; if there's a gap, note it in one line under the table rather than forcing agreement. This table is built ONLY from daily field activity data — never fold in any Annual Progress Report figures here.

## 4. Progress Report
If an "Annual Progress Report" data block was provided, render its rows as their own table here — columns Activity/Deliverable | Target | Achievement | % Achieved (compute % as Achievement/Target, blank if Target is 0 or missing) — plus a TOTAL row using its given totals. State the Financial Year and the "as of" month it's cumulative through directly above the table. This table is entirely independent of Section 3 — do not total it together with, or reconcile it against, the daily-field-activity figures there. Below the table, write a full explanatory narrative (not just the bare numbers) covering: which deliverables are ahead of target and which are behind and by how much, what the headline cumulative achievement figure means for the project's overall financial-year trajectory, and any deliverable-specific pattern worth calling out. This is a real qualitative explanation of the achievement data, not a one-line caption. If no such block was provided, keep this heading and write one line noting no Annual Progress Report data was available for this period.

## 5. Thematic Qualitative Analysis (5.1–5.7)
One subsection per theme, at minimum 2–3 full paragraphs each but going well beyond that where the data supports it — cover every distinct activity, village, or incident under the theme worth naming, not just one representative example: first — what happened and where, naming specific villages/Panchayats/people involved; second — how it connects to the project's broader goal and any notable community outcome or reaction; third, where the data supports it — a specific incident, a paraphrased quote-worthy moment, or a challenge encountered on the ground. If a theme genuinely has thin data, say so honestly rather than padding with generic filler. If an activity within this theme has a real "Photo:" line, you may embed the single best-fitting one inline alongside this theme's description — same format as Section 12 (exclamation mark, caption in square brackets, then the exact link copied character-for-character in parentheses). Optional, at most one per theme, and independent of the five chosen for Section 12 — the same photo may appear in both places if it's genuinely the best fit for each.

## 6. Community Events Celebrated / Organised
Every notable event, celebration, or observance day conducted in the period — event name and date (if known), village/location, approximate participation, who organised or partnered on it, and what it achieved beyond the celebration itself. Give every significant event its own paragraph rather than compressing them into a short combined summary — the number of paragraphs should scale with how many events actually occurred.

## 7. Case Studies
Two case studies, written in full narrative human-interest style suitable for a donor report, at minimum 4–6 paragraphs each but longer where the data genuinely supports more detail:
- Case Study 1 — an individual or small group of farmers/beneficiaries (real name(s) from the data): their situation before the intervention, the specific support received (training, inputs, linkage), what changed, and a forward-looking note on what they plan next. Name their village and Panchayat.
- Case Study 2 — a community institution (an MCMC, SHG, cooperative, or similar, by its real name where available): how it was formed, who leads it, what milestone it reached this period (registration, resolution passed, bank account, first activity conducted), and what it enables going forward.
Each needs a short title, a one-line standfirst, and should end with one sentence on why this case is representative of the broader thematic pattern in Section 5. If the data doesn't contain enough real detail for a full case study, say so explicitly and offer instead a shorter "field snapshot" clearly labelled as such, built only from verifiable details — never fabricate a beneficiary's personal story.

## 8. Learnings During This Period
As many bullet points as the data genuinely supports — do not stop at a small handful if more real insights are present. Each written out in full (not a one-liner): state the insight, then the evidence behind it and why it matters going forward — ideally connecting two or more themes.

## 9. Reflective Analysis
Assess performance against stated objectives in full prose depth — not compressed to one or two paragraphs if the data supports a fuller discussion — naming the honest bottleneck(s) or tension(s) in the data (e.g. mobilisation outpacing institution-building) — not just listing successes. If an Annual Progress Report data block was provided, close with a further paragraph that situates this period's field activity against the project's cumulative financial-year achievement figure as qualitative context (e.g. pace relative to target, which deliverables are driving or lagging that pace) — written as prose, never as a recomputed quantitative claim.

## 10. Innovative Components
As many bullet points as genuinely apply, each written out in full: name the innovation, describe concretely what was done differently, and note the early effect or why it's worth continuing.

## 11. Strategic Plan for Next Quarter
Grouped into Priority Activities / Priority Locations or Communities / Support & Resources Needed. Write each point out in full detail rather than a short bullet — specific (which village, which institution, which unresolved issue) — based on unresolved issues and momentum visible in this period's data.

## 12. Field Documentation
Select only the best five photos overall — by relevance to the report's key themes and image clarity/subject — from the activities above that have a real "Photo:" line in their record, even if more are available. For each: on its own line, write an exclamation mark, the caption in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record's "Photo:" line — e.g. an image line whose parenthesised part is exactly the https://drive.google.com/... link (not a description of it). NEVER write the literal words "Photo URL" or any placeholder in place of the real link. If an activity has no "Photo:" line, skip it. If fewer than five activities have a real photo, include only those that do — never pad to reach five.

## 13. Data Quality Flags
Required closing section: what was excluded (out-of-geography entries, duplicates, implausible figures), what was merged (name-spelling variants), and any pattern worth the field team's attention. If genuinely nothing came up this period, say so in one line rather than omitting the section.

**Style:** Plain, donor-report-ready prose — no marketing language, no unverified superlatives. Every quantitative claim in the prose must trace back to Section 3's table (or, for Annual Progress Report context in Section 9, to Section 4's table) — never blend the two. Keep thematic subsections roughly equal length so no theme reads as an afterthought. Flag weak or missing data at the point it appears, not just in a footnote. Real names, real places, and an honestly-flagged gap are always better than a smooth but generic sentence.`,
  },
  {
    id: 'impact',
    icon: <Heart className="w-5 h-5" />,
    title: t.ctImpactTitle,
    description: t.ctImpactDesc,
    category: 'report',
    color: '#dc2626', bg: '#fef2f2', border: '#fecaca',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Focus exclusively on human impact and beneficiary reach. Quantify lives touched, quality improvements achieved, and the depth of change created in communities. Include case narratives where possible.',
  },
  {
    // Subjects come from the dashboard contributor filter; the logged-in user is the
    // generator (see buildReportPrompt's dual-block prompt in routes/reports.routes.js).
    id: 'other',
    icon: <Users className="w-5 h-5" />,
    // Falls back to English where the locale lacks ctOtherTitle / ctOtherDesc.
    title: ((t as unknown as Record<string, string>).ctOtherTitle) || 'Generate Report for Other',
    description: ((t as unknown as Record<string, string>).ctOtherDesc) || 'Performance / activity report about one or more selected team members.',
    category: 'report',
    color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Write a comprehensive performance / activity report about the named SUBJECT(S) of this report (see Subjects block in the system prompt). Use third person throughout for subjects. Structure: (1) Executive Summary — period covered + headline figures, (2) Subject Profile(s) — role, projects, geography, (3) Key Activities — dated narrative grouped by project/intervention area, (4) Quantitative Outputs — beneficiaries, sessions, locations, (5) Quality & Process Observations — strengths and gaps visible in the data, (6) Recommendations for the Subject and their Reporting Manager. Cite source field-entry IDs (r1, r2, …) where claims rest on specific entries. If a multi-subject report, contrast contributions and call out collaboration patterns.',
  },
  // ── Content ───────────────────────────────────────────────────────
  {
    id: 'story',
    icon: <Search className="w-5 h-5" />,
    title: t.ctStoryTitle,
    description: t.ctStoryDesc,
    category: 'content',
    color: '#d97706', bg: '#fffbeb', border: '#fde68a',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: `You are a nonprofit storytelling expert using the Nonprofit Storytelling Conference framework. Your task is to mine these field entries and surface the single most powerful, shareable human story hidden in the data.

STEP 1 — STORY DISCOVERY (work through these prompts internally to identify the best story):
• Is there a person whose life has been completely transformed by services or interventions described?
• What is the most unexpected or surprising way impact was made here?
• Is there a story of resilience or hope that perfectly encapsulates the mission?
• What were the biggest challenges faced — before and after the intervention?
• If a beneficiary hadn't encountered this programme, what might their life look like now?
• Which entry carries an emotional charge — a detail, a place, a number — that deserves to be told?

STEP 2 — APPLY THE 3-PART STORY ARC:
• Beginning: Set the scene. Introduce the protagonist (a real or composite beneficiary), their location, their world before the intervention. Use specific details from the data.
• Middle: The conflict or challenge. What problem did they face? What obstacles existed? Make the stakes real and human.
• End: The resolution and transformation. What changed? What is possible now that wasn't before? End with a forward-looking sentence that inspires.

STEP 3 — WRITE THE STORY following these rules:
1. Start with a hook — a single vivid sentence that drops the reader into the moment
2. The field worker in this story is the person named in the Staff Profile block (if present) — use their exact name and designation. The beneficiary is a real or composite community member drawn from the field data.
3. Show, don't just tell — use concrete sensory details, specific locations and dates from the data
4. Create an emotional connection — let the reader feel what the beneficiary felt
5. Be authentic — ground every claim in what the field data actually shows; do not invent facts
6. Keep it to 4-6 tight paragraphs — shareable, readable, and moving
7. End with a call to action or a sentence that connects this story to the larger mission

OUTPUT FORMAT:
## [Compelling Story Title]

[The story — 4-6 paragraphs]

---
*Story sourced from: [Project name, Location, Date range from field entries]*`,
  },
  {
    id: 'caseStudy',
    icon: <Quote className="w-5 h-5" />,
    title: ((t as unknown as Record<string, string>).ctCaseStudyTitle) || 'Case Study',
    description: ((t as unknown as Record<string, string>).ctCaseStudyDesc) || 'Single-beneficiary field story with a verified before/after arc, sectoral context, and a scalability case.',
    category: 'content',
    color: '#be185d', bg: '#fdf2f8', border: '#fbcfe8',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: `You are a field communications writer producing a beneficiary case study / field story from the data below. The story must read like real storytelling, not a report — but every fact in it must be traceable to the source data.

**1. Find a real before/after arc in the data — do not invent one.** Scan the field entries for a beneficiary, or a local collective, where the data shows a genuine arc: Before (a problem, constraint, or livelihood risk mentioned in an entry), Intervention (the specific support given — training, input, linkage, group formation — with date and village), After / emerging change (a follow-up entry showing a reported outcome, reaction, or early result). If the data only shows the intervention step with no before-context or after-result, say so plainly and build a shorter story around what is genuinely there, clearly noting the arc is partial — never invent the missing piece.

**2. Validate geography before writing.** No fixed district list is provided — infer this project's expected operating geography from the Location field pattern across entries (the area/district the clear majority share), and confirm the beneficiary or institution you feature falls within it. If the strongest candidate story sits in a location that's a clear outlier from that pattern, exclude it and note this rather than using it — a case study is public-facing, so a geography error here is more visible and more damaging than in an internal report.

**3. Decide: single beneficiary or composite story.** Default to a single, real, named beneficiary or a single named institution/collective wherever the data supports it — this is always the stronger, more credible story. Only build a composite (blending 3–4 similar beneficiary accounts into one narrative voice) when the data has multiple similar-but-thin individual accounts and no single one has enough detail alone to carry a full story. If you build a composite: say so explicitly in the story itself (e.g. a closing standfirst note naming the real individuals it draws on); never present it as one single verified individual's unbroken personal account; keep every specific fact (a quote, a number, a date) attributed to whichever real entry it actually came from — do not smooth several people's separate facts into a timeline that implies they all happened to one person.

**4. Testimonials — real words only, clearly marked.** If the data contains something close to a direct beneficiary quote, use it (lightly cleaned up for readability, meaning preserved). If no real quote exists, do not invent one in quotation marks — write the beneficiary's reaction in reported/paraphrased speech instead (e.g. "Anita said the ice box meant she no longer worried about her stock spoiling by midday"). Never attribute a quote to a named individual unless that individual is real and the sentiment is traceable to the source data.

**5. Add sectoral context to strengthen the "why this matters" case.** Where you can draw on a current, credible external data point relevant to this sector and geography (a government/NABARD statistic, a documented sector trend, comparable-model coverage), cite the source by name, paraphrase rather than quote at length, and keep it to a short paragraph or boxed callout — it should support the human story, not overtake it. If you don't have a solid, current, relevant source, say so rather than citing something generic just to fill the section.

**6. Add one mid-story "live impact" callout.** Partway through the narrative — typically right after the intervention is described — insert a short, visually distinct callout (2–4 lines) with a concrete, sourced number that makes the impact tangible: a beneficiary count, a before/after figure, a group's membership size, a percentage change. Pull this only from the field data given, never from imagination.

**7. Make the scalability and policy case.** Close the story's substantive section with a short passage (narrative voice, not a bullet list) on what makes this specific model (the input, the training format, the group structure) replicable elsewhere — point to something concrete in the data (low input cost, an existing bank/NABARD partnership, a simple training format) — and any real signal already in the data of institutional or policy interest (NABARD engagement, government scheme linkage, bank partnership). If no such signal exists, say the model could be considered for larger schemes rather than claiming policy interest that hasn't happened yet. Keep this grounded and specific, not generic "this could change the world" language.

**8. Include real field photos of the featured beneficiary/institution.** Check the activity records behind this case study for a "Photo:" line. If the featured beneficiary/institution has one (ideally one from the intervention and one from the after/outcome stage — use whichever real ones exist), embed each inline on its own bare line: an exclamation mark, a short specific caption in square brackets, then in parentheses the ACTUAL LINK copied character-for-character from that record's "Photo:" line — e.g. \`![Anita packing fish at her stall in Rahmunia](https://drive.google.com/...)\`. NEVER write a placeholder link, a stock-photo description, or the words "Photo URL" in place of the real link, and never attach a photo from a different beneficiary's record to this one. If none of the records behind this case study have a "Photo:" line, skip the photo entirely — do not invent one or leave a placeholder.

**Structure — produce exactly these parts in order:**

## [Title — human, specific, not generic; use the person's name, place, or the concrete change, not "Empowering Communities" style]

[Standfirst — one or two sentences summarising who this is about and what changed]

[Opening — the "before": ground the reader in the real problem, in the beneficiary's own context]

[The intervention — what the project did, when, where, specifically]

[Photo from the intervention record, per Section 8 — omit if the record has none]

> **Live impact:** [2–4 line sourced-number callout, per Section 6]

[The "after" — the reported outcome, in narrative voice, with testimonial per Section 4]

[Photo from the after/outcome record, per Section 8 — omit if the record has none]

> **Why this matters:** [short sectoral-context callout, per Section 5 — omit this callout entirely if no solid source was found, rather than filling it with generic text]

[Why this can scale — per Section 7]

[Closing line — forward-looking, human, not a slogan]

---
*Attribution: [state plainly whether this is a single verified account or a composite, per Section 3; the source period of the data; the project name.]*
*Consent: real names and villages are being used in a public-facing document — flag here that field-team consent confirmation is still needed before publishing, and suggest a first-name-only or pseudonym option if consent status is unknown.*

**Style:** Write like a magazine human-interest piece, not a report — short sentences, concrete sensory detail where the data supports it, minimal jargon. Every name, number, date, and quote must trace back to the field data or the cited external source — nothing invented for narrative effect. Keep the sectoral-context and scalability sections clearly distinguishable from the personal narrative. Target length: 500–800 words for a single-beneficiary story; up to 900 for a composite.`,
  },
  {
    id: 'newsletter',
    icon: <Newspaper className="w-5 h-5" />,
    title: t.ctNewsletterTitle,
    description: t.ctNewsletterDesc,
    category: 'content',
    color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Write a complete monthly newsletter in Markdown format. Structure: (1) Warm header with month/year and mission tagline, (2) Executive Highlights — 3 bullet achievements, (3) From the Field — 2-3 compelling stories drawn from actual entries, (4) Impact in Numbers — formatted statistics, (5) Team Spotlight — celebrate a standout contributor, (6) Looking Ahead — next steps and calls to action. Professional but warm, inspiring tone suitable for donors and partners.',
  },
  {
    id: 'blog',
    icon: <BookOpen className="w-5 h-5" />,
    title: t.ctBlogTitle,
    description: t.ctBlogDesc,
    category: 'content',
    color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: `You are writing the weekly public blog for the organisation's website, focused on wetland-based livelihood models, from the field data below. This is public, searchable, thought-leadership content — more focused and more frequent than the monthly newsletter, and expected to demonstrate expertise, not just report activity.

**1. Pick this week's lens — don't run the same structure every week.** Choose one of the following to lead the post, touching the other three only briefly in support. If the additional instructions below name a lens or project explicitly, use that; if they list topics/lenses used in recent posts, pick a *different* lens or project than the most recent one or two; otherwise, pick whichever lens the field data actually supports best.
   - **Process Spotlight** — a deep look at one specific, unique method (how an institution formed and got its first shared asset, how documentation is sequenced, how a digital tool changes one field decision). Written like a "how we actually do this" explainer.
   - **Field Caselet** — a shorter, blog-length version of a beneficiary or institution story (200–400 words within the post, not a full case study), anchored to a real output number, following the no-fabrication/consent rules in Section 2.
   - **Data & Analysis** — a pattern noticed across this period's data (e.g. a mobilisation-to-enterprise gap, a surprising uptake pattern in a new livelihood), explained for a general reader, not an internal M&E audience.
   - **Global & National Context** — led by a current wetland-sector study, report, or policy development, with the organisation's own field data brought in partway through to show what that trend looks like on the ground.
   State which lens (and which project/state) was used in the byline metadata (Section 3), so an editor can track rotation week to week.

**2. Ground rules.** Never fabricate a name, quote, number, or study finding. Real names and places are being used in public-facing content — flag in a closing attribution note that field-team consent confirmation is still needed before publishing if consent status isn't already established. Every number in this post must come from the field data given here; because this generator does not have access to this period's newsletter or impact report, list the exact figures used and which record(s) they came from in that same attribution note, so an editor can cross-check them against whatever else has already been published for this period before this goes live — a blog stating a different figure than the newsletter for the same period is a credibility problem even if both were accurate when written. When citing an external wetland study or report (for a Global & National Context lens, or as supporting context in any post), cite it by name, paraphrase rather than quote at length, and don't overstate what it actually found.

**3. Structure — produce exactly these parts in order:**

## [Title — specific and searchable: name the place, the method, or the concrete number, not an abstract phrase]

*[Byline metadata — publish date if given, estimated read time, project/state tag, lens used]*

[Opening — a concrete scene, number, or moment from the field data. Get the reader into a real place within the first two sentences — never open with an abstract statement about the sector.]

[Body, organised around this week's chosen lens, with the other three lenses touched only briefly in support]

> **By the numbers:** [one short, visually distinct callout partway through with 2–4 concrete figures relevant to this week's angle, sourced from the field data]

### The Wider Lens

[2–3 closing paragraphs, present regardless of lens, connecting this week's specific story back to the broader wetland-livelihoods picture nationally or globally, citing at least one current external source by name. Even a Global & National Context-led post must land back on the organisation's own field data here — never end as generic sector commentary disconnected from the work.]

[Closing — a forward-looking line on what's next on this thread, plus a newsletter subscribe prompt]

---
*SEO: [a one-line meta description under 160 characters] — Keywords: [3–5 target keywords/phrases]*
*Attribution: [lens and project/state used; source period of the data; consent status per Section 2; figures to cross-check per Section 2.]*

**Style:** Write for an intelligent general reader who cares about livelihoods and ecosystems but doesn't know the organisation's internal categories — no jargon, no unexplained acronyms on first use. Target 700–1,100 words. Voice: confident, specific, and a little more opinionated than a report or newsletter — venture an interpretation or prediction where useful, but frame it clearly as the organisation's own view, not settled fact. Real names, real places, real numbers throughout.`,
  },
  {
    id: 'grant',
    icon: <Globe className="w-5 h-5" />,
    title: t.ctGrantTitle,
    description: t.ctGrantDesc,
    category: 'content',
    color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a compelling grant proposal narrative using this field data as the evidence base. Include: (1) Project Background & Problem Statement, (2) Theory of Change, (3) Activities Implemented — draw directly from field entries, (4) Impact Achieved — quantified from data, (5) Community Voices — infer testimonials from descriptions, (6) Sustainability & Scale-up Plan, (7) Budget Justification narrative. Formal donor language, internationally appropriate.',
  },
  {
    id: 'donor',
    icon: <Heart className="w-5 h-5" />,
    title: t.ctDonorTitle,
    description: t.ctDonorDesc,
    category: 'content',
    color: '#db2777', bg: '#fdf2f8', border: '#fbcfe8',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a quarterly donor report. Lead with the ROI of their investment, list specific activities their funding enabled, detail beneficiaries reached, show geographic coverage with state-wise breakdown, celebrate milestones, and outline next quarter plans. Grateful, accountable, evidence-based tone that builds donor trust and encourages renewal.',
  },
  {
    id: 'mis',
    icon: <Building2 className="w-5 h-5" />,
    title: t.ctMisTitle,
    description: t.ctMisDesc,
    category: 'content',
    color: '#374151', bg: '#f9fafb', border: '#e5e7eb',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Format this data as a Government MIS (Management Information System) report. Include: district-wise and state-wise activity tables, beneficiary counts by gender and category where available, intervention area statistics with completion percentages, compliance indicators, and a summary dashboard table. Formal government report style with numbered sections.',
  },
  {
    id: 'whatsapp',
    icon: <MessageSquare className="w-5 h-5" />,
    title: t.ctWhatsappTitle,
    description: t.ctWhatsappDesc,
    category: 'content',
    color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Write a short WhatsApp update (max 250 words) that field workers can share with their local communities. Celebrate achievements, highlight community impact, and inspire continued participation. Simple language, warm tone. Use relevant emojis naturally. A Hindi phrase or two is welcome. No jargon.',
  },
  {
    id: 'press',
    icon: <Megaphone className="w-5 h-5" />,
    title: t.ctPressTitle,
    description: t.ctPressDesc,
    category: 'content',
    color: '#ea580c', bg: '#fff7ed', border: '#fed7aa',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Write a press release about the milestone achievements shown in this field data. Format: (1) FOR IMMEDIATE RELEASE header, (2) Punchy headline with the biggest stat, (3) Location dateline, (4) Strong opening paragraph with lead stat, (5) 2-3 body paragraphs with supporting data, (6) Quote attributed to "Jaljeevika leadership", (7) Boilerplate "About Jaljeevika" paragraph, (8) Contact details placeholder. AP style, newsroom-ready.',
  },
  {
    id: 'annual',
    icon: <Award className="w-5 h-5" />,
    title: t.ctAnnualTitle,
    description: t.ctAnnualDesc,
    category: 'content',
    color: '#341272', bg: '#FBF9F4', border: '#DDD6FE',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a comprehensive Annual Impact Report for Jaljeevika. Structure: (1) Letter from Leadership, (2) Year in Numbers — key stats in bold, (3) Programme Highlights by project, (4) Geographic Reach — states and communities served, (5) Stories of Change — 2 beneficiary narratives drawn from data, (6) Financial Stewardship summary, (7) Looking Ahead — goals for next year. Formal, celebratory, publication-ready.',
  },
  {
    id: 'board',
    icon: <BarChart2 className="w-5 h-5" />,
    title: t.ctBoardTitle,
    description: t.ctBoardDesc,
    category: 'content',
    color: '#0E3A46', bg: '#FBF9F4', border: '#DDD6FE',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Board Report for senior governance. Structure: (1) Executive Dashboard — 5 KPIs with period comparison, (2) Programme Performance — project-wise summary table, (3) Operational Highlights, (4) Risk and Mitigation, (5) Recommendations for Board Action. Concise, data-heavy, strategic language. Suitable for a 15-minute board meeting agenda item.',
  },
  {
    id: 'toc',
    icon: <GitBranch className="w-5 h-5" />,
    title: t.ctTocTitle,
    description: t.ctTocDesc,
    category: 'content',
    color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Construct a Theory of Change narrative from this field data. Structure: (1) Problem Statement — what issues were being addressed, (2) Inputs — resources and activities deployed, (3) Activities — what was actually done (draw from entries), (4) Outputs — immediate measurable results, (5) Outcomes — medium-term changes, (6) Impact — long-term vision. Use the data as evidence at each stage. Clear causal logic throughout.',
  },
  {
    id: 'sdg',
    icon: <Flag className="w-5 h-5" />,
    title: t.ctSdgTitle,
    description: t.ctSdgDesc,
    category: 'content',
    color: '#059669', bg: '#ecfdf5', border: '#6ee7b7',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write an SDG Alignment Report. For each relevant SDG (likely 1, 2, 3, 4, 5, 6, 8, 10, 11, 13 — select only those genuinely supported by the data), provide: the SDG name and number, specific activities from the data that contribute, measurable indicators achieved, and a one-sentence impact statement. Conclude with a summary table of SDGs covered. Suitable for UN reporting or international donor submissions.',
  },
  {
    id: 'funder',
    icon: <Target className="w-5 h-5" />,
    title: t.ctFunderTitle,
    description: t.ctFunderDesc,
    category: 'content',
    color: '#d97706', bg: '#fffbeb', border: '#fde68a',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a formal Funder Progress Report. Structure: (1) Project Overview and Grant Period, (2) Activities Completed — with dates and locations from the data, (3) Milestone Achievement Table — list expected milestones and mark status, (4) Beneficiary Reach — numbers with disaggregation where possible, (5) Challenges and Mitigation, (6) Financial Narrative — activities per budget line (narrative only), (7) Next Period Plan. Compliance-focused, evidence-based, formal tone.',
  },
  {
    id: 'stories',
    icon: <BookMarked className="w-5 h-5" />,
    title: t.ctStoriesTitle,
    description: t.ctStoriesDesc,
    category: 'content',
    color: '#db2777', bg: '#fdf2f8', border: '#fbcfe8',
    roles: ['admin', 'manager', 'employee'],
    phase: 1,
    instruction: 'Create a collection of 3-5 distinct Impact Stories drawn from this field data. Each story should: have a compelling 1-line title, open with a specific person or community moment, describe the challenge they faced, explain what Jaljeevika did (reference actual activities), show the measurable change, and end with a forward-looking sentence. Stories should each feel unique — vary location, project, and beneficiary type. Ready for website, social media, or printed collateral.',
  },
  // ── Impact Measurement ────────────────────────────────────────────────────
  {
    id: 'sroi',
    icon: <BarChart2 className="w-5 h-5" />,
    title: t.ctSroiTitle,
    description: t.ctSroiDesc,
    category: 'content',
    color: '#341272', bg: '#FBF9F4', border: '#DDD6FE',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Social Return on Investment (SROI) narrative. Include: (1) Outcome Mapping — map each intervention area to a measurable social outcome, (2) Proxy Values — assign reasonable proxy financial values to each outcome category, (3) Beneficiary Stakeholder Groups — segment by project and area, (4) Attribution & Deadweight — acknowledge what change would have happened anyway and what Jaljeevika specifically caused, (5) SROI Ratio narrative — synthesise ratio with confidence intervals. Analytical, institutional-investor tone. Avoid invented data; infer conservatively from field entries.',
  },
  {
    id: 'beneficiaryJourney',
    icon: <Users className="w-5 h-5" />,
    title: t.ctBeneficiaryJourneyTitle,
    description: t.ctBeneficiaryJourneyDesc,
    category: 'content',
    color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Composite Beneficiary Journey report from this field data. Structure: (1) Composite Profile — create a representative beneficiary persona drawn from location, activity, and demographic patterns, (2) Before — situation before Jaljeevika intervention (infer from problem context in descriptions), (3) Touchpoints — list the key field activities this beneficiary type encountered in chronological order, (4) Change Observed — measurable or qualitative changes visible in the entries, (5) Sustained Impact — what long-term change has been enabled. Use specific field entry examples as evidence at each stage.',
  },
  {
    id: 'funderCompliance',
    icon: <FileText className="w-5 h-5" />,
    title: t.ctFunderComplianceTitle,
    description: t.ctFunderComplianceDesc,
    category: 'content',
    color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Grant Compliance Summary document. Include all of these sections: (1) Grant Compliance Summary — overview paragraph, (2) Financial Accountability Narrative — how funds were deployed across activities (narrative, no invented numbers), (3) Programmatic Outcomes Table — formatted as: Milestone | Target | Achieved | Status, with rows for each major project and area of intervention, (4) Regulatory Compliance Statements — standard declarations of field data integrity and reporting standards, (5) Audit-Ready Documentation Summary — list of evidence available (field reports, photos, attendance records), (6) Variance Explanation — any gaps between planned and actual activities with reasons.',
  },
  {
    id: 'boardImpactDeck',
    icon: <Award className="w-5 h-5" />,
    title: t.ctBoardImpactDeckTitle,
    description: t.ctBoardImpactDeckDesc,
    category: 'content',
    color: '#0E3A46', bg: '#FBF9F4', border: '#DDD6FE',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Board Impact Deck in slide-outline format. Number each slide section with: a punchy Headline, 3 bullet points, and a Data Callout (a bold statistic). Sections: (1) Period Snapshot — key numbers, (2) Programme Highlights — top 3 projects, (3) Geographic Reach — states and districts, (4) Beneficiary Impact — who was reached and how, (5) Theory of Change Progress — where we are on the causal chain, (6) Risk & Mitigation — 2-3 operational risks and mitigations, (7) Strategic Priorities — top 3 next steps for Board approval. Concise, data-heavy, boardroom-ready language.',
  },
  {
    id: 'trainingEval',
    icon: <BookOpen className="w-5 h-5" />,
    title: t.ctTrainingEvalTitle,
    description: t.ctTrainingEvalDesc,
    category: 'content',
    color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0',
    roles: ['admin', 'manager', 'employee'],
    phase: 2,
    instruction: 'Write a Training Evaluation Report using the Kirkpatrick 4-Level Model. Draw each level from patterns observed in field entry descriptions: (1) Level 1 — Reaction: how did field workers respond to training activities (infer from description quality and activity types), (2) Level 2 — Learning: evidence of knowledge or skill acquisition visible in entries, (3) Level 3 — Behaviour: how have participants applied learning in field activities, (4) Level 4 — Results: measurable outcomes linked to trained behaviours (beneficiary counts, coverage, quality indicators). Close with a Recommendations section proposing 3 improvements to evaluation rigour and training design.',
  },
  ]
}
