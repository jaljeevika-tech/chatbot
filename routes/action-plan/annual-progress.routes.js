// Annual Progress Report: portfolio snapshot, Excel template, upload/read/delete,
// AI categorisation, latest/months/trend views and single-cell edits.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { requireEditor, requireAdmin } from '../../lib/routeGuards.js'
import { runAI } from '../../lib/ai/runAI.js'
import { AP_MONTHS, resolveProjectKey } from './helpers.js'

const router = Router()

// GET /api/action-plans/:id/portfolio-snapshot — headline figure from each tab
// (Beneficiaries / Finance Tracker / Annual Progress) by project_key. A figure is
// null when its source has no data yet, as opposed to a real zero.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/portfolio-snapshot', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })
    const pool = getPool()

    const { rows: [benf] } = await pool.query(
      `SELECT count(*)::int AS total, sum(income_realised)::float8 AS income_sum
       FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )

    const { rows: apPeriods } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    let apAchievementPct = null
    if (apPeriods.length) {
      const latest = apPeriods.sort((a, b) => (b.fy_start_year * 12 + AP_MONTHS.indexOf(b.month)) - (a.fy_start_year * 12 + AP_MONTHS.indexOf(a.month)))[0]
      const { rows: [apAgg] } = await pool.query(
        `SELECT coalesce(sum(target), 0)::float8 AS target_sum, coalesce(sum(achievement_total), 0)::float8 AS achievement_sum
         FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
        [req.user.orgId, projectKey, latest.fy_start_year, latest.month]
      )
      apAchievementPct = apAgg.target_sum > 0 ? Math.round((apAgg.achievement_sum / apAgg.target_sum) * 100) : null
    }

    // Utilisation is cumulative SUM(expenses) over all uploaded months
    // (033_budget_utilisation_v2.sql) against the headline action_plans.budget.
    const { rows: [buLatest] } = await pool.query(
      `SELECT MAX(period_month)::text AS period_month FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    let buUtilisedPct = null
    if (buLatest?.period_month) {
      const { rows: [buAgg] } = await pool.query(
        `SELECT COALESCE((SELECT budget FROM action_plans WHERE id = $3 AND org_id = $1), 0)::float8 AS budget_sum,
                COALESCE(SUM(expenses), 0)::float8 AS expenses_sum
         FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2`,
        [req.user.orgId, projectKey, req.params.id]
      )
      buUtilisedPct = buAgg.budget_sum > 0 ? Math.round((buAgg.expenses_sum / buAgg.budget_sum) * 100) : null
    }

    res.json({
      beneficiaryCount: benf.total > 0 ? benf.total : null,
      incomeRealisedSum: benf.total > 0 ? (benf.income_sum || 0) : null,
      apAchievementPct,
      buUtilisedPct,
    })
  } catch (e) {
    console.error('[action-plans/:id/portfolio-snapshot GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/annual-progress-template.xlsx — blank template in the layout
// UploadAnnualProgressModal.tsx parses (header text must be exactly "Achievement";
// per-location column names go in the row below the header).
router.get('/action-plans/annual-progress-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    const LOCS = ['Khagaria', 'Alauli', 'Bhaptiyahi']
    const h1 = ['S.N.', 'Activity/Deliverables', 'Target', 'Achievement', '', '', '', 'Related Link', 'Remark']
    const h2 = ['', '', '', 'Total', ...LOCS, '', '']

    const rows = [h1, h2]
    rows.push([1, 'Survey software/Tools subscription', 300, 180, 60, 60, 60, 'https://example.org/evidence-1', 'On track'])
    rows.push([2, '2-day training for farmers', 120, 90, 30, 30, 30, 'https://example.org/evidence-2', ''])
    rows.push([3, 'Pond/chaur/maun listing', 50, 20, 10, 5, 5, '', 'Behind schedule'])

    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 6 }, { wch: 32 }, { wch: 10 }, { wch: 10 }, ...LOCS.map(() => ({ wch: 12 })), { wch: 28 }, { wch: 20 }]
    ws['!merges'] = [
      { s: { r: 0, c: 3 }, e: { r: 0, c: 3 + LOCS.length } }, // "Achievement" spans Total + per-location cols
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Annual Progress')

    const readme = [
      ['Annual Progress Report — Upload Template'],
      [''],
      ['Row 1 is the main header, Row 2 is a sub-header (only needed under "Achievement").'],
      [''],
      ['  S.N.                — sequential activity number'],
      ['  Activity/Deliverables — activity name (this, not S.N., is the row identity — reordering rows is safe)'],
      ['  Target              — planned target for the year'],
      ['  Achievement          — cumulative achievement so far; sub-header "Total"'],
      ['  (columns after Achievement, before Related Link) — one per location; name each in the row below the header'],
      ['  Related Link        — link to evidence (photo, doc, etc.), optional'],
      ['  Remark               — free-text note, optional'],
      [''],
      ['Add/remove location columns as needed between "Achievement" and "Related Link".'],
      ['The Financial Year and Month this snapshot is "as of" are picked in the upload dialog, not read from the file.'],
    ]
    const wsReadme = XLSX.utils.aoa_to_sheet(readme)
    wsReadme['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, wsReadme, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="annual-progress-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[annual-progress template]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/annual-progress — upload/update one FY+month snapshot.
// Body: { fy_start_year: 2026, month: 'Jun', rows: [{ sn, activity, target, achievement_total, locations: {loc: val}, related_link, remark }] }
router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { fy_start_year, month, rows } = req.body || {}
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // activity_name is the identity (the sheet's S.N. is usually blank);
      // activity_sn is just upload position, for display.
      let position = 0
      for (const r of rows) {
        position += 1
        const activityName = String(r.activity || '').trim()
        if (!activityName) continue
        const sn = Number.isInteger(r.sn) ? r.sn : position
        await client.query(
          `INSERT INTO annual_progress_reports
             (org_id, project_key, fy_start_year, month, activity_sn, activity_name, target, achievement_total, locations, related_link, remark, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (org_id, project_key, fy_start_year, month, activity_name)
             DO UPDATE SET activity_sn = $5, target = $7, achievement_total = $8,
                           locations = $9, related_link = $10, remark = $11,
                           uploaded_by = $12, updated_at = NOW()`,
          [
            req.user.orgId, projectKey, fy_start_year, month, sn,
            activityName, r.target ?? null, r.achievement_total ?? null,
            JSON.stringify(r.locations || {}), r.related_link || null, r.remark || null,
            req.user.name || 'unknown',
          ]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.upload','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, fy_start_year, month, activity_count: rows.length })]
    ).catch(() => {})

    res.json({ ok: true, fy_start_year, month, count: rows.length })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress?fy_start_year=2026&month=Jun
// Without month, returns the latest month with data in Apr-first fiscal order.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    let month = req.query.month
    if (!month) {
      const { rows: monthRows } = await pool.query(
        `SELECT DISTINCT month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3`,
        [req.user.orgId, projectKey, fy_start_year]
      )
      const available = monthRows.map(r => r.month).sort((a, b) => AP_MONTHS.indexOf(b) - AP_MONTHS.indexOf(a))
      month = available[0]
      if (!month) return res.json({ month: null, rows: [] })
    }

    const { rows } = await pool.query(
      `SELECT activity_sn AS sn, activity_name AS activity, category,
              target::float8 AS target, achievement_total::float8 AS achievement_total,
              locations, related_link, remark, updated_at
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_sn`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    res.json({ month, rows })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/action-plans/:id/annual-progress?fy_start_year=2026&month=Jun
// Admin-only: drops every row of one FY+month snapshot (e.g. a bad upload) with no undo.
router.delete('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    const month = req.query.month
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!rowCount) return res.status(404).json({ error: 'No snapshot found for that Financial Year + Month' })

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.delete','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, fy_start_year, month, activity_count: rowCount })]
    ).catch(() => {})

    res.json({ ok: true, deleted: rowCount })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress DELETE]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/action-plans/:id/annual-progress/categorize — AI-assign a category to
// each activity (the template has no category column). One batched Gemini call;
// the category is applied to every row with that activity_name across all months,
// since it depends on the wording, not the numbers.
const AP_CATEGORIES = [
  'Training', 'Exposure Visit', 'Community Mobilization', 'Enterprise & Livelihood',
  'Infrastructure', 'Financial Literacy', 'Livestock & Animal Husbandry',
  'Knowledge & Content', 'Other',
]
router.post('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/categorize', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.body?.fy_start_year)
    const month = req.body?.month
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: activities } = await pool.query(
      `SELECT DISTINCT activity_name FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_name`,
      [req.user.orgId, projectKey, fy_start_year, month]
    )
    if (!activities.length) return res.status(404).json({ error: 'No activities found for this snapshot' })

    const systemPrompt =
      `You categorize NGO field-project activity descriptions into exactly one of these categories: ` +
      `${AP_CATEGORIES.join(', ')}. Respond with strict JSON only: ` +
      `{"categories": [{"activity": "<exact activity text>", "category": "<one of the categories>"}]}. ` +
      `Include every activity given, in the same order. If none fit well, use "Other".`
    const userPrompt = JSON.stringify({ activities: activities.map(a => a.activity_name) })

    const out = await runAI({
      feature: 'annual_progress',
      operation: 'categorize_activities',
      prompt: userPrompt,
      systemPrompt,
      orgId: req.user.orgId,
      userId: req.user.uid,
    }, { jsonMode: true, maxTokens: 2048, temperature: 0.2 })

    const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
    const items = Array.isArray(parsed?.categories) ? parsed.categories : null
    if (!items) return res.status(502).json({ error: 'AI categorization unavailable — try again shortly', fallbackReason: out?.fallbackReason })

    const categoryFor = new Map()
    for (const item of items) {
      const name = String(item?.activity || '').trim()
      const cat = AP_CATEGORIES.includes(item?.category) ? item.category : 'Other'
      if (name) categoryFor.set(name, cat)
    }

    const client = await pool.connect()
    let updated = 0
    try {
      await client.query('BEGIN')
      for (const [name, cat] of categoryFor) {
        const r = await client.query(
          `UPDATE annual_progress_reports SET category = $1
           WHERE org_id = $2 AND project_key = $3 AND activity_name = $4`,
          [cat, req.user.orgId, projectKey, name]
        )
        updated += r.rowCount
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({ categories: Object.fromEntries(categoryFor), rowsUpdated: updated })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/categorize POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/latest — most recent snapshot across any
// FY, for the Project Report's "Verified Totals" fallback when its own FY has no upload.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/latest', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: periods } = await pool.query(
      `SELECT DISTINCT fy_start_year, month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2`,
      [req.user.orgId, projectKey]
    )
    if (!periods.length) return res.json({ fy_start_year: null, month: null, rows: [] })

    const latest = periods.sort((a, b) => (b.fy_start_year * 12 + AP_MONTHS.indexOf(b.month)) - (a.fy_start_year * 12 + AP_MONTHS.indexOf(a.month)))[0]
    const { rows } = await pool.query(
      `SELECT activity_sn AS sn, activity_name AS activity, category,
              target::float8 AS target, achievement_total::float8 AS achievement_total,
              locations, related_link, remark, updated_at
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4
       ORDER BY activity_sn`,
      [req.user.orgId, projectKey, latest.fy_start_year, latest.month]
    )
    res.json({ fy_start_year: latest.fy_start_year, month: latest.month, rows })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/latest GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/months?fy_start_year=2026 — which
// months have a snapshot, so the dashboard's month picker only shows real options.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/months', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const { rows } = await getPool().query(
      `SELECT DISTINCT month FROM annual_progress_reports WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3`,
      [req.user.orgId, projectKey, fy_start_year]
    )
    const months = rows.map(r => r.month).sort((a, b) => AP_MONTHS.indexOf(a) - AP_MONTHS.indexOf(b))
    res.json({ months })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/months GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/action-plans/:id/annual-progress/trend?fy_start_year=2026
// Rows are already cumulative, so this is a per-month SUM (not a running total),
// plus a deterministic year-end projection like budget-utilisation's /trend.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/trend', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const fy_start_year = parseInt(req.query.fy_start_year)
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const { rows } = await getPool().query(
      `SELECT month, coalesce(sum(target), 0)::float8 AS target_sum, coalesce(sum(achievement_total), 0)::float8 AS achievement_sum
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3
       GROUP BY month`,
      [req.user.orgId, projectKey, fy_start_year]
    )
    const trend = rows
      .map(r => ({ month: r.month, target_sum: r.target_sum, achievement_sum: r.achievement_sum }))
      .sort((a, b) => AP_MONTHS.indexOf(a.month) - AP_MONTHS.indexOf(b.month))

    if (!trend.length) return res.json({ trend: [], projectedYearEnd: null, pace: 'unknown', elapsedPct: 0 })

    const latest = trend[trend.length - 1]
    const elapsedMonths = AP_MONTHS.indexOf(latest.month) + 1
    const elapsedPct = Math.round((elapsedMonths / 12) * 100)
    const projectedYearEnd = (latest.achievement_sum / elapsedMonths) * 12
    const achievedPct = latest.target_sum > 0 ? Math.round((latest.achievement_sum / latest.target_sum) * 100) : null
    const gap = achievedPct != null ? achievedPct - elapsedPct : null
    const pace = gap == null ? 'unknown' : gap > 20 ? 'ahead' : gap < -20 ? 'behind' : 'on_track'

    res.json({ trend, projectedYearEnd, pace, elapsedPct, achievedPct })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/trend GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/action-plans/:id/annual-progress/cell — admin-only correction of one
// activity's Target/Achievement without re-uploading (it bypasses the sheet as source of truth).
// Body: { fy_start_year, month, activity_name, target?, achievement_total? }; omitted fields are kept.
router.put('/action-plans/:id([0-9a-fA-F-]{36})/annual-progress/cell', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { fy_start_year, month, activity_name, target, achievement_total } = req.body || {}
    if (!Number.isInteger(fy_start_year)) return res.status(400).json({ error: 'fy_start_year (int) required' })
    if (!AP_MONTHS.includes(month)) return res.status(400).json({ error: `month must be one of ${AP_MONTHS.join(', ')}` })
    if (!activity_name) return res.status(400).json({ error: 'activity_name required' })

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: prev } = await pool.query(
      `SELECT target::float8 AS target, achievement_total::float8 AS achievement_total
       FROM annual_progress_reports
       WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3 AND month = $4 AND activity_name = $5`,
      [req.user.orgId, projectKey, fy_start_year, month, activity_name]
    )
    if (!prev[0]) return res.status(404).json({ error: 'Activity not found in this snapshot' })

    const { rows } = await pool.query(
      `UPDATE annual_progress_reports
       SET target = COALESCE($1, target), achievement_total = COALESCE($2, achievement_total), updated_at = NOW()
       WHERE org_id = $3 AND project_key = $4 AND fy_start_year = $5 AND month = $6 AND activity_name = $7
       RETURNING target::float8 AS target, achievement_total::float8 AS achievement_total`,
      [target ?? null, achievement_total ?? null, req.user.orgId, projectKey, fy_start_year, month, activity_name]
    )

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'annual_progress.cell_edit','annual_progress_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({
        activity_name, fy_start_year, month,
        target: target !== undefined ? { before: prev[0].target, after: rows[0].target } : undefined,
        achievement_total: achievement_total !== undefined ? { before: prev[0].achievement_total, after: rows[0].achievement_total } : undefined,
      })]
    ).catch(() => {})

    res.json({ ok: true, target: rows[0].target, achievement_total: rows[0].achievement_total })
  } catch (e) {
    console.error('[action-plans/:id/annual-progress/cell PUT]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
