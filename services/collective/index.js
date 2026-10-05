// services/collective/index.js — FieldFlow Collective Registration
// Microservice.
//
// Bounded Context: Collective Registration — owns collectives +
// collective_seq. Reads (never writes) cb_registration_tokens (minted by
// the monolith) and the shared lgd_* reference tables. Structurally a
// sibling of services/individual-beneficiary/index.js and
// services/micro-entrepreneur/index.js — same auth model, same RLS trust
// boundary, same LGD cascade — kept as a fully separate bounded context
// (own role, own tables) so rotating one org's link never touches another.
//
// Public, no-login registration form. Each org gets a shareable link from
// an admin in the main app:
//
//   https://<this-service>/register?org=<org_id>&key=<token>
//
// `key` is validated with Postgres RLS: org_id from the query string sets
// `app.current_org_id` BEFORE the token comparison runs, so a
// right-token-wrong-org (or vice versa) request matches zero rows instead
// of leaking another org's token. See db/migrations/042_collectives.sql.
//
// The monolith reads the resulting roster directly from Postgres for the
// Beneficiaries tab > Collective sub-tab.
//
// Deploy: gcloud run deploy fieldflow-collective --source . --region asia-south1

import express from 'express'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { encryptPii, hashContactNo } from './crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 8085

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'collective', version: '1.0.0' }))

