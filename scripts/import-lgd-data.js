#!/usr/bin/env node
/**
 * scripts/import-lgd-data.js
 * ───────────────────────────
 * Seeds the LGD reference tables created by
 * db/migrations/035_lgd_admin_divisions.sql (lgd_states, lgd_districts,
 * lgd_blocks, lgd_panchayats, lgd_villages) that back the State → District →
 * Block → Panchayat → Village dropdowns on the "+ New Project" form. Source
 * data + provenance: db/seed-data/lgd/README.md.
 *
 * Usage:
 *   node scripts/import-lgd-data.js
 *
 * Safe to re-run — every insert is ON CONFLICT (code) DO UPDATE. Takes a few
 * minutes (the village table is ~690k rows).
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'
import { getPool } from '../db/pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../db/seed-data/lgd')

function readCsvGz(file) {
  const buf = fs.readFileSync(path.join(DATA_DIR, file))
  const text = zlib.gunzipSync(buf).toString('utf8')
  const { data, errors } = Papa.parse(text, { header: true, skipEmptyLines: true })
  if (errors.length) console.log(`  ⚠️   ${file}: ${errors.length} parse warnings (first: ${errors[0].message})`)
  return data
}

const toInt = v => {
  const n = parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : null
}
const clean = v => String(v ?? '').trim()

// Batched, parameterized multi-row upsert. `cols` are the destination column
// names in order; `rows` are arrays of values in the same order.
async function upsert(pool, table, cols, rows, conflictCol = 'code', chunk = 2000) {
  const updateCols = cols.filter(c => c !== conflictCol)
  const setSql = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
  let done = 0
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const values = []
    const placeholders = slice.map((row, ri) => {
      const ph = cols.map((_, ci) => { values.push(row[ci]); return `$${ri * cols.length + ci + 1}` })
      return `(${ph.join(', ')})`
    })
    await pool.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders.join(', ')}
       ON CONFLICT (${conflictCol}) DO UPDATE SET ${setSql}`,
      values
    )
    done += slice.length
    process.stdout.write(`\r  ${table}: ${done}/${rows.length}`)
  }
  console.log(`\r  ✅  ${table}: ${done}/${rows.length} rows`)
}

async function main() {
  const pool = getPool()
  console.log('🚀  Importing LGD administrative division data\n')

  // ── States ──────────────────────────────────────────────────────────────
  const stateRows = readCsvGz('states.csv.gz')
  const states = stateRows
    .map(r => ({ code: toInt(r['State Code']), name: clean(r['State Name']), isUt: clean(r['State or UT']) === 'U' }))
    .filter(s => s.code != null && s.name)
  await upsert(pool, 'lgd_states', ['code', 'name', 'is_ut'], states.map(s => [s.code, s.name, s.isUt]))
  const stateCodes = new Set(states.map(s => s.code))

  // ── Districts ───────────────────────────────────────────────────────────
  const districtRows = readCsvGz('districts.csv.gz')
  const districts = districtRows
    .map(r => ({ code: toInt(r['District Code']), name: clean(r['District Name']), stateCode: toInt(r['State Code']) }))
    .filter(d => d.code != null && d.name && stateCodes.has(d.stateCode))
  await upsert(pool, 'lgd_districts', ['code', 'name', 'state_code'], districts.map(d => [d.code, d.name, d.stateCode]))
  const districtCodes = new Set(districts.map(d => d.code))

  // ── Blocks ──────────────────────────────────────────────────────────────
  // A handful of Block Codes appear twice (e.g. a block moved to a newly
  // split-off district but kept its code in both rows) — a single INSERT
  // can't upsert the same conflict target twice, so dedupe by code first,
  // keeping the last occurrence (LGD lists reorganizations after the row
  // they superseded).
  // blocks.csv has two unlabeled name columns distinguished only by a
  // trailing space in the header: 'Block Name ' (trailing space) is English
  // ("ALINAGAR"); 'Block Name' (no trailing space) is the local-language
  // name ("अलीनगर") where LGD has one, empty otherwise. Try English first —
  // getting this order backwards (as a previous version of this script did)
  // silently imports Devanagari/local-script names for every state that has
  // a local-language block name (e.g. all of Bihar), while states without
  // one (e.g. Andaman) still came out in English, masking the bug for years.
  const blockRows = readCsvGz('blocks.csv.gz')
  const blockByCode = new Map()
  for (const r of blockRows) {
    const code = toInt(r['Block Code'])
    const name = clean(r['Block Name ']) || clean(r['Block Name'])
    const districtCode = toInt(r['District Code'])
    const stateCode = toInt(r['State Code'])
    if (code == null || !name || !stateCodes.has(stateCode) || !districtCodes.has(districtCode)) continue
    blockByCode.set(code, { code, name, districtCode, stateCode })
  }
  const blocks = [...blockByCode.values()]
  await upsert(pool, 'lgd_blocks', ['code', 'name', 'district_code', 'state_code'],
    blocks.map(b => [b.code, b.name, b.districtCode, b.stateCode]))
  const blockCodes = new Set(blocks.map(b => b.code))

  // ── Panchayats (Village Panchayat tier of rural-local-body.csv) ─────────
  const rlbRows = readCsvGz('rural-local-body.csv.gz')
  const panchayatMeta = new Map() // code -> { name, stateCode }
  for (const r of rlbRows) {
    if (clean(r['Local Body Type Code']) !== '3') continue // 3 = Village Panchayat
    const code = toInt(r['Local Body Code'])
    const stateCode = toInt(r['State Code'])
    const name = clean(r['Local Body Name (IN English)'])
    if (code == null || !name || !stateCodes.has(stateCode)) continue
    panchayatMeta.set(code, { name, stateCode })
  }
  console.log(`  parsed ${panchayatMeta.size} village panchayats from rural-local-body.csv`)

  // ── Villages + empirical Panchayat → Block linkage ─────────────────────
  // rural-local-body.csv's own "Intermediate/Block Panchayat Code" is a
  // *different* LGD code namespace from administrative/blocks.csv's Block
  // Code (see db/seed-data/lgd/README.md), so instead we derive each
  // Panchayat's Block from the Block its member villages actually report —
  // whichever Block code is most common among them.
  // ~19.8k Village Codes also appear more than once — usually one copy with
  // a Panchayat ("Localbody") mapped and a duplicate without, or (rarely) two
  // different Panchayats both claiming the same village. Dedupe by code,
  // preferring whichever occurrence has a Panchayat mapped (more complete)
  // over one that doesn't, so the same one-INSERT-per-conflict-target
  // constraint that bit Blocks above doesn't bite here too.
  const villageRows = readCsvGz('village-directory.csv.gz')
  const villageByCode = new Map()
  let skippedNoCode = 0
  for (const r of villageRows) {
    const code = toInt(r['Village code'])
    if (code == null || !clean(r['Village Name(In English)'])) { skippedNoCode++; continue }
    const existing = villageByCode.get(code)
    if (!existing || (!clean(existing['Localbody Code']) && clean(r['Localbody Code']))) {
      villageByCode.set(code, r)
    }
  }

  const panchayatBlockVotes = new Map() // panchayatCode -> Map<blockCode, count>
  const villages = []
  let skippedNoDistrict = 0

  for (const r of villageByCode.values()) {
    const code = toInt(r['Village code'])
    const name = clean(r['Village Name(In English)'])
    const stateCode = toInt(r['State code'])
    const districtCode = toInt(r['District code'])
    if (!stateCodes.has(stateCode) || !districtCodes.has(districtCode)) { skippedNoDistrict++; continue }

    const subdistrictCode = toInt(r['Subdistrict code'])
    const subdistrictName = clean(r['Subdistrict Name(In English)']) || null
    let blockCode = toInt(r['Block code'])
    if (blockCode != null && !blockCodes.has(blockCode)) blockCode = null
    const panchayatCode = toInt(r['Localbody Code'])

    if (panchayatCode != null && blockCode != null) {
      let votes = panchayatBlockVotes.get(panchayatCode)
      if (!votes) panchayatBlockVotes.set(panchayatCode, votes = new Map())
      votes.set(blockCode, (votes.get(blockCode) ?? 0) + 1)
    }

    villages.push([
      code, name, stateCode, districtCode, subdistrictCode, subdistrictName,
      blockCode, (panchayatCode != null && panchayatMeta.has(panchayatCode)) ? panchayatCode : null,
    ])
  }
  if (skippedNoCode || skippedNoDistrict) {
    console.log(`  ⚠️   skipped ${skippedNoCode} villages with no code/name, ${skippedNoDistrict} with unrecognized state/district`)
  }

  // Finalize panchayats with their derived block_code, then insert (before
  // villages, since villages.panchayat_code references lgd_panchayats).
  const panchayatRows = []
  for (const [code, meta] of panchayatMeta) {
    const votes = panchayatBlockVotes.get(code)
    let blockCode = null
    if (votes) {
      let best = -1
      for (const [bc, n] of votes) if (n > best) { best = n; blockCode = bc }
    }
    panchayatRows.push([code, meta.name, blockCode, meta.stateCode])
  }
  await upsert(pool, 'lgd_panchayats', ['code', 'name', 'block_code', 'state_code'], panchayatRows)

  await upsert(pool, 'lgd_villages',
    ['code', 'name', 'state_code', 'district_code', 'subdistrict_code', 'subdistrict_name', 'block_code', 'panchayat_code'],
    villages)

  console.log('\n🎉  LGD import complete.')
  await pool.end()
}

main().catch(err => {
  console.error('\n❌  Import failed:', err.message)
  console.error(err.stack)
  process.exit(1)
})
