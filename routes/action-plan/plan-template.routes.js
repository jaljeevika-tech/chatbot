// GET /action-plans/template.xlsx: blank upload template (layout constants live in helpers.js).

import { Router } from 'express'
import { requireEditor } from '../../lib/routeGuards.js'
import { actionPlanMonthlyHeaderRows, ACTION_PLAN_MONTHLY_COLS, ACTION_PLAN_README_ROWS } from './helpers.js'

const router = Router()

// GET /api/action-plans/template.xlsx — blank template in the Kosi Sahjivan 2026 layout:
// wide "Monthly Plan" sheet (one row per activity × location) plus "Plan Info" and "README".
router.get('/action-plans/template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    // ─── Sheet 1 — Plan Info ─────────────────────────────────────────────────
    const planInfo = [
      ['Field', 'Value', 'Notes'],
      ['Name', 'My Project 2026', 'Project name shown in dropdowns'],
      ['Year', 2026, 'Plan year as integer'],
      ['Start Month', 4, 'Month number where the plan year begins (1=Jan, 4=Apr, 7=Jul)'],
      ['Locations', 'Khagaria, Alauli, Bhaptiyahi, Pipra, Kishanpur, Kusheshwar Sthan',
        'Comma-separated list — these become the Location sub-rows in Monthly Plan'],
    ]
    const ws1 = XLSX.utils.aoa_to_sheet(planInfo)
    ws1['!cols'] = [{ wch: 16 }, { wch: 60 }, { wch: 60 }]
    XLSX.utils.book_append_sheet(wb, ws1, 'Plan Info')

    // ─── Sheet 2 — Monthly Plan (Kosi-style wide format) ────────────────────
    // 32 cols: metadata(0-6) + optional Category(7) + Apr-T(8) + Location(9) + 11 × T/A pairs (10-31)
    const [h1, h2] = actionPlanMonthlyHeaderRows()

    // Sample activity 1 — Survey software (across 6 locations)
    const LOCS = ['Khagaria','Alauli','Bhaptiyahi','Pipra','Kishanpur','Kusheshwar Sthan']

    const rows = [h1, h2, []]   // 3rd row empty (matches Kosi)

    // Sample activity 1 — first row has full metadata + first location
    rows.push([
      1, 'Survey software/Tools subscription', 'Online subscription', 1,
      'Pond/chaur/maun listing in program areas', 'BM',
      'Hire local youth; give target to mobilisers',
      'technology',
      50,                                                // Apr Target
      LOCS[0],                                           // Location
      50, '', '', '', '', '', '', '', '', '', '', '',   // May-Mar T/A pairs (empty Achieved)
      '', '', '', '', '', '', '', '', '', '', '', '',
    ].slice(0, 32))
    // Sample sub-rows for activity 1 — locations 2..6
    for (let i = 1; i < LOCS.length; i++) {
      rows.push([
        '', '', '', '', '', '', '', '',
        50, LOCS[i],
        ...Array(22).fill(''),
      ].slice(0, 32))
    }

    // Sample activity 2 — Training, 4 quarterly trainings
    rows.push([
      2, '2-day training for farmers', 'people', 4,
      'Technology transfer training', 'Niraj',
      'Curriculum + farmer cards + monthly schedule',
      'capacity',
      '',                          // Apr Target empty
      LOCS[0],                     // Location
      30, '', 30, '', 30, '', 30, '', '', '', '', '',   // May-Aug have targets
      '', '', '', '', '', '', '', '', '', '', '', '',
    ].slice(0, 32))
    for (let i = 1; i < 4; i++) {
      rows.push([
        '', '', '', '', '', '', '', '',
        '', LOCS[i],
        30, '', 30, '', 30, '', 30, '', ...Array(14).fill(''),
      ].slice(0, 32))
    }

    const ws2 = XLSX.utils.aoa_to_sheet(rows)
    ws2['!cols'] = ACTION_PLAN_MONTHLY_COLS
    ws2['!freeze'] = { xSplit: 2, ySplit: 2 }
    XLSX.utils.book_append_sheet(wb, ws2, 'Monthly Plan')

    // ─── Sheet 3 — README ────────────────────────────────────────────────────
    const ws3 = XLSX.utils.aoa_to_sheet(ACTION_PLAN_README_ROWS)
    ws3['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, ws3, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="action-plan-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[action-plans template]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
