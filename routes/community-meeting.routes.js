// MIS > Community Meeting (056). Like campaign.routes.js, not linked to a beneficiary:
// the sheet only has aggregate attendee headcounts.
//
//   GET  /api/community-meeting?search=&page=       — list + KPIs
//   POST /api/community-meeting/bulk-upload          — bulk import (no UID resolution needed)
//   GET  /api/community-meeting-template.xlsx         — blank upload template

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { buildTemplateXlsx, sendXlsx, misSheetName, resolveProjectName } from '../lib/misTemplateXlsx.js'

const router = Router()

// GET /api/community-meeting-template.xlsx
router.get('/community-meeting-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const projectName = await resolveProjectName(pool, req.user.orgId, req.query.project_key)
    const buf = await buildTemplateXlsx({
      sheetName: misSheetName(projectName, 'Community Meeting'),
      header: ['Purpose of Meeting', 'Total No. of Attendees', 'No. of Male', 'No. of Female', 'No. of Children', 'Date', 'Place'],
      sampleRows: [
        ['Monthly Village Meeting', '45', '20', '22', '3', '2026-01-15', 'Sample Village'],
      ],
      readmeLines: [
        'Community Meeting — Upload Template',
        '',
        'Columns: Purpose of Meeting, Total No. of Attendees, No. of Male, No. of Female,',
        'No. of Children, Date, Place.',
        '',
        'Community meetings are aggregate EVENTS, not linked to a specific beneficiary —',
        'there is no UID/Name/Contact No. column on this sheet.',
        '',
        'Purpose of Meeting is the only required field.',
      ],
    })
    sendXlsx(res, buf, 'community-meeting-template.xlsx')
  } catch (e) {
    console.error('[community-meeting template]', e.message)
    res.status(500).json({ error: e.message })
  }
})

function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN // NaN signals "was provided but not a whole number"
}

// GET /api/community-meeting?search=&page=
router.get('/community-meeting', async (req, res) => {
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
      where.push(`(purpose ILIKE $${values.length} OR place ILIKE $${values.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total,
              coalesce(sum(total_attendees), 0)::int AS total_attendees,
              coalesce(sum(male_count), 0)::int AS total_male,
              coalesce(sum(female_count), 0)::int AS total_female,
              coalesce(sum(children_count), 0)::int AS total_children
       FROM community_meeting WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    const { rows: purposeRows } = await pool.query(
      `SELECT purpose AS label, count(*)::int AS total, coalesce(sum(total_attendees), 0)::int AS attendees
       FROM community_meeting WHERE ${whereSql}
       GROUP BY purpose ORDER BY attendees DESC LIMIT 10`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, purpose, total_attendees, male_count, female_count, children_count,
              meeting_date, place, created_at
       FROM community_meeting
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
      purposeBreakdown: purposeRows.map(r => ({ label: r.label, total: r.total, attendees: r.attendees })),
    })
  } catch (e) {
    console.error('[community-meeting GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/community-meeting/bulk-upload
// Body: { rows: [{ purpose, total_attendees, male_count, female_count,
//   children_count, date, place }] }
router.post('/community-meeting/bulk-upload', async (req, res) => {
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
      const purpose = String(r.purpose || '').trim()
      if (!purpose) {
        errors.push({ row: i + 1, error: 'Purpose of Meeting is required' })
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

      const parsedDate = r.date ? new Date(r.date) : null
      const meetingDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : null

      try {
        await pool.query(
          `INSERT INTO community_meeting
             (org_id, project_key, purpose, total_attendees, male_count, female_count, children_count,
              meeting_date, place, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (org_id, project_key, purpose, meeting_date, place)
             DO UPDATE SET total_attendees = $4, male_count = $5, female_count = $6,
                           children_count = $7, uploaded_by = $10`,
          [orgId, project_key, purpose, totalAttendees, maleCount, femaleCount, childrenCount,
            meetingDate, r.place || null, req.user.name || 'unknown']
        )
        saved += 1
      } catch (e) {
        errors.push({ row: i + 1, error: 'Save failed: ' + e.message })
      }
    }

    res.json({ ok: true, saved, skipped: errors.length, errors })
  } catch (e) {
    console.error('[community-meeting bulk-upload]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
