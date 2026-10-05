// LLM prose for a performance review (strengths, improvements, risk, recommendation +
// action plan), via runAI so the org budget cap and breaker apply. Falls back to
// deterministic defaults when the model is unavailable.

import { getOrgPrompt } from '../promptStore.js'

const GEMINI_FLASH_JSON_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

async function _callGeminiProJSON(systemPrompt, userPrompt) {
  const key = (process.env.GEMINI_API_KEY || '').trim()
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(GEMINI_FLASH_JSON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini Pro ${res.status}: ${body.slice(0, 200)}`)
  }
  const data  = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts.filter(p => !p.thought).map(p => p.text || '').join('')
}

const DEFAULT_STRENGTHS_PROMPT = `You are a senior HR performance analyst conducting a comprehensive employee performance review. Given an employee's quantitative scores and activity data, produce a detailed list of strength areas as JSON.

Output ONLY:
{
  "strengths": [
    { "area": "<short noun phrase>", "reason": "<2-3 sentences grounded in specific data points, metrics, and observations — explain WHY this is a strength and its impact>" }
  ]
}

Pick 5-7 distinct strength areas covering multiple dimensions: KPI performance, activity quality, learning engagement, consistency, outreach impact, and process adherence. Each "reason" must cite specific numbers or observations from the data. Never invent areas not implied by the data.`

const DEFAULT_IMPROVEMENTS_PROMPT = `You are a senior HR performance analyst. Given an employee's lowest-scoring dimensions and performance gaps, produce a detailed improvement analysis as JSON.

Output ONLY:
{
  "improvements": [
    { "area": "<short noun phrase>", "reason": "<2-3 sentences citing the specific gap, its root cause hypothesis, and its impact on outcomes or team effectiveness>" }
  ]
}

Pick 5-7 improvement areas covering KPI gaps, documentation quality, consistency issues, and skill gaps where evident. Each "reason" must reference a specific dimension, score, or pattern. Include the potential consequence of not addressing each gap. Never fabricate.`

const DEFAULT_RISK_PROMPT = `You are a senior HR performance analyst. Given an employee's scores, trend data, and activity patterns, provide a comprehensive risk and potential analysis.

Output ONLY:
{
  "risk": {
    "performance":  "<Low | Low to Medium | Medium | Medium to High | High>",
    "growth":       "<Low | Low to Medium | Medium | High>",
    "promotion":    "<Not Ready | 12+ Months | 6-12 Months | Ready>",
    "training_need":"<None | Low | Moderate | High | Critical>",
    "retention":    "<At Risk | Below Average | Average | Good | Excellent>"
  },
  "risk_notes": {
    "performance":  "<2-3 sentences with specific score references, trend direction, and performance band context>",
    "growth":       "<2-3 sentences covering learning trajectory, skill acquisition rate, and development potential based on data>",
    "promotion":    "<2-3 sentences explaining readiness assessment with specific criteria met, gaps remaining, and a timeframe estimate>",
    "training_need":"<2-3 sentences identifying specific training gaps, which dimensions they address, and recommended intervention type>",
    "retention":    "<2-3 sentences covering contribution value, engagement signals from data patterns, and any flight-risk indicators>"
  }
}

Use evidence-based assessments grounded in the data provided. Default to conservative estimates when data is ambiguous. Every note must reference specific metrics or observed patterns.`

const DEFAULT_ACTION_PROMPT = `You are a senior HR performance coach. Given an employee's comprehensive performance data, strengths, improvements, and rating, produce a detailed recommendation and structured action plan as JSON.

Output ONLY:
{
  "recommendation": "<Full paragraph of 4-6 sentences: open with an overall performance assessment, highlight 1-2 key achievements, name the primary development areas, explain the strategic implication for the team or organisation, and close with clear forward-looking guidance for the next review period. Ground every claim in the data — no generic statements.>",
  "action_plan": [
    { "action": "<specific, measurable imperative action>", "timeline_days": <int 30|60|90|180>, "expected_result": "<specific measurable outcome with a target metric or behaviour change>" }
  ]
}

Generate 5-7 action items spanning: skill development in lowest KPIs, documentation/quality habits, engagement or volume consistency, a learning or certification goal, and at least one stretch goal for above-average performers. Each timeline_days must be 30, 60, 90, or 180. Every expected_result must be quantifiable or clearly observable.`

function _safeJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

function _fallbackStrengths(score) {
  const top = [...score.kpis].sort((a, b) => b.score - a.score).slice(0, 3)
  return top.map(k => ({ area: k.area, reason: k.observation || 'Strong performance in this dimension.' }))
}

function _fallbackImprovements(score) {
  const bot = [...score.kpis].sort((a, b) => a.score - b.score).slice(0, 3)
  return bot.map(k => ({ area: k.area, reason: k.observation || 'Below baseline — focus area for next period.' }))
}

function _fallbackRisk(weighted) {
  const final = weighted.final
  return {
    risk: {
      performance:   final >= 80 ? 'Low' : final >= 70 ? 'Low to Medium' : 'Medium',
      growth:        weighted.learning_score >= 75 ? 'High' : 'Medium',
      promotion:     final >= 85 ? 'High' : final >= 75 ? 'Medium' : 'Low',
      training_need: final >= 85 ? 'No' : 'Yes',
      retention:     final >= 80 ? 'Good' : final >= 70 ? 'Average' : 'Poor',
    },
    risk_notes: {
      performance:   `Final score ${final}/100 places employee in ${weighted.rating} band.`,
      growth:        `Learning score ${weighted.learning_score}/100 indicates ${weighted.learning_score >= 75 ? 'strong' : 'moderate'} development trajectory.`,
      promotion:     final >= 85 ? 'Strong candidate for advancement.' : 'Continued improvement needed before promotion consideration.',
      training_need: final >= 85 ? 'No structural training gap identified.' : 'Targeted training in lowest-scoring KPIs recommended.',
      retention:     'Stable contributor.',
    },
  }
}

function _fallbackAction(score) {
  const weak = [...score.kpis].sort((a, b) => a.score - b.score).slice(0, 3)
  return {
    recommendation: `Continue in current role with structured improvement plan targeting ${weak.map(k => k.area.toLowerCase()).join(', ')}.`,
    action_plan: weak.map((k, i) => ({
      action: `Strengthen ${k.area.toLowerCase()} via weekly review with manager`,
      timeline_days: [30, 60, 90][i] || 90,
      expected_result: `Score in ${k.area} reaches 4.0+ by end of period.`,
    })),
  }
}

async function _callJudge(orgId, systemKey, defaultSys, userPrompt) {
  try {
    const systemPrompt = await getOrgPrompt(orgId, systemKey, defaultSys)
    const text = await _callGeminiProJSON(systemPrompt, userPrompt)
    return _safeJson(text)
  } catch {
    return null
  }
}

/**
 * Generate narrative blocks for a performance review from scoreEmployee()'s output.
 * @returns {Promise<{ strengths, improvements, risk, risk_notes, recommendation, action_plan }>}
 */
export async function narrateReview(score, ctx = {}) {
  const orgId = ctx.orgId
  const payload = JSON.stringify({
    employee: ctx.employeeName || 'Employee',
    weighted: score.weighted,
    kpis: score.kpis,
    activities: score.activities,
    learning: score.learning,
    trend: score.trend,
  })

  // Four calls in parallel; any failure falls back to the deterministic text.
  const [stRes, imRes, rkRes, acRes] = orgId
    ? await Promise.all([
        _callJudge(orgId, 'pr_review_strengths',    DEFAULT_STRENGTHS_PROMPT,    payload),
        _callJudge(orgId, 'pr_review_improvements', DEFAULT_IMPROVEMENTS_PROMPT, payload),
        _callJudge(orgId, 'pr_review_risk',         DEFAULT_RISK_PROMPT,         payload),
        _callJudge(orgId, 'pr_review_action_plan',  DEFAULT_ACTION_PROMPT,       payload),
      ])
    : [null, null, null, null]

  return {
    strengths: Array.isArray(stRes?.strengths) ? stRes.strengths : _fallbackStrengths(score),
    improvements: Array.isArray(imRes?.improvements) ? imRes.improvements : _fallbackImprovements(score),
    risk: rkRes?.risk || _fallbackRisk(score.weighted).risk,
    risk_notes: rkRes?.risk_notes || _fallbackRisk(score.weighted).risk_notes,
    recommendation: acRes?.recommendation || _fallbackAction(score).recommendation,
    action_plan: Array.isArray(acRes?.action_plan) ? acRes.action_plan : _fallbackAction(score).action_plan,
  }
}
