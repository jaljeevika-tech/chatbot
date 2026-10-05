// services/micro-entrepreneur/index.js — FieldFlow Micro-Entrepreneur
// Registration Microservice.
//
// Bounded Context: Micro-Entrepreneur Registration — owns
// micro_entrepreneurs + micro_entrepreneur_seq. Reads (never writes)
// me_registration_tokens (minted/rotated by the monolith) and the shared
// lgd_* reference tables. Structurally a sibling of
// services/individual-beneficiary/index.js — same auth model, same RLS
// trust boundary, same LGD cascade — kept as a fully separate bounded
// context (own role, own tables) rather than reusing that service's, so
// rotating one org's link never touches the other.
//
// Public, no-login registration form. Each org gets a shareable link from
// an admin in the main app:
//
//   https://<this-service>/register?org=<org_id>&key=<token>
//
// `key` is validated with Postgres RLS: org_id from the query string sets
// `app.current_org_id` BEFORE the token comparison runs, so a
// right-token-wrong-org (or vice versa) request matches zero rows instead
// of leaking another org's token. See db/migrations/041_micro_entrepreneurs.sql.
//
// The monolith reads the resulting roster directly from Postgres for the
// Beneficiaries tab > Micro-Entrepreneur sub-tab.
//
// Deploy: gcloud run deploy fieldflow-micro-entrepreneur --source . --region asia-south1

import express from 'express'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { encryptPii, hashContactNo } from './crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 8084

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'micro-entrepreneur', version: '1.0.0' }))

