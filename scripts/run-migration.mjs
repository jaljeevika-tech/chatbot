// General-purpose runner for any db/migrations/*.sql file against the DB
// configured in .env (psql isn't installed locally). Mirrors db/pool.js's
// priority: DATABASE_URL (Neon/Supabase/etc.) first, falling back to the
// discrete DB_HOST/... TCP vars.
//
// Usage: node scripts/run-migration.mjs 029_mis_entries.sql
import 'dotenv/config'
import pg from 'pg'
import { readFileSync } from 'fs'

const filename = process.argv[2]
if (!filename) {
  console.error('Usage: node scripts/run-migration.mjs <filename in db/migrations/>')
  process.exit(1)
}

const { Client } = pg
const sql = readFileSync(new URL(`../db/migrations/${filename}`, import.meta.url), 'utf8')

const client = process.env.DATABASE_URL
  ? new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Client({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'fieldflow',
      user: process.env.DB_USER || 'fieldflow_app',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false,
    })

try {
  await client.connect()
  console.log('[migrate] connected via', process.env.DATABASE_URL ? 'DATABASE_URL' : `${process.env.DB_HOST}/${process.env.DB_NAME}`)
  await client.query(sql)
  console.log(`[migrate] ${filename} applied successfully`)
} catch (e) {
  console.error('[migrate] FAILED:', e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
