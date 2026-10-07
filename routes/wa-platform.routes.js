// routes/wa-platform.routes.js — Native WhatsApp Platform
//
// PUBLIC (no Firebase auth):
//   GET  /api/wa/webhook          Meta webhook verification challenge
//   POST /api/wa/webhook          Meta sends all inbound messages here
//
// AUTHED:
//   GET  /api/wa/config           get WA config for this org
//   PUT  /api/wa/config           set WA credentials (admin only)
//   GET  /api/wa/flows            list flows
//   POST /api/wa/flows            create flow
//   PUT  /api/wa/flows/:id        update flow
//   DELETE /api/wa/flows/:id      delete flow
//   POST /api/wa/flows/:id/publish toggle active
//   GET  /api/wa/contacts         list contacts
//   GET  /api/wa/contacts/:id/messages  message history for a contact
//   POST /api/wa/broadcast        send broadcast message
//   GET  /api/wa/stats            dashboard stats

import { Router }                      from 'express'
import { getPool }                      from '../db/pool.js'
import { verifyWebhookSignature, parseWebhookEvents } from '../lib/whatsapp.js'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { waClientFromConfig, runFlowFrom, processReply } from '../lib/flowEngine.js'
import { detectIntent, extractSlotValue, generateFallbackResponse } from '../lib/nlp.js'
import { redact } from '../lib/contentModeration.js'
import { handleApprovalReply } from '../lib/waApprovals.js'

const router = Router()

// Redact PII in a stringified JSON payload before persisting. Keep structure
// intact by re-parsing — but on any redact/parse failure, fall back to raw
// (PII protection is best-effort; never block message logging).
function _redactInboundContent(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr)
    const walked = _walkAndRedact(obj)
    return JSON.stringify(walked)
  } catch {
    return jsonStr
  }
}
function _walkAndRedact(v) {
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map(_walkAndRedact)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v)) out[k] = _walkAndRedact(v[k])
    return out
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC — Meta webhook verification (GET)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wa/webhook', async (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode !== 'subscribe') return res.sendStatus(400)
  if (!token || !challenge)  return res.sendStatus(400)

  // 1️⃣ Check env var first (works even before DB is configured)
  const envToken = process.env.WA_WEBHOOK_VERIFY_TOKEN
  if (envToken && token === envToken) {
    console.log('[wa] webhook verified via env token')
    return res.status(200).send(challenge)
  }

  // 2️⃣ Fall back to DB lookup (multi-org: find org by webhook_secret)
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT org_id FROM wa_config WHERE webhook_secret = $1 AND enabled = true LIMIT 1`,
      [token]
    )
    if (!rows.length) return res.sendStatus(403)
    console.log('[wa] webhook verified for org', rows[0].org_id)
    res.status(200).send(challenge)
  } catch (err) {
    console.error('[wa] webhook verify DB error:', err.message)
    res.sendStatus(500)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC — Incoming messages from Meta (POST)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/wa/webhook', async (req, res) => {
  // Always ACK immediately — Meta retries if not 200 within 20s
  res.sendStatus(200)

  const rawBody   = req.rawBody || JSON.stringify(req.body)
  const sigHeader = req.headers['x-hub-signature-256'] || ''
  const pool      = getPool()
  const events    = parseWebhookEvents(req.body)

  for (const event of events) {
    try {
      await handleWebhookEvent(event, pool, rawBody, sigHeader)
    } catch (err) {
      console.error('[wa] unhandled event error:', err.message, '| event:', event.type, event.from)
      // Dead-letter: stash for inspection/retry instead of silently dropping
      pool.query(
        `INSERT INTO wa_dead_letter (org_id, wa_id, event_type, payload, error_msg, error_stack)
         VALUES (
           (SELECT org_id FROM wa_config WHERE phone_number_id = $1 LIMIT 1),
           $2, $3, $4, $5, $6
         )`,
        [
          event.phoneNumberId || null,
          event.from || null,
          event.type || 'unknown',
          JSON.stringify(event),
          err.message || 'unknown',
          (err.stack || '').slice(0, 4000),
        ]
      ).catch(e => console.warn('[wa-dlq] failed to persist DLQ row:', e.message))
    }
  }
})

// GET /api/wa/dead-letter — list recent failed inbound events (admin only)
router.get('/wa/dead-letter', async (req, res) => {
  if (!['admin','superadmin'].includes(req.user?.role)) return res.status(403).json({ error: 'Admin only' })
  const pool = getPool()
  try {
    // org_id IS NULL rows are events whose org couldn't be resolved — they
    // can hold any tenant's contact numbers/payloads, so only platform
    // superadmins may see or replay them, never a tenant admin.
    const { rows } = await pool.query(
      `SELECT id, wa_id, event_type, error_msg, created_at, retried_at, retried_ok
       FROM wa_dead_letter
       WHERE org_id = $1 OR (org_id IS NULL AND $2::boolean)
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.orgId, req.user.role === 'superadmin']
    )
    res.json({ events: rows })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/dead-letter/:id/retry — replay one DLQ event (admin only)
