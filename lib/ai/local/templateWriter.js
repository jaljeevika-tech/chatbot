// lib/ai/local/templateWriter.js — Deterministic template generation
//
// Produces structured Markdown drafts and WhatsApp messages without any AI call.
// Templates are data-driven: every section uses pre-computed stats from reportAnalyzer.
// The model (when available) polishes the narrative — it never invents the numbers.

// ── WhatsApp fallback response ────────────────────────────────────────────────
/**
 * Build a warm, concise fallback reply when no intent matched.
 * Mirrors the tone of generateFallbackResponse() but without Gemini.
 */
export function buildFallbackResponse(contactName, orgName, flows = []) {
  const person = contactName ? contactName.split(' ')[0] : 'there'
  const org    = orgName || 'the organisation'

  const hints = (flows || [])
    .filter(f => !f.is_default && (f.trigger_keywords || []).length > 0)
    .slice(0, 4)
    .map(f => `• *${(f.trigger_keywords || [])[0]}* — ${f.name}`)
    .join('\n')

  if (hints) {
    return `Hi ${person}! 👋 I'm the ${org} field assistant. I didn't quite understand that — here's what I can help with:\n\n${hints}\n\nType a keyword to get started.`
  }
  return `Hi ${person}! 👋 I'm the ${org} assistant. Type *help* to see what I can do, or contact your coordinator for assistance.`
}

// ── Field visit report template ───────────────────────────────────────────────
export function draftFieldVisitReport(sources = {}, voiceProfile = {}, orgName = '') {
  const {
    workerName = '', project = '', location = '', state = '',
    area = '', beneficiaries = '', description = '',
    date = new Date().toLocaleDateString('en-IN'),
  } = sources

  const heading = project
    ? `# Field Visit Report — ${project}`
    : '# Field Visit Report'

  return `${heading}

**Date:** ${date}
**Location:** ${[location, state].filter(Boolean).join(', ') || '_(to be filled)_'}
**Field Worker:** ${workerName || '_(to be filled)_'}
**Area of Intervention:** ${area || '_(to be filled)_'}
**Beneficiaries Reached:** ${beneficiaries || '_(to be filled)_'}

---

## Summary of Activities

${description || '_(Describe the main activities carried out during this visit)_'}

---

## Key Observations

- _(What did you observe on the ground?)_
- _(Any challenges or barriers encountered?)_
- _(Community response and engagement level?)_

---

## Beneficiary Interactions

| Name | Age | Details |
|------|-----|---------|
| _(Add row)_ | | |

---

## Outcomes & Impact

- _(What changed as a result of this visit?)_
- _(Any immediate actions taken?)_

---

## Follow-up Actions

- [ ] _(Action item 1)_
- [ ] _(Action item 2)_

---

_Report by: ${workerName || 'Field Worker'} | ${orgName || 'Organisation'}_`
}

// ── Monthly summary template ───────────────────────────────────────────────────
export function draftMonthlySummary(stats = {}, orgName = '', month = '') {
  const {
    totals = {},
    topWorkers = [],
    topProjects = [],
    topStates = [],
    barriers = [],
    trend = null,
  } = stats

  const periodLabel = month || new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  const workerRows = topWorkers.slice(0, 5).map(w =>
    `| ${w.name} | ${w.reports} | ${w.beneficiaries.toLocaleString()} | ${(w.projects || []).join(', ')} |`
  ).join('\n') || '| _(No data)_ | | | |'

  const projectRows = topProjects.slice(0, 5).map(p =>
    `| ${p.project} | ${p.reports} | ${p.beneficiaries.toLocaleString()} | ${(p.states || []).join(', ')} |`
  ).join('\n') || '| _(No data)_ | | | |'

  const barrierList = barriers.slice(0, 5).map(b =>
    `- **${b.term}** — mentioned ${b.count} times`
  ).join('\n') || '- No barriers flagged this period'

  const trendNote = trend?.direction === 'up'
    ? `📈 Report volume increased ${trend.reportsDelta}% vs last month.`
    : trend?.direction === 'down'
      ? `📉 Report volume declined ${Math.abs(trend.reportsDelta || 0)}% vs last month.`
      : '📊 Activity levels stable compared to last month.'

  return `# ${orgName || 'Monthly'} Field Activity Summary — ${periodLabel}

---

## Overview

| Metric | Value |
|--------|-------|
| Total Reports | **${(totals.reports || 0).toLocaleString()}** |
| Total Beneficiaries | **${(totals.beneficiaries || 0).toLocaleString()}** |
| Avg. per Report | **${(totals.avgBenefPerReport || 0).toLocaleString()}** |

${trendNote}

---

## Worker Performance

| Worker | Reports | Beneficiaries | Projects |
|--------|---------|---------------|---------|
${workerRows}

---

## Project Activity

| Project | Reports | Beneficiaries | States |
|---------|---------|---------------|--------|
${projectRows}

---

## Challenges & Barriers

${barrierList}

---

## Geographic Spread

${topStates.slice(0, 4).map(s =>
  `- **${s.state}**: ${s.reports} reports, ${s.beneficiaries.toLocaleString()} beneficiaries`
).join('\n') || '- No state data available'}

---

## Recommendations

_(Add 2–3 recommendations based on the above data)_

---

_Generated from field data | ${orgName || 'FieldFlow'}_`
}

// ── Template picker ────────────────────────────────────────────────────────────
/**
 * Produce a deterministic template draft based on report type and source data.
 * @param {string} reportType   — 'field-visit' | 'monthly' | 'training' | 'generic'
 * @param {object} sources      — structured source data (from reportAnalyzer or DB)
 * @param {object} voiceProfile — org/worker writing preferences
 * @param {string} orgId        — for future org-specific templates
 * @returns {string|null}       — Markdown template or null if type unknown
 */
export function draftTemplate(reportType, sources = {}, voiceProfile = {}, orgId = null) {
  const type = (reportType || '').toLowerCase()

  if (type.includes('field') || type.includes('visit') || type.includes('field-visit'))
    return draftFieldVisitReport(sources, voiceProfile, sources.orgName)

  if (type.includes('month') || type.includes('summary') || type.includes('monthly'))
    return draftMonthlySummary(sources.stats || sources, sources.orgName, sources.month)

  // Generic starter
  return `# ${sources.title || 'Field Report'}

**Date:** ${sources.date || new Date().toLocaleDateString('en-IN')}
**Organisation:** ${sources.orgName || ''}
**Prepared by:** ${sources.authorName || ''}

---

## Summary

_(Provide a 2–3 sentence overview of activities and outcomes)_

---

## Details

_(Add details here)_

---

## Impact

_(Describe the impact and beneficiary reach)_`
}
