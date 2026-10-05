// GET /action-plan/export.xlsx: export in the same shape as the upload template so it round-trips.

import { Router } from 'express'
import { getPool } from '../../db/pool.js'
import { requireEditor } from '../../lib/routeGuards.js'
import { resolvePlanKey, ACTION_PLAN_MONTHS_AFTER_APR, actionPlanMonthlyHeaderRows, ACTION_PLAN_MONTHLY_COLS, ACTION_PLAN_README_ROWS } from './helpers.js'

const router = Router()

// GET /api/action-plan/export.xlsx?plan=key
// Same shape as template.xlsx (Plan Info + Monthly Plan + README) so it round-trips,
// with seed ∪ override values (untouched cells still show their seed target).
router.get('/action-plan/export.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const planKey = await resolvePlanKey(req)
    const pool = getPool()

    const { rows: planRows } = await pool.query(
      `SELECT name, year, start_month, locations, activities
       FROM action_plans WHERE org_id = $1 AND project_key = $2 AND active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [req.user.orgId, planKey]
    )
    const plan = planRows[0] || { name: planKey, year: null, start_month: 4, locations: [], activities: [] }
    const activities = (Array.isArray(plan.activities) ? plan.activities : [])
      .slice().sort((a, b) => (a.sn ?? 0) - (b.sn ?? 0))

    // project_deliverables only holds touched cells; the rest come from the seed.
    const { rows: overrideRows } = await pool.query(
      `SELECT indicator, planned, achieved
       FROM project_deliverables
       WHERE org_id = $1 AND project = $2 AND data_type = 'action_plan'`,
      [req.user.orgId, planKey]
    )
    const overrides = new Map(overrideRows.map(r => [r.indicator, r]))
    const mergedCell = (sn, loc, month, base) => {
      const o = overrides.get(`${sn}|${loc}|${month}`)
      const target   = o?.planned  != null ? Number(o.planned)  : (base?.target  ?? null)
      const achieved = o?.achieved != null ? Number(o.achieved) : (base?.achieved ?? null)
      return { target, achieved }
    }

    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    // ─── Sheet 1 — Plan Info (same shape as template.xlsx) ──────────────────
    const planInfo = [
      ['Field', 'Value', 'Notes'],
      ['Name', plan.name, 'Project name shown in dropdowns'],
      ['Year', plan.year, 'Plan year as integer'],
      ['Start Month', plan.start_month, 'Month number where the plan year begins (1=Jan, 4=Apr, 7=Jul)'],
      ['Locations', (plan.locations || []).join(', '),
        'Comma-separated list — these become the Location sub-rows in Monthly Plan'],
    ]
    const ws1 = XLSX.utils.aoa_to_sheet(planInfo)
    ws1['!cols'] = [{ wch: 16 }, { wch: 60 }, { wch: 60 }]
    XLSX.utils.book_append_sheet(wb, ws1, 'Plan Info')

    // ─── Sheet 2 — Monthly Plan, same wide layout as template.xlsx, filled
    //     with this plan's real (seed ∪ override) target/achieved values ───
    const [h1, h2] = actionPlanMonthlyHeaderRows()
    const rows = [h1, h2, []]

    for (const a of activities) {
      const locs = Array.isArray(a.locations) ? a.locations : []
      const metaRow = [a.sn, a.activity, a.unit, a.times, a.description, a.responsibility, a.process, a.category || 'capacity']
      const blankMeta = ['', '', '', '', '', '', '', '']

      if (locs.length === 0) {
        // No locations at all — still emit one metadata-only row rather than dropping the activity
        rows.push([...metaRow, '', '', ...Array(22).fill('')])
        continue
      }

      locs.forEach((l, i) => {
        const apr = mergedCell(a.sn, l.location, 'Apr', l.monthly?.Apr)
        const monthCells = ACTION_PLAN_MONTHS_AFTER_APR.flatMap(m => {
          const c = mergedCell(a.sn, l.location, m, l.monthly?.[m])
          return [c.target ?? '', c.achieved ?? '']
        })
        rows.push([
          ...(i === 0 ? metaRow : blankMeta),
          apr.target ?? '', l.location,
          ...monthCells,
        ])
      })
    }

    const ws2 = XLSX.utils.aoa_to_sheet(rows)
    ws2['!cols'] = ACTION_PLAN_MONTHLY_COLS
    ws2['!freeze'] = { xSplit: 2, ySplit: 2 }
    XLSX.utils.book_append_sheet(wb, ws2, 'Monthly Plan')

    // ─── Sheet 3 — README (identical instructions as template.xlsx) ────────
    const ws3 = XLSX.utils.aoa_to_sheet(ACTION_PLAN_README_ROWS)
    ws3['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, ws3, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="action-plan-${planKey}-${new Date().toISOString().slice(0,10)}.xlsx"`)
    res.send(buf)
  } catch (e) {
    console.error('[action-plan/export]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
