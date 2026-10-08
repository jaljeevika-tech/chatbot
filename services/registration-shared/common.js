// services/registration-shared/common.js — shared by the four public registration
// services (individual-beneficiary, micro-entrepreneur, collective, resource): DB pool,
// RLS-scoped query, registration-link check and the form-field parsers. Each service is
// built from the REPO ROOT so this directory is in its image.

import pg from 'pg'

/**
 * @param {object} o
 * @param {string} o.prefix      'IB' | 'EB' | 'CB' | 'RS' — selects <prefix>_DB_USER /
 *                               <prefix>_DB_PASSWORD and the <prefix>_service Cloud SQL role
 * @param {string} o.tokenTable  the service's registration-link table (minted by the monolith)
 */
export function createRegistrationDb({ prefix, tokenTable }) {
  const tag = prefix.toLowerCase()

  // Cloud SQL Unix socket when actually configured for it, otherwise plain TCP
  // (this is what the platform's production DB — Neon — actually needs, in
  // dev/staging too). This deliberately does NOT gate on K_SERVICE alone —
  // Cloud Run sets K_SERVICE on every deployment regardless of which DB is
  // behind it, so that check alone would force the socket path even when
  // DB_HOST (Neon) is what's configured. DB_HOST present is the real signal to use TCP.
  const useCloudSQLSocket = !process.env.DB_HOST && !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
  let _pool = null
  function getPool() {
    if (_pool) return _pool
    _pool = new pg.Pool(useCloudSQLSocket
      ? {
          host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
          database: process.env.DB_NAME || 'fieldflow',
          user:     process.env[`${prefix}_DB_USER`] || `${tag}_service`,
          password: process.env[`${prefix}_DB_PASSWORD`] || '',
          max: 5,
        }
      : {
          host:     process.env.DB_HOST || 'localhost',
          port:     parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME || 'fieldflow',
          user:     process.env[`${prefix}_DB_USER`] || 'fieldflow_app',
          password: process.env[`${prefix}_DB_PASSWORD`] || '',
          ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
          max: 5,
        }
    )
    _pool.on('error', (err) => console.error(`[${tag}-db] Pool error:`, err.message))
    return _pool
  }

  /** Execute a query with org-level RLS set.
   *
   * BUG TRAP: set_config(..., true) scopes the value to the current transaction
   * ("is_local"). Without an explicit BEGIN, node-postgres runs each
   * client.query() call as its own autocommit transaction, so the setting is
   * gone again before the second statement runs — current_setting() silently
   * returns '' and every RLS policy comparing against it matches nothing.
   * Wrapping both statements in one BEGIN/COMMIT keeps them in the same
   * transaction so the setting actually applies to the real query.
   */
  async function orgQuery(orgId, text, values = []) {
    const client = await getPool().connect()
    try {
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

  async function validateLink(orgId, key) {
    if (!orgId || !key) return false
    try {
      const { rows } = await orgQuery(orgId, `SELECT token FROM ${tokenTable} WHERE org_id = $1`, [orgId])
      return !!rows[0] && rows[0].token === String(key)
    } catch (e) {
      console.error(`[${tag}] validateLink error:`, e.message)
      return false
    }
  }

  return { getPool, orgQuery, validateLink }
}

export function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN // NaN signals "was provided but not a number"
}

export function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

// UID district code: first 3 letters of the district name (alpha chars
// only, so "PASHCHIM CHAMPARAN" -> "PAS" not " PA"), or "GEN" when no
// district is known. Purely cosmetic/informational: each service's counter
// is still one running sequence, not restarted per district.
export function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

// Type of Production System — multiselect on the individual-beneficiary (required),
// micro-entrepreneur and collective (optional) forms. Livestock is counted (a
// headcount), the other three are measured by production in Quintal.
export const PRODUCTION_SYSTEMS = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']

/** Validates the client-submitted Production System multiselect: an array of
 * { type, production_quintal } (Aquaculture/Agriculture/Horticulture) or
 * { type: 'Livestock', livestock_count }. Drops anything not on the allowed list
 * rather than trusting the client and ignores a type submitted twice. `required`
 * demands at least one valid entry; otherwise an absent/empty list is valid.
 * Returns { error } or { value }. */
export function validateProductionSystems(productionSystems, { required }) {
  if (required) {
    if (!Array.isArray(productionSystems) || productionSystems.length === 0) {
      return { error: 'Select at least one Type of Production System' }
    }
  } else {
    if (productionSystems == null) return { value: [] }
    if (!Array.isArray(productionSystems)) return { error: 'Type of Production System must be a list' }
  }
  const out = []
  const seen = new Set()
  for (const item of productionSystems) {
    const type = item && item.type
    if (!PRODUCTION_SYSTEMS.includes(type)) continue // silently drop unknown/disallowed entries
    if (seen.has(type)) continue // dedupe a type submitted twice
    seen.add(type)
    if (type === 'Livestock') {
      const count = toNullableInt(item.livestock_count)
      if (Number.isNaN(count) || (count != null && count < 0)) {
        return { error: 'Number of Livestock must be a non-negative whole number' }
      }
      out.push({ type, livestock_count: count })
    } else {
      const quintal = toNullableNumber(item.production_quintal)
      if (Number.isNaN(quintal) || (quintal != null && quintal < 0)) {
        return { error: `${type} production (Quintal) must be a non-negative number` }
      }
      out.push({ type, production_quintal: quintal })
    }
  }
  if (required && !out.length) return { error: 'Select at least one Type of Production System' }
  return { value: out }
}
