// lib/org.js — Shared org lookup helper used by multiple route files

import { getPool } from '../db/pool.js'

/** Fetch org row from PostgreSQL by org UUID */
export async function getOrg(orgId) {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT id, slug, name, metadata FROM organizations WHERE id = $1',
    [orgId]
  )
  return rows[0] || null
}
