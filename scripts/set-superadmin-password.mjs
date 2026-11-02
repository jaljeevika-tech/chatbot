// Sets the password of an existing platform superadmin (users.role = 'superadmin').
// The password comes from an env var so it never lands in shell history or chat.
//
// Usage (PowerShell):
//   $env:SUPERADMIN_PHONE = "9876543210"; $env:SUPERADMIN_PASSWORD = "<new password>"
//   node scripts/set-superadmin-password.mjs
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcrypt'
import { normPhone } from '../lib/sheets.js'

const phone = normPhone(process.env.SUPERADMIN_PHONE)
const password = process.env.SUPERADMIN_PASSWORD || ''
if (!phone || !password) {
  console.error('Set SUPERADMIN_PHONE and SUPERADMIN_PASSWORD first.')
  process.exit(1)
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.')
  process.exit(1)
}

const { Client } = pg
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
  const hashed = await bcrypt.hash(password, 12)
  const { rowCount } = await client.query(
    `UPDATE users SET password = $1 WHERE phone = $2 AND lower(role) = 'superadmin'`,
    [hashed, phone]
  )
  if (rowCount === 0) {
    console.error(`No superadmin user found with phone ${phone}. Nothing changed.`)
    process.exitCode = 1
  } else {
    console.log(`Superadmin password updated for ${phone}. Sign in at superadmin.fieldimpact.in.`)
  }
} catch (e) {
  console.error('FAILED:', e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