router.post('/wa/dead-letter/:id/retry', async (req, res) => {
  if (!['admin','superadmin'].includes(req.user?.role)) return res.status(403).json({ error: 'Admin only' })
  const pool = getPool()
  try {
    // CRIT: scope by org_id (or the shared/global NULL rows) — without this an
    // admin in Org A could pass Org B's dead-letter id and replay Org B's event
    // (re-sending WhatsApp messages / mutating Org B's session state) from
    // their own session. Mirrors the GET list's WHERE clause above.
    const { rows } = await pool.query(
      `SELECT payload FROM wa_dead_letter WHERE id = $1 AND (org_id = $2 OR (org_id IS NULL AND $3::boolean))`,
      [req.params.id, req.user.orgId, req.user.role === 'superadmin']
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })

    const event = rows[0].payload
    let ok = true
    let errMsg = null
    try {
      // The stored event was already signature-checked when Meta delivered it.
      await handleWebhookEvent(event, pool, '', '', { trusted: true })
    } catch (err) {
      ok = false
      errMsg = err.message
    }
    await pool.query(
      `UPDATE wa_dead_letter SET retried_at = NOW(), retried_ok = $1 WHERE id = $2 AND (org_id = $3 OR (org_id IS NULL AND $4::boolean))`,
      [ok, req.params.id, req.user.orgId, req.user.role === 'superadmin']
    )
    res.json({ ok, error: errMsg })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function handleWebhookEvent(event, pool, rawBody, sigHeader, { trusted = false } = {}) {
  // Status receipts used to be applied HERE — before the org lookup and the
  // signature check, with no org filter — so an unauthenticated POST could
  // rewrite any tenant's message delivery status. They now go through the
  // same org resolution + signature verification as messages (below).
  if (event.type !== 'message' && event.type !== 'status') return

  if (event.type === 'message') {
    // Sanitize PII in logs: mask all but last 4 digits of contact number; truncate text.
    const maskedFrom = event.from ? `***${String(event.from).slice(-4)}` : 'unknown'
    const preview = String(event.text || event.interactiveTitle || event.messageType || '').slice(0, 40)
    console.log(`[wa] inbound msg from ${maskedFrom} via phone ${event.phoneNumberId}: "${preview}"`)
  }

  // ── Look up org from phone_number_id ────────────────────────────────────────
  const { rows: cfgRows } = await pool.query(
    `SELECT * FROM wa_config WHERE phone_number_id = $1 AND enabled = true LIMIT 1`,
    [event.phoneNumberId]
  ).catch(() => ({ rows: [] }))

  if (!cfgRows.length) {
    console.warn('[wa] no config for phone_number_id', event.phoneNumberId)
    return
  }
  const cfg   = cfgRows[0]
  // Decrypt the stored access token (legacy plaintext returned as-is)
  cfg.access_token = decryptSecret(cfg.access_token)
  const orgId = cfg.org_id

  // ── Signature verification — fail closed ───────────────────────────────────
  // Prefer the per-org `app_secret` stored in wa_config. Fall back to a global
  // env-var so a single-org deployment doesn't require per-org config. If
  // NEITHER is set AND we're in production, refuse the event (otherwise anyone
  // who finds the webhook URL can spoof inbound messages). In dev with no
  // secret configured we still allow it so local testing works.
  const sigSecret = decryptSecret(cfg.app_secret) || process.env.WA_APP_SECRET || null
  if (trusted) {
    // internal dead-letter replay
  } else if (sigSecret) {
    if (!verifyWebhookSignature(rawBody, sigHeader, sigSecret)) {
      console.warn('[wa] invalid signature — dropping')
      return
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[wa] webhook signature NOT verifiable (no app_secret configured) — REFUSING in prod. Set WA_APP_SECRET env var or wa_config.app_secret.')
    return
  } else {
    console.warn('[wa] signature check skipped (no secret in dev mode)')
  }

  if (event.type === 'status') {
    await pool.query(
      `UPDATE wa_messages SET status = $1 WHERE wa_message_id = $2 AND org_id = $3`,
      [event.status, event.messageId, orgId]
    ).catch(() => {})
    return
  }

  const waClient = waClientFromConfig(cfg)

  // Mark as read (non-fatal — test numbers return #131009, ignore it)
  await waClient.markRead(event.messageId, event.from).catch(e => {
    if (!e.message.includes('131009')) {   // suppress expected test-number error
      console.warn('[wa] markRead failed:', e.message)
    }
  })

  // ── Voice → text transcription (P1 Move) ────────────────────────────────────
  // If the user sent a voice note, transcribe it via Gemini and set event.text
  // so the rest of the pipeline (flow engine, NLP) treats it like a typed reply.
  if (event.subType === 'audio' && event.media?.id) {
    try {
      await waClient.sendText(event.from, '🎙 Transcribing your voice…').catch(() => {})
      const { downloadMetaMedia, transcribeAudio } = await import('../lib/voiceTranscribe.js')
      const dl = await downloadMetaMedia(event.media.id, cfg.access_token)
      if (dl) {
        const transcript = await transcribeAudio(dl.buffer, event.media.mime_type || dl.mimeType)
        if (transcript) {
          console.log(`[voice] ${event.from} transcribed: "${transcript.slice(0, 80)}"`)
          event.text = transcript
        } else {
          await waClient.sendText(event.from, "Sorry, I couldn't understand the audio. Please type your reply.").catch(() => {})
          return
        }
      } else {
        await waClient.sendText(event.from, "Sorry, I couldn't download the audio. Please try again.").catch(() => {})
        return
      }
    } catch (e) {
      console.warn('[voice] transcription pipeline error:', e.message)
    }
  }

  // ── Upsert contact ──────────────────────────────────────────────────────────
  const { rows: contactRows } = await pool.query(
    `INSERT INTO wa_contacts (org_id, wa_id, name, last_seen)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (org_id, wa_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, wa_contacts.name), last_seen = NOW()
     RETURNING *`,
    [orgId, event.from, event.contactName || null]
  )
  const contact = contactRows[0]

  // ── Log inbound message ─────────────────────────────────────────────────────
  // Redact PII (Aadhaar, mobile, PAN, email, etc.) before persisting so audit
  // exports don't carry sensitive identifiers. The waMessageId stays raw so
  // dedup still works; only the body payload is masked.
  const safeContent = _redactInboundContent(JSON.stringify(event.raw))
  const logged = await pool.query(
    `INSERT INTO wa_messages (org_id, contact_id, wa_message_id, direction, type, content)
     VALUES ($1,$2,$3,'inbound',$4,$5)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [orgId, contact.id, event.messageId, event.messageType, safeContent]
  )

  // ── HR / Finance "Approve" + Check in / out button taps (lib/waApprovals.js) ──
  // Skip Meta's redeliveries (already logged) so one tap never approves twice.
  if (await handleApprovalReply(event, { orgId, pool, waClient, contact, duplicate: !logged.rowCount && !trusted })) return

  // ── Find active or handoff session ──────────────────────────────────────────
  const { rows: sessionRows } = await pool.query(
    `SELECT s.*, f.nodes, f.show_progress AS flow_show_progress, f.name AS flow_name
     FROM wa_sessions s
     JOIN wa_flows f ON f.id = s.flow_id
     WHERE s.contact_id = $1 AND s.status IN ('active','handoff') AND s.expires_at > NOW()
     ORDER BY s.updated_at DESC LIMIT 1`,
    [contact.id]
  )

  // ── If session is in handoff, log inbound and skip bot — agent will reply ──
  if (sessionRows.length && sessionRows[0].status === 'handoff') {
    console.log(`[wa] handoff active for ${event.from} — bot paused`)
    // Touch session so it stays alive
    await pool.query(`UPDATE wa_sessions SET updated_at=NOW() WHERE id=$1`, [sessionRows[0].id])
    return
  }

  if (sessionRows.length) {
    // ── Continue existing session ──────────────────────────────────────────────
    const session  = sessionRows[0]
    // Optimistic-concurrency guard: two events for the same contact arriving
    // close together (double-tap send, or a retried webhook delivery) would
    // otherwise both read this same row and race on the final UPDATE, silently
    // losing one answer. Every write below is conditioned on updated_at still
    // matching what we just read; if it doesn't, someone else already advanced
    // this session and we drop out rather than clobber their result.
    const readAt   = session.updated_at
    const nodes    = session.nodes
    const flowCtx  = { nodes, show_progress: !!session.flow_show_progress, name: session.flow_name }
    const nodeMap  = Object.fromEntries(nodes.map(n => [n.id, n]))
    const curNode  = nodeMap[session.current_node]

    let updatedCollected = processReply(curNode, event, session.collected)
    // Capture last raw text so a human_handoff node can include it in staff notify
    if (event.text) updatedCollected.__last_text = event.text

    // NLP enhancement: if strict number validation failed, try to extract the
    // number from natural language ("around fifty", "लगभग 50", etc.)
    if (
      updatedCollected.__validation_error &&
      curNode?.type === 'wait_input' &&
      curNode?.validation === 'number' &&
      event.text
    ) {
      const extracted = await extractSlotValue(event.text, curNode.save_as || 'value', 'number')
      if (extracted !== null && !isNaN(parseFloat(extracted))) {
        updatedCollected = { ...updatedCollected, [curNode.save_as]: extracted }
        delete updatedCollected.__validation_error
      }
    }

    if (updatedCollected.__validation_error) {
      await waClient.sendText(event.from, updatedCollected.__validation_error).catch(e =>
        console.error('[wa] send validation error failed:', e.message)
      )
      return
    }

    // recap_confirm branching: YES → node.next; anything else → node.next_edit
    let nextNodeId
    if (curNode?.type === 'recap_confirm') {
      nextNodeId = updatedCollected.__recap_confirmed
        ? (curNode.next || null)
        : (curNode.next_edit || curNode.next || null)
    } else {
      nextNodeId = curNode?.next || null
    }
    if (!nextNodeId) {
      const { rowCount } = await pool.query(
        `UPDATE wa_sessions SET status='completed', collected=$1, updated_at=NOW()
         WHERE id=$2 AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz)`,
        [JSON.stringify(updatedCollected), session.id, readAt]
      )
      if (rowCount === 0) {
        console.warn(`[wa] session ${session.id} already advanced by a concurrent event — dropping this reply`)
      }
      return
    }

    const { finalNodeId, collected: finalCollected, done } = await runFlowFrom(
      nodes, nextNodeId, updatedCollected,
      { name: contact.name, wa_id: contact.wa_id, fields: contact.fields, org_id: orgId },
      waClient, event.from, 20, pool, flowCtx
    )
    const newStatus = finalCollected.__handoff ? 'handoff' : (done ? 'completed' : 'active')
    const newAssignee = finalCollected.__handoff ? (finalCollected.__handoff_assignee || null) : null
    const { rowCount } = await pool.query(
      `UPDATE wa_sessions
         SET current_node=$1, collected=$2, status=$3,
             assigned_to = COALESCE($5, assigned_to),
             updated_at=NOW()
       WHERE id=$4 AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $6::timestamptz)`,
      [finalNodeId, JSON.stringify(finalCollected), newStatus, session.id, newAssignee, readAt]
    )
    if (rowCount === 0) {
      console.warn(`[wa] session ${session.id} already advanced by a concurrent event — dropping this reply's result`)
      return
    }

    // Handle enter_flow handoff
    if (finalCollected.__enter_flow) {
      await startNamedFlow(finalCollected.__enter_flow, contact, orgId, pool, waClient, event)
    }

  } else {
    // ── No active session — match keyword or NLP intent ────────────────────────
    const incomingText = (event.text || event.interactiveTitle || '').trim().toLowerCase()
    if (!incomingText) return

    let { rows: flowRows } = await pool.query(
      `SELECT * FROM wa_flows
       WHERE org_id = $1 AND is_active = true
         AND (
           EXISTS (SELECT 1 FROM unnest(trigger_keywords) kw WHERE lower(kw) = $2)
           OR is_default = true
         )
       ORDER BY is_default ASC LIMIT 1`,
      [orgId, incomingText]
    )

    if (!flowRows.length) {
      // ── NLP fallback: understand natural language instead of showing keyword list ──
      const { rows: allFlows } = await pool.query(
        `SELECT id, name, description, trigger_keywords, is_default, nodes
         FROM wa_flows WHERE org_id=$1 AND is_active=true`,
        [orgId]
      ).catch(() => ({ rows: [] }))

      const nlpMatch = await detectIntent(incomingText, allFlows)

      if (nlpMatch) {
        // Intent recognised — start the matched flow
        console.log(`[nlp:hit] org=${orgId} flow="${nlpMatch.name}" input="${incomingText.slice(0,80)}"`)
        // Track in audit_log as a soft analytics signal (no PII leak — only flow name + input prefix)
        pool.query(
          `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
           VALUES ($1,$2,$3,'nlp.hit','wa_flow',$4,$5)`,
          [orgId, 'wa-webhook', contact.wa_id, nlpMatch.id, JSON.stringify({ input: incomingText.slice(0,200), flow: nlpMatch.name })]
        ).catch(() => {})
        flowRows = [nlpMatch]
      } else {
        // No intent — generate a warm, human-like AI response
        console.log(`[nlp:miss] org=${orgId} input="${incomingText.slice(0,80)}" — falling back to warm reply`)
        pool.query(
          `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
           VALUES ($1,$2,$3,'nlp.miss','wa_flow',NULL,$4)`,
          [orgId, 'wa-webhook', contact.wa_id, JSON.stringify({ input: incomingText.slice(0,200), active_flows: allFlows.length })]
        ).catch(() => {})

        const reply = await generateFallbackResponse(
          event.text || incomingText,
          contact.name,
          null,       // org name (future: query from orgs table)
          allFlows
        )
        await waClient.sendText(event.from, reply)
          .catch(e => console.error('[wa] NLP fallback reply failed:', e.message))
        return
      }
    }

    const flow  = flowRows[0]
    const nodes = flow.nodes
    if (!nodes?.length) return

    const startNode = nodes[0]
    const { rows: newSession } = await pool.query(
      `INSERT INTO wa_sessions (org_id, contact_id, flow_id, current_node, collected)
       VALUES ($1,$2,$3,$4,'{}') RETURNING id`,
      [orgId, contact.id, flow.id, startNode.id]
    )

    console.log(`[wa] starting flow "${flow.name}" for ${event.from}`)

    const { finalNodeId, collected: finalCollected, done } = await runFlowFrom(
      nodes, startNode.id, { __last_text: event.text || '' },
      { name: contact.name, wa_id: contact.wa_id, fields: contact.fields, org_id: orgId },
      waClient, event.from, 20, pool, flow
    )
    const newStatus = finalCollected.__handoff ? 'handoff' : (done ? 'completed' : 'active')
    await pool.query(
      `UPDATE wa_sessions SET current_node=$1, collected=$2, status=$3, updated_at=NOW() WHERE id=$4`,
      [finalNodeId, JSON.stringify(finalCollected), newStatus, newSession[0].id]
    )

    // Handle enter_flow handoff
    if (finalCollected.__enter_flow) {
      await startNamedFlow(finalCollected.__enter_flow, contact, orgId, pool, waClient, event)
    }
  }
}

