// HR notifications over the same channels as services/finance/src/notify.js: email
// (address from hr_employee_profiles.email) and WhatsApp (one approved template with
// a single {{1}}, set in HR Settings). Queued in the transaction and sent after
// COMMIT by dispatch(); best-effort, failures are logged only. Every message
// carries a link into the FieldFlow Org app (/org); leave approvals go out on
// the optional approval template, whose quick-reply "Approve" button is handled
// by lib/waApprovals.js.

import { withOrg } from './db.js'
import { decryptSecret } from './crypto.js'

export const EVENTS = [
  'leaveRequested', 'leaveDecided', 'leaveCancelled', 'attendanceMarked', 'checkInOut',
  'missedCheckIn', 'checkOutReminder', 'autoCheckOut', 'approvalReminder', 'leaveTomorrow',
]

export const DEFAULT_NOTIFY = {
  emailEnabled:         true,
  whatsappEnabled:      false,
  whatsappTemplate:     '',
  whatsappLang:         'en',
  // Template with body {{1}} + one quick-reply button ("Approve"); blank = no button.
  whatsappApprovalTemplate: '',
  events:               Object.fromEntries(EVENTS.map(e => [e, true])),
  // Missed check-in reminder goes out at this org-local time (field shifts
  // have no start time to measure from).
  reminderTime:         '11:00',
  checkOutReminderTime: '19:00',   // still checked in → reminder
  autoCheckOutTime:     '22:00',   // still checked in → closed at this time and flagged
  approvalReminderTime: '10:00',   // pending approvals, escalations, leave-tomorrow
  escalateAfterDays:    2,         // pending with the manager this long → HR is reminded too
}

export function notifySettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return { ...DEFAULT_NOTIFY, ...r, events: { ...DEFAULT_NOTIFY.events, ...(r.events || {}) } }
}

export const emailConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS)

// ── Email ────────────────────────────────────────────────────────────────────
let _transport // undefined = not tried yet, null = unavailable
async function getTransport() {
  if (_transport !== undefined) return _transport
  if (!emailConfigured()) return (_transport = null)
  try {
    const nodemailer = (await import('nodemailer')).default
    const port = Number(process.env.SMTP_PORT || 465)
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  } catch (e) {
    console.warn('[hr-notify] email disabled — nodemailer unavailable:', e.message)
    _transport = null
  }
  return _transport
}

