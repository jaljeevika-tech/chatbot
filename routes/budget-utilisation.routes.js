// routes/budget-utilisation.routes.js
// Budget Utilisation ("Financial Tracker"): Section > Subsection > Line item,
// one row per calendar month holding that month's own (non-cumulative) spend.
//
//   GET    /api/action-plans/budget-utilisation-template.xlsx    — blank template, trailing 12 months
//   POST   /api/action-plans/:id/budget-utilisation              — upload/update (adds new months, never blanks existing ones)
//   GET    /api/action-plans/:id/budget-utilisation               — full multi-month series
//   DELETE /api/action-plans/:id/budget-utilisation               — admin-only, clears one month or one FY
//   GET    /api/action-plans/:id/budget-utilisation/trend         — spend per month
//   PUT    /api/action-plans/:id/budget-utilisation/cell          — admin-only manual correction
//   POST   /api/action-plans/:id/budget-utilisation/insights      — AI narrative + anomaly flags, as-of any month
//   POST   /api/action-plans/:id/budget-utilisation/categorize    — AI-classify line items into a fixed spend taxonomy

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { runAI } from '../lib/ai/runAI.js'

const router = Router()

async function resolveProjectKey(id, orgId) {
  const { rows } = await getPool().query(
    `SELECT project_key FROM action_plans WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  )
  return rows[0]?.project_key || null
}

// Apr–Mar Financial Year; must match fyOfMonth()/fyLabel() in BudgetUtilisationPage.tsx.
// FY "2025-26" is fy_start_year = 2025.
function fyStartYearOfMonth(periodMonthStr) {
  const [y, m] = periodMonthStr.split('-').map(Number)
  return m >= 4 ? y : y - 1
}
// [start, end) as 'YYYY-MM-DD' strings — DATE-comparable, end exclusive.
function fyBounds(fyStartYear) {
  return { start: `${fyStartYear}-04-01`, end: `${fyStartYear + 1}-04-01` }
}

// Keeps action_plans.budget (the lifetime figure other views read) equal to
// SUM of this project's per-FY grants. Call after every write to fy_grants.
async function resyncFyTotal(db, orgId, projectKey, planId) {
  const { rows: [sum] } = await db.query(
    `SELECT COALESCE(SUM(total_budget), 0)::float8 AS total FROM budget_utilisation_fy_grants
     WHERE org_id = $1 AND project_key = $2`,
    [orgId, projectKey]
  )
  await db.query(
    `UPDATE action_plans SET budget = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
    [sum.total, planId, orgId]
  )
}

// Resyncs the budget_heads cache to cumulative spend per section. Uses each line
// item's latest budget, not a sum across months (that would multiply it).
// `db` may be the pool or a transaction client.
async function resyncBudgetHeads(db, orgId, projectKey) {
  const { rows } = await db.query(
    `SELECT section,
            SUM(budget)::float8 AS budget_sum,
            SUM(expenses)::float8 AS expenses_sum
     FROM (
       SELECT DISTINCT ON (section, budget_head) section, budget_head, budget
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2
       ORDER BY section, budget_head, period_month DESC
     ) latest_budget
     JOIN (
       SELECT section, budget_head, SUM(expenses) AS expenses
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2
       GROUP BY section, budget_head
     ) exp_sum USING (section, budget_head)
     GROUP BY section`,
    [orgId, projectKey]
  )
  for (const t of rows) {
    await db.query(
      `INSERT INTO budget_heads (org_id, project_key, head, budget, utilised, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (org_id, project_key, head)
         DO UPDATE SET budget = $4, utilised = $5, updated_at = NOW()`,
      [orgId, projectKey, t.section, t.budget_sum || 0, t.expenses_sum || 0]
    )
  }
  // Sections that lose their last month leave a stale budget_heads row behind.
}