// ── Start a flow by name (used by enter_flow node) ────────────────────────────
async function startNamedFlow(flowName, contact, orgId, pool, waClient, event) {
  const { rows } = await pool.query(
    `SELECT * FROM wa_flows WHERE org_id=$1 AND name ILIKE $2 AND is_active=true LIMIT 1`,
    [orgId, flowName]
  ).catch(() => ({ rows: [] }))
  if (!rows[0]) { console.warn('[wa] enter_flow: flow not found:', flowName); return }

  const flow  = rows[0]
  const nodes = flow.nodes
  if (!nodes?.length) return

  const { rows: newSession } = await pool.query(
    `INSERT INTO wa_sessions (org_id, contact_id, flow_id, current_node, collected)
     VALUES ($1,$2,$3,$4,'{}') RETURNING id`,
    [orgId, contact.id, flow.id, nodes[0].id]
  )
  console.log(`[wa] enter_flow → "${flow.name}" for ${event.from}`)
  const { finalNodeId, collected: finalCollected, done } = await runFlowFrom(
    nodes, nodes[0].id, {},
    { name: contact.name, wa_id: contact.wa_id, fields: contact.fields, org_id: orgId },
    waClient, event.from, 20, pool, flow
  )
  await pool.query(
    `UPDATE wa_sessions SET current_node=$1, collected=$2, status=$3, updated_at=NOW() WHERE id=$4`,
    [finalNodeId, JSON.stringify(finalCollected), done ? 'completed' : 'active', newSession[0].id]
  )
}

