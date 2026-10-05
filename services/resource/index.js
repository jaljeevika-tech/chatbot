// services/resource/index.js — FieldFlow Resource Registration Microservice.
//
// Bounded Context: Resource Registration — owns resources + resource_seq.
// Reads (never writes) rs_registration_tokens (minted by the monolith) and,
// uniquely among the four registration services, also reads ACROSS the
// other three bounded contexts' tables (individual_beneficiaries,
// micro_entrepreneurs, collectives) — read-only, org-scoped — to look up a
// beneficiary by UID and show field staff who they're mapping a resource
// to before they submit. See db/migrations/043_resources.sql for the
// scoped grants that make this safe (rs_service gets a new SELECT-only,
// org-isolated policy on each of those three tables; nothing about their
// own service's access changes).
//
// Public, no-login registration form. Each org gets a shareable link from
// an admin in the main app:
//
//   https://<this-service>/register?org=<org_id>&key=<token>
//
// `key` is validated with Postgres RLS exactly like the sibling services —
// see services/individual-beneficiary/index.js's module header for the
// mechanism.
//
// UID format: <ProductionSystem>-<BeneficiaryType>-<District>-<N>, e.g.
// FW-IB-AGR-1 (Freshwater Wetland, mapped to an Individual Beneficiary in
// Agra district, 1st for that production system). Production system prefix
// is FW- Freshwater Wetland, CW- Coastal Wetland, AG- Agricultural Land,
// BW- Brackish Water; beneficiary-type prefix is the mapped beneficiary's
// own UID prefix (IB-/EB-/CB-); district is derived from the mapped
// beneficiary's district — same cosmetic-only convention as the other three
// registration services' own UIDs (e.g. IB-AGR-1). The running count (N) is
// one sequence per (org, resource_type) — resource_seq is keyed that way —
// not restarted per district or beneficiary type.
//
// The monolith reads the resulting roster directly from Postgres for the
// Beneficiaries tab > Resources sub-tab.
//
// Deploy: gcloud run deploy fieldflow-resource --source . --region asia-south1

import express from 'express'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 8086

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'resource', version: '1.0.0' }))

// ── DB Pool (rs_service role) ─────────────────────────────────────────────────
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
        user:     process.env.RS_DB_USER  || 'rs_service',
        password: process.env.RS_DB_PASSWORD || '',
        max: 5,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'fieldflow',
        user:     process.env.RS_DB_USER  || 'fieldflow_app',
        password: process.env.RS_DB_PASSWORD || '',
        ssl:      process.env.DB_HOST ? { rejectUnauthorized: false } : false,
        max: 5,
      }
  )
  _pool.on('error', (err) => console.error('[rs-db] Pool error:', err.message))
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
    const { rows } = await orgQuery(orgId, `SELECT token FROM rs_registration_tokens WHERE org_id = $1`, [orgId])
    return !!rows[0] && rows[0].token === String(key)
  } catch (e) {
    console.error('[rs] validateLink error:', e.message)
    return false
  }
}

// ── GET /api/validate — the form's first call, to show/hide itself ──────────
app.get('/api/validate', async (req, res) => {
  const { org, key } = req.query
  res.json({ ok: await validateLink(org, key) })
})

// ── Beneficiary UID lookup — routes to the right table by UID prefix ────────
// typePrefix feeds the new Resource UID format (see districtCode/UID_PREFIX
// below) — IB/EB/CB, same prefix the beneficiary's own UID already carries.
function beneficiaryLookupSpec(uid) {
  const u = String(uid || '').trim().toUpperCase()
  if (u.startsWith('IB-')) {
    return {
      normalizedUid: u, type: 'Individual Beneficiary', typePrefix: 'IB',
      sql: `SELECT uid, name, contact_no, village, panchayat, block, district, state
            FROM individual_beneficiaries WHERE org_id = $1 AND uid = $2`,
      toResult: (r) => ({ name: r.name, subLabel: r.contact_no || '' }),
    }
  }
  if (u.startsWith('EB-')) {
    return {
      normalizedUid: u, type: 'Micro-Entrepreneur', typePrefix: 'EB',
      sql: `SELECT uid, name, contact_no, enterprise_name, village, panchayat, block, district, state
            FROM micro_entrepreneurs WHERE org_id = $1 AND uid = $2`,
      toResult: (r) => ({ name: r.name, subLabel: r.enterprise_name || r.contact_no || '' }),
    }
  }
  if (u.startsWith('CB-')) {
    return {
      normalizedUid: u, type: 'Collective', typePrefix: 'CB',
      sql: `SELECT uid, collective_name, lead_person_name, contact_no, village, panchayat, block, district, state
            FROM collectives WHERE org_id = $1 AND uid = $2`,
      toResult: (r) => ({ name: r.collective_name, subLabel: r.lead_person_name ? `Lead: ${r.lead_person_name}` : (r.contact_no || '') }),
    }
  }
  return null
}

