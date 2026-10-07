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
// Deploy — build context is the REPO ROOT (shares services/registration-shared, lib/):
//   docker build -f services/individual-beneficiary/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/individual-beneficiary .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/individual-beneficiary
//   gcloud run deploy fieldflow-individual-beneficiary --image asia-south1-docker.pkg.dev/<project>/fieldflow/individual-beneficiary --region asia-south1
//   (keep the service's existing env/secrets — the image change alone doesn't touch them)

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRegistrationDb, toNullableNumber, toNullableInt, districtCode, validateProductionSystems } from '../registration-shared/common.js'
import { correlationId } from '../../lib/correlationId.js'
import { createLgdRouter } from '../../lib/lgdRouter.js'
import { encryptPii, hashContactNo } from '../registration-shared/crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app  = express()
const PORT = process.env.PORT || 8083

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use(correlationId)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'individual-beneficiary', version: '1.0.0' }))

// ── DB (ib_service role on Cloud SQL) — pool, RLS-scoped orgQuery and the
// registration-link check live in services/registration-shared/common.js.
const { getPool, orgQuery, validateLink } = createRegistrationDb({ prefix: 'IB', tokenTable: 'ib_registration_tokens' })

// ── GET /api/validate — the form's first call, to show/hide itself ──────────
app.get('/api/validate', async (req, res) => {
  const { org, key } = req.query
  res.json({ ok: await validateLink(org, key) })
})

// ── LGD location lookups — the same governed reference data and query shapes as the
// monolith's /api/lgd (lib/lgdRouter.js), read through this service's pool.
app.use('/api', createLgdRouter(getPool, { requireState: true }))

const GENDERS          = ['Male', 'Female', 'Other']
const CATEGORIES       = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']

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
  const productionResult = validateProductionSystems(production_systems, { required: true })
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
