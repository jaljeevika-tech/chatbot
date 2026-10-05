// routes/leads.routes.js — public landing page trial / demo requests.
// POST /api/public/trial-request (no auth, rate-limited). Stored in trial_requests;
// optional notification to LEADS_NOTIFY_EMAIL via the platform sender.

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { getPool } from '../db/pool.js'
import { sendOrgEmail, renderEmail } from '../lib/mailer.js'

const router = Router()

const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
  skip: req => req.method === 'OPTIONS',
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const str = (v, max) => String(v ?? '').trim().slice(0, max)

export function validateLead(body = {}) {
  const lead = {
    name: str(body.name, 120),
    org_name: str(body.org_name, 200),
    email: str(body.email, 200).toLowerCase(),
    phone: str(body.phone, 30),
    role: str(body.role, 80),
    team_size: str(body.team_size, 40),
    message: str(body.message, 2000),
  }
  if (!lead.name || !lead.org_name) return { error: 'Please tell us your name and organisation.' }
  if (!EMAIL_RE.test(lead.email)) return { error: 'Please enter a valid email address.' }
  if (lead.phone && !/^[+\d][\d\s-]{6,}$/.test(lead.phone)) return { error: 'Please enter a valid phone number.' }
  return { lead }
}

router.post('/public/trial-request', leadLimiter, async (req, res) => {
  // Honeypot: real visitors never see or fill `website`. Pretend success for bots.
  if (req.body?.website) return res.json({ ok: true })
  const { lead, error } = validateLead(req.body)
  if (error) return res.status(400).json({ error })
  try {
    await getPool().query(
      `INSERT INTO trial_requests (name, org_name, email, phone, role, team_size, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [lead.name, lead.org_name, lead.email, lead.phone || null, lead.role || null,
       lead.team_size || null, lead.message || null]
    )
  } catch (e) {
    console.error('[trial-request]', e)
    return res.status(500).json({ error: 'Could not save your request. Please try again.' })
  }
  res.json({ ok: true })

  const notify = (process.env.LEADS_NOTIFY_EMAIL || '').trim()
  if (notify) {
    const rows = Object.entries(lead).filter(([, v]) => v).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`)
    sendOrgEmail(null, {
      to: notify,
      subject: `New trial request — ${lead.org_name}`,
      kind: 'lead',
      text: rows.join('\n'),
      html: renderEmail({ orgName: 'FieldFlow', heading: 'New trial request', paragraphs: rows }),
    }, { org_name: 'FieldFlow', mode: 'platform', from_name: 'FieldFlow' })
      .catch(e => console.warn('[trial-request] notify failed:', e.message))
  }
})

export default router
