// lib/ai/learning/learningCollector.js — Capture interaction outcomes for learning
//
// Raw outcomes are stored in ai_interactions, then lessonExtractor picks them up.

import { storeLesson } from '../local/memoryStore.js'

// ── Slot extraction outcome ───────────────────────────────────────────────────
/** Record a local slot-extractor miss that Gemini handled, to mine new slotExtractor patterns. */
export async function recordSlotFallback(orgId, message, fieldType, geminiResult) {
  if (!orgId || !message || !geminiResult) return
  try {
    await storeLesson(orgId, 'whatsapp', {
      type:   'slot_pattern',
      change: {
        message:     message.slice(0, 80),
        fieldType,
        expected:    String(geminiResult).slice(0, 40),
      },
      evidenceCount: 1,
    })
  } catch { /* non-fatal */ }
}
