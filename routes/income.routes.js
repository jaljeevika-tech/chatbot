// MIS > Income (071). Rows map to a beneficiary registry by UID prefix (IB-/EB-/CB-),
// as in trainings.routes.js; beneficiary_type drives the sub-tabs client-side.
//
//   GET  /api/income-template.xlsx                    — blank upload template
//   GET  /api/income?beneficiary_type=&search=&page=  — list + KPIs
//   POST /api/income/bulk-upload                       — bulk import, resolves UID -> beneficiary_type

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { buildTemplateXlsx, sendXlsx, misSheetName, resolveProjectName } from '../lib/misTemplateXlsx.js'
import { upsertMisRow } from '../lib/misUpsertHelpers.js'

const router = Router()

const INCOME_SOURCES = ['Fisheries', 'Agriculture', 'Horticulture', 'Livestock', 'Trade', 'Service', 'Labour', 'Other']

// GET /api/income-template.xlsx
router.get('/income-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const projectName = await resolveProjectName(pool, req.user.orgId, req.query.project_key)
    const buf = await buildTemplateXlsx({
      sheetName: misSheetName(projectName, 'Income'),
      header: ['UID', 'Name', 'Financial Year', 'Source', 'Income realised in INR', 'Place'],
      sampleRows: [
        ['IB-KHA-1', 'Sample Beneficiary', '2026-2027', 'Fisheries', '25000', 'Sample Village'],
        ['', 'Walk-in Respondent', '2026-2027', 'Agriculture', '18000', 'Sample Village'],
      ],
      readmeLines: [
        'Income — Upload Template',
        '',
        'Columns: UID, Name, Financial Year, Source, Income realised in INR, Place.',
        '',
        `Source must be one of: ${INCOME_SOURCES.join(', ')}.`,
        '',
        'UID is OPTIONAL — leave it blank for someone with no registered Beneficiary UID.',
        'They are saved automatically as an Indirect Beneficiary, matched by name.',
        '',
        'A beneficiary can have more than one row per Financial Year — one row per',
        'income Source. Financial Year and Source together are the only required fields.',
      ],
    })
    sendXlsx(res, buf, 'income-template.xlsx')
  } catch (e) {
    console.error('[income template]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Local copy of trainings.routes.js's beneficiaryLookupSpec.
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

// A row with no UID is an Indirect Beneficiary (047). The Income sheet has no
// contact column, so match by name against the org's roster, else mint a
// sequential UID (XB-0001, ...).
async function resolveIndirectBeneficiary(pool, orgId, name, place) {
  const trimmedName = name ? String(name).trim() : ''

  if (trimmedName) {
    const { rows } = await pool.query(
      `SELECT uid, name, contact_no FROM indirect_beneficiaries
       WHERE org_id = $1 AND lower(trim(name)) = lower($2)`,
      [orgId, trimmedName]
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
      `INSERT INTO indirect_beneficiaries (org_id, uid, name, place, source)
       VALUES ($1,$2,$3,$4,'income')`,
      [orgId, uid, trimmedName || null, place || null]
    )
    await client.query('COMMIT')
    return { uid, type: 'Indirect Beneficiary', name: trimmedName || null, contact_no: null }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// GET /api/income?beneficiary_type=&search=&page=
router.get('/income', async (req, res) => {
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
      where.push(`(beneficiary_uid ILIKE $${values.length} OR beneficiary_name ILIKE $${values.length} OR income_source ILIKE $${values.length})`)
    }
    const whereSql = where.join(' AND ')

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE beneficiary_type = 'Individual Beneficiary')::int AS individual,
              count(*) FILTER (WHERE beneficiary_type = 'Micro-Entrepreneur')::int AS entrepreneur,
              count(*) FILTER (WHERE beneficiary_type = 'Collective')::int AS collective,
              count(*) FILTER (WHERE beneficiary_type = 'Indirect Beneficiary')::int AS indirect,
              count(DISTINCT beneficiary_uid)::int AS unique_beneficiaries,
              coalesce(sum(income_realised), 0)::float8 AS total_income
       FROM income WHERE ${whereSql}`,
      values
    )
    const kpiRow = countRows[0] || {}

    const { rows: sourceRows } = await pool.query(
      `SELECT income_source AS label, count(*)::int AS total, coalesce(sum(income_realised), 0)::float8 AS amount
       FROM income WHERE ${whereSql}
       GROUP BY income_source ORDER BY amount DESC`,
      values
    )

    const { rows } = await pool.query(
      `SELECT id, beneficiary_uid, beneficiary_type, beneficiary_name, contact_no,
              financial_year, income_source, income_realised, place, created_at
       FROM income
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
        totalIncome:         kpiRow.total_income || 0,
      },
      sourceBreakdown: sourceRows,
    })
  } catch (e) {
    console.error('[income GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/income/bulk-upload
// Body: { rows: [{ uid, name, financial_year, income_source, income_realised, place }] }
// Sheet names are preview-only when a UID is given; only what the UID resolves to is
// stored (as in trainings.routes.js). A blank UID becomes an Indirect Beneficiary.
router.post('/income/bulk-upload', async (req, res) => {
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
      const fy     = String(r.financial_year || '').trim()
      const source = String(r.income_source || '').trim()

      if (!fy) {
        errors.push({ row: i + 1, uid, error: 'Financial Year is required' })
        continue
      }
      if (!INCOME_SOURCES.includes(source)) {
        errors.push({ row: i + 1, uid, error: `Source must be one of: ${INCOME_SOURCES.join(', ')}` })
        continue
      }

      let beneficiary
      try {
        beneficiary = uid
          ? await lookupBeneficiary(pool, orgId, uid)
          : await resolveIndirectBeneficiary(pool, orgId, r.name, r.place)
      } catch (e) {
        errors.push({ row: i + 1, uid, error: 'Lookup failed: ' + e.message })
        continue
      }
      if (beneficiary.error) {
        errors.push({ row: i + 1, uid, error: beneficiary.error })
        continue
      }

      const amount = r.income_realised != null && r.income_realised !== '' ? Number(r.income_realised) : null
      if (amount != null && Number.isNaN(amount)) {
        errors.push({ row: i + 1, uid, error: 'Income realised in INR must be a number' })
        continue
      }

      try {
        // Duplicate = same identity (uid + financial year + source) and identical
        // content (lib/misUpsertHelpers.js); other years/sources are new rows.
        const outcome = await upsertMisRow(pool, {
          table: 'income',
          identity: { org_id: orgId, project_key, beneficiary_uid: beneficiary.uid, financial_year: fy, income_source: source },
          content: { beneficiary_type: beneficiary.type, beneficiary_name: beneficiary.name, contact_no: beneficiary.contact_no, income_realised: amount, place: r.place || null },
          audit: { uploaded_by: req.user.name || 'unknown' },
        })
        if (outcome === 'new') created += 1
        else if (outcome === 'updated') updated += 1
        else { duplicates += 1; warnings.push({ row: i + 1, uid: beneficiary.uid, warning: 'Duplicate — an identical income record already exists (same beneficiary, financial year, source and amount)' }) }
      } catch (e) {
        errors.push({ row: i + 1, uid, error: 'Save failed: ' + e.message })
      }
    }

    res.json({ ok: true, saved: created + updated, created, updated, duplicates, skipped: errors.length, errors, warnings })
  } catch (e) {
    console.error('[income bulk-upload]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
