// MIS > Scheme Access (049). Same upload flow as trainings.routes.js — UID resolves
// the beneficiary type, a blank UID becomes an Indirect Beneficiary (047) — with
// scheme_name as the activity column.
//
//   GET  /api/scheme-access?project_key=&beneficiary_type=&search=&page=  — list + KPIs
//   POST /api/scheme-access/bulk-upload                       — bulk import, resolves UID -> beneficiary_type
//   GET  /api/scheme-access-template.xlsx                      — blank upload template
//
// Project-scoped (058): rows carry the project being viewed at upload, and the
// list only returns the requested project_key.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { buildTemplateXlsx, sendXlsx, misSheetName, resolveProjectName } from '../lib/misTemplateXlsx.js'
import { upsertMisRow, parseMisDate } from '../lib/misUpsertHelpers.js'

const router = Router()

// GET /api/scheme-access-template.xlsx
router.get('/scheme-access-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const projectName = await resolveProjectName(pool, req.user.orgId, req.query.project_key)
    const buf = await buildTemplateXlsx({
      sheetName: misSheetName(projectName, 'Scheme Access'),
      header: ['UID', 'Name', 'Contact No.', 'Scheme', 'Date', 'Place'],
      sampleRows: [
        ['IB-KHA-1', 'Sample Beneficiary', '9876543210', 'PM Matsya Sampada Yojana', '2026-01-15', 'Sample Village'],
        ['', 'Walk-in Beneficiary', '9876500000', 'PM Matsya Sampada Yojana', '2026-01-15', 'Sample Village'],
      ],
      readmeLines: [
        'Scheme Access — Upload Template',
        '',
        'Columns: UID, Name, Contact No., Scheme, Date, Place.',
        '',
        'UID is OPTIONAL — leave it blank for someone with no registered Beneficiary UID.',
        'They are saved automatically as an Indirect Beneficiary, matched across every',
        'upload by Contact No.',
        '',
        'Scheme is the only required field.',
      ],
    })
    sendXlsx(res, buf, 'scheme-access-template.xlsx')
  } catch (e) {
    console.error('[scheme-access template]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function beneficiaryLookupSpec(uid) {
  const u = String(uid || '').trim().toUpperCase()
  if (u.startsWith('IB-')) {
    return {
      normalizedUid: u, type: 'Individual Beneficiary',
      sql: `SELECT uid, name, contact_no FROM individual_beneficiaries WHERE org_id = $1 AND uid = $2`,
    }
  }
  if (u.startsWith('EB-')) {
    return {
      normalizedUid: u, type: 'Micro-Entrepreneur',
      sql: `SELECT uid, name, contact_no FROM micro_entrepreneurs WHERE org_id = $1 AND uid = $2`,
    }
  }
  if (u.startsWith('CB-')) {
    return {
      normalizedUid: u, type: 'Collective',
      sql: `SELECT uid, collective_name AS name, contact_no FROM collectives WHERE org_id = $1 AND uid = $2`,
    }
  }
  return null
}

async function lookupBeneficiary(pool, orgId, uid) {
  const spec = beneficiaryLookupSpec(uid)
  if (!spec) return { error: `UID "${uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur) or CB- (Collective)` }
  const { rows } = await pool.query(spec.sql, [orgId, spec.normalizedUid])
  const row = rows[0]
  if (!row) return { error: `No beneficiary found for UID "${spec.normalizedUid}"` }
  return { uid: spec.normalizedUid, type: spec.type, name: row.name, contact_no: row.contact_no }
}

// Same as trainings.routes.js's normalizePhone: the phone is an Indirect
// Beneficiary's org-wide identity, so the same number maps to one XB-<phone> across categories.
function normalizePhone(v) {
  const digits = String(v || '').replace(/\D/g, '')
  if (!digits) return null
  const stripped = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  return stripped.length >= 7 ? stripped : null
}

async function resolveIndirectBeneficiary(pool, orgId, name, contactNo, place) {
  const trimmedName = name ? String(name).trim() : ''
  const contact = contactNo ? String(contactNo).trim() : null
  const phone = normalizePhone(contactNo)

  if (phone) {
    const uid = `XB-${phone}`
    const { rows } = await pool.query(
      `INSERT INTO indirect_beneficiaries (org_id, uid, name, contact_no, place, source)
       VALUES ($1,$2,$3,$4,$5,'scheme_access')
       ON CONFLICT (org_id, uid) DO UPDATE SET
         name  = COALESCE(EXCLUDED.name, indirect_beneficiaries.name),
         place = COALESCE(EXCLUDED.place, indirect_beneficiaries.place)
       RETURNING uid, name, contact_no`,
      [orgId, uid, trimmedName || null, contact, place || null]
    )
    return { uid: rows[0].uid, type: 'Indirect Beneficiary', name: rows[0].name, contact_no: rows[0].contact_no }
  }

  if (trimmedName) {
    const { rows } = await pool.query(
      `SELECT uid, name, contact_no FROM indirect_beneficiaries
       WHERE org_id = $1 AND lower(trim(name)) = lower($2) AND contact_no IS NOT DISTINCT FROM $3`,
      [orgId, trimmedName, contact]
    )
    if (rows[0]) return { uid: rows[0].uid, type: 'Indirect Beneficiary', name: rows[0].name, contact_no: rows[0].contact_no }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const seqRes = await client.query(
      `INSERT INTO indirect_beneficiary_seq (org_id, next_val) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET next_val = indirect_beneficiary_seq.next_val + 1
       RETURNING next_val`,
      [orgId]
    )
    const uid = `XB-${String(seqRes.rows[0].next_val).padStart(4, '0')}`
    await client.query(
      `INSERT INTO indirect_beneficiaries (org_id, uid, name, contact_no, place, source)
       VALUES ($1,$2,$3,$4,$5,'scheme_access')`,
      [orgId, uid, trimmedName || null, contact, place || null]
    )
    await client.query('COMMIT')
    return { uid, type: 'Indirect Beneficiary', name: trimmedName || null, contact_no: contact }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// GET /api/scheme-access?beneficiary_type=&search=&page=
router.get('/scheme-access', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { beneficiary_type, search, project_key } = req.query
    if (!project_key) return res.status(400).json({ error: 'project_key required' })
    const page     = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = 50

    const where  = ['org_id = $1', 'project_key = $2']
    const values = [req.user.orgId, project_key]
    if (beneficiary_type) { values.push(beneficiary_type); where.push(`beneficiary_type = $${values.length}`) }
    if (search) {
      values.push(`%${search}%`)
      where.push(`(beneficiary_uid ILIKE $${values.length} OR beneficiary_name ILIKE $${values.length} OR scheme_name ILIKE $${values.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE beneficiary_type = 'Individual Beneficiary')::int AS individual,
              count(*) FILTER (WHERE beneficiary_type = 'Micro-Entrepreneur')::int AS entrepreneur,
              count(*) FILTER (WHERE beneficiary_type = 'Collective')::int AS collective,
              count(*) FILTER (WHERE beneficiary_type = 'Indirect Beneficiary')::int AS indirect,
              count(DISTINCT beneficiary_uid)::int AS unique_beneficiaries
       FROM scheme_access WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    const { rows: schemeRows } = await pool.query(
      `SELECT scheme_name AS label, count(*)::int AS total
       FROM scheme_access WHERE ${whereSql}
       GROUP BY scheme_name ORDER BY total DESC LIMIT 10`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, beneficiary_uid, beneficiary_type, beneficiary_name, contact_no,
              scheme_name, access_date, place, created_at
       FROM scheme_access
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
        total:               kpiRow.total || 0,
        individual:          kpiRow.individual || 0,
        entrepreneur:        kpiRow.entrepreneur || 0,
        collective:          kpiRow.collective || 0,
        indirect:            kpiRow.indirect || 0,
        uniqueBeneficiaries: kpiRow.unique_beneficiaries || 0,
      },
      schemeBreakdown: schemeRows,
    })
  } catch (e) {
    console.error('[scheme-access GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/scheme-access/bulk-upload
// Body: { project_key, rows: [{ uid, name, contact_no, scheme_name, date, place }] }
router.post('/scheme-access/bulk-upload', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows, project_key } = req.body || {}
    if (!project_key) return res.status(400).json({ error: 'project_key required' })
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const pool  = getPool()
    const orgId = req.user.orgId
    let created = 0, updated = 0, duplicates = 0
    const errors = []
    const warnings = []

    for (const [i, r] of rows.entries()) {
      const uid    = String(r.uid || '').trim()
      const scheme = String(r.scheme_name || '').trim()
      if (!scheme) {
        errors.push({ row: i + 1, uid, error: 'Scheme is required' })
        continue
      }

      const parsedDate = parseMisDate(r.date)
      if (parsedDate.error) {
        errors.push({ row: i + 1, uid, error: parsedDate.error })
        continue
      }
      const accessDate = parsedDate.date

      let beneficiary
      try {
        beneficiary = uid
          ? await lookupBeneficiary(pool, orgId, uid)
          : await resolveIndirectBeneficiary(pool, orgId, r.name, r.contact_no, r.place)
      } catch (e) {
        errors.push({ row: i + 1, uid, error: 'Lookup failed: ' + e.message })
        continue
      }
      if (beneficiary.error) {
        errors.push({ row: i + 1, uid, error: beneficiary.error })
        continue
      }

      try {
        // Duplicate = same identity (uid + scheme + date) and identical content
        // (lib/misUpsertHelpers.js); another scheme/date is a new row.
        const outcome = await upsertMisRow(pool, {
          table: 'scheme_access',
          identity: { org_id: orgId, project_key, beneficiary_uid: beneficiary.uid, scheme_name: scheme, access_date: accessDate },
          content: { beneficiary_type: beneficiary.type, beneficiary_name: beneficiary.name, contact_no: beneficiary.contact_no, place: r.place || null },
          audit: { uploaded_by: req.user.name || 'unknown' },
        })
        if (outcome === 'new') created += 1
        else if (outcome === 'updated') updated += 1
        else { duplicates += 1; warnings.push({ row: i + 1, uid: beneficiary.uid, warning: 'Duplicate — an identical scheme access record already exists (same beneficiary, scheme, date, contact and place)' }) }
      } catch (e) {
        errors.push({ row: i + 1, uid, error: 'Save failed: ' + e.message })
      }
    }

    res.json({ ok: true, saved: created + updated, created, updated, duplicates, skipped: errors.length, errors, warnings })
  } catch (e) {
    console.error('[scheme-access bulk-upload]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