// ── DB Pool (cb_service role — restricted to cb_*/collective* tables + read-only lgd_* ) ──
// DB_HOST-first resolution — see services/individual-beneficiary/index.js's
// comment for why this deliberately does NOT gate on K_SERVICE alone
// (Cloud Run sets it regardless of which DB is behind it).
const useCloudSQLSocket = !process.env.DB_HOST && !!(process.env.GAE_APPLICATION || process.env.K_SERVICE)
let _pool = null
function getPool() {
  if (_pool) return _pool
  _pool = new Pool(useCloudSQLSocket
    ? {
        host:     `/cloudsql/${process.env.CLOUD_SQL_INSTANCE || 'chatbot-492915:us-central1:fieldflow-pg'}`,
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.CB_DB_USER  || 'cb_service',
        password: process.env.CB_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.CB_DB_USER  || 'fieldflow_app',
        password: process.env.CB_DB_PASSWORD || '',
        ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[cb-db] Pool error:', err.message))
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
    const { rows } = await orgQuery(orgId, `SELECT token FROM cb_registration_tokens WHERE org_id = $1`, [orgId])
    return !!rows[0] && rows[0].token === String(key)
  } catch (e) {
    console.error('[cb] validateLink error:', e.message)
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
// query shapes as routes/lgd.routes.js / the other registration services —
// no org scoping needed, global reference tables with no RLS.
const LGD_TYPEAHEAD_LIMIT = 50

app.get('/api/lgd/states', async (_req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT code, name, is_ut AS "isUt" FROM lgd_states ORDER BY name`)
    res.json(rows)
  } catch (e) {
    console.error('[cb lgd states]', e.message)
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
    console.error('[cb lgd districts]', e.message)
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
    console.error('[cb lgd blocks]', e.message)
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
    console.error('[cb lgd panchayats]', e.message)
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
    console.error('[cb lgd villages]', e.message)
    res.status(500).json({ error: e.message })
  }
})

const COLLECTIVE_TYPES = ['FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective']
// Type of Production System — multiselect, optional (a collective need not
// be production-based at all, e.g. a Vendor Collective). Livestock is
// counted (a headcount), the other three are measured by production in
// Quintal — see validateProductionSystems below.
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
 * shape and rules as services/individual-beneficiary/index.js's
 * validateProductionSystems, except this one is OPTIONAL (an absent/empty
 * array is valid — this field was already optional on this form before
 * the multiselect redesign). Returns { error } or { value }. */
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
// sequence per org (collective_seq), not restarted per district.
function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

// ── POST /api/register — the only write path into collectives ─────────────
app.post('/api/register', async (req, res) => {
  const {
    org, key, collective_name, collective_type, lead_person_name, contact_no,
    state, district, block, panchayat, village, male_count, female_count,
    focus_area, current_revenue_inr, production_systems,
    per_capita_income_inr, credit_access_inr,
  } = req.body || {}

  if (!(await validateLink(org, key))) {
    return res.status(403).json({ error: 'This registration link is invalid or has expired. Ask your program admin for a new link.' })
  }
  if (!collective_name || !String(collective_name).trim()) {
    return res.status(400).json({ error: 'Collective Name is required' })
  }
  if (!COLLECTIVE_TYPES.includes(collective_type)) {
    return res.status(400).json({ error: 'Type of Collective must be one of: ' + COLLECTIVE_TYPES.join(', ') })
  }
  if (!lead_person_name || !String(lead_person_name).trim()) {
    return res.status(400).json({ error: 'Lead Person Name is required' })
  }
  if (!contact_no || !/^\d{10}$/.test(String(contact_no).trim())) {
    return res.status(400).json({ error: 'A valid 10-digit contact number is required' })
  }
  const productionResult = validateProductionSystems(production_systems)
  if (productionResult.error) return res.status(400).json({ error: productionResult.error })
  const productionSystems = productionResult.value
  const maleCount   = toNullableInt(male_count)
  const femaleCount = toNullableInt(female_count)
  if (Number.isNaN(maleCount) || (maleCount != null && maleCount < 0)) {
    return res.status(400).json({ error: 'No. of Male must be a non-negative whole number' })
  }
  if (Number.isNaN(femaleCount) || (femaleCount != null && femaleCount < 0)) {
    return res.status(400).json({ error: 'No. of Female must be a non-negative whole number' })
  }
  const revenue        = toNullableNumber(current_revenue_inr)
  const perCapitaIncome = toNullableNumber(per_capita_income_inr)
  const creditAccess    = toNullableNumber(credit_access_inr)
  if (Number.isNaN(revenue) || (revenue != null && revenue < 0)) {
    return res.status(400).json({ error: 'Current Revenue must be a non-negative number' })
  }
  if (Number.isNaN(perCapitaIncome) || (perCapitaIncome != null && perCapitaIncome < 0)) {
    return res.status(400).json({ error: 'Current per capita income must be a non-negative number' })
  }
  if (Number.isNaN(creditAccess) || (creditAccess != null && creditAccess < 0)) {
    return res.status(400).json({ error: 'Current credit access must be a non-negative number' })
  }

  // Duplicate check: contact number ALONE is not a safe identity — see
  // services/individual-beneficiary/index.js's dup-check comment (the same
  // shared-phone reality applies to a lead person's own number). A lead
  // person could also legitimately lead two differently-named collectives
  // on the same phone, so the identity is contact number AND collective
  // name together: only a resubmission of the same collective is a
  // duplicate. Checked before the seq/UID is allocated so a rejected
  // submission never burns a counter value.
  // DPDP Phase 4: contact_no is stored encrypted (contact_no_enc), which
  // can't be compared for equality — contact_no_hash (a deterministic
  // HMAC) is the lookup key instead, same (phone, collective name) identity
  // as before.
  const contactHash = hashContactNo(String(contact_no).trim())
  try {
    const { rows: dupRows } = await orgQuery(org,
      `SELECT uid, collective_name FROM collectives
       WHERE org_id = $1 AND contact_no_hash = $2 AND lower(trim(collective_name)) = lower($3)`,
      [org, contactHash, String(collective_name).trim()]
    )
    if (dupRows[0]) {
      return res.status(409).json({
        error: `Collective "${dupRows[0].collective_name}" is already registered with this contact number (${dupRows[0].uid}).`,
      })
    }
  } catch (e) {
    console.error('[cb register dup-check]', e.message)
    return res.status(500).json({ error: 'Registration failed — please try again' })
  }

  const pool   = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(org)])

    // Atomic per-org counter: one UPSERT, no read-then-write race window.
    const seqRes = await client.query(
      `INSERT INTO collective_seq (org_id, next_val) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET next_val = collective_seq.next_val + 1
       RETURNING next_val`,
      [org]
    )
    const uid = `CB-${districtCode(district)}-${seqRes.rows[0].next_val}`

    // DPDP Phase 4: contact_no, per_capita_income_inr, and panchayat are
    // written ONLY to their encrypted (_enc) columns from this point
    // forward. current_revenue_inr/credit_access_inr stay plaintext — the
    // collective's own group-level financial metrics, not personal income
    // of an individual (see lib/anonymizeSpecs.js's monolith-side comment
    // on the same collective_name-vs-lead_person_name distinction).
    const insertRes = await client.query(
      `INSERT INTO collectives
         (org_id, uid, collective_name, collective_type, lead_person_name, contact_no_enc, contact_no_hash,
          state, district, block, panchayat_enc, village, male_count, female_count,
          focus_area, current_revenue_inr, production_systems,
          per_capita_income_inr_enc, credit_access_inr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, uid, collective_name, collective_type, lead_person_name,
                 state, district, block, village, male_count, female_count,
                 focus_area, current_revenue_inr, production_systems,
                 credit_access_inr, created_at`,
      [
        org, uid, String(collective_name).trim(), collective_type, String(lead_person_name).trim(),
        encryptPii(String(contact_no).trim()), contactHash,
        state || null, district || null, block || null, encryptPii(panchayat), village || null,
        maleCount, femaleCount, focus_area ? String(focus_area).trim() : null,
        revenue, JSON.stringify(productionSystems), encryptPii(perCapitaIncome), creditAccess,
      ]
    )
    await client.query('COMMIT')
    res.json({
      ...insertRes.rows[0],
      contact_no: String(contact_no).trim(),
      panchayat: panchayat || null,
      per_capita_income_inr: perCapitaIncome,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[cb register]', e.message)
    // 23505 = unique_violation on collectives_dup_hash_key (db/migrations/
    // 070) — see services/individual-beneficiary/index.js's equivalent
    // catch for why this can fire despite the dup-check above.
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This collective appears to already be registered with this name and contact number.' })
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

app.listen(PORT, () => console.log(`[collective] listening on ${PORT}`))
