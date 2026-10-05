// Quick Report endpoints, plus the org-wide daily_reports read the Reports tab
// merges with its Google-Sheet rows.
//
//   POST /api/reports/quick-extract — turn free text into structured fields via Gemini
//   POST /api/reports/quick-submit  — insert one row into daily_reports
//   GET  /api/reports/daily         — list daily_reports for the org (DB-backed submissions)
//
// Extraction tries lib/nlp.js parseFieldUpdate first, then a richer Gemini extractor.

import { Router } from 'express'
import { getPool }       from '../db/pool.js'
import { parseFieldUpdate, callGemini } from '../lib/nlp.js'
import { check, recordVerdict } from '../lib/dataCorrectness/index.js'
import { requireEditor, requireAuth } from '../lib/routeGuards.js'

const router = Router()

// ── Richer one-shot extractor used when parseFieldUpdate confidence < 0.6
async function richExtract(text, projectsHint = []) {
  const system =
    `You are an NLP parser for NGO field reports. Given a worker's update, extract:\n` +
    `Return JSON: {\n` +
    `  "location":              "<village/district/state or null>",\n` +
    `  "state":                 "<state name or null>",\n` +
    `  "project":               "<project name (from this list if it matches: ${projectsHint.join(', ') || 'any'}) or null>",\n` +
    `  "area_of_intervention":  "<short topic e.g. training, awareness, livelihood, health or null>",\n` +
    `  "beneficiaries":         <integer or null>,\n` +
    `  "description":           "<one-sentence summary in the original language>",\n` +
    `  "confidence":            0.0-1.0\n` +
    `}\n` +
    `Only populate a field if clearly mentioned. Use null otherwise.`
  const out = await callGemini(`Worker update: "${text}"`, system, 256, true, 12_000)
  return out || { location: null, state: null, project: null, area_of_intervention: null, beneficiaries: null, description: text, confidence: 0 }
}

// ── POST /api/reports/quick-extract ──────────────────────────────────────────
router.post('/reports/quick-extract', async (req, res) => {
  const { text, projectsHint } = req.body || {}
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'text required (min 3 chars)' })
  }
  try {
    const cheap = await parseFieldUpdate(text.trim())
    // If it's confident enough AND found at least location or beneficiaries, use it.
    if (cheap.confidence >= 0.6 && (cheap.location || cheap.beneficiaries)) {
      return res.json({
        fields: {
          location:              cheap.location,
          state:                 null,
          project:               null,
          area_of_intervention:  cheap.activity,
          beneficiaries:         cheap.beneficiaries,
          description:           text.trim(),
        },
        confidence: cheap.confidence,
        original_text: text.trim(),
      })
    }
    const rich = await richExtract(text.trim(), Array.isArray(projectsHint) ? projectsHint : [])
    res.json({
      fields: {
        location:              rich.location,
        state:                 rich.state,
        project:               rich.project,
        area_of_intervention:  rich.area_of_intervention,
        beneficiaries:         rich.beneficiaries,
        description:           rich.description || text.trim(),
      },
      confidence: rich.confidence,
      original_text: text.trim(),
    })
  } catch (e) {
    console.warn('[quick-extract]', e)
    res.json({
      fields: { location: null, state: null, project: null, area_of_intervention: null, beneficiaries: null, description: text.trim() },
      confidence: 0,
      original_text: text.trim(),
    })
  }
})

