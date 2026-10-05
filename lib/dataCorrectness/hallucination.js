// Layer 2: hallucination guard on AI output. Adds ⟨MISSING⟩ marker enforcement,
// citation-ref validation and section-padding detection on top of
// lib/ai/local/evidenceChecker.js, with an optional LLM judge pass.

import { checkOutput } from '../ai/local/evidenceChecker.js'
import { runAI } from '../ai/runAI.js'
import { getOrgPrompt } from '../promptStore.js'
import { VALIDATION_PROMPTS } from './prompts.js'
import { getEnforcementMode } from './policy.js'

const MISSING_RE = /⟨\s*MISSING\s*:[^⟩]*⟩/g
const CITATION_RE = /\br(\d{1,4})\b/g

function _checkMissingMarkers(output, sources, reasons, kind) {
  const markers = (output.match(MISSING_RE) || []).length
  const sourceCount = Array.isArray(sources) ? sources.length : 0
  // Story Finder cites only the 1-3 rows behind each story; sparse citations are normal there.
  if (kind === 'story_finder') return null
  // If sources are sparse but output is long with no MISSING markers, flag.
  const longOutput = output.length > 600
  if (longOutput && sourceCount < 5 && markers === 0) {
    reasons.push(`output is ${output.length} chars long but only ${sourceCount} source rows and no ⟨MISSING⟩ markers — possible fabrication padding`)
    return { breach: 'moderate' }
  }
  return null
}

function _checkCitations(output, sources, reasons) {
  const refs = new Set()
  let m
  const re = new RegExp(CITATION_RE.source, CITATION_RE.flags)
  while ((m = re.exec(output)) !== null) refs.add(parseInt(m[1], 10))
  if (refs.size === 0) return null
  const sourceCount = Array.isArray(sources) ? sources.length : 0
  const broken = [...refs].filter(idx => idx < 1 || idx > sourceCount)
  if (broken.length > 0) {
    reasons.push(`citations to non-existent reports: ${broken.map(b => 'r' + b).join(', ')} (only ${sourceCount} sources provided)`)
    return { breach: 'severe' }
  }
  return null
}

