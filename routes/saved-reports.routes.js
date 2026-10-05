// routes/saved-reports.routes.js — Saved AI Reports
// POST   /api/saved-reports          save a generated report
// GET    /api/saved-reports          list saved reports for org
// GET    /api/saved-reports/:id      get full content of one report
// DELETE /api/saved-reports/:id      delete a saved report

import { Router } from 'express'
import { getPool, orgQuery } from '../db/pool.js'
import { check, recordVerdict } from '../lib/dataCorrectness/index.js'
import { buildLineage, resolveClaim } from '../lib/dataCorrectness/lineage.js'

const router = Router()

// ── POST /api/saved-reports ────────────────────────────────────────────
router.post('/saved-reports', async (req, res) => {
  const {
    title, content, reportCount, filters, sources,
    subjects: _subjects, kind: _kind,
  } = req.body
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' })
  }

  const orgId  = req.user.orgId
  const userId = req.user.uid

  // Normalise subjects + kind. Cap at 20 to bound array sizes.
  const subjects = Array.isArray(_subjects)
    ? _subjects.filter(s => s && (s.id || s.name)).slice(0, 20)
    : []
  const reportKind = _kind === 'for_other' || _kind === 'team' || _kind === 'self'
    ? _kind
    : (subjects.length > 1 ? 'team' : subjects.length === 1 ? 'for_other' : 'self')
  // Server-side identity — never trust the client claim about who generated.
  const generatedByName = req.user.name || null
  const subjectIds   = subjects.map(s => s.id).filter(Boolean)
  const subjectNames = subjects.map(s => s.name).filter(Boolean)

  // ── Hallucination guard (tiered — may block); skipped when no sources are sent ──
  let verdict = null
  if (Array.isArray(sources) && sources.length > 0) {
    try {
      verdict = await check('hallucination',
        { output: content, sources },
        { orgId, userId, userName: req.user.name, kind: 'saved_report', cid: req.cid }
      )
      if (verdict?.action === 'block') {
        return res.status(422).json({
          error: 'Report blocked by hallucination guard',
          severity: verdict.severity,
          grounding_score: verdict.grounding_score,
          suspicious: verdict.suspicious || [],
          fabricated_claims: verdict.fabricated_claims || [],
          unsupported_inferences: verdict.unsupported_inferences || [],
          reasons: verdict.reasons || [],
          guidance: 'Regenerate with stricter grounding or mark unverified claims with ⟨MISSING⟩ before saving.',
        })
      }
    } catch (e) {
      console.warn('[saved-reports] hallucination check threw:', e.message)
    }
  }

  try {
    const flag = verdict && verdict.action !== 'allow'
      ? (verdict.severity === 'high' || verdict.severity === 'medium' ? 'needs_review' : 'low_confidence')
      : null
    const grounding = verdict?.grounding_score ?? null

    // Lineage index for LineagePanel (no LLM); empty when sources lack `id` fields.
    let lineage = null
    if (Array.isArray(sources) && sources.length > 0) {
      try { lineage = buildLineage(content, sources) }
      catch (e) { console.warn('[saved-reports] lineage build failed:', e.message) }
    }

    const result = await orgQuery(orgId,
      `INSERT INTO saved_reports
         (org_id, created_by, title, content, report_count, filters,
          quality_flag, grounding_score, lineage,
          subject_employee_ids, subject_employee_names, generated_by_name, report_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, created_at`,
      [orgId, userId, title, content, reportCount ?? 0,
       filters ? JSON.stringify(filters) : null, flag, grounding,
       lineage ? JSON.stringify(lineage) : null,
       subjectIds.length ? subjectIds : null,
       subjectNames.length ? subjectNames : null,
       generatedByName, reportKind]
    )
    const savedId = result.rows[0].id

    if (verdict && verdict.action !== 'allow') {
      recordVerdict(verdict, { table: 'saved_reports', id: savedId }, {
        orgId, userId, userName: req.user.name, cid: req.cid,
      }).catch(() => {})
    }

    res.json({
      success: true,
      id: savedId,
      createdAt: result.rows[0].created_at,
      quality_flag: flag,
      grounding_score: grounding,
      suspicious: verdict?.suspicious || [],
      subject_employee_ids:   subjectIds,
      subject_employee_names: subjectNames,
      generated_by_name:      generatedByName,
      report_kind:            reportKind,
    })
  } catch (err) {
    console.error('[saved-reports] save error:', err)
    res.status(500).json({ error: 'Failed to save report' })
  }
})