// ── POST /api/reports/quick-submit ───────────────────────────────────────────
router.post('/reports/quick-submit', async (req, res) => {
  const { fields, original_text, photo_urls } = req.body || {}
  if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields required' })

  const pool = getPool()
  try {
    const { rows: userRows } = await pool.query(
      `SELECT id, name FROM users WHERE firebase_uid = $1 AND org_id = $2 LIMIT 1`,
      [req.user.uid, req.user.orgId]
    )
    const submitter   = userRows[0]?.id || null

    const custom_data = {
      source:      'quick-form',
      submitted_at: new Date().toISOString(),
      original_text: original_text || null,
      photo_urls:    Array.isArray(photo_urls) ? photo_urls : [],
    }

    const { rows } = await pool.query(
      `INSERT INTO daily_reports
        (org_id, submitted_by, report_date,
         state, location, project, area_of_intervention,
         description, beneficiaries, attachment_url, custom_data)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date,
               $3, $4, $5, $6,
               $7, $8, $9, $10)
       RETURNING id`,
      [
        req.user.orgId,
        submitter,
        fields.state || null,
        fields.location || null,
        fields.project || null,
        fields.area_of_intervention || null,
        fields.description || original_text || '',
        fields.beneficiaries != null ? parseInt(fields.beneficiaries) || null : null,
        (Array.isArray(photo_urls) && photo_urls[0]) || null,
        JSON.stringify(custom_data),
      ]
    )
    const reportId = rows[0].id

    // ── Data-correctness checks (soft, flag only) ──────────────────────────
    // L1 anomaly + L4 photo-text (sampled at 10%), fire-and-forget; verdicts set
    // daily_reports.quality_flag and are logged.
    const ccCtx = {
      orgId:     req.user.orgId,
      userId:    req.user.uid,
      userName:  req.user.name,
      submitter,
      kind:      'daily_report',
      cid:       req.cid,
    }
    const photoUrl = (Array.isArray(photo_urls) && photo_urls[0]) || null
    Promise.all([
      check('anomaly', {
        beneficiaries: fields.beneficiaries != null ? parseInt(fields.beneficiaries) : null,
        description:   fields.description || original_text || '',
        report_date:   new Date().toISOString().slice(0, 10),
        location:      fields.location || null,
        area_of_intervention: fields.area_of_intervention || null,
      }, ccCtx),
      photoUrl
        ? check('photo_text', { photoUrl, description: fields.description || original_text || '' }, ccCtx)
        : Promise.resolve(null),
    ]).then(([anomaly, photoText]) => {
      // Pick the severer of the two as the row's flag
      const verdicts = [anomaly, photoText].filter(v => v && v.action !== 'allow')
      if (verdicts.length === 0) return
      const sev = verdicts.find(v => v.severity === 'high')
        || verdicts.find(v => v.severity === 'medium')
        || verdicts[0]
      // Photo mismatch wins the flag label so the badge shows the right type
      const isPhoto = photoText && photoText.action !== 'allow'
      const flag = isPhoto && (!anomaly || anomaly.action === 'allow') ? 'photo_mismatch' : null
      if (flag) {
        getPool().query(
          `UPDATE daily_reports SET quality_flag = $1, quality_confidence = $2 WHERE id = $3`,
          [flag, photoText.confidence, reportId]
        ).catch(() => {})
      }
      return recordVerdict(sev, { table: 'daily_reports', id: reportId }, ccCtx)
    }).catch(e => console.warn('[quick-submit] correctness check failed:', e.message))

    res.json({ id: reportId, success: true })
  } catch (e) {
    console.warn('[quick-submit]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/reports/for-project?project=<name>&location=<optional>&limit=10
// Recent field reports for a project dashboard's evidence panel. project is free
// text (no FK), so matching is ILIKE; rows are shaped as DailyReport for <ReportCard>.
router.get('/reports/for-project', async (req, res) => {
  if (!requireEditor(req, res)) return
  const project = (req.query.project || '').trim()
  if (!project) return res.status(400).json({ error: 'project required' })
  const location = (req.query.location || '').trim()
  const limit = Math.min(parseInt(req.query.limit) || 10, 50)

  try {
    const pool = getPool()
    const params = [req.user.orgId, project]
    let locationClause = ''
    if (location) { params.push(location); locationClause = `AND dr.location ILIKE '%' || $${params.length} || '%'` }
    params.push(limit)

    const { rows } = await pool.query(
      `SELECT dr.id, dr.report_date, dr.state, dr.location, dr.project,
              dr.area_of_intervention, dr.description, dr.beneficiaries,
              dr.attachment_url, dr.quality_flag, dr.quality_confidence,
              dr.custom_data, u.name AS submitter_name, u.phone AS submitter_phone
       FROM daily_reports dr
       LEFT JOIN users u ON u.id = dr.submitted_by
       WHERE dr.org_id = $1 AND dr.project ILIKE '%' || $2 || '%' ${locationClause}
       ORDER BY dr.report_date DESC, dr.created_at DESC
       LIMIT $${params.length}`,
      params
    )

    const reports = rows.map(r => ({
      id: r.id,
      timestamp: r.report_date,
      name: r.submitter_name || '',
      phone: r.submitter_phone || '',
      state: r.state || '',
      location: r.location || '',
      project: r.project || '',
      areaOfIntervention: r.area_of_intervention || '',
      description: r.description || '',
      beneficiaries: r.beneficiaries,
      attachmentUrl: r.attachment_url,
      source: r.custom_data?.source === 'quick-form' ? 'web' : (r.custom_data?.source || 'web'),
      qualityFlag: r.quality_flag,
      qualityConfidence: r.quality_confidence,
    }))
    res.json({ reports })
  } catch (e) {
    console.error('[reports/for-project GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/reports/daily — the org's daily_reports rows (Quick Report + WhatsApp),
// shaped as DailyReport so ReportContext.tsx can merge them with the sheet rows.
router.get('/reports/daily', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT dr.id, dr.report_date, dr.state, dr.location, dr.project,
              dr.area_of_intervention, dr.description, dr.beneficiaries,
              dr.attachment_url, dr.custom_data, dr.quality_flag, dr.quality_confidence,
              u.name AS submitter_name, u.phone AS submitter_phone
       FROM daily_reports dr
       LEFT JOIN users u ON u.id = dr.submitted_by
       WHERE dr.org_id = $1
       ORDER BY dr.report_date DESC, dr.created_at DESC
       LIMIT 1000`,
      [req.user.orgId]
    )
    const reports = rows.map(r => ({
      id:                 'db-' + r.id,
      timestamp:           r.report_date,
      name:                r.submitter_name || r.custom_data?.wa_name || '',
      phone:               r.submitter_phone || r.custom_data?.wa_phone || '',
      state:               r.state || '',
      location:            r.location || '',
      project:             r.project || '',
      areaOfIntervention:  r.area_of_intervention || '',
      description:         r.description || '',
      beneficiaries:       r.beneficiaries,
      attachmentUrl:       r.attachment_url,
      source:              r.custom_data?.source === 'whatsapp-flow' ? 'whatsapp' : 'web',
      qualityFlag:         r.quality_flag,
      qualityConfidence:   r.quality_confidence,
    }))
    res.json({ reports })
  } catch (e) {
    console.error('[reports/daily GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
