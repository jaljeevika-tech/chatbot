// routes/ai.routes.js — Platform-wide AI assistant + memory management
//
// POST   /api/ai/ask              — SSE chat with org context injection
// POST   /api/ai/feedback         — Submit thumbs up/down for an interaction
// GET    /api/ai/memories         — List org memories (admin/manager)
// POST   /api/ai/memories         — Manually add a memory (admin)
// PUT    /api/ai/memories/:id     — Edit a memory (admin)
// DELETE /api/ai/memories/:id     — Delete a memory (admin)

import { Router } from 'express'
import {
  setupSSE, sendSSE, pipeGeminiStream,
  makeAbortSignal, GEMINI_FLASH_URL,
} from '../lib/gemini.js'
import { getOrgPrompt }       from '../lib/promptStore.js'
import { getOrgSector }       from '../lib/orgMetaCache.js'
import { sectorOverlay }      from '../lib/prompts/sectorPrompts.js'
import { trackUsage }         from '../lib/usageTracker.js'
import { buildOrgContext, invalidateOrgContext } from '../lib/aiContext.js'
import {
  createInteraction,
  updateInteraction,
  updateFeedback,
  reinforceMemory,
} from '../lib/aiAgent.js'
import { batchExtractMemories, orgNeedsInitialSeed } from '../lib/memoryExtractor.js'
import { getPool } from '../db/pool.js'

const router = Router()