function _checkPaddingByHeading(output, reasons) {
  // Split on Markdown headings; check sibling section lengths.
  const sections = output.split(/^#{1,4}\s+/m).filter(s => s.trim().length > 0)
  if (sections.length < 2) return null
  const lengths = sections.map(s => s.length)
  const median = lengths.slice().sort((a, b) => a - b)[Math.floor(lengths.length / 2)]
  const tiny = lengths.filter(l => l < 30).length
  const giant = lengths.filter(l => l > median * 4 && median > 100).length
  if (tiny >= 2) {
    reasons.push(`${tiny} report sections under 30 chars — likely empty stubs`)
    return { breach: 'moderate' }
  }
  if (giant >= 1) {
    reasons.push(`${giant} report section is >4× sibling length — possible padding`)
    return { breach: 'low' }
  }
  return null
}

function _aggregate(findings, evidenceScore) {
  const severities = findings.filter(Boolean).map(f => f.breach)
  let severity = 'clean'
  if (severities.includes('severe')) severity = 'high'
  else if (severities.includes('moderate')) severity = 'medium'
  else if (severities.includes('low')) severity = 'low'

  // A low evidence score forces severity up.
  if (evidenceScore < 0.6) severity = severity === 'clean' ? 'medium' : 'high'
  else if (evidenceScore < 0.85 && severity === 'clean') severity = 'low'

  const groundingScore = Math.min(evidenceScore, 1 - severities.length * 0.15)
  return { severity, groundingScore: Math.max(0, groundingScore) }
}

/**
 * Run hallucination checks on AI output against its source data.
 * @param {object} ctx  { orgId, kind: 'report'|'rw_draft'|'notebook_chat' }
 */
export async function checkHallucination(output, sources, ctx = {}) {
  if (!output || typeof output !== 'string') {
    return {
      severity: 'clean',
      grounding_score: 1.0,
      suspicious: [],
      reasons: [],
      action: 'allow',
      llm_used: false,
    }
  }

  const reasons = []

  const evidence = checkOutput(output, sources)

  const missing  = _checkMissingMarkers(output, sources, reasons, ctx.kind)
  const citation = _checkCitations(output, sources, reasons)
  const padding  = _checkPaddingByHeading(output, reasons)

  for (const s of evidence.suspicious) {
    reasons.push(s.reason)
  }

  let agg = _aggregate([missing, citation, padding], evidence.score)
  let llmUsed = false
  let fabricated_claims = []
  let unsupported_inferences = []

  // ── Judge pass: only when grounding < 0.85 ──────────────────────────────
  // Skipped for story_finder: the judge is tuned for literal donor reports and
  // reads narrative prose as fabrication, dropping every story. The deterministic
  // checks above still cover real fabrication there.
  if (ctx?.orgId && agg.groundingScore < 0.85 && ctx.kind !== 'story_finder') {
    try {
      const systemPrompt = await getOrgPrompt(
        ctx.orgId,
        'validation_hallucination_judge',
        VALIDATION_PROMPTS.validation_hallucination_judge
      )
      // Trim sources to bound prompt size — the judge needs structure, not bulk
      const sourceSnippet = Array.isArray(sources)
        ? sources.slice(0, 50).map((s, i) => `[r${i + 1}] ${JSON.stringify(s).slice(0, 300)}`).join('\n')
        : String(sources).slice(0, 6000)
      const userPrompt = `SOURCE_DATA:\n${sourceSnippet}\n\nDRAFT:\n${output.slice(0, 8000)}`
      const out = await runAI({
        feature: 'validation',
        operation: 'hallucination_judge',
        prompt: userPrompt,
        systemPrompt,
        orgId: ctx.orgId,
        userId: ctx.userId,
      })
      const parsed = _safeJson(out?.text)
      if (parsed) {
        llmUsed = true
        fabricated_claims = Array.isArray(parsed.fabricated_claims) ? parsed.fabricated_claims : []
        unsupported_inferences = Array.isArray(parsed.unsupported_inferences) ? parsed.unsupported_inferences : []
        const totalIssues = fabricated_claims.length + unsupported_inferences.length
        if (totalIssues > 0) {
          // Each fabricated claim drags grounding score down further
          const downgrade = Math.min(0.5, totalIssues * 0.1)
          agg.groundingScore = Math.max(0, agg.groundingScore - downgrade)
          if (agg.groundingScore < 0.6) agg.severity = 'high'
          else if (agg.groundingScore < 0.85) agg.severity = agg.severity === 'clean' ? 'medium' : agg.severity
          for (const c of fabricated_claims.slice(0, 5)) {
            reasons.push(`judge: fabricated — ${c.text?.slice(0, 60) || ''}`)
          }
          for (const u of unsupported_inferences.slice(0, 3)) {
            reasons.push(`judge: unsupported inference — ${u.text?.slice(0, 60) || ''}`)
          }
        }
      }
    } catch (e) {
      console.warn('[hallucination] judge pass failed:', e.message)
    }
  }

  // Enforcement mode: 'soft' flags; 'tiered' blocks high severity
  const mode = ctx?.orgId ? await getEnforcementMode(ctx.orgId) : 'soft'
  let action = 'allow'
  if (agg.severity === 'low' || agg.severity === 'medium') action = 'flag'
  else if (agg.severity === 'high') action = mode === 'tiered' ? 'block' : 'flag'

  return {
    severity: agg.severity,
    grounding_score: agg.groundingScore,
    suspicious: evidence.suspicious,
    fabricated_claims,
    unsupported_inferences,
    reasons,
    action,
    llm_used: llmUsed,
  }
}

function _safeJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
