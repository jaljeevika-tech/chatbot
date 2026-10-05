// services/individual-beneficiary/index.js — FieldFlow Individual Beneficiary
// Registration Microservice.
//
// Bounded Context: Individual Beneficiary Registration — owns
// individual_beneficiaries + individual_beneficiary_seq. Reads (never writes)
// ib_registration_tokens, which the monolith mints/rotates.
//
// Serves a public, no-login registration form to field staff. There is no
// Firebase auth here on purpose — field staff filling this form in the
// village usually don't have (and shouldn't need) a FieldFlow account.
// Instead, each org gets one shareable link from an admin in the main app:
//
//   https://<this-service>/register?org=<org_id>&key=<token>
//
// Every request must carry a valid (org, key) pair. `key` is validated with
// Postgres RLS: org_id from the query string sets `app.current_org_id`
// BEFORE the token comparison runs, so the comparison is always scoped to
// that one org — a right-token-wrong-org (or vice versa) request just
// matches zero rows instead of leaking another org's token. See
// db/migrations/038_individual_beneficiaries.sql for the policy.
//
// The monolith reads the resulting roster directly from Postgres (its
// fieldflow_app role bypasses RLS) for the Beneficiaries tab > Individual
// Beneficiary sub-tab — same convention as the existing `beneficiaries` /
// `beneficiary_mis_records` tables. This service is written-to only, never
// proxied-through, for reads.
//
// Deploy: gcloud run deploy fieldflow-individual-beneficiary --source . --region asia-south1

import express from 'express'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { encryptPii, hashContactNo } from './crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 8083

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'individual-beneficiary', version: '1.0.0' }))