// GET /api/action-plans/budget-utilisation-template.xlsx
// Rolling 12 months ending now, so the template doesn't imply an April start.
// Header cells are real dates so it round-trips through the cellDates:true parser.
router.get('/action-plans/budget-utilisation-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    const now = new Date()
    const monthEnds = []
    for (let i = 11; i >= 0; i--) {
      // Day 0 of month M is the last day of month M-1.
      monthEnds.push(new Date(Date.UTC(now.getFullYear(), now.getMonth() - i + 1, 0)))
    }

    // One Plan + Actual column pair per month (same date in both, told apart by
    // the sub-header row). Actual-only sheets still parse; see UploadBudgetUtilisationModal.tsx.
    const dateHeaderRow = ['Sr No', 'Budget Head', 'Budget Line Item', 'Budget', ...monthEnds.flatMap(d => [d, d])]
    const subHeaderRow = ['', '', '', '', ...monthEnds.flatMap(() => ['Plan', 'Actual'])]
    const rows = [dateHeaderRow, subHeaderRow]

    const sectionRow = (n, name) => rows.push([String(n), name, '', '', ...monthEnds.flatMap(() => ['', ''])])
    // Spend starts at `fromIdx` to model a line item that begins mid-window.
    // `lineItemCode` is a donor's budget-line reference, independent of `sr`.
    const lineItem = (sr, name, lineItemCode, budget, plan, actual, fromIdx = 0) =>
      rows.push([sr, name, lineItemCode, budget, ...monthEnds.flatMap((_, i) => (i >= fromIdx ? [plan, actual] : ['', '']))])
    const subTotal = (budget, plans, actuals) =>
      rows.push(['', 'Sub Total', '', budget, ...plans.flatMap((p, i) => [p, actuals[i]])])

    sectionRow(1, 'PERSONNEL')
    sectionRow('1.1', 'Program')
    lineItem('T1', 'Program Manager', 'BL-101', 600000, 35000, 35000, 5)
    lineItem('T2', 'Field Coordinator', 'BL-102', 400000, 30000, 28000, 5)
    subTotal(1000000, monthEnds.map((_, i) => (i >= 5 ? 65000 : '')), monthEnds.map((_, i) => (i >= 5 ? 63000 : '')))

    sectionRow(2, 'CAPITAL COST')
    sectionRow('2.1', 'Equipment')
    lineItem('T3', 'Laptops & Field Kits', 'BL-201', 200000, 50000, 50000, 0)
    subTotal(200000, monthEnds.map(() => 50000), monthEnds.map(() => 50000))

    rows.push(['', 'Grand Total', '', 1200000,
      ...monthEnds.flatMap((_, i) => (i >= 5 ? [115000, 113000] : [50000, 50000]))])

    const ws = XLSX.utils.aoa_to_sheet(rows)
    // Merge each month's date cell across its Plan+Actual pair.
    ws['!merges'] = monthEnds.map((_, i) => ({
      s: { r: 0, c: 4 + i * 2 }, e: { r: 0, c: 4 + i * 2 + 1 },
    }))
    ws['!cols'] = [{ wch: 10 }, { wch: 32 }, { wch: 16 }, { wch: 14 }, ...monthEnds.flatMap(() => [{ wch: 11 }, { wch: 11 }])]
    XLSX.utils.book_append_sheet(wb, ws, 'Budget Utilisation')

    const readme = [
      ['Budget Utilisation Report — Upload Template'],
      [''],
      ['Columns:'],
      ['  Sr No            — see row types below'],
      ['  Budget Head      — section name / subsection name / line item name'],
      ['  Budget Line Item — optional short code/reference id for a line item row (e.g. a donor\'s own budget-line'],
      ['                     reference number) — independent of Sr No (this sheet\'s own "T1"/"T2" marker) and of'],
      ['                     Budget Head (the name). Leave blank if you don\'t track a separate reference number.'],
      ['  Budget           — this line item\'s allocation for the Financial Year you pick at upload time (see the'],
      ['                     Financial Year field in the upload dialog). Constant across every month in THAT year;'],
      ['                     a multi-year project uploads a separate Budget figure for each year as it begins.'],
      [`  <month columns> — one PLAN + ACTUAL pair per calendar month (see the "Plan"/"Actual" sub-header`],
      [`                     row under each month's date). Plan is that month's own planned/allocated`],
      [`                     spend; Actual is that month's own real expense. Neither is cumulative.`],
      [''],
      ['Row types (identified by Sr No):'],
      ['  "1", "2", "3", ...     — SECTION header (e.g. PERSONNEL, CAPITAL COST, PROGRAM COST, OVERHEAD COST)'],
      ['  "1.1", "1.2", ...      — SUBSECTION header, nested under the section above it'],
      ['  "T1", "T2", ...        — LINE ITEM (any text starting with "T"); Budget Head/Budget + monthly figures required'],
      ['                           (Budget Line Item is optional)'],
      ['  blank Sr No            — "Sub Total" / "Total" / "Grand Total" rows are ignored on upload (recomputed)'],
      [''],
      ['Months are read directly from this sheet\'s own header row (real dates) — a project can start in any'],
      ['calendar month of its Financial Year: leave earlier months blank until spending actually begins there.'],
      ['The Financial Year picked in the upload dialog only tags the Budget/Total Budget figures above — it'],
      ['does not limit which months this sheet can carry.'],
      [''],
      ['Leave Plan blank for a month/line-item you have not planned yet — it will show as "no plan set"'],
      ['rather than 0% utilised. A sheet with only Actual columns (no "Plan"/"Actual" sub-header row) still'],
      ['uploads fine; it just carries no Plan figures.'],
      [''],
      ['Re-uploading a fuller version of this file (e.g. with more months now filled in) only ADDS data —'],
      ['it never blanks out a month that already has a value here.'],
      [''],
      ['Fill in your own sections/subsections/line items following this structure, then upload the sheet.'],
    ]
    const wsReadme = XLSX.utils.aoa_to_sheet(readme)
    wsReadme['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, wsReadme, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="budget-utilisation-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[budget-utilisation template]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/action-plans/:id/budget-utilisation
// Body: { rows: [{ section, subsection, sr_no, budget_head, budget_line_item, budget, monthly: [{ period_month, expenses, planned_expenses }] }], fy_start_year?, fy_grants?: [{ fy_start_year, total_budget }], replace_period? }
// Monthly cells are COALESCEd so a re-upload only adds data, never blanks a month.
// `budget` belongs to fy_start_year (required whenever any row carries a budget).
// `fy_grants` sets the headline Total Budget per FY, independent of fy_start_year.
// `replace_period: { from, to }` deletes stored rows in that range first, so the
// upload acts as a new version of those months rather than a merge.
router.post('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows, fy_start_year, fy_grants, replace_period } = req.body || {}
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })
    if (fy_start_year != null && (typeof fy_start_year !== 'number' || !Number.isInteger(fy_start_year))) {
      return res.status(400).json({ error: 'fy_start_year must be an integer, e.g. 2025 for FY 2025-26' })
    }
    // Multi-year grants arrive pre-split client-side, one entry per FY.
    let grants = null
    if (fy_grants != null) {
      if (!Array.isArray(fy_grants) || !fy_grants.length) {
        return res.status(400).json({ error: 'fy_grants must be a non-empty array of { fy_start_year, total_budget }' })
      }
      grants = []
      for (const g of fy_grants) {
        if (!g || typeof g.fy_start_year !== 'number' || !Number.isInteger(g.fy_start_year)) {
          return res.status(400).json({ error: 'each fy_grants entry needs an integer fy_start_year' })
        }
        if (typeof g.total_budget !== 'number' || !isFinite(g.total_budget)) {
          return res.status(400).json({ error: 'each fy_grants entry needs a numeric total_budget' })
        }
        // Optional upload period this figure was entered for — both or neither.
        const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
        const hasPeriod = g.period_from != null || g.period_to != null
        if (hasPeriod && (!isDay(g.period_from) || !isDay(g.period_to) || g.period_from > g.period_to)) {
          return res.status(400).json({ error: 'fy_grants period_from/period_to must both be YYYY-MM-DD with period_from <= period_to' })
        }
        grants.push({ fy_start_year: g.fy_start_year, total_budget: g.total_budget,
          period_from: hasPeriod ? g.period_from : null, period_to: hasPeriod ? g.period_to : null })
      }
    }
    if (replace_period != null) {
      const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      if (!isDay(replace_period.from) || !isDay(replace_period.to) || replace_period.from > replace_period.to) {
        return res.status(400).json({ error: 'replace_period must be { from, to } as YYYY-MM-DD with from <= to' })
      }
    }
    const anyLineItemBudget = rows.some(r => r && r.budget != null)
    if (anyLineItemBudget && fy_start_year == null) {
      return res.status(400).json({ error: 'fy_start_year is required when uploading a Budget figure' })
    }

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()

    // Anchor month for budget-only line items: the later of the project start and
    // the FY's April 1st, so it doesn't drift with whichever column the sheet starts at,
    // and an item budgeted for FY2 isn't filed under FY1.
    const { rows: planRows } = await pool.query(
      `SELECT year, start_month FROM action_plans WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )
    const plan = planRows[0]
    const projectStartMonth = plan?.year && plan?.start_month
      ? `${plan.year}-${String(plan.start_month).padStart(2, '0')}-01`
      : null
    const fyStartMonth = fy_start_year != null ? fyBounds(fy_start_year).start : null
    const anchorMonth = projectStartMonth && fyStartMonth
      ? (projectStartMonth > fyStartMonth ? projectStartMonth : fyStartMonth)
      : (projectStartMonth || fyStartMonth)

    if (grants) {
      for (const g of grants) {
        await pool.query(
          `INSERT INTO budget_utilisation_fy_grants (org_id, project_key, fy_start_year, total_budget, period_from, period_to)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (org_id, project_key, fy_start_year) DO UPDATE SET total_budget = $4, period_from = $5, period_to = $6, updated_at = NOW()`,
          [req.user.orgId, projectKey, g.fy_start_year, g.total_budget, g.period_from, g.period_to]
        )
      }
      await resyncFyTotal(pool, req.user.orgId, projectKey, req.params.id)
    }

    const client = await pool.connect()
    const periodsTouched = new Set()
    let cellCount = 0
    let replacedCount = 0
    try {
      await client.query('BEGIN')
      if (replace_period) {
        const del = await client.query(
          `DELETE FROM budget_utilisation_reports
            WHERE org_id = $1 AND project_key = $2 AND period_month >= $3 AND period_month <= $4`,
          [req.user.orgId, projectKey, replace_period.from, replace_period.to]
        )
        replacedCount = del.rowCount
      }
      for (const r of rows) {
        const section = String(r.section || '').trim()
        const budgetHead = String(r.budget_head || '').trim()
        if (!section || !budgetHead) continue
        const subsection = r.subsection ? String(r.subsection).trim() : null
        const srNo = r.sr_no ? String(r.sr_no).trim() : null
        const budgetLineItem = r.budget_line_item ? String(r.budget_line_item).trim() : null
        const budget = r.budget ?? null
        const monthly = Array.isArray(r.monthly) ? r.monthly : []

        // Write months that carry an actual OR a plan, so planned-but-unspent
        // items still have a row for the Plan side.
        const nonNull = monthly.filter(m => m && m.period_month && (m.expenses != null || m.planned_expenses != null))
        const toWrite = nonNull.length ? nonNull
          : (budget != null && monthly.length ? [{ period_month: anchorMonth || monthly[0].period_month, expenses: null, planned_expenses: null }] : [])

        for (const m of toWrite) {
          // Budget belongs to fy_start_year only; a sheet straddling two FYs must
          // not stamp it onto the other FY's months. The budget-only anchor row always carries it.
          const monthBudget = budget != null && (!nonNull.length || fyStartYearOfMonth(m.period_month) === fy_start_year)
            ? budget : null
          await client.query(
            `INSERT INTO budget_utilisation_reports
               (org_id, project_key, period_month, section, subsection, sr_no, budget_head, budget_line_item, budget, expenses, planned_expenses, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (org_id, project_key, period_month, section, budget_head)
               DO UPDATE SET subsection = $5, sr_no = $6,
                             budget_line_item = COALESCE($8, budget_utilisation_reports.budget_line_item),
                             budget = COALESCE($9, budget_utilisation_reports.budget),
                             expenses = COALESCE($10, budget_utilisation_reports.expenses),
                             planned_expenses = COALESCE($11, budget_utilisation_reports.planned_expenses),
                             uploaded_by = $12, updated_at = NOW()`,
            [req.user.orgId, projectKey, m.period_month, section, subsection, srNo, budgetHead, budgetLineItem, monthBudget, m.expenses ?? null, m.planned_expenses ?? null, req.user.name || 'unknown']
          )
          periodsTouched.add(m.period_month)
          cellCount += 1
        }

        // Budget is constant within one FY. Reads take the latest month's budget in
        // that FY, so propagate it to every row in the FY or an untouched later month
        // would mask the revision. Other FYs are left alone.
        if (budget != null) {
          const { start, end } = fyBounds(fy_start_year)
          await client.query(
            `UPDATE budget_utilisation_reports SET budget = $1, updated_at = NOW()
             WHERE org_id = $2 AND project_key = $3 AND section = $4 AND budget_head = $5
               AND period_month >= $6 AND period_month < $7`,
            [budget, req.user.orgId, projectKey, section, budgetHead, start, end]
          )
        }
      }

      await resyncBudgetHeads(client, req.user.orgId, projectKey)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'budget_utilisation.upload','budget_utilisation_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, periods: [...periodsTouched].sort(), line_item_count: rows.length, fy_start_year, fy_grants: grants, replace_period: replace_period ?? null, replaced_row_count: replacedCount })]
    ).catch(() => {})

    res.json({ ok: true, periods: [...periodsTouched].sort(), count: cellCount })
  } catch (e) {
    console.error('[budget-utilisation POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/action-plans/:id/budget-utilisation
// → { months, fyGrants, grantPeriods, rows: [{ ..., budget: { [fy_start_year]: n },
//     expenses: { [period_month]: n }, planned_expenses: { [period_month]: n } }] }
// expenses/planned_expenses are per-month (not cumulative), null where never set.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT section, subsection, sr_no, budget_head, budget_line_item, period_month::text AS period_month,
              budget::float8 AS budget, expenses::float8 AS expenses,
              planned_expenses::float8 AS planned_expenses
       FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = $2
       ORDER BY section, subsection NULLS FIRST, sr_no, period_month`,
      [req.user.orgId, projectKey]
    )
    const { rows: grantRows } = await pool.query(
      `SELECT fy_start_year, total_budget::float8 AS total_budget,
              period_from::text AS period_from, period_to::text AS period_to
       FROM budget_utilisation_fy_grants
       WHERE org_id = $1 AND project_key = $2 ORDER BY fy_start_year`,
      [req.user.orgId, projectKey]
    )
    const fyGrants = Object.fromEntries(grantRows.map(g => [g.fy_start_year, g.total_budget]))
    // fy_start_year -> the upload period that grant was entered for, if any.
    const grantPeriods = Object.fromEntries(grantRows.filter(g => g.period_from && g.period_to)
      .map(g => [g.fy_start_year, { from: g.period_from, to: g.period_to }]))

    const monthsSet = new Set()
    const lineItems = new Map() // key: `${section}|${budget_head}`
    for (const r of rows) {
      monthsSet.add(r.period_month)
      const key = `${r.section}|${r.budget_head}`
      let item = lineItems.get(key)
      if (!item) {
        item = { section: r.section, subsection: r.subsection, sr_no: r.sr_no, budget_head: r.budget_head, budget_line_item: r.budget_line_item, budget: {}, expenses: {}, planned_expenses: {} }
        lineItems.set(key, item)
      }
      // Rows are ordered by period_month, so the last assignment wins: latest
      // subsection/sr_no/budget_line_item, and latest budget within each FY.
      if (r.budget != null) item.budget[fyStartYearOfMonth(r.period_month)] = r.budget
      if (r.subsection != null) item.subsection = r.subsection
      if (r.sr_no != null) item.sr_no = r.sr_no
      if (r.budget_line_item != null) item.budget_line_item = r.budget_line_item
      item.expenses[r.period_month] = r.expenses
      item.planned_expenses[r.period_month] = r.planned_expenses
    }

    res.json({ months: [...monthsSet].sort(), fyGrants, grantPeriods, rows: Array.from(lineItems.values()) })
  } catch (e) {
    console.error('[budget-utilisation GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/action-plans/:id/budget-utilisation?period_month=2026-06-01
//   — clears one month across every line item (e.g. before re-uploading a fixed sheet).
// DELETE /api/action-plans/:id/budget-utilisation?fy_start_year=2025
//   — wipes that FY's rows and its headline grant, then resyncs action_plans.budget.
// Exactly one query param is required. Admin-only.
router.delete('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const periodMonth = req.query.period_month
    const fyStartYearRaw = req.query.fy_start_year
    if (periodMonth != null && fyStartYearRaw != null) {
      return res.status(400).json({ error: 'Provide only one of period_month or fy_start_year' })
    }

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()

    if (fyStartYearRaw != null) {
      const fyStartYear = Number(fyStartYearRaw)
      if (!Number.isInteger(fyStartYear)) return res.status(400).json({ error: 'fy_start_year must be an integer, e.g. 2025 for FY 2025-26' })

      const { start, end } = fyBounds(fyStartYear)
      const { rowCount } = await pool.query(
        `DELETE FROM budget_utilisation_reports
         WHERE org_id = $1 AND project_key = $2 AND period_month >= $3 AND period_month < $4`,
        [req.user.orgId, projectKey, start, end]
      )
      const { rowCount: grantRowCount } = await pool.query(
        `DELETE FROM budget_utilisation_fy_grants WHERE org_id = $1 AND project_key = $2 AND fy_start_year = $3`,
        [req.user.orgId, projectKey, fyStartYear]
      )
      if (!rowCount && !grantRowCount) return res.status(404).json({ error: 'No data found for that Financial Year' })

      await resyncBudgetHeads(pool, req.user.orgId, projectKey)
      await resyncFyTotal(pool, req.user.orgId, projectKey, req.params.id)

      pool.query(
        `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
         VALUES ($1,$2,$3,'budget_utilisation.delete_fy','budget_utilisation_reports',$4,$5)`,
        [req.user.orgId, req.user.uid, req.user.name, req.params.id,
         JSON.stringify({ project_key: projectKey, fy_start_year: fyStartYear, line_item_count: rowCount, grant_deleted: grantRowCount > 0 })]
      ).catch(() => {})

      return res.json({ ok: true, deleted: rowCount, grant_deleted: grantRowCount > 0 })
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonth || '')) return res.status(400).json({ error: 'period_month (YYYY-MM-DD) or fy_start_year required' })

    const { rowCount } = await pool.query(
      `DELETE FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2 AND period_month = $3`,
      [req.user.orgId, projectKey, periodMonth]
    )
    if (!rowCount) return res.status(404).json({ error: 'No data found for that month' })

    await resyncBudgetHeads(pool, req.user.orgId, projectKey)

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'budget_utilisation.delete','budget_utilisation_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id,
       JSON.stringify({ project_key: projectKey, period_month: periodMonth, line_item_count: rowCount })]
    ).catch(() => {})

    res.json({ ok: true, deleted: rowCount })
  } catch (e) {
    console.error('[budget-utilisation DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/action-plans/:id/budget-utilisation/trend
// Spend per month plus the headline action_plans.budget. Pace/projection is left
// to the frontend since a project can start in any month.
router.get('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation/trend', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()
    const { rows: trend } = await pool.query(
      `SELECT period_month::text AS month, COALESCE(SUM(expenses), 0)::float8 AS expenses_sum
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2
       GROUP BY period_month ORDER BY period_month`,
      [req.user.orgId, projectKey]
    )

    const { rows: [budgetRow] } = await pool.query(
      `SELECT COALESCE(budget, 0)::float8 AS total_budget FROM action_plans WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.orgId]
    )

    res.json({ totalBudget: budgetRow?.total_budget || 0, trend })
  } catch (e) {
    console.error('[budget-utilisation/trend GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/action-plans/:id/budget-utilisation/cell — admin-only, since it
// bypasses the sheet-is-source-of-truth upload.
// Body: { section, budget_head, period_month?, budget?, expenses?, planned_expenses?, fy_start_year? }
//   - { period_month, expenses|planned_expenses }: upserts one month; each field is
//     independent, so editing Actual never blanks Plan.
//   - { fy_start_year, budget }: sets the budget across that FY's rows, anchoring a
//     new row (same rule as POST) if the item has none in that FY.
router.put('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation/cell', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { section, budget_head, period_month, budget, expenses, planned_expenses, fy_start_year } = req.body || {}
    if (!section || !budget_head) return res.status(400).json({ error: 'section and budget_head required' })
    const editingExpenses = period_month != null && expenses !== undefined
    const editingPlanned = period_month != null && planned_expenses !== undefined
    if (!editingExpenses && !editingPlanned && budget == null) {
      return res.status(400).json({ error: 'either { period_month, expenses }, { period_month, planned_expenses }, or { fy_start_year, budget } required' })
    }
    if (!editingExpenses && !editingPlanned && (fy_start_year == null || !Number.isInteger(fy_start_year))) {
      return res.status(400).json({ error: 'fy_start_year (integer) is required when editing Budget' })
    }

    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })

    const pool = getPool()

    if (editingExpenses || editingPlanned) {
      const { rows: prev } = await pool.query(
        `SELECT expenses::float8 AS expenses, planned_expenses::float8 AS planned_expenses
         FROM budget_utilisation_reports
         WHERE org_id = $1 AND project_key = $2 AND period_month = $3 AND section = $4 AND budget_head = $5`,
        [req.user.orgId, projectKey, period_month, section, budget_head]
      )
      // CASE on "was this field sent" rather than COALESCE, so an explicit null
      // still clears the cell while an omitted field keeps its value.
      const expensesVal = editingExpenses ? (expenses ?? null) : null
      const plannedVal = editingPlanned ? (planned_expenses ?? null) : null
      const { rows } = await pool.query(
        `INSERT INTO budget_utilisation_reports (org_id, project_key, period_month, section, budget_head, expenses, planned_expenses, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (org_id, project_key, period_month, section, budget_head)
           DO UPDATE SET
             expenses = CASE WHEN $9 THEN $6 ELSE budget_utilisation_reports.expenses END,
             planned_expenses = CASE WHEN $10 THEN $7 ELSE budget_utilisation_reports.planned_expenses END,
             updated_at = NOW()
         RETURNING expenses::float8 AS expenses, planned_expenses::float8 AS planned_expenses`,
        [req.user.orgId, projectKey, period_month, section, budget_head, expensesVal, plannedVal, req.user.name || 'unknown', editingExpenses, editingPlanned]
      )
      await resyncBudgetHeads(pool, req.user.orgId, projectKey)
      pool.query(
        `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
         VALUES ($1,$2,$3,'budget_utilisation.cell_edit','budget_utilisation_reports',$4,$5)`,
        [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({
          section, budget_head, period_month,
          ...(editingExpenses ? { expenses: { before: prev[0]?.expenses ?? null, after: rows[0].expenses } } : {}),
          ...(editingPlanned ? { planned_expenses: { before: prev[0]?.planned_expenses ?? null, after: rows[0].planned_expenses } } : {}),
        })]
      ).catch(() => {})
      return res.json({ ok: true, expenses: rows[0].expenses, planned_expenses: rows[0].planned_expenses })
    }

    const { start, end } = fyBounds(fy_start_year)
    const { rows: prev } = await pool.query(
      `SELECT budget::float8 AS budget FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = $2 AND section = $3 AND budget_head = $4
         AND period_month >= $5 AND period_month < $6
       ORDER BY period_month DESC LIMIT 1`,
      [req.user.orgId, projectKey, section, budget_head, start, end]
    )
    const { rowCount } = await pool.query(
      `UPDATE budget_utilisation_reports SET budget = $1, updated_at = NOW()
       WHERE org_id = $2 AND project_key = $3 AND section = $4 AND budget_head = $5
         AND period_month >= $6 AND period_month < $7`,
      [budget, req.user.orgId, projectKey, section, budget_head, start, end]
    )
    if (!rowCount) {
      // No rows in this FY yet — anchor one, same rule as POST.
      const { rows: planRows } = await pool.query(
        `SELECT year, start_month FROM action_plans WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.user.orgId]
      )
      const plan = planRows[0]
      const projectStartMonth = plan?.year && plan?.start_month
        ? `${plan.year}-${String(plan.start_month).padStart(2, '0')}-01`
        : null
      const anchorMonth = projectStartMonth && projectStartMonth > start ? projectStartMonth : start
      // subsection/sr_no stay null; the sheet remains their source of truth.
      await pool.query(
        `INSERT INTO budget_utilisation_reports (org_id, project_key, period_month, section, budget_head, budget, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (org_id, project_key, period_month, section, budget_head)
           DO UPDATE SET budget = $6, updated_at = NOW()`,
        [req.user.orgId, projectKey, anchorMonth, section, budget_head, budget, req.user.name || 'unknown']
      )
    }
    await resyncBudgetHeads(pool, req.user.orgId, projectKey)
    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'budget_utilisation.cell_edit','budget_utilisation_reports',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.id, JSON.stringify({
        section, budget_head, fy_start_year, budget: { before: prev[0]?.budget ?? null, after: budget },
      })]
    ).catch(() => {})
    res.json({ ok: true, fy_start_year, budget })
  } catch (e) {
    console.error('[budget-utilisation/cell PUT]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/action-plans/:id/budget-utilisation/insights
// Deterministic checks first (cumulative spend vs budget; this month vs the previous
// uploaded month), then one AI call turns them into a narrative. The deterministic
// output is the fallback when AI is unavailable.
const SPIKE_FACTOR = 3          // this month's expenses >= 3x the preceding uploaded month's, for the same line item
const NEW_SPEND_FLOOR = 10000   // a brand-new (no prior baseline) expense line worth flagging

router.post('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation/insights', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })
    const pool = getPool()

    let asOf = req.body?.as_of_period_month
    if (!asOf) {
      const { rows: latest } = await pool.query(
        `SELECT MAX(period_month)::text AS m FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2`,
        [req.user.orgId, projectKey]
      )
      asOf = latest[0]?.m
    }
    if (!asOf) return res.status(404).json({ error: 'No data uploaded yet' })

    const { rows: current } = await pool.query(
      `SELECT section, budget_head, budget::float8 AS budget, expenses::float8 AS expenses
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2 AND period_month = $3`,
      [req.user.orgId, projectKey, asOf]
    )
    if (!current.length) return res.status(404).json({ error: 'No line items found for that month' })

    // Cumulative-to-date expenses per line item, through and including asOf.
    const { rows: cumRows } = await pool.query(
      `SELECT section, budget_head, SUM(expenses)::float8 AS cum_expenses
       FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = $2 AND period_month <= $3
       GROUP BY section, budget_head`,
      [req.user.orgId, projectKey, asOf]
    )
    const cumByKey = new Map(cumRows.map(r => [`${r.section}|${r.budget_head}`, r.cum_expenses]))

    // Previous uploaded month, for spike detection. Don't add DISTINCT here: with
    // the ::text alias Postgres rejects ORDER BY on the un-cast column.
    const { rows: priorPeriodRows } = await pool.query(
      `SELECT period_month::text AS m FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = $2 AND period_month < $3
       ORDER BY period_month DESC LIMIT 1`,
      [req.user.orgId, projectKey, asOf]
    )
    const priorPeriod = priorPeriodRows[0]?.m || null

    let priorByKey = new Map()
    if (priorPeriod) {
      const { rows: priorRows } = await pool.query(
        `SELECT section, budget_head, expenses::float8 AS expenses
         FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2 AND period_month = $3`,
        [req.user.orgId, projectKey, priorPeriod]
      )
      priorByKey = new Map(priorRows.map(r => [`${r.section}|${r.budget_head}`, r.expenses]))
    }

    // ── Deterministic checks ────────────────────────────────────────────────
    const flags = []
    for (const r of current) {
      const key = `${r.section}|${r.budget_head}`
      const budget = Number(r.budget) || 0
      const expenses = Number(r.expenses) || 0             // this month's own spend
      const cumExpenses = Number(cumByKey.get(key)) || 0    // cumulative to date

      if (budget > 0 && cumExpenses > budget) {
        flags.push({ section: r.section, budget_head: r.budget_head, type: 'over_budget',
          reason: `Cumulative expenses (₹${cumExpenses.toLocaleString('en-IN')}) exceed the ₹${budget.toLocaleString('en-IN')} budget by ₹${(cumExpenses - budget).toLocaleString('en-IN')}` })
      } else if (budget <= 0 && cumExpenses > 0) {
        flags.push({ section: r.section, budget_head: r.budget_head, type: 'no_budget',
          reason: `₹${cumExpenses.toLocaleString('en-IN')} spent to date with no budget allocated to this line item` })
      }

      const priorExpenses = priorByKey.get(key)
      if (priorExpenses != null) {
        if (priorExpenses > 0) {
          const factor = expenses / priorExpenses
          if (factor >= SPIKE_FACTOR) {
            flags.push({ section: r.section, budget_head: r.budget_head, type: 'spike_up',
              reason: `Expenses jumped ${factor.toFixed(1)}x vs ${priorPeriod} (₹${priorExpenses.toLocaleString('en-IN')} → ₹${expenses.toLocaleString('en-IN')})` })
          }
        } else if (expenses >= NEW_SPEND_FLOOR) {
          flags.push({ section: r.section, budget_head: r.budget_head, type: 'new_spend',
            reason: `New spending of ₹${expenses.toLocaleString('en-IN')} with no prior-month baseline to compare against` })
        }
      }
    }

    // ── Section-level cumulative utilisation (no "elapsed fiscal year" left) ──
    const sectionMap = new Map()
    for (const r of current) {
      const cur = sectionMap.get(r.section) || { budget: 0, cumExpenses: 0 }
      cur.budget += Number(r.budget) || 0
      cur.cumExpenses += Number(cumByKey.get(`${r.section}|${r.budget_head}`)) || 0
      sectionMap.set(r.section, cur)
    }
    const sections = Array.from(sectionMap.entries()).map(([section, v]) => ({
      section, budget: v.budget, expenses: v.cumExpenses,
      utilisedPct: v.budget > 0 ? Math.round((v.cumExpenses / v.budget) * 100) : null,
    }))
    const overUtilised = sections.filter(s => s.utilisedPct != null && s.utilisedPct > 100)

    // ── Templated fallback (used verbatim if AI is unavailable) ─────────────
    const fallbackNarrative = [
      `Cumulative figures as of ${asOf}.`,
      overUtilised.length
        ? `${overUtilised.length} of ${sections.length} section(s) have exceeded their budget (${overUtilised.map(s => s.section).join(', ')}).`
        : 'No section has exceeded its budget.',
      flags.length ? `${flags.length} line item(s) flagged for review.` : 'No line-item anomalies detected.',
    ].join(' ')

    let narrative = fallbackNarrative
    let rankedFlags = flags

    if (flags.length || overUtilised.length) {
      try {
        const systemPrompt =
          `You are a financial analyst assistant for an NGO. Given computed budget-utilisation ` +
          `statistics for one project as of a given month, write a SHORT (2-4 sentence) plain-English ` +
          `narrative summarizing cumulative spend-to-date and highlighting the most important flagged items. Then ` +
          `re-rank the given flags by importance (most concerning first) and give each a one-line reason ` +
          `in plain English, non-technical. Respond with strict JSON only: ` +
          `{"narrative": "...", "flags": [{"section": "...", "budget_head": "...", "type": "...", "reason": "..."}]}. ` +
          `Include every flag given, do not invent new ones.`
        const userPrompt = JSON.stringify({ as_of_period_month: asOf, sections, flags })
        const out = await runAI({
          feature: 'budget_utilisation',
          operation: 'insights',
          prompt: userPrompt,
          systemPrompt,
          orgId: req.user.orgId,
          userId: req.user.uid,
        }, { jsonMode: true, maxTokens: 1024, temperature: 0.3 })

        const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
        if (parsed?.narrative && Array.isArray(parsed?.flags)) {
          narrative = parsed.narrative
          rankedFlags = parsed.flags
        }
      } catch (e) {
        console.warn('[budget-utilisation/insights] AI narrative unavailable, using fallback:', e.message)
      }
    }

    res.json({ narrative, flags: rankedFlags, sections, as_of_period_month: asOf })
  } catch (e) {
    console.error('[budget-utilisation/insights POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/action-plans/:id/budget-utilisation/categorize
// Classifies each budget_head into a fixed taxonomy, with a keyword fallback when
// AI is unavailable. Not persisted; it's an analytical lens, not upload data.
const CATEGORY_TAXONOMY = [
  'Personnel',
  'Program Delivery',
  'Travel & Field Operations',
  'Training & Capacity Building',
  'Equipment & Capital',
  'Monitoring & Evaluation',
  'Administrative & Overheads',
]

function keywordCategory(section, budgetHead) {
  const t = `${section} ${budgetHead}`.toLowerCase()
  if (/salary|staff|personnel|manager|coordinator|officer|wage|\bhr\b/.test(t)) return 'Personnel'
  if (/travel|transport|fuel|vehicle|conveyance|mileage|logistics/.test(t)) return 'Travel & Field Operations'
  if (/training|workshop|capacity|orientation|seminar|exposure visit/.test(t)) return 'Training & Capacity Building'
  if (/laptop|computer|equipment|kit|furniture|capital|asset|machinery|infrastructure/.test(t)) return 'Equipment & Capital'
  if (/monitoring|evaluation|survey|assessment|\bm&e\b|\bmis\b/.test(t)) return 'Monitoring & Evaluation'
  if (/admin|overhead|rent|utilit|office|stationery|audit|bank charges|communication/.test(t)) return 'Administrative & Overheads'
  if (/program|activity|activities|community|beneficiar|field visit|awareness|distribution|input support/.test(t)) return 'Program Delivery'
  return 'Other'
}

router.post('/action-plans/:id([0-9a-fA-F-]{36})/budget-utilisation/categorize', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const projectKey = await resolveProjectKey(req.params.id, req.user.orgId)
    if (!projectKey) return res.status(404).json({ error: 'Not found' })
    const pool = getPool()

    const { rows: items } = await pool.query(
      `SELECT section, budget_head
       FROM budget_utilisation_reports WHERE org_id = $1 AND project_key = $2
       GROUP BY section, budget_head
       ORDER BY section, budget_head`,
      [req.user.orgId, projectKey]
    )
    if (!items.length) return res.status(404).json({ error: 'No data uploaded yet' })

    let categories = Object.fromEntries(items.map(it => [it.budget_head, keywordCategory(it.section, it.budget_head)]))

    try {
      const systemPrompt =
        `You are classifying an NGO project's budget line items into spend categories, for a portfolio ` +
        `finance dashboard. Assign EACH given line item to EXACTLY ONE of this fixed list: ` +
        `${CATEGORY_TAXONOMY.join(', ')}. Use "Other" only if truly none fit. Respond with strict JSON ` +
        `only: {"categories": {"<budget_head>": "<category>"}}. Include every line item given, do not invent new ones.`
      const userPrompt = JSON.stringify({ line_items: items.map(it => ({ section: it.section, budget_head: it.budget_head })) })
      const out = await runAI({
        feature: 'budget_utilisation',
        operation: 'categorize',
        prompt: userPrompt,
        systemPrompt,
        orgId: req.user.orgId,
        userId: req.user.uid,
      }, { jsonMode: true, maxTokens: 1024, temperature: 0.1 })

      const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
      const allowed = new Set([...CATEGORY_TAXONOMY, 'Other'])
      if (parsed?.categories && typeof parsed.categories === 'object') {
        const aiCategories = {}
        for (const it of items) {
          const cat = parsed.categories[it.budget_head]
          aiCategories[it.budget_head] = allowed.has(cat) ? cat : (categories[it.budget_head] || 'Other')
        }
        categories = aiCategories
      }
    } catch (e) {
      console.warn('[budget-utilisation/categorize] AI classification unavailable, using keyword fallback:', e.message)
    }

    res.json({ categories, taxonomy: CATEGORY_TAXONOMY })
  } catch (e) {
    console.error('[budget-utilisation/categorize POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
