// HR notifications over the same channels as services/finance/src/notify.js: email
// (address from hr_employee_profiles.email) and WhatsApp (one approved template with
// a single {{1}}, set in HR Settings). Queued in the transaction and sent after
// COMMIT by dispatch(); best-effort, failures are logged only.

import { withOrg } from './db.js'
import { decryptSecret } from './crypto.js'

export const EVENTS = ['leaveRequested', 'leaveDecided', 'attendanceMarked', 'checkInOut', 'missedCheckIn']

export const DEFAULT_NOTIFY = {
  emailEnabled:         true,
  whatsappEnabled:      false,
  whatsappTemplate:     '',
  whatsappLang:         'en',
  events:               Object.fromEntries(EVENTS.map(e => [e, true])),
  // Missed check-in reminder goes out at this org-local time (field shifts
  // have no start time to measure from).
  reminderTime:         '11:00',
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

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function sendEmail(to, msg) {
  const transport = await getTransport()
  if (!transport) throw new Error('Email is not configured on the server (SMTP_USER / SMTP_PASS).')
  const link = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, '')}/#hr` : ''
  await transport.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `[HR] ${msg.title}`,
    text:    `${msg.title}\n\n${msg.body || ''}${link ? `\n\nOpen HR Management: ${link}` : ''}`,
    html:    `<p style="font:15px/1.5 sans-serif;margin:0 0 8px"><strong>${esc(msg.title)}</strong></p>`
           + (msg.body ? `<p style="font:14px/1.5 sans-serif;margin:0 0 12px;color:#333">${esc(msg.body)}</p>` : '')
           + (link ? `<p style="font:14px sans-serif"><a href="${esc(link)}">Open HR Management</a></p>` : ''),
  })
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
function waNumber(phone) {
  const c = String(phone || '').replace(/\D/g, '')
  if (c.length === 10) return '91' + c
  return c.length >= 11 ? c : null
}

async function sendWhatsApp(cfg, settings, phone, msg) {
  const to = waNumber(phone)
  if (!to) throw new Error('No valid phone number.')
  // Template params may not contain newlines/tabs or long runs of spaces.
  const text = `${msg.title}${msg.body ? ' — ' + msg.body : ''}`.replace(/\s+/g, ' ').slice(0, 1000)
  const res = await fetch(`https://graph.facebook.com/v19.0/${cfg.phone_number_id}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name:       settings.whatsappTemplate,
        language:   { code: settings.whatsappLang || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
      },
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j?.error?.message || `WhatsApp API ${res.status}`)
  }
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

/** Send queued { event, userIds, title, body } after COMMIT; one result per send, never throws. */
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
          `SELECT phone_number_id, access_token FROM wa_config WHERE org_id = $1 AND enabled = true`, [orgId]
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
