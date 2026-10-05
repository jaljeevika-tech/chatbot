#!/usr/bin/env node
// scripts/import-kosi-beneficiary-mis.mjs — ONE-OFF import of the real Kosi
// Sahjivan Beneficiary MIS Master Sheet into beneficiary_mis_records.
//
// What it does:
//   1. Applies db/migrations/027_beneficiary_mis_records.sql (idempotent — CREATE TABLE IF NOT EXISTS)
//   2. Resolves org_id for slug 'jaljeevika', project_key 'kosi'
//   3. Parses every sheet except "PIP" (one sheet per Block) from the source
//      workbook, mirroring UploadBeneficiaryMisModal.tsx's column-detection rules
//   4. Upserts all rows in one transaction, keyed by (org_id, project_key, block, sl_no, beneficiary_name)
//
// Usage: node scripts/import-kosi-beneficiary-mis.mjs
// Safe to re-run — upsert is idempotent, re-running just updates in place.

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import XLSX from 'xlsx'
import { getPool } from '../db/pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_FILE = 'C:\\Users\\infoj\\Downloads\\1.1 Kosi Sahjivan_Beneficiary MIS Master Sheet (1).xlsx'
const ORG_SLUG = 'jaljeevika'
// 'kosi' (this script's original value) is stale single-tenant seed data from
// 001_initial.sql's legacy `projects` list, NOT a real project_key — the
// actual project_key for "Kosi Sahajivan" comes from action_plans.project_key.
// Confirmed by querying action_plans directly: 'kosi-2026'. Using 'kosi' here
// created 1,491 orphaned duplicate rows nothing in the app ever queried
// (cleaned up manually — see conversation history, not a migration).
const PROJECT_KEY = 'kosi-2026'
const SKIP_SHEETS = new Set(['pip'])

const NUMERIC_FIELDS = new Set(['sl_no', 'cultivating_area_katha', 'cultivating_area_acre', 'income_realised', 'convergence_amount'])

const COLUMN_RULES = [
  [/^sl\.?\s*no/, 'sl_no', false],
  [/^block$/, 'block', false],
  [/^panchayat$/, 'panchayat', false],
  [/^village$/, 'village', false],
  [/beneficiary name/, 'beneficiary_name', false],
  [/primary or secondary/, 'primary_or_secondary', true],
  [/farmer id/, 'farmer_id', false],
  [/contact no/, 'contact_no', false],
  [/benf\.?\s*type/, 'benf_type', false],
  [/cooperative name/, 'cooperative_name', false],
  [/katha/, 'cultivating_area_katha', false],
  [/acre/, 'cultivating_area_acre', false],
  [/training\s*1/, 'training_pond_water_mgmt', true],
  [/training\s*2/, 'training_feeding_practice', true],
  [/training\s*3/, 'training_health_mgmt', true],
  [/training\s*4/, 'training_post_harvest', true],
  [/fin\.?\s*literacy|financial literacy/, 'fin_literacy_trg', true],
  [/social security 1/, 'social_security_1', true],
  [/social security 2/, 'social_security_2', true],
  [/social security 3/, 'social_security_3', true],
  [/credit linkage/, 'credit_linkage', true],
  [/agri dept\.?\s*convergence/, 'agri_dept_convergence', true],
  [/horti\.?\s*dept\.?\s*convergence/, 'horti_dept_convergence', true],
  [/member of jaljeevika pg/, 'member_pg', true],
  [/pen culture/, 'pen_culture_benf', true],
  [/pond based aquaculture/, 'pond_based_aquaculture', true],
  [/makhana/, 'makhana_benf_farmer', true],
  [/singhara/, 'singhara_benf_farmer', true],
  [/fish seed nursery.*training/, 'fish_seed_nursery_training', true],
  [/fish seed nursery/, 'fish_seed_nursery', true],
  [/ifs.*primary/, 'ifs_primary', true],
  [/ifs.*secondary/, 'ifs_secondary', true],
  [/jhang model/, 'jhang_model', true],
  [/goat camp/, 'goat_camp', true],
  [/cold storage/, 'cold_storage_benf', true],
  [/ice box/, 'ice_box', true],
  [/affordable hatchery/, 'affordable_hatchery_pg', true],
  [/vendors pg members/, 'vendors_pg_members', true],
  [/exposure visit/, 'exposure_visit', true],
  [/ffpo member/, 'ffpo_member', true],
  [/income realised/, 'income_realised', false],
  [/convergence amount/, 'convergence_amount', false],
]