async function getKeywordList(pool, orgId) {
  const { rows } = await pool.query(
    `SELECT name, trigger_keywords FROM wa_flows WHERE org_id=$1 AND is_active=true AND is_default=false`,
    [orgId]
  )
  return rows.map(r => `*${(r.trigger_keywords || []).join(' / ')}* — ${r.name}`).join('\n') || 'No flows active yet.'
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Config
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wa/config', async (req, res) => {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT phone_number_id, business_id, display_phone, enabled, updated_at,
            app_secret IS NOT NULL as has_app_secret
     FROM wa_config WHERE org_id=$1`,
    [req.user.orgId]
  )
  // Never return access_token / webhook_secret / app_secret values to frontend
  res.json(rows[0] || null)
})

// POST /api/wa/templates/approval — create the quick-reply templates used by
// lib/waApprovals.js on this org's WhatsApp Business Account, with the token
// already saved here: "Approve" (HR / Finance approvals) and "Check in" /
// "Check out" (HR attendance reminders). Idempotent: existing ones are reported.
const BUTTON_TEMPLATES = [
  { name: 'fieldflow_approval', button: 'Approve',
    text: 'New approval request on FieldFlow: {{1}} Tap Approve below to approve it, or open the link above to review the details first.',
    example: base => `Leave request from Ravi Kumar, 3 days from 12 Oct. Details: ${base}/org/#approvals` },
  { name: 'fieldflow_checkin', button: 'Check in',
    text: 'FieldFlow attendance reminder: {{1}} Tap Check in below and share your location to record your attendance.',
    example: base => `You have not checked in today. Details: ${base}/org/#attendance` },
  { name: 'fieldflow_checkout', button: 'Check out',
    text: 'FieldFlow attendance reminder: {{1}} Tap Check out below and share your location to record your check-out.',
    example: base => `You are still checked in. Details: ${base}/org/#attendance` },
]
router.post('/wa/templates/approval', async (req, res) => {
  if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' })
  const lang = String(req.body?.lang || 'en').trim()
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(lang)) return res.status(400).json({ error: 'Language looks like en or en_US.' })
  try {
    const { rows: [cfg] } = await getPool().query(
      `SELECT business_id, access_token FROM wa_config WHERE org_id = $1 AND enabled = true`, [req.user.orgId])
    if (!cfg) return res.status(400).json({ error: 'Connect a WhatsApp number first (WhatsApp tab → settings).' })
    if (!cfg.business_id) return res.status(400).json({ error: 'Save the WhatsApp Business Account ID in WhatsApp settings first.' })
    const token = decryptSecret(cfg.access_token)
    const graph = (path, init = {}) => fetch(`https://graph.facebook.com/v19.0/${cfg.business_id}/${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    }).then(async r => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
    const base = (process.env.APP_BASE_URL || 'https://app.example.org').replace(/\/$/, '')

    const templates = []
    for (const t of BUTTON_TEMPLATES) {
      const existing = await graph(`message_templates?name=${t.name}&fields=name,language,status&limit=100`)
      const same = (existing.j.data || []).find(x => x.name === t.name && x.language === lang)
      if (same) { templates.push({ name: t.name, status: same.status, existed: true }); continue }
      const created = await graph('message_templates', { method: 'POST', body: JSON.stringify({
        name: t.name, language: lang, category: 'UTILITY',
        components: [
          { type: 'BODY', text: t.text, example: { body_text: [[t.example(base)]] } },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: t.button }] },
        ],
      }) })
      templates.push(created.ok
        ? { name: t.name, status: created.j.status || 'PENDING', existed: false }
        : { name: t.name, status: 'ERROR', error: created.j?.error?.error_user_msg || created.j?.error?.message || 'Meta refused it' })
    }
    res.json({ name: BUTTON_TEMPLATES[0].name, templates })
  } catch (e) {
    console.error('[wa-platform] button templates:', e.message)
    res.status(500).json({ error: 'Could not reach Meta. Try again.' })
  }
})

router.put('/wa/config', async (req, res) => {
  if (!['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' })
  // Accept both camelCase and snake_case from frontend
  const phone_number_id = req.body.phone_number_id || req.body.phoneNumberId
  const access_token    = req.body.access_token    || req.body.accessToken
  const webhook_secret  = req.body.webhook_secret  || req.body.webhookSecret
  const app_secret      = req.body.app_secret      || req.body.appSecret
  const business_id     = req.body.business_id     || req.body.businessId
  const display_phone   = req.body.display_phone   || req.body.displayPhone
  const enabled         = req.body.enabled ?? true
  if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id required' })

  const pool = getPool()

  // CRIT: phone_number_id is the sole identifier the inbound-webhook resolver
  // uses to attribute a message to an org (`WHERE phone_number_id = $1 ...
  // LIMIT 1`) — with no DB uniqueness constraint, letting a second org claim
  // a number already registered to another org would make that LIMIT 1 lookup
  // non-deterministic and could misattribute (and leak) the true owner's
  // inbound contacts/messages to the claiming org. Refuse the claim instead.
  const { rows: claimedBy } = await pool.query(
    `SELECT org_id FROM wa_config WHERE phone_number_id = $1 AND org_id <> $2`,
    [phone_number_id, req.user.orgId]
  )
  if (claimedBy.length) {
    return res.status(409).json({ error: 'This WhatsApp phone_number_id is already registered to another organization.' })
  }

  // Check if row already exists (to allow token-preserving updates)
  const { rows: existing } = await pool.query(
    `SELECT org_id FROM wa_config WHERE org_id=$1`, [req.user.orgId]
  )
  const rowExists = existing.length > 0

  if (access_token) {
    // Full upsert including access_token
    await pool.query(
      `INSERT INTO wa_config (org_id, phone_number_id, access_token, webhook_secret, app_secret, business_id, display_phone, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE
         SET phone_number_id=$2, access_token=$3,
             webhook_secret=COALESCE($4, wa_config.webhook_secret),
             app_secret=COALESCE($5, wa_config.app_secret),
             business_id=$6, display_phone=$7, enabled=$8, updated_at=NOW()`,
      // Encrypt the access token + app_secret at rest (the webhook handler decrypts
      // app_secret to verify the HMAC). webhook_secret stays plaintext: it is the
      // Meta verify token, matched by equality in GET /wa/webhook and sent by Meta
      // in the query string, so encrypting it would break the lookup for no gain.
      [req.user.orgId, phone_number_id, encryptSecret(access_token), webhook_secret||null, app_secret ? encryptSecret(app_secret) : null, business_id||null, display_phone||null, enabled]
    )
  } else if (rowExists) {
    // Update without changing access_token (keeping existing value)
    await pool.query(
      `UPDATE wa_config SET phone_number_id=$2,
         webhook_secret=COALESCE($3, webhook_secret),
         app_secret=COALESCE($4, app_secret),
         business_id=$5, display_phone=$6, enabled=$7, updated_at=NOW()
       WHERE org_id=$1`,
      [req.user.orgId, phone_number_id, webhook_secret||null, app_secret ? encryptSecret(app_secret) : null, business_id||null, display_phone||null, enabled]
    )
  } else {
    return res.status(400).json({ error: 'access_token is required for initial setup' })
  }
  res.json({ success: true })
})

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Flows
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wa/flows', async (req, res) => {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id, name, description, trigger_keywords, is_active, is_default, show_progress,
            jsonb_array_length(nodes) AS node_count, created_at, updated_at
     FROM wa_flows WHERE org_id=$1 ORDER BY updated_at DESC`,
    [req.user.orgId]
  )
  res.json({ flows: rows })
})

router.get('/wa/flows/:id', async (req, res) => {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM wa_flows WHERE id=$1 AND org_id=$2`,
    [req.params.id, req.user.orgId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// Flows are executable config: a `webhook` node makes the SERVER fetch an
// author-chosen URL, and flows message the org's beneficiaries. Authoring and
// publishing is an editor action, not something every employee login can do.
function requireFlowEditor(req, res) {
  if (['admin', 'manager', 'superadmin'].includes(req.user?.role)) return true
  res.status(403).json({ error: 'Admin or manager role required to change flows' })
  return false
}

router.post('/wa/flows', async (req, res) => {
  if (!requireFlowEditor(req, res)) return
  // Accept both snake_case (frontend) and camelCase
  const name            = req.body.name
  const description     = req.body.description || ''
  const trigger_keywords = req.body.trigger_keywords || req.body.triggerKeywords || []
  const nodes           = req.body.nodes || []
  const is_default      = req.body.is_default ?? req.body.isDefault ?? false
  const show_progress   = !!(req.body.show_progress ?? req.body.showProgress)
  if (!name) return res.status(400).json({ error: 'name required' })

  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO wa_flows (org_id, name, description, trigger_keywords, nodes, is_default, show_progress, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.user.orgId, name, description, trigger_keywords, JSON.stringify(nodes), is_default, show_progress, req.user.uid]
  )
  res.json({ id: rows[0].id })
})

router.put('/wa/flows/:id', async (req, res) => {
  if (!requireFlowEditor(req, res)) return
  const name            = req.body.name
  const description     = req.body.description || ''
  const trigger_keywords = req.body.trigger_keywords || req.body.triggerKeywords || []
  const nodes           = req.body.nodes || []
  const is_default      = req.body.is_default ?? req.body.isDefault ?? false
  const show_progress   = !!(req.body.show_progress ?? req.body.showProgress)
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE wa_flows SET name=$1, description=$2, trigger_keywords=$3, nodes=$4,
      is_default=$5, show_progress=$6, updated_at=NOW()
     WHERE id=$7 AND org_id=$8 RETURNING id`,
    [name, description, trigger_keywords, JSON.stringify(nodes), is_default, show_progress, req.params.id, req.user.orgId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true })
})

router.delete('/wa/flows/:id', async (req, res) => {
  if (!requireFlowEditor(req, res)) return
  const pool = getPool()
  await pool.query(`DELETE FROM wa_flows WHERE id=$1 AND org_id=$2`, [req.params.id, req.user.orgId])
  res.json({ success: true })
})

router.post('/wa/flows/:id/publish', async (req, res) => {
  if (!requireFlowEditor(req, res)) return
  const pool = getPool()
  const { rows: cur } = await pool.query(
    `SELECT is_active FROM wa_flows WHERE id=$1 AND org_id=$2`,
    [req.params.id, req.user.orgId]
  )
  if (!cur[0]) return res.status(404).json({ error: 'Not found' })
  // Accept explicit active value from body, or toggle current
  const newActive = req.body.active !== undefined ? Boolean(req.body.active) : !cur[0].is_active
  await pool.query(`UPDATE wa_flows SET is_active=$1, updated_at=NOW() WHERE id=$2 AND org_id=$3`, [newActive, req.params.id, req.user.orgId])
  res.json({ is_active: newActive })
})

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Contacts
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wa/contacts', async (req, res) => {
  const pool   = getPool()
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  // Support both 'q' (new frontend) and 'search' (legacy)
  const search = (req.query.q || req.query.search || '').trim()

  const params = search
    ? [req.user.orgId, limit, offset, `%${search}%`]
    : [req.user.orgId, limit, offset]

  const { rows } = await pool.query(
    `SELECT c.*,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.contact_id = c.id)::int AS message_count,
      (SELECT MAX(created_at) FROM wa_messages m WHERE m.contact_id = c.id AND m.direction='inbound') AS last_message_at
     FROM wa_contacts c
     WHERE c.org_id=$1
       ${search ? `AND (c.name ILIKE $4 OR c.wa_id ILIKE $4)` : ''}
     ORDER BY c.last_seen DESC
     LIMIT $2 OFFSET $3`,
    params
  )

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM wa_contacts c
     WHERE c.org_id=$1 ${search ? `AND (c.name ILIKE $2 OR c.wa_id ILIKE $2)` : ''}`,
    search ? [req.user.orgId, `%${search}%`] : [req.user.orgId]
  )

  res.json({ contacts: rows, total: countRows[0].total })
})

