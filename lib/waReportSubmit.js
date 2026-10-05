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
    beneficiaries, description, attachment_url,
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

/** True when a flow webhook node targets the in-app reports bridge. */
export function isWaReportTarget(url) {
  try {
    return new URL(String(url), 'http://internal').pathname.replace(/\/+$/, '') === '/api/wa/reports/submit'
  } catch { return false }
}