async function lookupBeneficiary(orgId, uid) {
  const spec = beneficiaryLookupSpec(uid)
  if (!spec) return { error: 'UID must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur) or CB- (Collective)' }
  const { rows } = await orgQuery(orgId, spec.sql, [orgId, spec.normalizedUid])
  const row = rows[0]
  if (!row) return { error: `No beneficiary found for ${spec.normalizedUid}` }
  const { name, subLabel } = spec.toResult(row)
  const location = [row.village, row.panchayat, row.block, row.district, row.state].filter(Boolean).join(', ')
  return {
    uid: spec.normalizedUid,
    type: spec.type,
    typePrefix: spec.typePrefix,
    district: row.district,
    name,
    subLabel,
    location,
  }
}

// GET /api/lookup?org=&key=&uid= — the form's "Fetch Details" call
app.get('/api/lookup', async (req, res) => {
  const { org, key, uid } = req.query
  if (!(await validateLink(org, key))) {
    return res.status(403).json({ error: 'This registration link is invalid or has expired. Ask your program admin for a new link.' })
  }
  if (!uid || !String(uid).trim()) {
    return res.status(400).json({ error: 'Beneficiary UID is required' })
  }
  try {
    const result = await lookupBeneficiary(org, String(uid).trim())
    if (result.error) return res.status(404).json({ error: result.error })
    res.json(result)
  } catch (e) {
    console.error('[rs lookup]', e.message)
    res.status(500).json({ error: 'Lookup failed — please try again' })
  }
})

// ── Type of Production System — the top-level branch ────────────────────────
// Each branch decides which of the fields below actually apply. Brackish
// Water has no follow-up questions yet (deliberate — not an oversight; ask
// for its question chain once it's been defined, same shape as the other
// three below).
const PRODUCTION_SYSTEMS = ['Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water']
const WATER_BODY_TYPES = ['Chour', 'Moen', 'Dhar', 'Pond']               // Freshwater Wetland > Type of Resource
const RESOURCE_ACCESS_TYPES = ['Owned', 'Leased', 'Common']              // Freshwater Wetland > Resource Access
const WETLAND_STRUCTURES = ['Raft', 'Mangroves']                        // Coastal Wetland > Type of Resource

// Resource Utility multiselect options, keyed by which branch asks it.
// "None of the above" is a real option on two of these lists but is never
// itself stored as a utility entry — selecting it is a no-op (see
// validateUtility below).
const UTILITY_OPTIONS = {
  'Freshwater Wetland':      ['Fishery', 'Makhana', 'Singhara'],
  'Coastal Wetland:Raft':    ['Seaweed', 'Oyster', 'Mussel', 'Fish', 'Crab'],
  'Agricultural Land':       ['Bio Fortified Crop', 'Millet Crop', 'Pulse Crop', 'Grain Crop', 'Oil Seed Crop'],
}

const UID_PREFIX = {
  'Freshwater Wetland': 'FW',
  'Coastal Wetland':    'CW',
  'Agricultural Land':  'AG',
  'Brackish Water':     'BW',
}

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN // NaN signals "was provided but not a number"
}

// UID district code — same convention as the other three registration
// services (e.g. services/individual-beneficiary/index.js's districtCode):
// first 3 letters of the district name, or "GEN" when unknown. Here it's
// derived from the MAPPED BENEFICIARY's district (this form doesn't collect
// one itself — it captures GPS coordinates instead), and is purely
// cosmetic/informational: the counter is still one running sequence per
// (org, resource_type), not restarted per district or beneficiary type.
function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

