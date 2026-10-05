// scripts/backfill-pii-encryption.mjs — DPDP Phase 4 backfill.
//
// For every row in individual_beneficiaries / micro_entrepreneurs /
// collectives registered BEFORE the Phase 4 cutover (i.e. its *_enc
// columns are still empty but the legacy plaintext column has a value),
// encrypts/hashes the plaintext value into the new columns. Does NOT
// touch or clear the legacy plaintext columns — that's a deliberately
// separate, later, explicitly-confirmed step once the cutover is verified
// stable (see db/migrations/064_pii_encryption_columns.sql's header).
//
// Safe to re-run: only rows where the *_enc column is still NULL are
// touched, so a partial run (e.g. interrupted) picks up cleanly next time.
//
// INCIDENT NOTE (2026-08-20): this script was once run from a shell whose
// .env had no ENCRYPTION_KEY — lib/crypto.js's _key() silently fell back
// to a weak local-dev-only key instead of the real one from Secret
// Manager, so every row got encrypted with a key the deployed app could
// never decrypt. That was caught, reset, and correctly re-backfilled by
// running the same logic from INSIDE the deployed App Engine process
// (where the real key is already loaded), not from here. The guard below
// makes this exact mistake impossible to repeat: this script now refuses
// to run at all unless ENCRYPTION_KEY is explicitly present in its own
// environment — never rely on lib/crypto.js's dev fallback for this.
//
// Usage: ENCRYPTION_KEY=<the real key> node scripts/backfill-pii-encryption.mjs
// (or export it in the shell first) — if you don't have the real key
// locally, don't run this here; do it via a protected in-app path instead.
import 'dotenv/config'
import pg from 'pg'
import { encryptPii, hashContactNo } from '../lib/piiCrypto.js'

if (!(process.env.ENCRYPTION_KEY || '').trim()) {
  console.error('[backfill] REFUSING TO RUN: ENCRYPTION_KEY is not set in this process.')
  console.error('[backfill] Running without it would silently use the weak local-dev fallback key')
  console.error('[backfill] (lib/crypto.js) — data encrypted that way is NOT decryptable by the real')
  console.error('[backfill] app. See this file\'s header comment for what happened last time.')
  process.exit(1)
}

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// table -> { plainCol: encCol, ... } plus optional hash column, matching
// lib/piiCrypto.js's PII_FIELD_MAP (kept as a literal copy here rather than
// importing PII_FIELD_MAP directly, so this script's column list is
// visible at a glance without cross-referencing another file).
const JOBS = [
  { table: 'individual_beneficiaries', fields: [
    { plain: 'contact_no', enc: 'contact_no_enc', hash: 'contact_no_hash' },
    { plain: 'current_income_inr', enc: 'current_income_inr_enc' },
    { plain: 'panchayat', enc: 'panchayat_enc' },
  ]},
  { table: 'micro_entrepreneurs', fields: [
    { plain: 'contact_no', enc: 'contact_no_enc', hash: 'contact_no_hash' },
    { plain: 'current_revenue_inr', enc: 'current_revenue_inr_enc' },
    { plain: 'panchayat', enc: 'panchayat_enc' },
  ]},
  { table: 'collectives', fields: [
    { plain: 'contact_no', enc: 'contact_no_enc', hash: 'contact_no_hash' },
    { plain: 'per_capita_income_inr', enc: 'per_capita_income_inr_enc' },
    { plain: 'panchayat', enc: 'panchayat_enc' },
  ]},
]

async function backfillField(table, field) {
  const { plain, enc, hash } = field
  const { rows } = await client.query(
    `SELECT id, ${plain} FROM ${table} WHERE ${enc} IS NULL AND ${plain} IS NOT NULL`
  )
  if (!rows.length) {
    console.log(`[backfill] ${table}.${plain}: nothing to do`)
    return 0
  }
  let done = 0
  for (const row of rows) {
    const encVal  = encryptPii(row[plain])
    const hashVal = hash ? hashContactNo(row[plain]) : undefined
    const setCols = hash ? `${enc} = $2, ${hash} = $3` : `${enc} = $2`
    const values  = hash ? [row.id, encVal, hashVal] : [row.id, encVal]
    await client.query(`UPDATE ${table} SET ${setCols} WHERE id = $1`, values)
    done++
  }
  console.log(`[backfill] ${table}.${plain}: encrypted ${done} rows`)
  return done
}

async function main() {
  await client.connect()
  let total = 0
  for (const job of JOBS) {
    for (const field of job.fields) {
      total += await backfillField(job.table, field)
    }
  }
  console.log(`[backfill] done — ${total} column-values encrypted in total`)
  await client.end()
}

main().catch(e => {
  console.error('[backfill] FAILED:', e.message)
  process.exit(1)
})
