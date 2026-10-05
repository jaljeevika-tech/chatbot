// Beneficiary MIS Progress Report: per-beneficiary dataset (Block > Panchayat >
// Village, trainings, social security, convergence, livelihood flags). Schema in 027.
//
//   GET  /api/projects/:projectKey/beneficiary-mis                  — filters + KPIs/charts + paginated rows
//   POST /api/projects/:projectKey/beneficiary-mis                  — bulk upload/upsert (one request, all blocks)
//   POST /api/projects/:projectKey/beneficiary-mis/planning-report  — AI planning analysis (deterministic gap flags + narrative)

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { runAI } from '../lib/ai/runAI.js'

const router = Router()

// Coverage flag groups; keys match the `attributes` JSONB written by the parsers.
// "Covered" = non-empty and not "no"/"na" (the sheet marks Yes / a date / FY / scheme name).
const TRAINING_FLAGS = [
  { key: 'training_pond_water_mgmt', label: 'Pond & Water Mgmt' },
  { key: 'training_feeding_practice', label: 'Feeding Practice' },
  { key: 'training_health_mgmt', label: 'Health Management' },
  { key: 'training_post_harvest', label: 'Post Harvest' },
  { key: 'fin_literacy_trg', label: 'Financial Literacy' },
]
const COMPONENT_FLAGS = [
  { key: 'credit_linkage', label: 'Credit Linkage' },
  { key: 'agri_dept_convergence', label: 'Agri Dept Convergence' },
  { key: 'horti_dept_convergence', label: 'Horti Dept Convergence' },
  { key: 'member_pg', label: 'Member of Jaljeevika PG' },
  { key: 'pen_culture_benf', label: 'Pen Culture Beneficiary' },
  { key: 'pond_based_aquaculture', label: 'Pond Based Aquaculture' },
  { key: 'makhana_benf_farmer', label: 'Makhana Farmer' },
  { key: 'singhara_benf_farmer', label: 'Singhara Farmer' },
  { key: 'fish_seed_nursery', label: 'Fish Seed Nursery' },
  { key: 'fish_seed_nursery_training', label: 'Fish Seed Nursery Training' },
  { key: 'ifs_primary', label: 'IFS - Primary' },
  { key: 'ifs_secondary', label: 'IFS - Secondary' },
  { key: 'jhang_model', label: 'Jhang Model' },
  { key: 'goat_camp', label: 'Goat Camp' },
  { key: 'cold_storage_benf', label: 'Cold Storage' },
  { key: 'ice_box', label: 'Ice Box' },
  { key: 'affordable_hatchery_pg', label: 'Affordable Hatchery (PG)' },
  { key: 'vendors_pg_members', label: 'Vendors PG Members' },
  { key: 'exposure_visit', label: 'Exposure Visit' },
  { key: 'ffpo_member', label: 'FFPO Member' },
  { key: 'social_security_1', label: 'Social Security 1' },
  { key: 'social_security_2', label: 'Social Security 2' },
  { key: 'social_security_3', label: 'Social Security 3' },
]

// SQL: true when attributes->>key is covered per the rule above.
function coveredExpr(key) {
  return `(attributes->>'${key}' IS NOT NULL AND trim(attributes->>'${key}') <> '' AND lower(trim(attributes->>'${key}')) NOT IN ('no', 'na'))`
}

// Benf. Type is free text against a numbered legend, so exports mix "Individual",
// "Individual (1)", "1", "Coop. Member (2)", "Fish vendor(3)"… for 4-5 real categories.
// Order matters: vendor/coop/both/all are checked before the bare "individual" fallback.
const BENF_TYPE_NORM = `
  CASE
    WHEN benf_type IS NULL OR trim(benf_type) = '' THEN 'Unspecified'
    WHEN benf_type ~* 'vendor|\\(3\\)|^3$' THEN 'Fish Vendor'
    WHEN benf_type ~* 'coop|collective|\\(2\\)|^2$' THEN 'Cooperative Member'
    WHEN benf_type ~* 'all|1&2&3' THEN 'All'
    WHEN benf_type ~* 'both|1&2(?!&3)' THEN 'Both'
    WHEN benf_type ~* 'individual|\\(1\\)|^1$' THEN 'Individual'
    ELSE trim(benf_type)
  END
`