// ── POST /api/ai/ask (SSE) ────────────────────────────────────────────────────
// Streams a Gemini response enriched with org-scoped memory context.
// Sends { interactionId } as the first SSE frame so the client can submit feedback.
router.post('/ai/ask', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }

  setupSSE(res)
  const signal = makeAbortSignal(req)

  try {
    const { message, history = [] } = req.body || {}
    if (!message?.trim()) {
      sendSSE(res, { error: 'message is required' })
      res.end()
      return
    }

    const orgId = req.user?.orgId

    // ── 1. Build org context from memory store ──────────────────────────────
    const orgCtx = await buildOrgContext(orgId)

    // ── 2. Build system prompt ──────────────────────────────────────────────
    const defaultSystem = `You are FieldFlow AI, a knowledgeable and warm field-operations assistant for an NGO or social-impact organisation.

Your role:
- Help users understand patterns, issues, and insights in their field data
- Answer questions about workers, projects, regions, beneficiary reach, and barriers
- Be conversational, concise, and actionable — like a sharp colleague, not a search engine
- When data is uncertain, say so honestly; don't fabricate numbers
- Prefer bullet points for lists, plain prose for explanations
- Keep responses focused and under 250 words unless the question requires more detail

IMPORTANT RULES:
- NEVER ask users to upload files, share spreadsheets, or provide raw data — the platform already collects all field data automatically via WhatsApp and Google Sheets
- NEVER say you "don't have access" or ask for credentials — you are embedded inside the platform and data flows in automatically
- If org context is not yet available, say so briefly and warmly (e.g. "I'm still learning your org's data — it should be ready shortly. In the meantime, I can help with general NGO questions.") then offer to help anyway

${orgCtx
  ? `${orgCtx}\n\nUse the above context to personalise your answers. If a question falls outside this context, answer from general NGO/development-sector knowledge.`
  : `No org-specific context has been loaded yet — this usually means your field data is still being processed in the background (it takes about 30 seconds on first use). Answer from general NGO/development-sector knowledge for now, and let the user know their data will be available shortly.`
}`

    const [systemPromptBase, sector] = await Promise.all([
      getOrgPrompt(orgId, 'ai_assistant_system', defaultSystem),
      getOrgSector(orgId),
    ])
    const systemPrompt = [systemPromptBase, sectorOverlay(sector, 'ai_assistant_system')].filter(Boolean).join('\n\n')

    // ── 3. Build conversation prompt ─────────────────────────────────────────
    const histBlock = (history || []).slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text || '').slice(0, 500)}`)
      .join('\n')

    const prompt = histBlock
      ? `${histBlock}\nUser: ${message.trim()}`
      : message.trim()

    // ── 4. Pre-insert interaction to get the DB id ────────────────────────────
    const interactionId = await createInteraction(orgId, 'assistant', message.trim())
    if (interactionId) {
      sendSSE(res, { interactionId })  // client uses this for feedback
    }

    // ── 5. Track usage (fire-and-forget) ─────────────────────────────────────
    trackUsage(orgId, {
      service: 'ai_assistant',
      model: 'flash',
      inputLength: prompt.length + systemPrompt.length,
      maxOutputTokens: 2048,
    })

    // ── 6. Stream Gemini response, capturing full text for recording ──────────
    let captured = ''
    const sendFn = (payload) => {
      if (payload.text) captured += payload.text
      sendSSE(res, payload)
    }

    const geminiRes = await fetch(GEMINI_FLASH_URL(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 2048, temperature: 0.6 },
      }),
      signal,
    })

    if (!geminiRes.ok || !geminiRes.body) {
      const errBody = await geminiRes.text().catch(() => '')
      sendFn({ error: `AI error ${geminiRes.status}: ${errBody.slice(0, 200)}` })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    await pipeGeminiStream(geminiRes, res, sendFn, signal)

    // ── 7. Persist full response (fire-and-forget) ────────────────────────────
    if (interactionId && captured) {
      updateInteraction(interactionId, captured, Math.ceil((prompt.length + captured.length) / 4))
        .catch(e => console.warn('[ai/ask] updateInteraction:', e.message))
    }
  } catch (e) {
    if (!res.writableEnded) {
      sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
})

// ── POST /api/ai/feedback ─────────────────────────────────────────────────────
router.post('/ai/feedback', async (req, res) => {
  const { interactionId, feedback } = req.body || {}
  if (!interactionId || ![1, -1].includes(feedback)) {
    return res.status(400).json({ error: 'interactionId and feedback (1 or -1) are required' })
  }
  try {
    await updateFeedback(Number(interactionId), feedback, req.user.orgId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/ai/memories ──────────────────────────────────────────────────────
// Admin and manager can view memories; employees cannot.
router.get('/ai/memories', async (req, res) => {
  // Allowlist, not "deny employee": sheet roles are free text ('crp', 'Field
  // Officer'…), so a deny-list let every non-'employee' string through.
  const role = req.user?.role ?? 'employee'
  if (!['manager', 'admin', 'superadmin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

  const orgId = req.user?.orgId
  if (!orgId) return res.status(400).json({ error: 'No orgId' })

  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, memory_type, subject, content, source, confidence, reinforced_at, created_at
       FROM ai_memories
       WHERE org_id = $1
       ORDER BY confidence DESC, reinforced_at DESC
       LIMIT 200`,
      [orgId]
    )
    res.json({ memories: rows, needsSeed: rows.length === 0 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/ai/memories ─────────────────────────────────────────────────────
// Admin only: manually create a memory.
router.post('/ai/memories', async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const { memoryType, subject = '', content, confidence = 1.0 } = req.body || {}
  if (!memoryType || !content) {
    return res.status(400).json({ error: 'memoryType and content are required' })
  }

  const orgId = req.user?.orgId
  if (!orgId) return res.status(400).json({ error: 'No orgId' })

  try {
    const id = await reinforceMemory(orgId, memoryType, subject, content, confidence, 'manual')
    res.json({ ok: true, id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PUT /api/ai/memories/:id ──────────────────────────────────────────────────
router.put('/ai/memories/:id', async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const orgId = req.user?.orgId
  const id    = parseInt(req.params.id)
  const { content, confidence } = req.body || {}

  if (!orgId || !id || !content) {
    return res.status(400).json({ error: 'content is required' })
  }

  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `UPDATE ai_memories
       SET content = $1, confidence = COALESCE($2, confidence), updated_at = NOW(), reinforced_at = NOW()
       WHERE id = $3 AND org_id = $4`,
      [content, confidence ?? null, id, orgId]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Memory not found' })
    invalidateOrgContext(orgId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/ai/memories/:id ───────────────────────────────────────────────
router.delete('/ai/memories/:id', async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const orgId = req.user?.orgId
  const id    = parseInt(req.params.id)
  if (!orgId || !id) return res.status(400).json({ error: 'Invalid id' })

  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM ai_memories WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Memory not found' })
    invalidateOrgContext(orgId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/ai/seed-memories (SSE) ─────────────────────────────────────────
// Admin-only: runs Gemini batch analysis on all whatsapp_submissions for this org
// and seeds ai_memories with worker profiles, project patterns, barriers, and org context.
// Streams progress lines so the UI can show what's happening.
router.post('/ai/seed-memories', async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin only' })
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { return res.status(500).json({ error: 'GEMINI_API_KEY not set' }) }

  const orgId = req.user?.orgId
  if (!orgId) return res.status(400).json({ error: 'No orgId' })

  setupSSE(res)

  try {
    const stats = await batchExtractMemories(orgId, apiKey, (text) => {
      sendSSE(res, { text })
    })
    sendSSE(res, { done: true, stats })
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Seeding failed' })
  } finally {
    res.end()
  }
})

export default router
