// MIS > Campaign (055). Unlike the other MIS categories, a campaign isn't linked to a
// beneficiary: the sheet only has aggregate headcounts, so there's no UID lookup,
// no Indirect Beneficiary and no sub-tabs — one flat list of events.
//
//   GET  /api/campaign?search=&page=       — list + KPIs
//   POST /api/campaign/bulk-upload          — bulk import (no UID resolution needed)
//   GET  /api/campaign-template.xlsx         — blank upload template

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { buildTemplateXlsx, sendXlsx, misSheetName, resolveProjectName } from '../lib/misTemplateXlsx.js'

const router = Router()

// GET /api/campaign-template.xlsx
router.get('/campaign-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const projectName = await resolveProjectName(pool, req.user.orgId, req.query.project_key)
    const buf = await buildTemplateXlsx({
      sheetName: misSheetName(projectName, 'Campaign'),
      header: ['Campaign Name', 'Total No. of Attendees', 'No. of Male', 'No. of Female', 'No. of Children', 'Date', 'Place'],
      sampleRows: [
        ['Fisheries Awareness Drive', '80', '35', '40', '5', '2026-01-15', 'Sample Village'],
      ],
      readmeLines: [
        'Campaign — Upload Template',
        '',
        'Columns: Campaign Name, Total No. of Attendees, No. of Male, No. of Female,',
        'No. of Children, Date, Place.',
        '',
        'Campaigns are aggregate EVENTS, not linked to a specific beneficiary — there is',
        'no UID/Name/Contact No. column on this sheet.',
        '',
        'Campaign Name is the only required field.',
      ],
    })
    sendXlsx(res, buf, 'campaign-template.xlsx')
  } catch (e) {
    console.error('[campaign template]', e.message)
    res.status(500).json({ error: e.message })
  }
})

function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN // NaN signals "was provided but not a whole number"
}

// GET /api/campaign?search=&page=
router.get('/campaign', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { search, project_key } = req.query
    if (!project_key) return res.status(400).json({ error: 'project_key required' })
    const page     = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = 50

    const where  = ['org_id = $1', 'project_key = $2']
    const values = [req.user.orgId, project_key]
    if (search) {
      values.push(`%${search}%`)
      where.push(`(campaign_name ILIKE $${values.length} OR place ILIKE $${values.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total,
              coalesce(sum(total_attendees), 0)::int AS total_attendees,
              coalesce(sum(male_count), 0)::int AS total_male,
              coalesce(sum(female_count), 0)::int AS total_female,
              coalesce(sum(children_count), 0)::int AS total_children
       FROM campaign WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    const { rows: campaignRows } = await pool.query(
      `SELECT campaign_name AS label, count(*)::int AS total, coalesce(sum(total_attendees), 0)::int AS attendees
       FROM campaign WHERE ${whereSql}
       GROUP BY campaign_name ORDER BY attendees DESC LIMIT 10`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, campaign_name, total_attendees, male_count, female_count, children_count,
              campaign_date, place, created_at
       FROM campaign
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      values
    )

    res.json({
      rows,
      totalRows: kpiRow.total || 0,
      page,
      pageSize,
      kpis: {
        total:          kpiRow.total || 0,
        totalAttendees: kpiRow.total_attendees || 0,
        totalMale:      kpiRow.total_male || 0,
        totalFemale:    kpiRow.total_female || 0,
        totalChildren:  kpiRow.total_children || 0,
      },
      campaignBreakdown: campaignRows.map(r => ({ label: r.label, total: r.total, attendees: r.attendees })),
    })
  } catch (e) {
    console.error('[campaign GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/campaign/bulk-upload
// Body: { rows: [{ campaign_name, total_attendees, male_count, female_count,
//   children_count, date, place }] }
router.post('/campaign/bulk-upload', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows, project_key } = req.body || {}
    if (!project_key) return res.status(400).json({ error: 'project_key required' })
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const pool  = getPool()
    const orgId = req.user.orgId
    let saved = 0
    const errors = []

    for (const [i, r] of rows.entries()) {
      const campaignName = String(r.campaign_name || '').trim()
      if (!campaignName) {
        errors.push({ row: i + 1, error: 'Campaign Name is required' })
        continue
      }

      const totalAttendees = toNullableInt(r.total_attendees)
      const maleCount       = toNullableInt(r.male_count)
      const femaleCount     = toNullableInt(r.female_count)
      const childrenCount   = toNullableInt(r.children_count)
      if ([totalAttendees, maleCount, femaleCount, childrenCount].some(Number.isNaN)) {
        errors.push({ row: i + 1, error: 'Attendee counts must be whole numbers' })
        continue
      }
      if ([totalAttendees, maleCount, femaleCount, childrenCount].some(v => v != null && v < 0)) {
        errors.push({ row: i + 1, error: 'Attendee counts must be non-negative' })
        continue
      }

      const parsedDate  = r.date ? new Date(r.date) : null
      const campaignDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : null

      try {
        await pool.query(
          `INSERT INTO campaign
             (org_id, project_key, campaign_name, total_attendees, male_count, female_count, children_count,
              campaign_date, place, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (org_id, project_key, campaign_name, campaign_date, place)
             DO UPDATE SET total_attendees = $4, male_count = $5, female_count = $6,
                           children_count = $7, uploaded_by = $10`,
          [orgId, project_key, campaignName, totalAttendees, maleCount, femaleCount, childrenCount,
            campaignDate, r.place || null, req.user.name || 'unknown']
        )
        saved += 1
      } catch (e) {
        errors.push({ row: i + 1, error: 'Save failed: ' + e.message })
      }
    }

    res.json({ ok: true, saved, skipped: errors.length, errors })
  } catch (e) {
    console.error('[campaign bulk-upload]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
