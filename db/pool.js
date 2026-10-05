// PostgreSQL connection pool
// Priority:
//   1. DATABASE_URL — any external managed DB (Neon, Supabase, Railway, etc.)
//   2. Cloud SQL Unix socket — when running on App Engine with CLOUD_SQL_INSTANCE set
//   3. TCP — local development

import pg from 'pg'

const { Pool } = pg

let _pool = null

export function getPool() {
  if (_pool) return _pool

  if (process.env.DATABASE_URL) {
    // ── Free-tier external PostgreSQL (Neon, Supabase, Render …) ────────────
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:              { rejectUnauthorized: false },
      max:              5,
    })
  } else if (process.env.GAE_APPLICATION && process.env.CLOUD_SQL_INSTANCE) {
    // ── Cloud SQL via Unix socket (App Engine production) ───────────────────
    _pool = new Pool({
      host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE}`,
      database: process.env.DB_NAME     || 'fieldflow',
      user:     process.env.DB_USER     || 'fieldflow_app',
      password: process.env.DB_PASSWORD || '',
      max:      5,
    })
  } else {
    // ── TCP — local dev ─────────────────────────────────────────────────────
    _pool = new Pool({
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'fieldflow',
      user:     process.env.DB_USER     || 'fieldflow_app',
      password: process.env.DB_PASSWORD || '',
      ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
      max:      10,
    })
  }

  _pool.on('error', (err) => console.error('[db] Pool error:', err.message))
  return _pool
}

/** Run a query with org-level RLS context set */
export async function orgQuery(orgId, text, values) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    // set_config(..., true) is transaction-local. Without an explicit BEGIN,
    // node-postgres autocommits each statement, so the setting was gone before
    // the real query ran and every RLS policy saw ''. Both statements must
    // share one transaction (same fix as services/individual-beneficiary).
    // Parameterized set_config (not string-interpolated SET LOCAL) keeps the
    // RLS trust boundary injection-safe even for an unexpected caller value.
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(orgId)])
    const result = await client.query(text, values)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
