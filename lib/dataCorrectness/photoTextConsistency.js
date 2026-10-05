// Layer 4: photo ↔ description match. Samples 10% of photo submissions (100% when
// already flagged), deterministically by photoUrl hash so rechecks agree.
// Multimodal via runAI; ~₹0.30 per check at Flash pricing.

import { runAI } from '../ai/runAI.js'
import { getOrgPrompt } from '../promptStore.js'
import { VALIDATION_PROMPTS } from './prompts.js'

const DEFAULT_SAMPLE_RATE = 0.10

function _shouldSample(photoUrl, sampleRate, forceCheck) {
  if (forceCheck) return true
  if (!photoUrl) return false
  // Deterministic hash → stable 0..1 score
  let h = 0
  for (let i = 0; i < photoUrl.length; i++) h = (h * 31 + photoUrl.charCodeAt(i)) | 0
  const score = (Math.abs(h) % 10000) / 10000
  return score < sampleRate
}

function _safeJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/**
 * Check whether a photo matches the report description.
 * @param {object} ctx  { orgId, userId, kind, forceCheck?, sampleRate? }
 */
export async function checkPhotoText(payload, ctx = {}) {
  const { photoUrl, description } = payload || {}
  if (!photoUrl || !description) {
    return { severity: 'clean', confidence: 1, reasons: [], action: 'allow', llm_used: false, sampled: false, observations: [], discrepancies: [] }
  }
  const sampleRate = typeof ctx.sampleRate === 'number' ? ctx.sampleRate : DEFAULT_SAMPLE_RATE
  if (!_shouldSample(photoUrl, sampleRate, ctx.forceCheck)) {
    return { severity: 'clean', confidence: 1, reasons: [], action: 'allow', llm_used: false, sampled: false, observations: [], discrepancies: [] }
  }
  if (!ctx.orgId) {
    return { severity: 'clean', confidence: 0.5, reasons: ['no org context — skipped'], action: 'allow', llm_used: false, sampled: false, observations: [], discrepancies: [] }
  }

  try {
    const systemPrompt = await getOrgPrompt(
      ctx.orgId,
      'validation_photo_text',
      VALIDATION_PROMPTS.validation_photo_text
    )
    const userPrompt = JSON.stringify({
      photo_url: photoUrl,
      description: description.slice(0, 1000),
    })
    const out = await runAI({
      feature: 'validation',
      operation: 'photo_text',
      prompt: userPrompt,
      systemPrompt,
      orgId: ctx.orgId,
      userId: ctx.userId,
      context: { multimodal: true, image_url: photoUrl },
    })
    const parsed = _safeJson(out?.text)
    if (!parsed) {
      return { severity: 'clean', confidence: 0.5, reasons: ['judge returned unparseable output'], action: 'allow', llm_used: true, sampled: true, observations: [], discrepancies: [] }
    }
    const observations = Array.isArray(parsed.observations) ? parsed.observations : []
    const discrepancies = Array.isArray(parsed.discrepancies) ? parsed.discrepancies : []
    if (parsed.matches === false && parsed.confidence > 0.8) {
      return {
        severity: 'medium',
        confidence: parsed.confidence,
        reasons: [`photo does not match description: ${discrepancies[0] || 'see observations'}`],
        action: 'flag',
        llm_used: true,
        sampled: true,
        observations,
        discrepancies,
      }
    }
    // Moderate-confidence mismatches (0.5-0.8) still go to review, at lower severity.
    if (parsed.matches === false && parsed.confidence >= 0.5) {
      return {
        severity: 'low',
        confidence: parsed.confidence,
        reasons: [`possible photo/description mismatch (moderate confidence): ${discrepancies[0] || 'see observations'}`],
        action: 'flag',
        llm_used: true,
        sampled: true,
        observations,
        discrepancies,
      }
    }
    return {
      severity: 'clean',
      confidence: parsed.confidence ?? 0.8,
      reasons: [],
      action: 'allow',
      llm_used: true,
      sampled: true,
      observations,
      discrepancies,
    }
  } catch (e) {
    console.warn('[photoText] check failed:', e.message)
    return { severity: 'low', confidence: 0, reasons: [`check failed — could not verify: ${e.message}`], action: 'flag', llm_used: false, sampled: true, observations: [], discrepancies: [] }
  }
}