/** Deep link into the Org app; msg.link is its hash route. Blank without APP_BASE_URL. */
export function appLink(msg) {
  const base = process.env.APP_BASE_URL
  const route = msg.link
    || (['approvalReminder', 'leaveCancelled'].includes(msg.event) ? 'approvals'
      : /^leave/.test(msg.event || '') ? 'leave' : 'attendance')
  return base ? `${base.replace(/\/$/, '')}/org/#${route}` : ''
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function sendEmail(to, msg) {
  const transport = await getTransport()
  if (!transport) throw new Error('Email is not configured on the server (SMTP_USER / SMTP_PASS).')
  const link = appLink(msg)
  await transport.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `[HR] ${msg.title}`,
    text:    `${msg.title}\n\n${msg.body || ''}${link ? `\n\nView details on FieldFlow: ${link}` : ''}`,
    html:    `<p style="font:15px/1.5 sans-serif;margin:0 0 8px"><strong>${esc(msg.title)}</strong></p>`
           + (msg.body ? `<p style="font:14px/1.5 sans-serif;margin:0 0 12px;color:#333">${esc(msg.body)}</p>` : '')
           + (link ? `<p style="font:14px sans-serif"><a href="${esc(link)}">View details on FieldFlow</a></p>` : ''),
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

/** Quick-reply payload read back by lib/waApprovals.js: ffa:<kind>:<stage>:<id>. */
export const approvePayload = a => `ffa:${a.kind}:${a.stage || '-'}:${a.id}`

async function sendWhatsApp(cfg, settings, phone, msg) {
  const to = waNumber(phone)
  if (!to) throw new Error('No valid phone number.')
  // Template params may not contain newlines/tabs or long runs of spaces.
  const link = appLink(msg)
  const text = `${msg.title}${msg.body ? ' — ' + msg.body : ''}`.replace(/\s+/g, ' ').slice(0, 900)
    + (link ? ` Details: ${link}` : '')
  const approval = msg.approve && settings.whatsappApprovalTemplate
  const name = approval ? settings.whatsappApprovalTemplate : settings.whatsappTemplate
  const send = (code) => fetch(`https://graph.facebook.com/v19.0/${cfg.phone_number_id}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code }, components: [
        { type: 'body', parameters: [{ type: 'text', text }] },
        ...(approval ? [{ type: 'button', sub_type: 'quick_reply', index: '0',
          parameters: [{ type: 'payload', payload: approvePayload(msg.approve) }] }] : []),
      ] },
    }),
    signal: AbortSignal.timeout(8000),
  })
  const lang = settings.whatsappLang || 'en'
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

/** HR users who give final approval; admins if nobody is flagged HR. */
export async function hrApproverIds(client, orgId) {
  const { rows } = await client.query(
    `SELECT p.user_id FROM hr_employee_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.org_id = $1 AND p.is_hr`, [orgId])
  if (rows.length) return rows.map(r => r.user_id)
  const { rows: admins } = await client.query(
    `SELECT id FROM users u WHERE org_id = $1 AND role = 'admin'`, [orgId])
  return admins.map(r => r.id)
}

/** Send queued { event, userIds, title, body, link?, approve? } after COMMIT; one result per send, never throws. */
export async function dispatch(orgId, queued, { force = false } = {}) {
  if (!queued?.length) return []
  const results = []
  try {
    const ids = [...new Set(queued.flatMap(q => q.userIds).filter(Boolean))]
    const { settings, people, wa } = await withOrg(orgId, async (client) => {
      const { rows: [s] } = await client.query(`SELECT notifications FROM hr_settings WHERE org_id = $1`, [orgId])
      const settings = notifySettings(s?.notifications)
      const { rows: people } = await client.query(
        `SELECT u.id, u.phone, p.email FROM users u
           LEFT JOIN hr_employee_profiles p ON p.user_id = u.id
          WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])`, [orgId, ids])
      let wa = null
      if (settings.whatsappEnabled && settings.whatsappTemplate) {
        const { rows } = await client.query(
          `SELECT phone_number_id, access_token, business_id FROM wa_config WHERE org_id = $1 AND enabled = true`, [orgId]
        ).catch(() => ({ rows: [] }))
        if (rows[0]) wa = { ...rows[0], access_token: decryptSecret(rows[0].access_token) }
      }
      return { settings, people, wa }
    })
    const byId = new Map(people.map(p => [p.id, p]))
    const sends = []
    for (const msg of queued) {
      if (!force && !settings.events[msg.event]) continue
      for (const id of new Set(msg.userIds)) {
        const p = byId.get(id)
        if (!p) continue
        const track = (channel, promise) => sends.push(promise
          .then(() => results.push({ userId: id, channel, ok: true }))
          .catch((e) => {
            results.push({ userId: id, channel, ok: false, error: e.message })
            console.warn(`[hr-notify] ${channel} to ${id} failed:`, e.message)
          }))
        if (settings.emailEnabled && p.email && (emailConfigured() || force)) track('email', sendEmail(p.email, msg))
        if (wa?.access_token && p.phone) track('whatsapp', sendWhatsApp(wa, settings, p.phone, msg))
      }
    }
    // Bounded: Cloud Run only guarantees CPU while the request is open, and a
    // slow SMTP server must not hang the user's request.
    await Promise.race([Promise.allSettled(sends), new Promise(r => setTimeout(r, 10_000))])
  } catch (e) {
    console.warn('[hr-notify] dispatch failed:', e.message)
  }
  return results
}