function norm(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function cellToAttrValue(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim() || null
}

function parseWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true })
  const rows = []
  const blockCounts = {}

  for (const sheetName of wb.SheetNames) {
    if (SKIP_SHEETS.has(norm(sheetName))) continue
    const ws = wb.Sheets[sheetName]
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

    const headerIdx = grid.findIndex(r => r.some(c => /^sl\.?\s*no/.test(norm(c))) && r.some(c => norm(c) === 'block'))
    if (headerIdx < 0) continue
    const header = grid[headerIdx]

    const colMap = []
    header.forEach((h, col) => {
      const n = norm(h)
      if (!n) return
      const rule = COLUMN_RULES.find(([re]) => re.test(n))
      if (rule) colMap.push({ col, field: rule[1], isAttr: rule[2] })
    })
    if (!colMap.some(c => c.field === 'beneficiary_name')) continue

    let position = 0
    let sheetCount = 0
    const nameCol = colMap.find(c => c.field === 'beneficiary_name')?.col
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r]
      if (!row) continue
      const name = nameCol != null ? String(row[nameCol] || '').trim() : ''
      if (!name) continue
      position += 1

      const parsed = {
        block: sheetName.trim(), panchayat: null, village: null, sl_no: null,
        beneficiary_name: name, farmer_id: null, contact_no: null, benf_type: null,
        cooperative_name: null, cultivating_area_katha: null, cultivating_area_acre: null,
        income_realised: null, convergence_amount: null, attributes: {},
      }
      for (const { col, field, isAttr } of colMap) {
        if (field === 'beneficiary_name' || field === 'block') continue
        const raw = row[col]
        if (isAttr) {
          parsed.attributes[field] = cellToAttrValue(raw)
        } else if (NUMERIC_FIELDS.has(field)) {
          const n = Number(raw)
          parsed[field] = raw === '' || raw == null || isNaN(n) ? null : n
        } else {
          const s = String(raw ?? '').trim()
          parsed[field] = s || null
        }
      }
      if (parsed.sl_no == null) parsed.sl_no = position
      rows.push(parsed)
      sheetCount += 1
    }
    if (sheetCount > 0) blockCounts[sheetName.trim()] = sheetCount
  }

  return { rows, blockCounts }
}

async function main() {
  const pool = getPool()

  console.log('── Applying migration 027 ──')
  const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '027_beneficiary_mis_records.sql'), 'utf8')
  await pool.query(migrationSql)
  console.log('  OK')

  console.log('── Resolving org ──')
  const { rows: orgRows } = await pool.query('SELECT id FROM organizations WHERE slug = $1', [ORG_SLUG])
  if (!orgRows.length) throw new Error(`No organization found with slug '${ORG_SLUG}'`)
  const orgId = orgRows[0].id
  console.log(`  org_id = ${orgId}`)

  console.log('── Parsing workbook ──')
  const { rows, blockCounts } = parseWorkbook(SOURCE_FILE)
  console.log(`  Parsed ${rows.length} beneficiary rows:`, blockCounts)
  if (!rows.length) throw new Error('No rows parsed — aborting without writing anything')

  console.log('── Upserting ──')
  const client = await pool.connect()
  let count = 0
  try {
    await client.query('BEGIN')
    for (const r of rows) {
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
          orgId, PROJECT_KEY, r.block, r.panchayat, r.village,
          r.sl_no, r.beneficiary_name, r.farmer_id, r.contact_no,
          r.benf_type, r.cooperative_name, r.cultivating_area_katha, r.cultivating_area_acre,
          r.income_realised, r.convergence_amount, JSON.stringify(r.attributes), 'import-script',
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
  console.log(`  Upserted ${count} rows`)

  console.log('── Verifying ──')
  const { rows: verify } = await pool.query(
    `SELECT block, count(*)::int AS total FROM beneficiary_mis_records
     WHERE org_id = $1 AND project_key = $2 GROUP BY block ORDER BY block`,
    [orgId, PROJECT_KEY]
  )
  console.table(verify)

  await pool.end()
}

main().catch(e => {
  console.error('FAILED:', e)
  process.exit(1)
})