function toNullableInt(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

/** Validates a client-submitted resource_utility array against the option
 * list for the resolved branch, dropping anything not on that list (e.g. a
 * stale "None of the above" entry, or an option from the wrong branch)
 * rather than trusting the client. Returns { error } or { value }. */
function validateUtility(resourceUtility, allowedOptions) {
  if (!allowedOptions) return { value: [] } // this branch/sub-branch doesn't ask a utility question at all
  if (resourceUtility == null) return { value: [] }
  if (!Array.isArray(resourceUtility)) return { error: 'Resource Utility must be a list' }
  const out = []
  for (const item of resourceUtility) {
    const utility = item && item.utility
    if (!allowedOptions.includes(utility)) continue // silently drop unknown/disallowed entries
    const kg = toNullableNumber(item.production_kg)
    if (Number.isNaN(kg) || (kg != null && kg < 0)) {
      return { error: `${utility} production (KG) must be a non-negative number` }
    }
    out.push({ utility, production_kg: kg })
  }
  return { value: out }
}

// ── POST /api/register — the only write path into resources ────────────────
app.post('/api/register', async (req, res) => {
  const {
    org, key, beneficiary_uid, resource_type, latitude, longitude, area_acre,
    water_body_type, resource_access, wetland_structure, raft_count, resource_utility,
  } = req.body || {}

  if (!(await validateLink(org, key))) {
    return res.status(403).json({ error: 'This registration link is invalid or has expired. Ask your program admin for a new link.' })
  }
  if (!beneficiary_uid || !String(beneficiary_uid).trim()) {
    return res.status(400).json({ error: 'Beneficiary UID is required' })
  }
  if (!PRODUCTION_SYSTEMS.includes(resource_type)) {
    return res.status(400).json({ error: 'Type of Production System must be one of: ' + PRODUCTION_SYSTEMS.join(', ') })
  }
  const lat = toNullableNumber(latitude)
  const lng = toNullableNumber(longitude)
  if (Number.isNaN(lat) || (lat != null && (lat < -90 || lat > 90))) {
    return res.status(400).json({ error: 'Latitude must be between -90 and 90' })
  }
  if (Number.isNaN(lng) || (lng != null && (lng < -180 || lng > 180))) {
    return res.status(400).json({ error: 'Longitude must be between -180 and 180' })
  }

  // Resolve which branch-specific fields actually apply — mirrors the
  // form's own conditional gating, but re-derived server-side rather than
  // trusted from the client. Anything not applicable to this exact branch
  // (e.g. raft_count when Mangroves was picked, or Coastal's utility list
  // if a Freshwater option slipped through) is forced to null/[] here.
  let waterBodyType = null, resourceAccess = null, wetlandStructure = null, raftCount = null
  let areaApplies = false
  let utilityOptions = null

  if (resource_type === 'Freshwater Wetland') {
    if (!WATER_BODY_TYPES.includes(water_body_type)) {
      return res.status(400).json({ error: 'Type of Resource must be one of: ' + WATER_BODY_TYPES.join(', ') })
    }
    waterBodyType = water_body_type
    areaApplies = true
    if (resource_access && !RESOURCE_ACCESS_TYPES.includes(resource_access)) {
      return res.status(400).json({ error: 'Resource Access must be one of: ' + RESOURCE_ACCESS_TYPES.join(', ') })
    }
    resourceAccess = resource_access || null
    utilityOptions = UTILITY_OPTIONS['Freshwater Wetland']
  } else if (resource_type === 'Coastal Wetland') {
    if (!WETLAND_STRUCTURES.includes(wetland_structure)) {
      return res.status(400).json({ error: 'Type of Resource must be Raft or Mangroves' })
    }
    wetlandStructure = wetland_structure
    if (wetland_structure === 'Raft') {
      raftCount = toNullableInt(raft_count)
      if (Number.isNaN(raftCount) || (raftCount != null && raftCount < 0)) {
        return res.status(400).json({ error: 'No. of Raft must be a non-negative whole number' })
      }
      utilityOptions = UTILITY_OPTIONS['Coastal Wetland:Raft']
    } else {
      areaApplies = true
    }
  } else if (resource_type === 'Agricultural Land') {
    areaApplies = true
    utilityOptions = UTILITY_OPTIONS['Agricultural Land']
  }
  // Brackish Water: no branch-specific fields — everything above stays null/[].

  const area = areaApplies ? toNullableNumber(area_acre) : null
  if (Number.isNaN(area) || (area != null && area < 0)) {
    return res.status(400).json({ error: 'Area in Acre must be a non-negative number' })
  }

  const utilityResult = validateUtility(resource_utility, utilityOptions)
  if (utilityResult.error) return res.status(400).json({ error: utilityResult.error })
  const utility = utilityResult.value

  // Re-resolve the beneficiary server-side — never trust a client-supplied
  // name/type for what gets stored, only what this lookup itself found.
  let beneficiary
  try {
    beneficiary = await lookupBeneficiary(org, String(beneficiary_uid).trim())
  } catch (e) {
    console.error('[rs register lookup]', e.message)
    return res.status(500).json({ error: 'Could not verify Beneficiary UID — please try again' })
  }
  if (beneficiary.error) {
    return res.status(404).json({ error: beneficiary.error })
  }

  // Duplicate check — different shape from the other three registration
  // services: a beneficiary can legitimately register more than one
  // Wetland/Agricultural Land (e.g. two separate plots), so matching just
  // (beneficiary_uid, resource_type) isn't enough to call it a duplicate.
  // Only a FULL match — identical coordinates, area, and every
  // branch-specific field — counts as "the same resource submitted twice";
  // anything less is a distinct, legitimate resource. Coordinates are
  // rounded to 5 decimal places (~1.1m) before comparing, so GPS jitter
  // between two submissions of the same plot doesn't look like a new one.
  try {
    const { rows: existingRows } = await orgQuery(org,
      `SELECT uid, latitude, longitude, area_acre, water_body_type, resource_access,
              wetland_structure, raft_count, resource_utility
       FROM resources WHERE org_id = $1 AND beneficiary_uid = $2 AND resource_type = $3`,
      [org, beneficiary.uid, resource_type]
    )
    const numOrNull = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
    const roundCoord = v => (v === null ? null : Math.round(v * 1e5) / 1e5)
    const utilitySig = list => JSON.stringify(
      (Array.isArray(list) ? list : []).slice().sort((a, b) => String(a.utility).localeCompare(String(b.utility)))
    )
    const newUtilitySig = utilitySig(utility)
    const duplicate = existingRows.find(r =>
      roundCoord(numOrNull(r.latitude)) === roundCoord(lat) &&
      roundCoord(numOrNull(r.longitude)) === roundCoord(lng) &&
      numOrNull(r.area_acre) === area &&
      (r.water_body_type || null) === waterBodyType &&
      (r.resource_access || null) === resourceAccess &&
      (r.wetland_structure || null) === wetlandStructure &&
      (r.raft_count ?? null) === (raftCount ?? null) &&
      utilitySig(r.resource_utility) === newUtilitySig
    )
    if (duplicate) {
      return res.status(409).json({
        error: `This resource has already been registered (${duplicate.uid}) for this beneficiary with the same location, area and details.`,
      })
    }
  } catch (e) {
    console.error('[rs register dup-check]', e.message)
    return res.status(500).json({ error: 'Registration failed — please try again' })
  }

  const pool   = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(org)])

    // Atomic per-(org, resource_type) counter: one UPSERT, no read-then-write race window.
    const seqRes = await client.query(
      `INSERT INTO resource_seq (org_id, resource_type, next_val) VALUES ($1, $2, 1)
       ON CONFLICT (org_id, resource_type) DO UPDATE SET next_val = resource_seq.next_val + 1
       RETURNING next_val`,
      [org, resource_type]
    )
    const uid = `${UID_PREFIX[resource_type]}-${beneficiary.typePrefix}-${districtCode(beneficiary.district)}-${seqRes.rows[0].next_val}`

    const insertRes = await client.query(
      `INSERT INTO resources
         (org_id, uid, resource_type, beneficiary_uid, beneficiary_type, beneficiary_name,
          latitude, longitude, area_acre, water_body_type, resource_access, wetland_structure,
          raft_count, resource_utility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, uid, resource_type, beneficiary_uid, beneficiary_type, beneficiary_name,
                 latitude, longitude, area_acre, water_body_type, resource_access, wetland_structure,
                 raft_count, resource_utility, created_at`,
      [org, uid, resource_type, beneficiary.uid, beneficiary.type, beneficiary.name, lat, lng, area,
        waterBodyType, resourceAccess, wetlandStructure, raftCount, JSON.stringify(utility)]
    )
    await client.query('COMMIT')
    res.json(insertRes.rows[0])
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[rs register]', e.message)
    res.status(500).json({ error: 'Registration failed — please try again' })
  } finally {
    client.release()
  }
})

// ── Public registration form ──────────────────────────────────────────────────
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/', (_req, res) => res.redirect('/register'))
app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, () => console.log(`[resource] listening on ${PORT}`))
