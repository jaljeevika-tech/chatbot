// routes/performance.routes.js — Performance Review REST surface
//
// GET    /api/performance/reviews                       list reviews visible to me
// POST   /api/performance/reviews/draft                 generate AI draft + persist
// GET    /api/performance/reviews/:id                   full review payload (visibility-gated)
// PATCH  /api/performance/reviews/:id                   manager edits scores/notes (recomputes weighted)
// POST   /api/performance/reviews/:id/finalise          reviewer signs off
// POST   /api/performance/reviews/:id/acknowledge       employee acknowledges
// GET    /api/performance/reviews/:id/export.docx       DOCX download
// POST   /api/performance/action-items/:id/status       toggle action item status

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { scoreEmployee, ratingFor } from '../lib/performanceReview/scorer.js'
import { narrateReview } from '../lib/performanceReview/narrator.js'
import { buildReviewDocx } from '../lib/performanceReview/docxBuilder.js'
import { buildReviewPdf  } from '../lib/performanceReview/pdfBuilder.js'
import { currentQuarter, currentFY, resolvePeriod, toSqlDate } from '../lib/dataCorrectness/periodMath.js'
import { getOrgMeta } from '../lib/orgMetaCache.js'

const router = Router()

function requireAuth(req, res, next) {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Auth required' })
  next()
}

// ── Visibility middleware ───────────────────────────────────────────────────
async function _canView(pool, viewer, review) {
  if (!viewer || !review) return false
  if (review.org_id !== viewer.orgId) return false
  if (['admin', 'superadmin'].includes(viewer.role)) return true
  // self via firebase_uid
  const { rows } = await pool.query(
    `SELECT id, firebase_uid, manager_id FROM users WHERE id = $1`,
    [review.employee_id]
  )
  const emp = rows[0]
  if (!emp) return false
  if (emp.firebase_uid === viewer.uid) return true
  // assigned reviewer
  if (review.reviewer_id) {
    const { rows: rv } = await pool.query(
      `SELECT firebase_uid FROM users WHERE id = $1`, [review.reviewer_id]
    )
    if (rv[0]?.firebase_uid === viewer.uid) return true
  }
  // direct line manager
  if (emp.manager_id) {
    const { rows: mg } = await pool.query(
      `SELECT firebase_uid FROM users WHERE id = $1`, [emp.manager_id]
    )
    if (mg[0]?.firebase_uid === viewer.uid) return true
  }
  return false
}

// ── Period resolution ───────────────────────────────────────────────────────
// Window bounds are local-midnight Dates; toISOString() would shift them a
// day back on any non-UTC host, so format from local fields.
const ymd = d => toSqlDate(d).slice(0, 10)

async function _resolvePeriodWindow(orgId, periodSpec) {
  const orgMeta = await getOrgMeta(orgId)
  // periodSpec: 'currentQuarter' | 'currentFY' | 'previousFY' | { start, end, label }
  if (periodSpec && typeof periodSpec === 'object' && periodSpec.start) {
    return {
      start: new Date(periodSpec.start),
      end:   new Date(periodSpec.end),
      label: periodSpec.label || `${periodSpec.start}_${periodSpec.end}`,
    }
  }
  const name = typeof periodSpec === 'string' ? periodSpec : 'currentQuarter'
  if (name === 'currentQuarter') return currentQuarter(orgMeta)
  if (name === 'currentFY')      return currentFY(orgMeta)
  return resolvePeriod(name, orgMeta)
}

