// services/hr/db.js — Postgres pool (hr_service role) + per-org transactions.

import pg from 'pg'

const { Pool } = pg

// Unix socket on Cloud Run / App Engine, TCP locally — same as the other services.
const useCloudSQLSocket = !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
let _pool = null

// When the monolith mounts this router in-process (routes/hr.routes.js) it
// hands over its own pool — App Engine has no hr_service credentials.
let poolProvider = getServicePool
export function usePool(provider) { poolProvider = provider }

function getServicePool() {
  if (_pool) return _pool
  _pool = new Pool(useCloudSQLSocket
    ? {
        host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
        database: process.env.DB_NAME        || 'fieldflow',
        user:     process.env.HR_DB_USER     || 'hr_service',
        password: process.env.HR_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.HR_DB_USER  || 'fieldflow_app',
        password: process.env.DB_PASSWORD || '',
        ssl:      process.env.DB_HOST && process.env.DB_SSL !== 'false' ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[hr-db] Pool error:', err.message))
  return _pool
}

/** A rejection the caller should see (bad input, not allowed, conflicting
 *  state). Anything else is treated as a transient server failure. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Cross-org read with no RLS context — only for the reminder job, which runs
 *  in the monolith as the tables' owner (routes/hr.routes.js). */
export async function withClient(fn) {
  const client = await poolProvider().connect()
  try { return await fn(client) } finally { client.release() }
}

/** Run fn(client) in one transaction with the org's RLS context set.
 *  set_config(..., true) is transaction-local, hence the explicit BEGIN. */
export async function withOrg(orgId, fn) {
  const client = await poolProvider().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(orgId)])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