// ── DB Pool (eb_service role — restricted to me_*/micro_entrepreneur* tables + read-only lgd_* ) ──
// Same DB_HOST-first resolution as services/individual-beneficiary/index.js —
// see that file's comment for why this deliberately does NOT gate on
// K_SERVICE alone (Cloud Run sets it regardless of which DB is behind it).
const useCloudSQLSocket = !process.env.DB_HOST && !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
let _pool = null
function getPool() {
  if (_pool) return _pool
  _pool = new Pool(useCloudSQLSocket
    ? {
        host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.EB_DB_USER  || 'eb_service',
        password: process.env.EB_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.EB_DB_USER  || 'fieldflow_app',
        password: process.env.EB_DB_PASSWORD || '',
        ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[eb-db] Pool error:', err.message))
  return _pool
}

/** Execute a query with org-level RLS set. See
 * services/individual-beneficiary/index.js's orgQuery for the BUG TRAP note
 * on why both statements must share one transaction. */
async function orgQuery(orgId, text, values = []) {
  const pool = getPool()
  const client = await pool.connect()
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
    const { rows } = await orgQuery(orgId, `SELECT token FROM me_registration_tokens WHERE org_id = $1`, [orgId])
    return !!rows[0] && rows[0].token === String(key)
  } catch (e) {
    console.error('[eb] validateLink error:', e.message)
    return false
  }
}

// ── GET /api/validate — the form's first call, to show/hide itself ──────────
app.get('/api/validate', async (req, res) => {
  const { org, key } = req.query
  res.json({ ok: await validateLink(org, key) })
})

// ── LGD (Local Government Directory) location lookups ────────────────────────
// Same State → District → Block → Panchayat → Village reference data and
// query shapes as routes/lgd.routes.js / services/individual-beneficiary —
// no org scoping needed, global reference tables with no RLS.
const LGD_TYPEAHEAD_LIMIT = 50

app.get('/api/lgd/states', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT code, name, is_ut AS "isUt" FROM lgd_states ORDER BY name`)
    res.json(rows)
  } catch (e) {
    console.error('[eb lgd states]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/lgd/districts', async (req, res) => {
  const stateCode = parseInt(req.query.state, 10)
  if (!Number.isFinite(stateCode)) return res.status(400).json({ error: 'state (LGD state code) required' })
  try {
    const { rows } = await getPool().query(`SELECT code, name FROM lgd_districts WHERE state_code = $1 ORDER BY name`, [stateCode])
    res.json(rows)
  } catch (e) {
    console.error('[eb lgd districts]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/lgd/blocks', async (req, res) => {
  const districtCode = parseInt(req.query.district, 10)
  if (!Number.isFinite(districtCode)) return res.status(400).json({ error: 'district (LGD district code) required' })
  const q = String(req.query.q || '').trim()
  try {
    const { rows } = await getPool().query(
      `SELECT code, name FROM lgd_blocks WHERE district_code = $1 ${q ? 'AND name ILIKE $2' : ''} ORDER BY name LIMIT ${LGD_TYPEAHEAD_LIMIT}`,
      q ? [districtCode, `${q}%`] : [districtCode]
    )
    res.json(rows)
  } catch (e) {
    console.error('[eb lgd blocks]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/lgd/panchayats', async (req, res) => {
  const blockCode = parseInt(req.query.block, 10)
  if (!Number.isFinite(blockCode)) return res.status(400).json({ error: 'block (LGD block code) required' })
  const q = String(req.query.q || '').trim()
  try {
    const { rows } = await getPool().query(
      `SELECT code, name FROM lgd_panchayats WHERE block_code = $1 ${q ? 'AND name ILIKE $2' : ''} ORDER BY name LIMIT ${LGD_TYPEAHEAD_LIMIT}`,
      q ? [blockCode, `${q}%`] : [blockCode]
    )
    res.json(rows)
  } catch (e) {
    console.error('[eb lgd panchayats]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/lgd/villages', async (req, res) => {
  const panchayatCode = parseInt(req.query.panchayat, 10)
  const blockCode = parseInt(req.query.block, 10)
  const scopeCol = Number.isFinite(panchayatCode) ? 'panchayat_code' : Number.isFinite(blockCode) ? 'block_code' : null
  const scopeVal = scopeCol === 'panchayat_code' ? panchayatCode : blockCode
  if (!scopeCol) return res.status(400).json({ error: 'panchayat or block (LGD code) required' })
  const q = String(req.query.q || '').trim()
  try {
    // Substring, not prefix, match — see routes/lgd.routes.js's equivalent
    // endpoint for why (numbered villages like "<Parent> village no:06"
    // wouldn't surface for a search on "06" or "village no 06" otherwise,
    // pushing the registrant toward free-typing a mismatched duplicate).
    const { rows } = await getPool().query(
      `SELECT code, name FROM lgd_villages WHERE ${scopeCol} = $1 ${q ? 'AND name ILIKE $2' : ''} ORDER BY name LIMIT ${LGD_TYPEAHEAD_LIMIT}`,
      q ? [scopeVal, `%${q}%`] : [scopeVal]
    )
    res.json(rows)
  } catch (e) {
    console.error('[eb lgd villages]', e.message)
    res.status(500).json({ error: e.message })
  }
})

const GENDERS    = ['Male', 'Female', 'Other']
const CATEGORIES = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']
// Type of Production System — multiselect, optional (not every
// micro-enterprise is farming/aquaculture-based, e.g. a tailor or grocery
// shop). Livestock is counted (a headcount), the other three are measured
// by production in Quintal — see validateProductionSystems below. Same
// field as services/individual-beneficiary/index.js's (required there) and
// services/collective/index.js's (optional, like here).
const PRODUCTION_SYSTEMS = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN // NaN signals "was provided but not a number"
}

function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

/** Validates the client-submitted Production System multiselect — same
 * rules as services/collective/index.js's validateProductionSystems
 * (optional: an absent/empty array is valid). Returns { error } or { value }. */
function validateProductionSystems(productionSystems) {
  if (productionSystems == null) return { value: [] }
  if (!Array.isArray(productionSystems)) return { error: 'Type of Production System must be a list' }
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
  return { value: out }
}

// UID district code: first 3 letters of the district name (alpha chars
// only), or "GEN" when no district was entered — District is optional here.
// Purely cosmetic/informational: the counter itself is still one running
// sequence per org (micro_entrepreneur_seq), not restarted per district.
function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

// ── POST /api/register — the only write path into micro_entrepreneurs ──────
app.post('/api/register', async (req, res) => {
  const {
    org, key, name, contact_no, state, district, block, panchayat, village,
    gender, category, enterprise_name, business_activity, current_revenue_inr, current_employee_count,
    production_systems,
  } = req.body || {}

  if (!(await validateLink(org, key))) {
    return res.status(403).json({ error: 'This registration link is invalid or has expired. Ask your program admin for a new link.' })
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name is required' })
  }
  if (!contact_no || !/^\d{10}$/.test(String(contact_no).trim())) {
    return res.status(400).json({ error: 'A valid 10-digit contact number is required' })
  }
  if (gender && !GENDERS.includes(gender)) {
    return res.status(400).json({ error: 'Invalid gender' })
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' })
  }
  const productionResult = validateProductionSystems(production_systems)
  if (productionResult.error) return res.status(400).json({ error: productionResult.error })
  const productionSystems = productionResult.value
  const revenue = toNullableNumber(current_revenue_inr)
  if (Number.isNaN(revenue) || (revenue != null && revenue < 0)) {
    return res.status(400).json({ error: 'Current Revenue must be a non-negative number' })
  }
  const employeeCount = toNullableInt(current_employee_count)
  if (Number.isNaN(employeeCount) || (employeeCount != null && employeeCount < 0)) {
    return res.status(400).json({ error: 'Current No. of Employee must be a non-negative whole number' })
  }

  // Duplicate check: contact number ALONE is not a safe identity — see
  // services/individual-beneficiary/index.js's dup-check comment. Multiple
  // real, different people can legitimately share one family phone, so the
  // identity is contact number AND name together: only a resubmission of
  // the same person is a duplicate. Checked before the seq/UID is allocated
  // so a rejected submission never burns a counter value.
  //
  // DPDP Phase 4: contact_no is stored encrypted (contact_no_enc), which
  // can't be compared for equality — contact_no_hash (a deterministic
  // HMAC) is the lookup key instead, same (phone, name) identity as before.
  const contactHash = hashContactNo(String(contact_no).trim())
  try {
    const { rows: dupRows } = await orgQuery(org,
      `SELECT uid, name FROM micro_entrepreneurs
       WHERE org_id = $1 AND contact_no_hash = $2 AND lower(trim(name)) = lower($3)`,
      [org, contactHash, String(name).trim()]
    )
    if (dupRows[0]) {
      return res.status(409).json({
        error: `${dupRows[0].name} is already registered with this contact number (${dupRows[0].uid}).`,
      })
    }
  } catch (e) {
    console.error('[eb register dup-check]', e.message)
    return res.status(500).json({ error: 'Registration failed — please try again' })
  }

  const pool   = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(org)])

    // Atomic per-org counter: one UPSERT, no read-then-write race window.
    const seqRes = await client.query(
      `INSERT INTO micro_entrepreneur_seq (org_id, next_val) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET next_val = micro_entrepreneur_seq.next_val + 1
       RETURNING next_val`,
      [org]
    )
    const uid = `EB-${districtCode(district)}-${seqRes.rows[0].next_val}`

    // DPDP Phase 4: contact_no, current_revenue_inr, and panchayat are
    // written ONLY to their encrypted (_enc) columns from this point
    // forward — see services/individual-beneficiary/index.js's equivalent
    // comment for why village/state/district/block/name stay plaintext.
    const insertRes = await client.query(
      `INSERT INTO micro_entrepreneurs
         (org_id, uid, name, contact_no_enc, contact_no_hash, state, district, block, panchayat_enc, village,
          gender, category, enterprise_name, business_activity, current_revenue_inr_enc, current_employee_count,
          production_systems)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, uid, name, state, district, block, village,
                 gender, category, enterprise_name, business_activity, current_employee_count,
                 production_systems, created_at`,
      [
        org, uid, String(name).trim(), encryptPii(String(contact_no).trim()), contactHash,
        state || null, district || null, block || null, encryptPii(panchayat), village || null,
        gender || null, category || null, enterprise_name ? String(enterprise_name).trim() : null,
        business_activity ? String(business_activity).trim() : null, encryptPii(revenue), employeeCount,
        JSON.stringify(productionSystems),
      ]
    )
    await client.query('COMMIT')
    res.json({
      ...insertRes.rows[0],
      contact_no: String(contact_no).trim(),
      panchayat: panchayat || null,
      current_revenue_inr: revenue,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[eb register]', e.message)
    // 23505 = unique_violation on micro_entrepreneurs_dup_hash_key (db/
    // migrations/070) — see services/individual-beneficiary/index.js's
    // equivalent catch for why this can fire despite the dup-check above.
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This person appears to already be registered with this name and contact number.' })
    }
    res.status(500).json({ error: 'Registration failed — please try again' })
  } finally {
    client.release()
  }
})

// ── Public registration form ──────────────────────────────────────────────────
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/', (_req, res) => res.redirect('/register'))
app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, () => console.log(`[micro-entrepreneur] listening on ${PORT}`))
