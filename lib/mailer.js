// lib/mailer.js — per-organisation email: the platform sender (Resend, or the global
// SMTP_* env when Resend isn't configured) or the org's own SMTP. A failing org SMTP
// never falls back to the platform sender. Every attempt is logged to email_log (no bodies).

import { getPool } from '../db/pool.js'
import crypto from 'crypto'
import { decryptSecret } from './crypto.js'

const RESEND_URL = 'https://api.resend.com/emails'
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function platformEmailStatus() {
  const resend = !!(process.env.RESEND_API_KEY || '').trim()
  const from = (process.env.PLATFORM_EMAIL_FROM || '').trim()
  const legacySmtp = !!(process.env.SMTP_USER && process.env.SMTP_PASS)
  return {
    provider: resend && from ? 'resend' : legacySmtp ? 'platform-smtp' : null,
    resend_configured: resend,
    from_address: from || (legacySmtp ? (process.env.SMTP_FROM || process.env.SMTP_USER) : null),
    ready: (resend && !!from) || legacySmtp,
  }
}

export async function getOrgEmailConfig(orgId) {
  const { rows } = await getPool().query(
    `SELECT c.*, o.name AS org_name, o.metadata->'branding' AS branding
       FROM organizations o LEFT JOIN org_email_config c ON c.org_id = o.id
      WHERE o.id = $1`,
    [orgId]
  )
  return rows[0] || null
}

const nodemailerTransports = new Map()   // key → transport (SMTP connections are reused)
async function smtpTransport({ host, port, secure, user, pass }) {
  // Hashed so the cache key doesn't keep a plaintext password around in memory dumps.
  const key = crypto.createHash('sha256').update(`${host}|${port}|${secure}|${user}|${pass}`).digest('hex')
  if (nodemailerTransports.has(key)) return nodemailerTransports.get(key)
  const nodemailer = (await import('nodemailer')).default
  const t = nodemailer.createTransport({
    host, port, secure, auth: { user, pass },
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  })
  nodemailerTransports.set(key, t)
  return t
}

async function sendViaResend({ from, to, subject, html, text, replyTo }) {
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(`Resend rejected the email: ${body.message || r.status}`)
  }
}

/** Display name with characters that would break a From header stripped. */
const cleanName = s => String(s || '').replace(/["<>\r\n]/g, '').trim().slice(0, 80)

/**
 * Send one email on behalf of an org. Throws a human-readable Error on failure
 * (and logs it); resolves to { provider } on success.
 */
export async function sendOrgEmail(orgId, { to, subject, html, text, kind = 'notification' }, cfgOverride) {
  const cfg = cfgOverride || await getOrgEmailConfig(orgId)
  const orgName = cfg?.org_name || 'FieldFlow'
  const fromName = cleanName(cfg?.from_name) || `${cleanName(orgName)} via FieldFlow`
  const replyTo = cfg?.reply_to || undefined
  let provider = null
  try {
    if (cfg?.mode === 'smtp') {
      provider = 'smtp'
      if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass || !cfg.smtp_from_email) {
        throw new Error('This organisation uses its own SMTP server, but host, username, password or from-address is missing.')
      }
      const t = await smtpTransport({
        host: cfg.smtp_host, port: Number(cfg.smtp_port) || 465, secure: cfg.smtp_secure !== false,
        user: cfg.smtp_user, pass: decryptSecret(cfg.smtp_pass),
      })
      await t.sendMail({ from: `"${fromName}" <${cfg.smtp_from_email}>`, to, subject, html, text, replyTo })
    } else {
      const p = platformEmailStatus()
      provider = p.provider
      if (p.provider === 'resend') {
        await sendViaResend({ from: `${fromName} <${process.env.PLATFORM_EMAIL_FROM.trim()}>`, to, subject, html, text, replyTo })
      } else if (p.provider === 'platform-smtp') {
        const port = Number(process.env.SMTP_PORT || 465)
        const t = await smtpTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS })
        await t.sendMail({ from: `"${fromName}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`, to, subject, html, text, replyTo })
      } else {
        throw new Error('Platform email is not configured on the server (set RESEND_API_KEY and PLATFORM_EMAIL_FROM).')
      }
    }
    logEmail(orgId, { kind, to, subject, provider, ok: true })
    return { provider }
  } catch (e) {
    const msg = friendlySmtpError(e)
    logEmail(orgId, { kind, to, subject, provider, ok: false, error: msg })
    throw new Error(msg)
  }
}

function friendlySmtpError(e) {
  const m = String(e?.message || e)
  if (e?.code === 'EAUTH' || /invalid login|authentication failed|535/i.test(m)) return 'SMTP login failed: check the username and password (Gmail and Microsoft 365 need an app password).'
  if (e?.code === 'ECONNECTION' || e?.code === 'ETIMEDOUT' || /timeout|ECONNREFUSED|ENOTFOUND/i.test(m)) return 'Could not reach the SMTP server: check the host and port (465 = SSL, 587 = STARTTLS).'
  if (/self.signed|certificate/i.test(m)) return 'The SMTP server’s TLS certificate was rejected.'
  return m.slice(0, 300)
}

function logEmail(orgId, { kind, to, subject, provider, ok, error }) {
  getPool().query(
    `INSERT INTO email_log (org_id, kind, to_address, subject, provider, ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, kind, to, String(subject || '').slice(0, 300), provider, ok, error || null]
  ).catch(err => console.warn('[mailer] log failed:', err.message))
}

/** Simple branded layout: org name/logo header, one message, one button. */
export function renderEmail({ branding, orgName, heading, paragraphs = [], button, footer }) {
  const color = /^#[0-9a-f]{6}$/i.test(branding?.theme?.primary || '') ? branding.theme.primary : '#341272'
  const logo = typeof branding?.logo_url === 'string' && /^https:\/\//.test(branding.logo_url) ? branding.logo_url : ''
  const name = branding?.org_name || orgName || 'FieldFlow'
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2a2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3eaec">
<tr><td style="padding:20px 28px;border-bottom:1px solid #eef2f3">${logo ? `<img src="${esc(logo)}" alt="" height="32" style="vertical-align:middle;margin-right:10px">` : ''}<strong style="font-size:16px;vertical-align:middle">${esc(name)}</strong></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 14px">${esc(heading)}</h1>
${paragraphs.map(p => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px">${esc(p)}</p>`).join('')}
${button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${esc(button.label)}</a></p>
<p style="font-size:12px;color:#6b7c80;margin:0;word-break:break-all">Or open this link: ${esc(button.url)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafa;font-size:12px;color:#6b7c80">${esc(footer || `Sent by ${name} using FieldFlow.`)}</td></tr>
</table></td></tr></table></body></html>`
  const text = [heading, '', ...paragraphs, ...(button ? ['', `${button.label}: ${button.url}`] : []), '', footer || `Sent by ${name} using FieldFlow.`].join('\n')
  return { html, text }
}

/** Base URL for links in emails. Never trusts the Host header in production. */
export function appBaseUrl(req) {
  const configured = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '')
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') throw new Error('APP_BASE_URL is not set, so email links cannot be built safely.')
  return `${req.protocol}://${req.get('host')}`
}
