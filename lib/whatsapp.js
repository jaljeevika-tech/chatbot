// Meta WhatsApp Cloud API client: outbound messages + webhook signature verification.
//
// API ref: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

import crypto from 'crypto'

const WA_BASE = 'https://graph.facebook.com/v19.0'

// ── Signature verification ────────────────────────────────────────────────────
// Meta sends X-Hub-Signature-256: sha256=<hmac> on every webhook POST
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret) return true  // no secret configured → skip check
  if (!signature) return false
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

// ── WhatsApp API client ───────────────────────────────────────────────────────
export class WhatsAppClient {
  constructor(phoneNumberId, accessToken) {
    this.phoneNumberId = phoneNumberId
    this.accessToken   = accessToken
  }

  async _post(payload) {
    const res = await fetch(`${WA_BASE}/${this.phoneNumberId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    })
    const json = await res.json()
    if (!res.ok) {
      const msg = json?.error?.message || `WhatsApp API ${res.status}`
      throw new Error(msg)
    }
    return json
  }

  // ── Plain text message ──────────────────────────────────────────────────────
  sendText(to, text, previewUrl = false) {
    return this._post({
      to,
      type: 'text',
      text: { body: text, preview_url: previewUrl },
    })
  }

  // ── Interactive list message (up to 10 options) ─────────────────────────────
  // sections: [{ title?: string, rows: [{ id, title, description? }] }]
  sendList(to, headerText, bodyText, buttonText, sections) {
    return this._post({
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: headerText },
        body:   { text: bodyText },
        action: { button: buttonText, sections },
      },
    })
  }

  // ── Interactive button message (up to 3 buttons) ────────────────────────────
  // buttons: [{ id, title }]
  sendButtons(to, bodyText, buttons) {
    return this._post({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(b => ({
            type:  'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    })
  }

  // ── Template message (required for first contact / 24h+ gap) ────────────────
  sendTemplate(to, templateName, languageCode = 'en', components = []) {
    return this._post({
      to,
      type: 'template',
      template: {
        name:     templateName,
        language: { code: languageCode },
        components,
      },
    })
  }

  // ── Mark message as read ────────────────────────────────────────────────────
  // Meta requires recipient_id (the sender's wa_id) alongside message_id
  markRead(messageId, recipientWaId) {
    const payload = {
      status:     'read',
      message_id: messageId,
    }
    // Some API versions require recipient_id
    if (recipientWaId) payload.recipient_id = recipientWaId
    return this._post(payload)
  }
}

// ── Parse incoming Meta webhook payload ──────────────────────────────────────
// → array of normalised events
export function parseWebhookEvents(body) {
  const events = []
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue
        const val = change.value
        const phoneNumberId = val?.metadata?.phone_number_id

        // Inbound messages
        for (const msg of val.messages || []) {
          const contact = val.contacts?.find(c => c.wa_id === msg.from)
          events.push({
            type:          'message',
            phoneNumberId,
            from:          msg.from,
            contactName:   contact?.profile?.name || '',
            messageId:     msg.id,
            timestamp:     new Date(parseInt(msg.timestamp) * 1000),
            messageType:   msg.type,
            subType:       msg.type,   // 'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive' | 'location'
            text:          msg.text?.body || '',
            interactiveId:    msg.interactive?.list_reply?.id
                           || msg.interactive?.button_reply?.id || '',
            interactiveTitle: msg.interactive?.list_reply?.title
                           || msg.interactive?.button_reply?.title || '',
            // Quick-reply button on a template message (type 'button').
            buttonPayload: msg.button?.payload || '',
            imageUrl:      msg.image?.id   ? `${WA_BASE}/${msg.image.id}` : '',
            // Generic media block for image / audio / video / document (used by voice transcription + image validation)
            media:         (() => {
              const m = msg.image || msg.audio || msg.video || msg.document
              if (!m) return null
              return {
                id:        m.id,
                mime_type: m.mime_type || '',
                caption:   msg.image?.caption || msg.video?.caption || msg.document?.caption || '',
                filename:  m.filename || '',
              }
            })(),
            locationLat:   msg.location?.latitude  || null,
            locationLng:   msg.location?.longitude || null,
            locationName:  msg.location?.name || '',
            raw: msg,
          })
        }

        // Status updates (delivered, read, failed)
        for (const status of val.statuses || []) {
          events.push({
            type:      'status',
            phoneNumberId,
            messageId: status.id,
            status:    status.status,
            to:        status.recipient_id,
          })
        }
      }
    }
  } catch (e) {
    console.error('[wa] parseWebhookEvents error:', e.message)
  }
  return events
}
