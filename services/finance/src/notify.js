// Finance notifications. In-app rows are written inside the business transaction
// (queueNotifications), so nothing is lost or sent for a rolled-back change. Email
// (SMTP_USER/SMTP_PASS, optional SMTP_FROM/HOST/PORT) and WhatsApp (one approved
// utility template with a single {{1}}, required outside the 24h window) go out
// after commit, best-effort: failures are logged, never surfaced.

import { decryptSecret } from './crypto.js'

export const DEFAULT_SETTINGS = {
  email_enabled:      true,
  whatsapp_enabled:   false,
  whatsapp_template:  '',
  whatsapp_lang:      'en',
  expense_categories: ['Travel', 'Local conveyance', 'Food', 'Accommodation', 'Training / meeting',
                       'Materials & supplies', 'Printing & stationery', 'Communication', 'Other'],
}

export async function loadSettings(client, orgId) {
  const { rows } = await client.query(`SELECT settings FROM fm_settings WHERE org_id = $1`, [orgId])
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.settings || {}) }
}

/**
 * Write in-app notifications for each recipient (deduped, actor excluded) and
 * return the payload to hand to dispatchExternal() after COMMIT.
 */
export async function queueNotifications(client, orgId, recipientIds, msg, actorId = null) {
  const ids = [...new Set(recipientIds.filter(Boolean))].filter(id => id !== actorId)
  for (const userId of ids) {
    await client.query(
      `INSERT INTO fm_notifications (org_id, user_id, title, body, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, userId, msg.title, msg.body || null, msg.entityType || null, msg.entityId || null]
    )
  }
  return ids.length ? [{ recipientIds: ids, ...msg }] : []
}

// ── Email ─────────────────────────────────────────────────────────────────────
let _transport // undefined = not tried yet, null = unavailable
async function getTransport() {
  if (_transport !== undefined) return _transport
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!user || !pass) return (_transport = null)
  try {
    const nodemailer = (await import('nodemailer')).default
    const port = Number(process.env.SMTP_PORT || 465)
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
    })
  } catch (e) {
    console.warn('[fm-notify] email disabled — nodemailer unavailable:', e.message)
    _transport = null
  }
  return _transport
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function sendEmail(to, msg) {
  const transport = await getTransport()
  if (!transport) return
  const link = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, '')}/#financemgmt` : ''
  await transport.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `[Finance] ${msg.title}`,
    text:    `${msg.title}\n\n${msg.body || ''}${link ? `\n\nOpen Finance Management: ${link}` : ''}`,
    html:    `<p style="font:15px/1.5 sans-serif;margin:0 0 8px"><strong>${esc(msg.title)}</strong></p>`
           + (msg.body ? `<p style="font:14px/1.5 sans-serif;margin:0 0 12px;color:#333">${esc(msg.body)}</p>` : '')
           + (link ? `<p style="font:14px sans-serif"><a href="${esc(link)}">Open Finance Management</a></p>` : ''),
  })
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
function waNumber(phone) {
  const c = String(phone || '').replace(/\D/g, '')
  if (c.length === 10) return '91' + c
  return c.length >= 11 ? c : null
}

// Meta #132001 = no APPROVED template with this name + language on the number's
// WhatsApp Business Account. Look it up so we can say why, and pick up the
// language it was approved in (en vs en_US is the usual mismatch).
async function approvedTemplateLang(cfg, name) {
  if (!cfg.business_id) throw new Error(`WhatsApp template "${name}" was not found, and no WhatsApp Business Account ID is saved to check it against.`)
  const res = await fetch(`https://graph.facebook.com/v19.0/${cfg.business_id}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status&limit=100`, {
    headers: { Authorization: `Bearer ${cfg.access_token}` }, signal: AbortSignal.timeout(8000),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`WhatsApp template "${name}" was not found, and Meta refused the lookup: ${j?.error?.message || res.status}`)
  const found = (j.data || []).filter(t => t.name === name)
  const approved = found.find(t => t.status === 'APPROVED')
  if (approved) return approved.language
  if (found.length) throw new Error(`WhatsApp template "${name}" is ${found.map(t => `${t.status} (${t.language})`).join(', ')} in Meta — it can be sent only once APPROVED.`)
  throw new Error(`No WhatsApp template named "${name}" on Business Account ${cfg.business_id}. Create it in Meta WhatsApp Manager, or fix the name in settings.`)
}

// Approved in this very language yet Meta says it doesn't exist: the number
// usually sits on a different Business Account than the one saved in settings.
async function sameLangHint(cfg, name, lang) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${cfg.business_id}/phone_numbers?fields=id,display_phone_number&limit=100`, {
    headers: { Authorization: `Bearer ${cfg.access_token}` }, signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  const j = res?.ok ? await res.json().catch(() => ({})) : null
  if (j && !(j.data || []).some(p => p.id === String(cfg.phone_number_id))) {
    return `WhatsApp template "${name}" is approved on Business Account ${cfg.business_id}, but phone number ID ${cfg.phone_number_id} is not on that account `
      + `(it has: ${(j.data || []).map(p => `${p.display_phone_number} = ${p.id}`).join(', ') || 'no numbers'}). Fix the Phone Number ID or Business Account ID in WhatsApp settings.`
  }
  return `WhatsApp template "${name}" (${lang}) is approved on Business Account ${cfg.business_id} and the number is on it, but Meta still rejects it (#132001). `
    + 'If it was approved in the last hour, wait and retry; otherwise check the template in Meta WhatsApp Manager.'
}

async function sendWhatsApp(cfg, settings, phone, msg) {
  const to = waNumber(phone)
  if (!to) return
  // Template params may not contain newlines/tabs or long runs of spaces.
  const text = `${msg.title}${msg.body ? ' — ' + msg.body : ''}`.replace(/\s+/g, ' ').slice(0, 1000)
  const name = settings.whatsapp_template
  const send = (code) => fetch(`https://graph.facebook.com/v19.0/${cfg.phone_number_id}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] },
    }),
    signal: AbortSignal.timeout(8000),
  })
  const lang = settings.whatsapp_lang || 'en'
  let res = await send(lang)
  let j = res.ok ? null : await res.json().catch(() => ({}))
  if (j?.error?.code === 132001) {
    const approvedLang = await approvedTemplateLang(cfg, name)
    if (approvedLang === lang) throw new Error(await sameLangHint(cfg, name, lang))
    console.warn(`[notify] template "${name}" is approved as ${approvedLang}, not ${lang} — fix the language in settings`)
    res = await send(approvedLang)
    j = res.ok ? null : await res.json().catch(() => ({}))
  }
  if (j) throw new Error(j?.error?.message || `WhatsApp API ${res.status}`)
}

/** Send queued notifications over email / WhatsApp. Call after COMMIT; never throws. */
export async function dispatchExternal(pool, orgId, queued, withOrgTx) {
  if (!queued?.length) return
  try {
    const allIds = [...new Set(queued.flatMap(q => q.recipientIds))]
    const { settings, users, wa } = await withOrgTx(pool, orgId, async client => {
      const settings = await loadSettings(client, orgId)
      const { rows: users } = await client.query(
        `SELECT u.id, p.email, u.phone FROM users u
         LEFT JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
         WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])`, [orgId, allIds])
      let wa = null
      if (settings.whatsapp_enabled && settings.whatsapp_template) {
        const { rows } = await client.query(
          `SELECT phone_number_id, access_token, business_id FROM wa_config WHERE org_id = $1 AND enabled = true`, [orgId])
        if (rows[0]) wa = { ...rows[0], access_token: decryptSecret(rows[0].access_token) }
      }
      return { settings, users, wa }
    })
    const byId = new Map(users.map(u => [u.id, u]))
    const sends = []
    for (const q of queued) {
      for (const id of q.recipientIds) {
        const u = byId.get(id)
        if (!u) continue
        if (settings.email_enabled && u.email) sends.push(sendEmail(u.email, q).catch(e => console.warn('[fm-notify] email failed:', e.message)))
        if (wa?.access_token && u.phone)       sends.push(sendWhatsApp(wa, settings, u.phone, q).catch(e => console.warn('[fm-notify] whatsapp failed:', e.message)))
      }
    }
    // Bounded wait: Cloud Run only guarantees CPU while a request is open, so
    // these finish before the response — but a slow SMTP server can't hang it.
    await Promise.race([Promise.allSettled(sends), new Promise(r => setTimeout(r, 10_000))])
  } catch (e) {
    console.warn('[fm-notify] dispatch failed:', e.message)
  }
}