// ── GET /api/saved-reports ─────────────────────────────────────────────
// Optional ?subject=<uuid> filters to reports where this user is a subject.
// Optional ?kind=self|for_other|team filters by report_kind.
router.get('/saved-reports', async (req, res) => {
  const orgId = req.user.orgId
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const subject = req.query.subject ? String(req.query.subject) : null
  const kind    = req.query.kind    ? String(req.query.kind)    : null

  try {
    const clauses = ['org_id = $1']
    const params  = [orgId]
    if (subject) {
      params.push(subject)
      clauses.push(`$${params.length}::uuid = ANY(subject_employee_ids)`)
    }
    if (kind && ['self', 'for_other', 'team'].includes(kind)) {
      params.push(kind)
      clauses.push(`report_kind = $${params.length}`)
    }
    params.push(limit)

    const result = await orgQuery(orgId,
      `SELECT id, title, report_count, filters, created_by, created_at,
              subject_employee_ids, subject_employee_names,
              generated_by_name, report_kind, quality_flag, grounding_score
       FROM saved_reports
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    )
    res.json({ reports: result.rows })
  } catch (err) {
    console.error('[saved-reports] list error:', err)
    res.status(500).json({ error: 'Failed to list saved reports' })
  }
})

// ── GET /api/saved-reports/:id/lineage?claim=… ────────────────────────
// Resolves a single claim (number or entity) back to the daily_reports rows
// that contributed to it. Reads the precomputed saved_reports.lineage JSONB.
router.get('/saved-reports/:id/lineage', async (req, res) => {
  const pool = getPool()
  const orgId = req.user.orgId
  const claim = String(req.query.claim || '').trim()
  if (!claim) return res.status(400).json({ error: 'claim query param required' })

  try {
    const { rows } = await pool.query(
      `SELECT lineage FROM saved_reports WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const lineage = rows[0].lineage || { numbers: [], entities: [], source_count: 0 }
    const sourceIds = resolveClaim(lineage, claim)
    if (!sourceIds.length) {
      return res.json({ claim, rows: [], hint: 'No source rows matched this claim — may be an aggregate or inferred figure.' })
    }
    // Fetch the underlying daily_reports rows (limit 100 to bound response size)
    const { rows: drRows } = await pool.query(
      `SELECT d.id, d.report_date, u.name AS submitted_by_name,
              d.location, d.project, d.beneficiaries, d.description, d.attachment_url
         FROM daily_reports d
         LEFT JOIN users u ON u.id = d.submitted_by
        WHERE d.org_id = $1 AND d.id = ANY($2::uuid[])
        ORDER BY d.report_date DESC
        LIMIT 100`,
      [orgId, sourceIds]
    )
    res.json({ claim, rows: drRows, source_count: lineage.source_count })
  } catch (err) {
    console.error('[saved-reports lineage] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/saved-reports/:id ─────────────────────────────────────────
router.get('/saved-reports/:id', async (req, res) => {
  const orgId = req.user.orgId

  try {
    const result = await orgQuery(orgId,
      `SELECT id, title, content, report_count, filters, created_by, created_at,
              subject_employee_ids, subject_employee_names,
              generated_by_name, report_kind, quality_flag, grounding_score
       FROM saved_reports
       WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (err) {
    console.error('[saved-reports] get error:', err)
    res.status(500).json({ error: 'Failed to get report' })
  }
})

// ── DELETE /api/saved-reports/:id ─────────────────────────────────────
router.delete('/saved-reports/:id', async (req, res) => {
  const orgId    = req.user.orgId
  const isElevated = ['admin', 'manager', 'superadmin'].includes(req.user.role)

  try {
    const params = isElevated
      ? [req.params.id, orgId]
      : [req.params.id, orgId, req.user.uid]

    const result = await orgQuery(orgId,
      isElevated
        ? `DELETE FROM saved_reports WHERE id = $1 AND org_id = $2 RETURNING id`
        : `DELETE FROM saved_reports WHERE id = $1 AND org_id = $2 AND created_by = $3 RETURNING id`,
      params
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found or not permitted' })
    res.json({ success: true })
  } catch (err) {
    console.error('[saved-reports] delete error:', err)
    res.status(500).json({ error: 'Failed to delete report' })
  }
})

export default router