router.get('/wa/contacts/:id/messages', async (req, res) => {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT m.* FROM wa_messages m
     JOIN wa_contacts c ON c.id = m.contact_id
     WHERE m.contact_id=$1 AND c.org_id=$2
     ORDER BY m.created_at ASC LIMIT 200`,
    [req.params.id, req.user.orgId]
  )
  res.json({ messages: rows })
})

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Conversations (Glific-style chat list)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/wa/conversations', async (req, res) => {
  const pool   = getPool()
  const orgId  = req.user.orgId
  const limit  = Math.min(parseInt(req.query.limit) || 60, 200)
  const offset = parseInt(req.query.offset) || 0
  const search = (req.query.q || '').trim()
  const mine   = req.query.assigned === 'me'   // Move 7 — "Assigned to me" filter

  try {
    const params = [orgId, limit, offset]
    let searchClause = ''
    if (search) {
      params.push(`%${search}%`)
      searchClause = `AND (c.name ILIKE $${params.length} OR c.wa_id ILIKE $${params.length})`
    }

    let mineClause = ''
    if (mine) {
      // Look up the current user's DB UUID; filter sessions assigned to them
      const { rows: me } = await pool.query(
        `SELECT id FROM users WHERE firebase_uid = $1 AND org_id = $2 LIMIT 1`,
        [req.user.uid, orgId]
      )
      if (me[0]) {
        params.push(me[0].id)
        mineClause = `AND s.assigned_to = $${params.length}`
      } else {
        // No match → return empty
        return res.json({ conversations: [] })
      }
    }

    const { rows } = await pool.query(`
      SELECT
        c.id, c.wa_id, c.name, c.tags, c.opted_in, c.last_seen, c.fields,
        lm.content   AS last_message_content,
        lm.direction AS last_message_direction,
        lm.created_at AS last_message_at,
        lm.type      AS last_message_type,
        s.id         AS session_id,
        s.status     AS session_status,
        s.flow_id,
        f.name       AS flow_name,
        s.current_node,
        s.assigned_to,
        u.name       AS assigned_to_name,
        (SELECT COUNT(*)::int FROM wa_messages WHERE contact_id = c.id) AS message_count
      FROM wa_contacts c
      LEFT JOIN LATERAL (
        SELECT content, direction, created_at, type
        FROM wa_messages
        WHERE contact_id = c.id
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN wa_sessions s ON s.contact_id = c.id AND s.status IN ('active','handoff')
      LEFT JOIN wa_flows f ON f.id = s.flow_id
      LEFT JOIN users u ON u.id = s.assigned_to
      WHERE c.org_id = $1 ${searchClause} ${mineClause}
      ORDER BY COALESCE(lm.created_at, c.last_seen) DESC
      LIMIT $2 OFFSET $3
    `, params)

    res.json({ conversations: rows })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/contacts/:id/send — manual message from agent
router.post('/wa/contacts/:id/send', async (req, res) => {
  const { text } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'text required' })

  const pool = getPool()
  try {
    const { rows: contacts } = await pool.query(
      `SELECT * FROM wa_contacts WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )
    if (!contacts.length) return res.status(404).json({ error: 'Contact not found' })
    const contact = contacts[0]

    const { rows: cfgRows } = await pool.query(
      `SELECT * FROM wa_config WHERE org_id = $1 AND enabled = true`, [req.user.orgId]
    )
    if (!cfgRows.length) return res.status(400).json({ error: 'WhatsApp not configured' })
    const cfg = cfgRows[0]
    cfg.access_token = decryptSecret(cfg.access_token)

    const { WhatsAppClient } = await import('../lib/whatsapp.js')
    const waClient = new WhatsAppClient(cfg.phone_number_id, cfg.access_token)
    await waClient.sendText(contact.wa_id, text.trim())

    const { rows: msgRows } = await pool.query(
      `INSERT INTO wa_messages (org_id, contact_id, direction, type, content, status)
       VALUES ($1,$2,'outbound','text',$3,'sent') RETURNING *`,
      [req.user.orgId, contact.id, JSON.stringify({ text: { body: text.trim() }, _manual: true })]
    )
    await pool.query(`UPDATE wa_contacts SET last_seen=NOW() WHERE id=$1`, [contact.id])

    res.json({ success: true, message: msgRows[0] })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/wa/sessions/:id — stop session (human takeover)
router.delete('/wa/sessions/:id', async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `UPDATE wa_sessions SET status='abandoned', updated_at=NOW()
       WHERE id=$1 AND org_id=$2 RETURNING id`,
      [req.params.id, req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })
    res.json({ success: true })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/sessions/:id/takeover — agent claims an open handoff
router.post('/wa/sessions/:id/takeover', async (req, res) => {
  const pool = getPool()
  try {
    // Look up current user's UUID from users table (req.user.uid is the Firebase UID)
    const { rows: userRows } = await pool.query(
      `SELECT id, name FROM users WHERE firebase_uid = $1 AND org_id = $2`,
      [req.user.uid, req.user.orgId]
    )
    const userId   = userRows[0]?.id   || null
    const userName = userRows[0]?.name || req.user.name || null

    const { rows } = await pool.query(
      `UPDATE wa_sessions SET status='handoff', assigned_to=$3, updated_at=NOW()
       WHERE id=$1 AND org_id=$2 RETURNING id, status, assigned_to`,
      [req.params.id, req.user.orgId, userId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })
    res.json({ success: true, session: rows[0], assigned_to_name: userName })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/sessions/:id/return-to-bot — hand the conversation back to the flow
router.post('/wa/sessions/:id/return-to-bot', async (req, res) => {
  const pool = getPool()
  try {
    // We mark it 'completed' so the next inbound message starts a fresh flow via keyword/NLP.
    // (Keeping 'active' would force the bot to resume mid-flow at the handoff node, which is a dead end.)
    const { rows } = await pool.query(
      `UPDATE wa_sessions SET status='completed', assigned_to=NULL, updated_at=NOW()
       WHERE id=$1 AND org_id=$2 RETURNING id`,
      [req.params.id, req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Session not found' })
    res.json({ success: true })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/contact-fields — distinct contact-field keys across this org.
// Feeds the Variables panel's "Global" section in FlowBuilder.
router.get('/wa/contact-fields', async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT key
      FROM wa_contacts, jsonb_object_keys(COALESCE(fields, '{}'::jsonb)) AS key
      WHERE org_id = $1
      ORDER BY key
    `, [req.user.orgId])
    res.json({ fields: rows.map(r => r.key) })
  } catch (e) {
    console.warn('[contact-fields]', e.message)
    res.json({ fields: [] })
  }
})

// GET /api/wa/collections — list all collections (= distinct tags) with member counts.
router.get('/wa/collections', async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(`
      SELECT
        tag                                                   AS name,
        COUNT(*)::int                                         AS member_count,
        SUM(CASE WHEN opted_in THEN 1 ELSE 0 END)::int        AS opted_in_count,
        MAX(last_seen)                                        AS last_activity
      FROM wa_contacts, unnest(COALESCE(tags, '{}'::text[])) AS tag
      WHERE org_id = $1
      GROUP BY tag
      ORDER BY member_count DESC, tag
    `, [req.user.orgId])
    res.json({ collections: rows })
  } catch (e) {
    console.warn('[collections list]', e.message)
    res.json({ collections: [] })
  }
})

// GET /api/wa/collections/:name/members — paginated member list
router.get('/wa/collections/:name/members', async (req, res) => {
  const pool = getPool()
  const limit  = Math.min(parseInt(req.query.limit) || 100, 500)
  const offset = parseInt(req.query.offset) || 0
  try {
    const { rows } = await pool.query(`
      SELECT id, wa_id, name, tags, opted_in, last_seen
      FROM wa_contacts
      WHERE org_id = $1 AND $2 = ANY(tags)
      ORDER BY last_seen DESC NULLS LAST
      LIMIT $3 OFFSET $4
    `, [req.user.orgId, req.params.name, limit, offset])
    res.json({ members: rows })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/collections/:name/add  body: { contact_ids: [uuid...] }
router.post('/wa/collections/:name/add', async (req, res) => {
  const pool = getPool()
  const name = (req.params.name || '').trim()
  const ids  = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : []
  if (!name || !ids.length) return res.status(400).json({ error: 'name and contact_ids required' })
  try {
    const { rowCount } = await pool.query(`
      UPDATE wa_contacts
         SET tags = array_append(tags, $1)
       WHERE org_id = $2
         AND id = ANY($3::uuid[])
         AND NOT ($1 = ANY(COALESCE(tags, '{}'::text[])))
    `, [name, req.user.orgId, ids])
    res.json({ added: rowCount })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/wa/collections/:name/remove  body: { contact_ids: [uuid...] }
router.post('/wa/collections/:name/remove', async (req, res) => {
  const pool = getPool()
  const name = (req.params.name || '').trim()
  const ids  = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : []
  if (!name || !ids.length) return res.status(400).json({ error: 'name and contact_ids required' })
  try {
    const { rowCount } = await pool.query(`
      UPDATE wa_contacts
         SET tags = array_remove(tags, $1)
       WHERE org_id = $2 AND id = ANY($3::uuid[])
    `, [name, req.user.orgId, ids])
    res.json({ removed: rowCount })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/wa/collections/:name — remove the tag from every contact in the org
router.delete('/wa/collections/:name', async (req, res) => {
  const pool = getPool()
  try {
    const { rowCount } = await pool.query(
      `UPDATE wa_contacts SET tags = array_remove(tags, $1) WHERE org_id = $2 AND $1 = ANY(tags)`,
      [req.params.name, req.user.orgId]
    )
    res.json({ affected: rowCount })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/wa/assignable-users — managers + admins who can be assigned a handoff
// Used by FlowBuilder's human_handoff property panel.
router.get('/wa/assignable-users', async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, COALESCE(designation, '') AS designation
       FROM users
       WHERE org_id = $1
         AND role IN ('admin', 'manager', 'superadmin')
       ORDER BY role, name`,
      [req.user.orgId]
    )
    res.json({ users: rows })
  } catch (e) {
    console.warn('[assignable-users]', e.message)
    res.json({ users: [] })
  }
})

// POST /api/wa/contacts/:id/suggest-replies — Gemini suggests 3 replies based on recent history
// Used by ConversationsTab to surface canned reply candidates the agent can one-click insert.
router.post('/wa/contacts/:id/suggest-replies', async (req, res) => {
  const pool = getPool()
  try {
    const { rows: msgs } = await pool.query(
      `SELECT direction, type, content, created_at
       FROM wa_messages
       WHERE contact_id = $1 AND org_id = $2
       ORDER BY created_at DESC LIMIT 12`,
      [req.params.id, req.user.orgId]
    )
    if (!msgs.length) return res.json({ suggestions: [] })

    // Build a compact transcript (oldest → newest) to send to Gemini
    const transcript = msgs.reverse().map(m => {
      const c = m.content || {}
      const text = c.text?.body || c.body || c.interactive?.body?.text
        || c.interactive?.button_reply?.title || c.interactive?.list_reply?.title
        || `[${m.type}]`
      return `${m.direction === 'inbound' ? 'CONTACT' : 'AGENT'}: ${String(text).slice(0, 240)}`
    }).join('\n')

    const { callGemini } = await import('../lib/nlp.js')
    const system =
      'You are an NGO support agent assistant. Given a WhatsApp conversation, propose THREE short reply options the live agent could send next. ' +
      'Match the contact\'s language. Be empathetic, concise, action-oriented. Return JSON: {"suggestions":["...","...","..."]}. ' +
      'Each suggestion: 5-30 words. No greetings unless missing. No markdown.'
    const result = await callGemini(transcript, system, 400, true, 12_000)

    const suggestions = Array.isArray(result?.suggestions)
      ? result.suggestions.filter(s => typeof s === 'string' && s.trim()).slice(0, 3)
      : []
    res.json({ suggestions })
  } catch (e) {
    console.warn('[suggest-replies]', e.message)
    res.json({ suggestions: [] })  // fail-soft — UI just hides the chips
  }
})

// PATCH /api/wa/contacts/:id/tags — update contact tags
router.patch('/wa/contacts/:id/tags', async (req, res) => {
  const { tags } = req.body
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be array' })
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `UPDATE wa_contacts SET tags=$1 WHERE id=$2 AND org_id=$3 RETURNING id, tags`,
      [tags, req.params.id, req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' })
    res.json({ success: true, tags: rows[0].tags })
  } catch (e) {
    console.error('[wa-platform]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Broadcast
// ─────────────────────────────────────────────────────────────────────────────
router.post('/wa/broadcast', async (req, res) => {
  if (!['admin','superadmin','manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not permitted' })
  }
  const name        = req.body.name
  const messageBody = req.body.message_body || req.body.message || req.body.messageBody
  // Accept tags via direct field OR via recipient_filter.tags (Collections picker)
  const tags        = req.body.tags
                   || (req.body.recipient_filter && Array.isArray(req.body.recipient_filter.tags) ? req.body.recipient_filter.tags : null)
  if (!messageBody) return res.status(400).json({ error: 'message_body required' })

  const pool = getPool()

  // Get WA config
  const { rows: cfgRows } = await pool.query(
    `SELECT * FROM wa_config WHERE org_id=$1 AND enabled=true`, [req.user.orgId]
  )
  if (!cfgRows[0]) return res.status(400).json({ error: 'WhatsApp not configured' })
  const cfg = cfgRows[0]
  cfg.access_token = decryptSecret(cfg.access_token)
  const { WhatsAppClient } = await import('../lib/whatsapp.js')
  const waClient = new WhatsAppClient(cfg.phone_number_id, cfg.access_token)

  // Select recipients
  let contactQuery = `SELECT * FROM wa_contacts WHERE org_id=$1 AND opted_in=true`
  const params = [req.user.orgId]
  if (tags?.length) {
    params.push(tags)
    contactQuery += ` AND tags && $2`
  }
  const { rows: contactsAll } = await pool.query(contactQuery, params)
  // MED-7: cap broadcast recipients to prevent accidental mass messaging
  const BROADCAST_CAP = 1000
  const contacts = contactsAll.slice(0, BROADCAST_CAP)
  if (contactsAll.length > BROADCAST_CAP) {
    console.warn(`[wa/broadcast] org ${req.user.orgId} capped at ${BROADCAST_CAP} of ${contactsAll.length} contacts`)
  }

  // Create broadcast record
  const { rows: bcRows } = await pool.query(
    `INSERT INTO wa_broadcasts (org_id, name, message_body, recipient_filter, status, created_by)
     VALUES ($1,$2,$3,$4,'sending',$5) RETURNING id`,
    [req.user.orgId, name || 'Broadcast', messageBody, JSON.stringify({ tags }), req.user.uid]
  )
  const broadcastId = bcRows[0].id

  // Return immediately; sending happens async below
  // Note: we respond before sending completes so the client isn't blocked
  res.json({ broadcastId, total: contacts.length, sent: 0, failed: 0, status: 'sending' })

  // Send in background
  let sent = 0, failed = 0
  for (const c of contacts) {
    try {
      await waClient.sendText(c.wa_id, messageBody)
      await pool.query(
        `INSERT INTO wa_messages (org_id, contact_id, direction, type, content)
         VALUES ($1,$2,'outbound','text',$3)`,
        [req.user.orgId, c.id, JSON.stringify({ body: messageBody, broadcast_id: broadcastId })]
      )
      sent++
    } catch { failed++ }
    // Throttle: 80 messages/second max
    await new Promise(r => setTimeout(r, 13))
  }

  await pool.query(
    `UPDATE wa_broadcasts SET total_sent=$1, total_failed=$2, status='done', sent_at=NOW() WHERE id=$3`,
    [sent, failed, broadcastId]
  )
})

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHED — Stats
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wa/analytics — 30-day analytics for the Analytics tab.
// Returns four sections at once so the page renders in a single round-trip.
router.get('/wa/analytics', async (req, res) => {
  const pool  = getPool()
  const orgId = req.user.orgId
  try {
    const [volRes, flowsRes, nluAggRes, missesRes, bcastsRes] = await Promise.all([
      // Section 1 — daily message volume (last 30 days)
      pool.query(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               SUM(CASE WHEN direction='inbound'  THEN 1 ELSE 0 END)::int AS inbound,
               SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)::int AS outbound
        FROM wa_messages
        WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `, [orgId]),

      // Section 2 — flow performance
      pool.query(`
        SELECT f.id, f.name,
               COUNT(s.id) FILTER (WHERE s.started_at >= NOW() - INTERVAL '30 days')::int AS starts,
               COUNT(s.id) FILTER (WHERE s.status='completed' AND s.started_at >= NOW() - INTERVAL '30 days')::int AS completes,
               COUNT(s.id) FILTER (WHERE s.status='handoff'   AND s.started_at >= NOW() - INTERVAL '30 days')::int AS handoffs,
               COALESCE(AVG(EXTRACT(EPOCH FROM (s.updated_at - s.started_at))) FILTER (WHERE s.started_at >= NOW() - INTERVAL '30 days'), 0)::int AS avg_sec
        FROM wa_flows f
        LEFT JOIN wa_sessions s ON s.flow_id = f.id
        WHERE f.org_id = $1 AND f.is_active = true
        GROUP BY f.id, f.name
        ORDER BY starts DESC, f.name
        LIMIT 20
      `, [orgId]),

      // Section 3a — NLU hit/miss totals
      pool.query(`
        SELECT action, COUNT(*)::int AS n
        FROM audit_log
        WHERE org_id = $1
          AND action IN ('nlp.hit','nlp.miss')
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY action
      `, [orgId]),

      // Section 3b — last 20 NLU misses (what users wanted that we don't have)
      pool.query(`
        SELECT created_at, diff->>'input' AS input, actor_name AS wa_id
        FROM audit_log
        WHERE org_id = $1 AND action = 'nlp.miss'
        ORDER BY created_at DESC
        LIMIT 20
      `, [orgId]),

      // Section 4 — recent broadcasts
      pool.query(`
        SELECT id, name, total_sent, total_failed, status, sent_at, created_at
        FROM wa_broadcasts
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [orgId]),
    ])

    const nluCounts = { hits: 0, misses: 0 }
    for (const r of nluAggRes.rows) {
      if (r.action === 'nlp.hit')  nluCounts.hits   = r.n
      if (r.action === 'nlp.miss') nluCounts.misses = r.n
    }

    res.json({
      messageVolume: volRes.rows,
      flowPerformance: flowsRes.rows,
      nluHealth: { ...nluCounts, missesRecent: missesRes.rows },
      broadcasts: bcastsRes.rows,
    })
  } catch (e) {
    console.warn('[wa/analytics]', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/wa/stats', async (req, res) => {
  const pool = getPool()
  const [contacts, messages, flows, sessions] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM wa_contacts WHERE org_id=$1`, [req.user.orgId]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE direction='inbound') AS inbound,
                       COUNT(*) FILTER (WHERE direction='outbound') AS outbound
                FROM wa_messages WHERE org_id=$1`, [req.user.orgId]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE is_active) AS active,
                       COUNT(*) AS total
                FROM wa_flows WHERE org_id=$1`, [req.user.orgId]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status='completed') AS completed,
                       COUNT(*) FILTER (WHERE status='active') AS active_now
                FROM wa_sessions WHERE org_id=$1`, [req.user.orgId]),
  ])
  res.json({
    contacts:        parseInt(contacts.rows[0].count),
    inboundMessages: parseInt(messages.rows[0].inbound),
    outboundMessages:parseInt(messages.rows[0].outbound),
    activeFlows:     parseInt(flows.rows[0].active),
    totalFlows:      parseInt(flows.rows[0].total),
    completedSessions: parseInt(sessions.rows[0].completed),
    activeSessions:  parseInt(sessions.rows[0].active_now),
  })
})

export default router
