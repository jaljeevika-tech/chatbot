// lib/waReportSubmit.js — WA "Reporting" flow → daily_reports insert
//
// Shared by lib/flowEngine.js and routes/wa-reports.routes.js. The org always comes
// from a server-verified source (flow session contact or req.user.orgId), never the payload.

import { getPool } from '../db/pool.js'

/**
 * Insert one WhatsApp-flow field report for `orgId`.
 * @returns {{ status: number, body: object }}
 */
export async function submitWaReport(orgId, payload = {}) {
  if (!orgId) return { status: 400, body: { success: false, error: 'org required' } }

  const {
    phone, name,
    state, location, project, area_of_intervention,
    beneficiaries, description, attachment_url, attachments,
  } = payload

  if (!project && !description) {
    return { status: 400, body: { success: false, error: 'At least project or description must be present' } }
  }

  const cleanPhone = String(phone || '').replace(/\D/g, '')
  const custom_data = {
    source:       'whatsapp-flow',
    submitted_at: new Date().toISOString(),
    wa_phone:     cleanPhone || null,
    wa_name:      name || null,
  }
  // Every file sent with the report; attachment_url keeps just the first photo
  // for the screens that show one picture.
  if (Array.isArray(attachments)) {
    const files = attachments
      .filter(a => a && isHttp(a.url))
      .slice(0, MAX_MEDIA_PER_REPORT)
      .map(a => ({ url: String(a.url), mime_type: cleanMime(a.mime_type), caption: String(a.caption || '').slice(0, 500) }))
    if (files.length) custom_data.attachments = files
  }

  // Single round-trip (submitter lookup as a subquery): the flow webhook node has a
  // 15s budget, and sequential queries can blow it on a cold Neon wake-up.
  try {
    const { rows } = await getPool().query(
      `INSERT INTO daily_reports
        (org_id, submitted_by, report_date,
         state, location, project, area_of_intervention,
         description, beneficiaries, attachment_url, custom_data)
       VALUES (
         $1,
         (SELECT id FROM users WHERE org_id = $1 AND $2 <> '' AND regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $2 LIMIT 1),
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         $3, $4, $5, $6,
         $7, $8, $9, $10
       )
       RETURNING id, report_date`,
      [
        orgId,
        cleanPhone.slice(-10),
        state || null,
        location || null,
        project || null,
        area_of_intervention || null,
        description || '',
        beneficiaries != null ? parseInt(beneficiaries) || null : null,
        attachment_url || null,
        JSON.stringify(custom_data),
      ]
    )
    const row = rows[0]
    return { status: 200, body: { success: true, id: row.id, project: project || 'N/A', date: row.report_date } }
  } catch (e) {
    if (e.code === '23503') { // foreign_key_violation — org doesn't exist
      return { status: 404, body: { success: false, error: 'Organisation not found' } }
    }
    console.error('[wa-reports] insert failed:', e.message)
    return { status: 500, body: { success: false, error: 'Failed to save report' } }
  }
}

// Served back inline by routes/wa-reports.routes.js, so keep to types a browser
// renders safely (no SVG/HTML).
export const MEDIA_MIME = /^(image\/(jpeg|png|webp|gif|heic)|video\/(mp4|3gpp|quicktime)|application\/pdf)$/
const MAX_MEDIA_BYTES = 16 * 1024 * 1024 // WhatsApp's own cap for video
export const MAX_MEDIA_PER_REPORT = 10

const isHttp = (u) => /^https?:\/\//i.test(String(u || ''))
const cleanMime = (m) => String(m || '').split(';')[0].trim().toLowerCase()

/** Every media item captured in a flow session: single-photo answers and multi-file lists. */
export function collectedMedia(collected) {
  return Object.entries(collected || {})
    .filter(([k]) => !k.startsWith('__'))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter(v => v && typeof v === 'object' && (v.media_id || v.url))
    .slice(0, MAX_MEDIA_PER_REPORT)
}

async function storeOne(orgId, item, accessToken) {
  const caption = String(item.caption || '').slice(0, 500)
  if (isHttp(item.url)) return { url: item.url, mime_type: cleanMime(item.mime_type), caption } // e.g. Glific already hosts it
  if (!item.media_id || !accessToken || !orgId) return null
  const { downloadMetaMedia } = await import('./voiceTranscribe.js')
  const dl = await downloadMetaMedia(item.media_id, accessToken)
  const mime = cleanMime(dl?.mimeType)
  if (!dl || !MEDIA_MIME.test(mime) || dl.buffer.length > MAX_MEDIA_BYTES) return null
  const { rows } = await getPool().query(
    'INSERT INTO wa_report_media (org_id, mime_type, data) VALUES ($1, $2, $3) RETURNING id',
    [orgId, mime, dl.buffer]
  )
  const base = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).trim().replace(/\/$/, '')
  return { url: `${base}/api/wa/media/${rows[0].id}`, mime_type: mime, caption }
}

/**
 * Download WhatsApp media items ({ media_id, url?, caption? }) and keep our own
 * copy, since Meta ids aren't viewable links. Returns [{ url, mime_type, caption }]
 * for the ones that worked; a failed file never blocks the report.
 */
export async function storeWaMedia(orgId, items, accessToken) {
  const stored = await Promise.all((items || []).slice(0, MAX_MEDIA_PER_REPORT).map(item =>
    storeOne(orgId, item, accessToken).catch(e => {
      console.error('[wa-reports] media store failed:', e.message)
      return null
    })
  ))
  return stored.filter(Boolean)
}

/** True when a flow webhook node targets the in-app reports bridge. */
export function isWaReportTarget(url) {
  try {
    return new URL(String(url), 'http://internal').pathname.replace(/\/+$/, '') === '/api/wa/reports/submit'
  } catch { return false }
}