// ── DB Pool (ib_service role — restricted to ib_* / individual_beneficiaries tables only) ──
// Cloud SQL Unix socket when actually configured for it, otherwise plain TCP
// (this is what the platform's production DB — Neon — actually needs, in
// dev/staging too). NOTE: this deliberately does NOT gate on K_SERVICE alone
// like services/report-writer/index.js does — Cloud Run sets K_SERVICE on
// every deployment regardless of which DB is behind it, so that check alone
// would force the socket path even when DB_HOST (Neon) is what's configured,
// silently ignoring it. DB_HOST present is the real signal to use TCP.
const useCloudSQLSocket = !process.env.DB_HOST && !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
let _pool = null
function getPool() {
  if (_pool) return _pool
  _pool = new Pool(useCloudSQLSocket
    ? {
        host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.IB_DB_USER  || 'ib_service',
        password: process.env.IB_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.IB_DB_USER  || 'fieldflow_app',
        password: process.env.IB_DB_PASSWORD || '',
        ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[ib-db] Pool error:', err.message))
  return _pool
}

/** Execute a query with org-level RLS set (see module header for why order matters).
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
    const { rows } = await orgQuery(orgId, `SELECT token FROM ib_registration_tokens WHERE org_id = $1`, [orgId])
    return !!rows[0] && rows[0].token === String(key)
  } catch (e) {
    console.error('[ib] validateLink error:', e.message)
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
// query shapes as routes/lgd.routes.js, so the registration form's location
// fields draw from the exact same governed dataset as the "+ New Project"
// form — no org scoping needed, these are global reference tables with no
// RLS (see db/migrations/039_ib_lgd_read_access.sql).
const LGD_TYPEAHEAD_LIMIT = 50

app.get('/api/lgd/states', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT code, name, is_ut AS "isUt" FROM lgd_states ORDER BY name`)
    res.json(rows)
  } catch (e) {
    console.error('[ib lgd states]', e.message)
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
    console.error('[ib lgd districts]', e.message)
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
    console.error('[ib lgd blocks]', e.message)
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
    console.error('[ib lgd panchayats]', e.message)
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
    console.error('[ib lgd villages]', e.message)
    res.status(500).json({ error: e.message })
  }
})

const GENDERS          = ['Male', 'Female', 'Other']
// Type of Production System — multiselect. Livestock is counted (a
// headcount), the other three are measured by production in Quintal — see
// validateProductionSystems below.
const PRODUCTION_SYSTEMS = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']
const CATEGORIES       = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']

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

/** Validates the client-submitted Production System multiselect: an array
 * of { type, production_quintal } (Aquaculture/Agriculture/Horticulture) or
 * { type: 'Livestock', livestock_count }. Mirrors
 * services/resource/index.js's validateUtility — drops anything not on the
 * allowed list rather than trusting the client, rejects duplicate types,
 * and requires at least one entry (this multiselect replaces what used to
 * be a required single-select). Returns { error } or { value }. */
function validateProductionSystems(productionSystems) {
  if (!Array.isArray(productionSystems) || productionSystems.length === 0) {
    return { error: 'Select at least one Type of Production System' }
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
  if (!out.length) return { error: 'Select at least one Type of Production System' }
  return { value: out }
}

// UID district code: first 3 letters of the district name (alpha chars
// only, so "PASHCHIM CHAMPARAN" -> "PAS" not " PA"), or "GEN" when no
// district was entered — District is an optional field on this form.
// Purely cosmetic/informational: the counter itself is still one running
// sequence per org (individual_beneficiary_seq), not restarted per district.
function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

// Form sends 'Yes'/'No'/'' (a <select>, same idiom as gender)
// rather than a raw boolean — undefined signals "was provided but invalid".
function toNullableYesNo(v) {
  if (v === '' || v === null || v === undefined) return null
  if (v === 'Yes' || v === true) return true
  if (v === 'No' || v === false) return false
  return undefined
}

// ── POST /api/register — the only write path into individual_beneficiaries ──
app.post('/api/register', async (req, res) => {
  const {
    org, key, name, contact_no, state, district, block, panchayat, village,
    gender, category, occupation, current_income_inr, production_systems,
    member_of_collective,
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
  const productionResult = validateProductionSystems(production_systems)
  if (productionResult.error) return res.status(400).json({ error: productionResult.error })
  const productionSystems = productionResult.value
  if (gender && !GENDERS.includes(gender)) {
    return res.status(400).json({ error: 'Invalid gender' })
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' })
  }
  const income = toNullableNumber(current_income_inr)
  if (Number.isNaN(income) || (income != null && income < 0)) {
    return res.status(400).json({ error: 'Current Income must be a non-negative number' })
  }
  const memberOfCollective = toNullableYesNo(member_of_collective)
  if (memberOfCollective === undefined) {
    return res.status(400).json({ error: 'Member of Collective must be Yes or No' })
  }

  // Duplicate check: contact number ALONE is not a safe identity here — a
  // check against live data found 24 orgs' worth of households where
  // several different real people (e.g. a mother, father and adult child)
  // share one family phone, all legitimately registered under that same
  // number. So the identity is contact number AND name together: only a
  // resubmission of the same person (same phone, same name) is a
  // duplicate; a different name on the same phone is a different person
  // and must go through. Checked before the seq/UID is allocated so a
  // rejected submission never burns a counter value.
  // DPDP Phase 4: contact_no is stored encrypted (contact_no_enc), which
  // can't be compared for equality — contact_no_hash (a deterministic
  // HMAC) is the lookup key instead, same (phone, name) identity as before.
  const contactHash = hashContactNo(String(contact_no).trim())
  try {
    const { rows: dupRows } = await orgQuery(org,
      `SELECT uid, name FROM individual_beneficiaries
       WHERE org_id = $1 AND contact_no_hash = $2 AND lower(trim(name)) = lower($3)`,
      [org, contactHash, String(name).trim()]
    )
    if (dupRows[0]) {
      return res.status(409).json({
        error: `${dupRows[0].name} is already registered with this contact number (${dupRows[0].uid}).`,
      })
    }
  } catch (e) {
    console.error('[ib register dup-check]', e.message)
    return res.status(500).json({ error: 'Registration failed — please try again' })
  }

  const pool   = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(org)])

    // Atomic per-org counter: one UPSERT, no read-then-write race window.
    const seqRes = await client.query(
      `INSERT INTO individual_beneficiary_seq (org_id, next_val) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET next_val = individual_beneficiary_seq.next_val + 1
       RETURNING next_val`,
      [org]
    )
    const uid = `IB-${districtCode(district)}-${seqRes.rows[0].next_val}`

    // DPDP Phase 4: contact_no, current_income_inr, and panchayat are
    // written ONLY to their encrypted (_enc) columns from this point
    // forward — the legacy plaintext columns are left NULL for every new
    // registration. village stays plaintext (used as a live filter/search
    // field in the monolith's individual-beneficiaries.routes.js); state/
    // district/block/name are likewise unencrypted (dropdown filters/display).
    const insertRes = await client.query(
      `INSERT INTO individual_beneficiaries
         (org_id, uid, name, contact_no_enc, contact_no_hash, state, district, block, panchayat_enc, village,
          gender, category, occupation, current_income_inr_enc, production_systems,
          member_of_collective)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, uid, name, state, district, block, village,
                 gender, category, occupation, production_systems,
                 member_of_collective, created_at`,
      [
        org, uid, String(name).trim(), encryptPii(String(contact_no).trim()), contactHash,
        state || null, district || null, block || null, encryptPii(panchayat), village || null,
        gender || null, category || null, occupation ? String(occupation).trim() : null, encryptPii(income), JSON.stringify(productionSystems),
        memberOfCollective,
      ]
    )
    await client.query('COMMIT')
    // Response echoes back what was actually submitted rather than
    // decrypting what was just encrypted — same data, one less crypto
    // round-trip, and the confirmation screen shows exactly what the
    // field worker entered.
    res.json({
      ...insertRes.rows[0],
      contact_no: String(contact_no).trim(),
      panchayat: panchayat || null,
      current_income_inr: income,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ib register]', e.message)
    // 23505 = unique_violation on individual_beneficiaries_dup_hash_key
    // (db/migrations/070) — the DB-level backstop for the race-condition
    // window the SELECT-before-INSERT dup-check above can't close (two
    // near-simultaneous submissions both passing that check before either
    // writes). Should be rare in practice; when it happens it's still a
    // real duplicate, not a server error.
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

app.listen(PORT, () => console.log(`[individual-beneficiary] listening on ${PORT}`))