// Shared by the GET grid and the planning-report endpoint so the aggregates live once.
async function getBeneficiaryStats(pool, orgId, projectKey, { block, panchayat, search } = {}) {
  const { rows: blockRows } = await pool.query(
    `SELECT DISTINCT block FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2 ORDER BY block`,
    [orgId, projectKey]
  )
  const panchayatParams = block ? [orgId, projectKey, block] : [orgId, projectKey]
  const { rows: panchayatRows } = await pool.query(
    `SELECT DISTINCT panchayat FROM beneficiary_mis_records
     WHERE org_id = $1 AND project_key = $2 ${block ? 'AND block = $3' : ''} AND panchayat IS NOT NULL
     ORDER BY panchayat`,
    panchayatParams
  )

  const where = ['org_id = $1', 'project_key = $2']
  const params = [orgId, projectKey]
  if (block) { params.push(block); where.push(`block = $${params.length}`) }
  if (panchayat) { params.push(panchayat); where.push(`panchayat = $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    where.push(`(beneficiary_name ILIKE $${params.length} OR village ILIKE $${params.length})`)
  }
  const whereSql = where.join(' AND ')

  const { rows: [agg] } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE ${coveredExpr('member_pg')})::int AS pg_members,
       coalesce(sum(income_realised), 0)::float8 AS income_sum,
       coalesce(sum(convergence_amount), 0)::float8 AS convergence_sum
     FROM beneficiary_mis_records WHERE ${whereSql}`,
    params
  )

  const { rows: blockCounts } = await pool.query(
    `SELECT block AS label, count(*)::int AS total
     FROM beneficiary_mis_records WHERE ${whereSql}
     GROUP BY block ORDER BY total DESC`,
    params
  )

  const { rows: benfTypeCounts } = await pool.query(
    `SELECT ${BENF_TYPE_NORM} AS label, count(*)::int AS total
     FROM beneficiary_mis_records WHERE ${whereSql}
     GROUP BY 1 ORDER BY total DESC`,
    params
  )

  // Top panchayats by beneficiary count, for the drill-down
  const { rows: panchayatCounts } = await pool.query(
    `SELECT panchayat AS label, count(*)::int AS total
     FROM beneficiary_mis_records WHERE ${whereSql} AND panchayat IS NOT NULL
     GROUP BY panchayat ORDER BY total DESC LIMIT 8`,
    params
  )

  // Per-type economics: avg income/area, not just headcount
  const { rows: typeEconomics } = await pool.query(
    `SELECT ${BENF_TYPE_NORM} AS label,
            count(*)::int AS total,
            coalesce(avg(income_realised), 0)::float8 AS avg_income,
            coalesce(avg(cultivating_area_acre), 0)::float8 AS avg_area
     FROM beneficiary_mis_records WHERE ${whereSql}
     GROUP BY 1 ORDER BY total DESC`,
    params
  )

  // Income per acre, only over rows with both fields populated
  const { rows: [ratio] } = await pool.query(
    `SELECT coalesce(avg(income_realised / NULLIF(cultivating_area_acre, 0)), 0)::float8 AS avg_income_per_acre
     FROM beneficiary_mis_records
     WHERE ${whereSql} AND income_realised IS NOT NULL AND cultivating_area_acre IS NOT NULL AND cultivating_area_acre > 0`,
    params
  )

  const trainingSelect = TRAINING_FLAGS
    .map(f => `count(*) FILTER (WHERE ${coveredExpr(f.key)})::int AS "${f.key}"`)
    .join(', ')
  const { rows: [trainingRow] } = await pool.query(
    `SELECT ${trainingSelect} FROM beneficiary_mis_records WHERE ${whereSql}`,
    params
  )
  const trainingCoverage = TRAINING_FLAGS.map(f => ({
    label: f.label,
    count: trainingRow[f.key] || 0,
    pct: agg.total > 0 ? Math.round(((trainingRow[f.key] || 0) / agg.total) * 100) : 0,
  }))

  const componentSelect = COMPONENT_FLAGS
    .map(f => `count(*) FILTER (WHERE ${coveredExpr(f.key)})::int AS "${f.key}"`)
    .join(', ')
  const { rows: [componentRow] } = await pool.query(
    `SELECT ${componentSelect} FROM beneficiary_mis_records WHERE ${whereSql}`,
    params
  )
  const componentCoverage = COMPONENT_FLAGS
    .map(f => ({ label: f.label, count: componentRow[f.key] || 0 }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count)

  return {
    blocks: blockRows.map(r => r.block),
    panchayats: panchayatRows.map(r => r.panchayat),
    kpis: {
      total: agg.total,
      pgMembers: agg.pg_members,
      incomeSum: agg.income_sum,
      convergenceSum: agg.convergence_sum,
      avgIncomePerAcre: ratio.avg_income_per_acre,
    },
    blockCounts,
    benfTypeCounts,
    panchayatCounts,
    typeEconomics,
    trainingCoverage,
    componentCoverage,
    // Internal: reused by the GET handler's paginated query, not part of the public stats
    _where: whereSql,
    _params: params,
  }
}

// GET /api/beneficiary-mis-template.xlsx — blank template, one sheet per Block.
// Headers match UploadBeneficiaryMisModal.tsx's COLUMN_RULES; "PIP" sheets are skipped on parse.
router.get('/beneficiary-mis-template.xlsx', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const XLSX = (await import('xlsx')).default
    const wb = XLSX.utils.book_new()

    const header = [
      'Sl No', 'Block', 'Panchayat', 'Village', 'Beneficiary Name', 'Primary or Secondary',
      'Farmer ID', 'Contact No', 'Benf. Type [Individual Pond Farmer (1)/Cooperative Member (2)/Both (1&2)/Fish Vendor (3)/All (1&2&3)]',
      'Cooperative Name', 'Cultivating Area (Katha)', 'Cultivating Area (Acre)',
      'Training 1 (Pond & Water Mgmt)', 'Training 2 (Feeding Practice)', 'Training 3 (Health Mgmt)', 'Training 4 (Post Harvest)',
      'Fin. Literacy Trg.', 'Social Security 1', 'Social Security 2', 'Social Security 3',
      'Credit Linkage', 'Agri Dept. Convergence', 'Horti Dept. Convergence', 'Member of Jaljeevika PG',
      'Pen Culture Beneficiary', 'Pond Based Aquaculture', 'Makhana Beneficiary Farmer', 'Singhara Beneficiary Farmer',
      'Fish Seed Nursery Training', 'Fish Seed Nursery', 'IFS - Primary', 'IFS - Secondary', 'Jhang Model',
      'Goat Camp', 'Cold Storage Beneficiary', 'Ice Box', 'Affordable Hatchery (PG)', 'Vendors PG Members',
      'Exposure Visit', 'FFPO Member', 'Income Realised', 'Convergence Amount',
    ]

    const sampleRow = (sl, name, village) => [
      sl, '', '', village, name, 'Primary',
      `F-${1000 + sl}`, '98765432' + String(10 + sl), 'Individual (1)',
      '', 12, 0.4,
      'Yes', 'Yes', '', '',
      'Yes', '', '', '',
      'Yes', '', '', 'Yes',
      '', '', '', '',
      '', '', '', '', '',
      '', '', '', '', '',
      '', '', 25000, 5000,
    ]

    const BLOCKS = [
      { name: 'Khagaria', villages: ['Beldaur', 'Gogri'] },
      { name: 'Alauli', villages: ['Rampur'] },
    ]

    for (const block of BLOCKS) {
      const rows = [header]
      block.villages.forEach((village, i) => {
        rows.push(sampleRow(i + 1, `Sample Beneficiary ${i + 1}`, village))
      })
      const ws = XLSX.utils.aoa_to_sheet(rows)
      ws['!cols'] = header.map(h => ({ wch: Math.min(Math.max(h.length, 10), 30) }))
      // Sheet NAME is the Block — parseWorkbook() reads it from wb.SheetNames, not a column.
      XLSX.utils.book_append_sheet(wb, ws, block.name.slice(0, 31))
    }

    const readme = [
      ['Beneficiary MIS — Upload Template'],
      [''],
      ['One worksheet PER BLOCK. The sheet NAME is the Block name (not a column) —'],
      ['rename each sheet tab to your own Block, and add one sheet per Block.'],
      ['Each row below the header is one beneficiary.'],
      [''],
      ['Required columns: Sl No, Block-sheet name, Beneficiary Name.'],
      ['All other columns are optional — leave blank if not applicable.'],
      ['Training/Social Security/component columns accept "Yes", a date, or a scheme name;'],
      ['blank means "not done". Do not add a sheet named "PIP" — that name is reserved and skipped on upload.'],
    ]
    const wsReadme = XLSX.utils.aoa_to_sheet(readme)
    wsReadme['!cols'] = [{ wch: 100 }]
    XLSX.utils.book_append_sheet(wb, wsReadme, 'README')

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="beneficiary-mis-template.xlsx"')
    res.send(buf)
  } catch (e) {
    console.error('[beneficiary-mis template]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/projects/:projectKey/beneficiary-mis', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const block = (req.query.block || '').trim()
    const panchayat = (req.query.panchayat || '').trim()
    const search = (req.query.search || '').trim()
    const page = Math.max(0, parseInt(req.query.page) || 0)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50))

    const stats = await getBeneficiaryStats(pool, orgId, projectKey, { block, panchayat, search })
    const { _where: whereSql, _params: params, ...publicStats } = stats

    const rowParams = [...params, pageSize, page * pageSize]
    const { rows } = await pool.query(
      `SELECT id, block, panchayat, village, beneficiary_name, benf_type, cooperative_name,
              cultivating_area_acre::float8 AS cultivating_area_acre,
              income_realised::float8 AS income_realised,
              convergence_amount::float8 AS convergence_amount
       FROM beneficiary_mis_records
       WHERE ${whereSql}
       ORDER BY block, panchayat NULLS LAST, village NULLS LAST, beneficiary_name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      rowParams
    )

    res.json({
      ...publicStats,
      rows,
      totalRows: stats.kpis.total,
      page,
      pageSize,
    })
  } catch (e) {
    console.error('[beneficiary-mis GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/projects/:projectKey/beneficiary-mis — bulk upload/upsert.
// Body: { rows: [{ block, panchayat, village, sl_no, beneficiary_name, farmer_id,
//   contact_no, benf_type, cooperative_name, cultivating_area_katha,
//   cultivating_area_acre, income_realised, convergence_amount, attributes }] }
router.post('/projects/:projectKey/beneficiary-mis', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows } = req.body || {}
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const pool = getPool()
    const client = await pool.connect()
    let count = 0
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        const block = String(r.block || '').trim()
        const name = String(r.beneficiary_name || '').trim()
        if (!block || !name) continue
        await client.query(
          `INSERT INTO beneficiary_mis_records
             (org_id, project_key, block, panchayat, village, sl_no, beneficiary_name, farmer_id,
              contact_no, benf_type, cooperative_name, cultivating_area_katha, cultivating_area_acre,
              income_realised, convergence_amount, attributes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (org_id, project_key, block, sl_no, beneficiary_name)
             DO UPDATE SET panchayat = $4, sl_no = $6, farmer_id = $8, contact_no = $9,
                           benf_type = $10, cooperative_name = $11, cultivating_area_katha = $12,
                           cultivating_area_acre = $13, income_realised = $14, convergence_amount = $15,
                           attributes = $16, uploaded_by = $17, updated_at = NOW()`,
          [
            req.user.orgId, req.params.projectKey, block, r.panchayat || null, r.village || null,
            Number.isFinite(r.sl_no) ? r.sl_no : null, name, r.farmer_id || null, r.contact_no || null,
            r.benf_type || null, r.cooperative_name || null,
            r.cultivating_area_katha ?? null, r.cultivating_area_acre ?? null,
            r.income_realised ?? null, r.convergence_amount ?? null,
            JSON.stringify(r.attributes || {}), req.user.name || 'unknown',
          ]
        )
        count += 1
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({ ok: true, count })
  } catch (e) {
    console.error('[beneficiary-mis POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/projects/:projectKey/beneficiary-mis?block=Khagaria
// Admin-only: removes every record for one Block (the workbook is one sheet per
// Block), e.g. to clear a bad upload. No undo.
router.delete('/projects/:projectKey/beneficiary-mis', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const block = String(req.query.block || '').trim()
    if (!block) return res.status(400).json({ error: 'block query param required' })

    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM beneficiary_mis_records WHERE org_id = $1 AND project_key = $2 AND block = $3`,
      [req.user.orgId, req.params.projectKey, block]
    )
    if (!rowCount) return res.status(404).json({ error: 'No records found for that Block' })

    pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,'beneficiary_mis.delete','beneficiary_mis_records',$4,$5)`,
      [req.user.orgId, req.user.uid, req.user.name, req.params.projectKey,
       JSON.stringify({ project_key: req.params.projectKey, block, record_count: rowCount })]
    ).catch(() => {})

    res.json({ ok: true, deleted: rowCount })
  } catch (e) {
    console.error('[beneficiary-mis DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── AI Planning Analysis ────────────────────────────────────────────────────
// Deterministic gap flags → templated narrative → one batched AI call to improve it
// (same layering as the /insights routes). AI failure falls back to the template, never a 5xx.
const LOW_COVERAGE_PCT_FLOOR = 50        // training/component coverage below this % is a planning gap
const UNDER_COVERED_GEOGRAPHY_FACTOR = 0.4  // a block with <40% of the average block's headcount is under-covered
const ECONOMIC_GAP_FACTOR = 0.6          // a type/panchayat averaging <60% of the overall avg income/acre is a gap

function computePlanningFlags(stats) {
  const flags = []

  for (const t of stats.trainingCoverage) {
    if (t.pct < LOW_COVERAGE_PCT_FLOOR) {
      flags.push({ type: 'low_coverage', reason: `Only ${t.pct}% of beneficiaries have completed "${t.label}" training — below the ${LOW_COVERAGE_PCT_FLOOR}% planning floor` })
    }
  }

  if (stats.blockCounts.length > 1) {
    const avgBlockCount = stats.blockCounts.reduce((s, b) => s + b.total, 0) / stats.blockCounts.length
    for (const b of stats.blockCounts) {
      if (b.total < avgBlockCount * UNDER_COVERED_GEOGRAPHY_FACTOR) {
        flags.push({ type: 'under_covered_geography', reason: `Block "${b.label}" has only ${b.total} beneficiaries, well below the ${Math.round(avgBlockCount)}-beneficiary average across blocks` })
      }
    }
  }

  const overallAvgIncomePerAcre = stats.kpis.avgIncomePerAcre
  if (overallAvgIncomePerAcre > 0) {
    for (const t of stats.typeEconomics) {
      if (t.avg_income > 0 && t.avg_area > 0) {
        const incomePerAcre = t.avg_income / t.avg_area
        if (incomePerAcre < overallAvgIncomePerAcre * ECONOMIC_GAP_FACTOR) {
          flags.push({ type: 'economic_gap', reason: `"${t.label}" beneficiaries average ₹${Math.round(incomePerAcre).toLocaleString('en-IN')}/acre, well below the ₹${Math.round(overallAvgIncomePerAcre).toLocaleString('en-IN')}/acre overall average` })
        }
      }
    }
  }

  return flags
}

function templatedNarrative(stats, flags) {
  const parts = [
    `${stats.kpis.total} beneficiaries recorded across ${stats.blockCounts.length} block(s).`,
    flags.length ? `${flags.length} planning gap(s) identified.` : 'No major coverage or economic gaps detected against current thresholds.',
  ]
  return parts.join(' ')
}

function templatedRecommendations(flags) {
  return flags.map(f => ({
    title: f.type === 'low_coverage' ? 'Close training coverage gap' : f.type === 'under_covered_geography' ? 'Increase geographic coverage' : 'Address economic disparity',
    detail: f.reason,
    relatedFlag: f.type,
  }))
}

router.post('/projects/:projectKey/beneficiary-mis/planning-report', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const orgId = req.user.orgId
    const projectKey = req.params.projectKey
    const block = (req.body?.block || '').trim()
    const panchayat = (req.body?.panchayat || '').trim()
    const search = (req.body?.search || '').trim()

    const stats = await getBeneficiaryStats(pool, orgId, projectKey, { block, panchayat, search })
    const { _where, _params, ...publicStats } = stats

    if (stats.kpis.total === 0) {
      return res.json({ narrative: 'No beneficiary data uploaded yet for this project/filter — upload a Beneficiary MIS sheet first.', recommendations: [], flags: [], stats: publicStats })
    }

    const flags = computePlanningFlags(publicStats)
    let narrative = templatedNarrative(publicStats, flags)
    let recommendations = templatedRecommendations(flags)

    try {
      const systemPrompt =
        `You are a livelihoods program planning assistant for an NGO. Given computed beneficiary ` +
        `coverage/economics statistics and a list of flagged planning gaps, write a SHORT (2-4 sentence) ` +
        `plain-English overview, then produce 3-6 prioritized recommendations for the NEXT planning cycle, ` +
        `each naming which gap it addresses. Use only the numbers given — never invent figures. Respond ` +
        `with strict JSON only: {"narrative": "...", "recommendations": [{"title": "...", "detail": "...", ` +
        `"relatedFlag": "<flag type or null>"}], "flags": [{"type": "...", "reason": "..."}]}. Include every ` +
        `flag given, do not invent new ones.`
      const userPrompt = JSON.stringify({ stats: publicStats, flags })
      const out = await runAI({
        feature: 'beneficiaries', operation: 'planning_report', prompt: userPrompt, systemPrompt,
        orgId, userId: req.user.uid,
      }, { jsonMode: true, maxTokens: 1536, temperature: 0.3 })

      const parsed = typeof out?.text === 'string' ? JSON.parse(out.text) : out?.text
      if (parsed?.narrative && Array.isArray(parsed?.recommendations) && Array.isArray(parsed?.flags)) {
        narrative = parsed.narrative
        recommendations = parsed.recommendations
      }
    } catch (e) {
      console.warn('[beneficiary-mis planning-report] AI narrative unavailable, using fallback:', e.message)
    }

    res.json({ narrative, recommendations, flags, stats: publicStats })
  } catch (e) {
    console.error('[beneficiary-mis planning-report]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