// ── GET /api/performance/reviews ────────────────────────────────────────────
router.get('/performance/reviews', requireAuth, async (req, res) => {
  const pool = getPool()
  const role = req.user.role
  try {
    // Resolve viewer's user row to scope correctly
    const { rows: vRows } = await pool.query(
      `SELECT id, role, manager_id FROM users WHERE firebase_uid = $1 AND org_id = $2`,
      [req.user.uid, req.user.orgId]
    )
    const viewer = vRows[0]
    if (!viewer) return res.json({ reviews: [] })

    let where, params
    if (role === 'admin' || role === 'superadmin') {
      // pr.-qualified: the users join below also has org_id (ambiguous otherwise)
      where = `pr.org_id = $1`
      params = [req.user.orgId]
    } else if (role === 'manager') {
      // Reviews of direct reports OR self
      where = `pr.org_id = $1 AND (
        pr.employee_id = $2
        OR pr.employee_id IN (SELECT id FROM users WHERE manager_id = $2 AND org_id = $1)
      )`
      params = [req.user.orgId, viewer.id]
    } else {
      // Employee — self only
      where = `pr.org_id = $1 AND pr.employee_id = $2`
      params = [req.user.orgId, viewer.id]
    }

    const { rows } = await pool.query(
      `SELECT pr.id, pr.employee_id, u.name AS employee_name, u.role AS employee_role,
              pr.reviewer_id, ru.name AS reviewer_name,
              pr.period_label, pr.period_start, pr.period_end,
              pr.status, pr.final_rating,
              (pr.final_scores->>'final')::numeric AS final_score,
              (pr.ai_draft->'weighted'->>'final')::numeric AS ai_score,
              pr.employee_ack, pr.created_at, pr.finalised_at
         FROM performance_reviews pr
         JOIN users u ON u.id = pr.employee_id
         LEFT JOIN users ru ON ru.id = pr.reviewer_id
        WHERE ${where}
        ORDER BY pr.period_end DESC, u.name
        LIMIT 200`,
      params
    )
    res.json({ reviews: rows })
  } catch (e) {
    console.warn('[performance] list error:', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/reviews/draft ─────────────────────────────────────
router.post('/performance/reviews/draft', requireAuth, async (req, res) => {
  // Role check before any write, so employees can't trigger the auto-register INSERT below.
  if (!['admin', 'superadmin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager role required to draft reviews' })
  }
  const { employee_id: empIdRaw, employee_phone, employee_name, period = 'currentQuarter' } = req.body || {}
  let employee_id = empIdRaw
  if (!employee_id && employee_phone) {
    const pool = getPool()
    const last10 = String(employee_phone).replace(/\D/g, '').slice(-10)
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE org_id = $1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2 LIMIT 1`,
      [req.user.orgId, last10]
    ).catch(() => ({ rows: [] }))
    employee_id = rows[0]?.id
    // Auto-register field worker not yet in DB (WhatsApp-only workers live in the sheet, not users table)
    if (!employee_id && employee_name) {
      const normPhone = String(employee_phone).replace(/\D/g, '')
      const { rows: ins } = await pool.query(
        `INSERT INTO users (org_id, name, phone, role)
         VALUES ($1, $2, $3, 'employee')
         ON CONFLICT (org_id, phone) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [req.user.orgId, employee_name, normPhone]
      ).catch(() => ({ rows: [] }))
      employee_id = ins[0]?.id
    }
  }
  if (!employee_id) return res.status(400).json({ error: 'employee_id or employee_phone required' })
  const pool = getPool()
  try {
    // Verify employee belongs to this org
    const { rows: empRows } = await pool.query(
      `SELECT id, name, role, manager_id, custom_data FROM users WHERE id = $1 AND org_id = $2`,
      [employee_id, req.user.orgId]
    )
    const employee = empRows[0]
    if (!employee) return res.status(404).json({ error: 'Employee not found' })

    // Manager scope check (admins exempt)
    if (req.user.role === 'manager') {
      const { rows: meRows } = await pool.query(
        `SELECT id FROM users WHERE firebase_uid = $1 AND org_id = $2`,
        [req.user.uid, req.user.orgId]
      )
      const me = meRows[0]
      if (!me || employee.manager_id !== me.id) {
        return res.status(403).json({ error: 'Can only draft reviews for direct reports' })
      }
    }

    const window = await _resolvePeriodWindow(req.user.orgId, period)
    const orgMeta = await getOrgMeta(req.user.orgId)

    // Score + narrate
    const score = await scoreEmployee(pool, {
      orgId: req.user.orgId,
      employeeId: employee_id,
      periodStart: ymd(window.start),
      periodEnd:   ymd(window.end),
      orgMeta,
    })
    const narrative = await narrateReview(score, {
      orgId: req.user.orgId,
      employeeName: employee.name,
    })

    const ai_draft = {
      employee: {
        id: employee.id,
        name: employee.name,
        designation: employee.custom_data?.designation || employee.role,
        department:  employee.custom_data?.department  || '',
        manager_name: '',
      },
      period: {
        label: window.label,
        start: ymd(window.start),
        end:   ymd(window.end),
      },
      ...score,
      ...narrative,
    }

    // Look up reviewer (current user) for default reviewer_id
    const { rows: rvRows } = await pool.query(
      `SELECT id FROM users WHERE firebase_uid = $1 AND org_id = $2`,
      [req.user.uid, req.user.orgId]
    )
    const reviewer_id = rvRows[0]?.id || null

    // Upsert — if a draft for this employee+period already exists, replace it.
    // A review that's moved past 'draft' is left alone (no row comes back).
    const { rows: ins } = await pool.query(
      `INSERT INTO performance_reviews
         (org_id, employee_id, reviewer_id, period_label, period_start, period_end, ai_draft, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')
       ON CONFLICT (org_id, employee_id, period_label)
         DO UPDATE SET
           ai_draft     = EXCLUDED.ai_draft,
           reviewer_id  = COALESCE(performance_reviews.reviewer_id, EXCLUDED.reviewer_id)
         WHERE performance_reviews.status = 'draft'
       RETURNING id, status, created_at`,
      [req.user.orgId, employee_id, reviewer_id, window.label,
       ymd(window.start), ymd(window.end),
       JSON.stringify(ai_draft)]
    )
    if (!ins.length) {
      return res.status(409).json({ error: 'A review for this period is already past draft and cannot be re-drafted' })
    }

    // Seed action items
    if (ai_draft.action_plan?.length) {
      for (const a of ai_draft.action_plan) {
        await pool.query(
          `INSERT INTO performance_action_items (review_id, action, timeline_days, expected_result)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [ins[0].id, a.action, a.timeline_days || 30, a.expected_result || '']
        ).catch(() => {})
      }
    }

    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'performance.draft','performance_reviews',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name || 'unknown',
       ins[0].id, JSON.stringify({ period: window.label, employee_id })]
    ).catch(() => {})

    res.json({ id: ins[0].id, status: ins[0].status, ai_draft })
  } catch (e) {
    console.error('[performance/draft] error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/performance/reviews/:id ────────────────────────────────────────
router.get('/performance/reviews/:id', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, u.name AS employee_name, u.role AS employee_role,
              u.custom_data AS employee_custom,
              mg.name AS manager_name,
              ru.name AS reviewer_name
         FROM performance_reviews pr
         JOIN users u ON u.id = pr.employee_id
         LEFT JOIN users mg ON mg.id = u.manager_id
         LEFT JOIN users ru ON ru.id = pr.reviewer_id
        WHERE pr.id = $1`,
      [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })

    const { rows: items } = await pool.query(
      `SELECT id, action, timeline_days, expected_result, status, created_at, completed_at
         FROM performance_action_items
        WHERE review_id = $1
        ORDER BY created_at`,
      [review.id]
    )
    res.json({ review, action_items: items })
  } catch (e) {
    console.warn('[performance] get error:', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/performance/reviews/:id ─────────────────────────────────────
// Manager edits scores / observations / strengths / improvements / action plan.
// Recomputes weighted from edited KPI/activity/learning rows.
router.patch('/performance/reviews/:id', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT * FROM performance_reviews WHERE id = $1`, [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    if (review.status !== 'draft') {
      return res.status(409).json({ error: 'Cannot edit a non-draft review' })
    }
    if (!['admin', 'superadmin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Manager role required' })
    }

    const { kpis, activities, learning, strengths, improvements,
            risk, risk_notes, recommendation, action_plan, reviewer_notes } = req.body || {}

    // Merge edits onto a copy of ai_draft → final_scores
    const draft = review.ai_draft || {}
    const next = { ...draft }
    if (Array.isArray(kpis))         next.kpis = kpis
    if (Array.isArray(activities))   next.activities = activities
    if (Array.isArray(learning))     next.learning = learning
    if (Array.isArray(strengths))    next.strengths = strengths
    if (Array.isArray(improvements)) next.improvements = improvements
    if (risk)                        next.risk = risk
    if (risk_notes)                  next.risk_notes = risk_notes
    if (typeof recommendation === 'string') next.recommendation = recommendation
    if (Array.isArray(action_plan))  next.action_plan = action_plan

    // Recompute weighted from edited rows
    const kpiAvg5 = next.kpis.length
      ? next.kpis.reduce((s, k) => s + (Number(k.score) || 0), 0) / next.kpis.length
      : 0
    const kpi_score = Math.round(kpiAvg5 * 20)
    const activity_score = next.activities.length
      ? Math.round(next.activities.reduce((s, a) => s + (Number(a.completion_pct) || 0), 0) / next.activities.length)
      : 0
    const learningAvg5 = next.learning.length
      ? next.learning.reduce((s, l) => s + (Number(l.score) || 0), 0) / next.learning.length
      : 0
    const learning_score = Math.round(learningAvg5 * 20)
    // Discipline is the dedicated KPI by name
    const disciplineKpi = next.kpis.find(k => /discipline/i.test(k.area))
    const discipline_score = disciplineKpi ? Math.round(disciplineKpi.score * 20) : draft.weighted?.discipline_score || 0
    const final = Math.round(
      (kpi_score * 0.4 + activity_score * 0.3 + learning_score * 0.2 + discipline_score * 0.1) * 10
    ) / 10
    next.weighted = {
      kpi_score, activity_score, learning_score, discipline_score,
      final, rating: ratingFor(final),
    }

    await pool.query(
      `UPDATE performance_reviews
         SET ai_draft = $1,
             final_scores = $2,
             final_rating = $3,
             reviewer_notes = COALESCE($4, reviewer_notes)
       WHERE id = $5`,
      [JSON.stringify(next), JSON.stringify(next.weighted), next.weighted.rating,
       typeof reviewer_notes === 'string' ? reviewer_notes : null, review.id]
    )
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'performance.edit','performance_reviews',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name || 'unknown', review.id,
       JSON.stringify({ final: next.weighted.final, rating: next.weighted.rating })]
    ).catch(() => {})

    res.json({ ok: true, weighted: next.weighted })
  } catch (e) {
    console.error('[performance/patch] error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/reviews/:id/finalise ─────────────────────────────
router.post('/performance/reviews/:id/finalise', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { final_decision } = req.body || {}
    const { rows } = await pool.query(
      `SELECT * FROM performance_reviews WHERE id = $1`, [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    if (review.status !== 'draft') {
      return res.status(409).json({ error: `Cannot finalise — current status: ${review.status}` })
    }
    if (!['admin', 'superadmin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Manager role required' })
    }

    const { rows: rvRows } = await pool.query(
      `SELECT id FROM users WHERE firebase_uid = $1 AND org_id = $2`,
      [req.user.uid, req.user.orgId]
    )
    const reviewer_id = rvRows[0]?.id || review.reviewer_id

    await pool.query(
      `UPDATE performance_reviews
         SET status = 'finalised',
             reviewer_id = $1,
             final_decision = COALESCE($2, final_decision),
             finalised_at = NOW()
       WHERE id = $3`,
      [reviewer_id, typeof final_decision === 'string' ? final_decision : null, review.id]
    )
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'performance.finalise','performance_reviews',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name || 'unknown', review.id,
       JSON.stringify({ final_decision: final_decision || null })]
    ).catch(() => {})
    res.json({ ok: true, status: 'finalised' })
  } catch (e) {
    console.error('[performance/finalise]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/reviews/:id/acknowledge ──────────────────────────
router.post('/performance/reviews/:id/acknowledge', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT * FROM performance_reviews WHERE id = $1`, [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    // Visibility check before the status check, so other orgs can't probe a review id via 404/409.
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })
    if (review.status !== 'finalised') {
      return res.status(409).json({ error: 'Review must be finalised first' })
    }
    // Only employee themselves can acknowledge
    const { rows: emp } = await pool.query(
      `SELECT firebase_uid FROM users WHERE id = $1`, [review.employee_id]
    )
    if (emp[0]?.firebase_uid !== req.user.uid) {
      return res.status(403).json({ error: 'Only the employee can acknowledge their review' })
    }
    await pool.query(
      `UPDATE performance_reviews
         SET status = 'acknowledged', employee_ack = true, employee_ack_at = NOW()
       WHERE id = $1`,
      [review.id]
    )
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'performance.acknowledge','performance_reviews',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name || 'unknown', review.id, JSON.stringify({})]
    ).catch(() => {})
    res.json({ ok: true, status: 'acknowledged' })
  } catch (e) {
    console.error('[performance/acknowledge]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/reviews/:id/export.docx ──────────────────────────
router.post('/performance/reviews/:id/export.docx', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, u.name AS employee_name, u.role AS employee_role,
              mg.name AS manager_name, ru.name AS reviewer_name
         FROM performance_reviews pr
         JOIN users u ON u.id = pr.employee_id
         LEFT JOIN users mg ON mg.id = u.manager_id
         LEFT JOIN users ru ON ru.id = pr.reviewer_id
        WHERE pr.id = $1`,
      [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })

    const { worker_stats = null, ai_analysis = '' } = req.body || {}

    // Merge ai_draft with any manager-edited fields (final_scores wins for weighted)
    const draft = review.ai_draft || {}
    const payload = {
      ...draft,
      employee: { ...(draft.employee || {}), name: review.employee_name, manager_name: review.manager_name },
      weighted: review.final_scores || draft.weighted,
      final_decision: review.final_decision,
      worker_stats,
      ai_analysis,
    }
    const buffer = await buildReviewDocx(payload)
    const safeName = String(review.employee_name || 'review').replace(/[^a-zA-Z0-9_-]/g, '_')
    const fileName = `${safeName}_${review.period_label}.docx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.send(buffer)
  } catch (e) {
    console.error('[performance/export.docx]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/reviews/:id/export.pdf ───────────────────────────
router.post('/performance/reviews/:id/export.pdf', requireAuth, async (req, res) => {
  const pool = getPool()
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, u.name AS employee_name, u.role AS employee_role,
              mg.name AS manager_name, ru.name AS reviewer_name
         FROM performance_reviews pr
         JOIN users u ON u.id = pr.employee_id
         LEFT JOIN users mg ON mg.id = u.manager_id
         LEFT JOIN users ru ON ru.id = pr.reviewer_id
        WHERE pr.id = $1`,
      [req.params.id]
    )
    const review = rows[0]
    if (!review) return res.status(404).json({ error: 'Not found' })
    const ok = await _canView(pool, req.user, review)
    if (!ok) return res.status(404).json({ error: 'Not found' })

    const { worker_stats = null, ai_analysis = '' } = req.body || {}

    const draft = review.ai_draft || {}
    const payload = {
      ...draft,
      employee: { ...(draft.employee || {}), name: review.employee_name, manager_name: review.manager_name },
      weighted: review.final_scores || draft.weighted,
      final_decision: review.final_decision,
      worker_stats,
      ai_analysis,
    }
    const buffer = await buildReviewPdf(payload)
    const safeName = String(review.employee_name || 'review').replace(/[^a-zA-Z0-9_-]/g, '_')
    const fileName = `${safeName}_${review.period_label}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.send(buffer)
  } catch (e) {
    console.error('[performance/export.pdf]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/action-items/:id/status ──────────────────────────
router.post('/performance/action-items/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body || {}
  if (!['open', 'in_progress', 'done'].includes(status)) {
    return res.status(400).json({ error: 'status must be open|in_progress|done' })
  }
  const pool = getPool()
  try {
    const { rows: itemRows } = await pool.query(
      `SELECT ai.*, pr.org_id
         FROM performance_action_items ai
         JOIN performance_reviews pr ON pr.id = ai.review_id
        WHERE ai.id = $1`,
      [req.params.id]
    )
    const item = itemRows[0]
    if (!item) return res.status(404).json({ error: 'Not found' })
    if (item.org_id !== req.user.orgId) return res.status(404).json({ error: 'Not found' })

    // Same visibility rule as the parent review (self / reviewer / line manager / admin).
    const { rows: reviewRows } = await pool.query(
      `SELECT * FROM performance_reviews WHERE id = $1`, [item.review_id]
    )
    const canAct = await _canView(pool, req.user, reviewRows[0])
    if (!canAct) return res.status(403).json({ error: 'Not authorized to update this action item' })

    await pool.query(
      `UPDATE performance_action_items
         SET status = $1,
             completed_at = CASE WHEN $1 = 'done' THEN NOW() ELSE completed_at END
       WHERE id = $2`,
      [status, item.id]
    )
    res.json({ ok: true, status })
  } catch (e) {
    console.error('[performance/action-item status]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/performance/scorecard (no DB write — fast structured scores) ──
router.post('/performance/scorecard', requireAuth, async (req, res) => {
  if (!['admin', 'superadmin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager role required' })
  }
  const { employee_id: empIdRaw, employee_phone, employee_name, period = 'currentQuarter' } = req.body || {}
  let employee_id = empIdRaw
  if (!employee_id && employee_phone) {
    const pool = getPool()
    const last10 = String(employee_phone).replace(/\D/g, '').slice(-10)
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE org_id = $1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2 LIMIT 1`,
      [req.user.orgId, last10]
    ).catch(() => ({ rows: [] }))
    employee_id = rows[0]?.id
    if (!employee_id && employee_name) {
      const normPhone = String(employee_phone).replace(/\D/g, '')
      const { rows: ins } = await pool.query(
        `INSERT INTO users (org_id, name, phone, role)
         VALUES ($1, $2, $3, 'employee')
         ON CONFLICT (org_id, phone) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [req.user.orgId, employee_name, normPhone]
      ).catch(() => ({ rows: [] }))
      employee_id = ins[0]?.id
    }
  }
  if (!employee_id) return res.status(400).json({ error: 'employee_id or employee_phone required' })

  const pool = getPool()
  try {
    const { rows: empRows } = await pool.query(
      `SELECT id, name, manager_id FROM users WHERE id = $1 AND org_id = $2`,
      [employee_id, req.user.orgId]
    )
    const employee = empRows[0]
    if (!employee) return res.status(404).json({ error: 'Employee not found' })

    if (req.user.role === 'manager') {
      const { rows: meRows } = await pool.query(
        `SELECT id FROM users WHERE firebase_uid = $1 AND org_id = $2`,
        [req.user.uid, req.user.orgId]
      )
      const me = meRows[0]
      if (!me || employee.manager_id !== me.id) {
        return res.status(403).json({ error: 'Can only view scorecard for direct reports' })
      }
    }

    const window = await _resolvePeriodWindow(req.user.orgId, period)
    const orgMeta = await getOrgMeta(req.user.orgId)
    const score = await scoreEmployee(pool, {
      orgId: req.user.orgId,
      employeeId: employee_id,
      periodStart: ymd(window.start),
      periodEnd:   ymd(window.end),
      orgMeta,
    })

    res.json({
      employee: { id: employee.id, name: employee.name },
      period:   { label: window.label, start: ymd(window.start), end: ymd(window.end) },
      weighted:   score.weighted,
      kpis:       score.kpis,
      activities: score.activities,
      learning:   score.learning,
      trend:      score.trend,
    })
  } catch (e) {
    console.error('[performance/scorecard] error:', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
