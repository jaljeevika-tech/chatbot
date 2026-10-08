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
// Deploy — build context is the REPO ROOT (shares services/registration-shared, lib/):
//   docker build -f services/micro-entrepreneur/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/micro-entrepreneur .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/micro-entrepreneur
//   gcloud run deploy fieldflow-micro-entrepreneur --image asia-south1-docker.pkg.dev/<project>/fieldflow/micro-entrepreneur --region asia-south1
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
const PORT = process.env.PORT || 8084

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use(correlationId)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'micro-entrepreneur', version: '1.0.0' }))

// ── DB (eb_service role on Cloud SQL) — pool, RLS-scoped orgQuery and the
// registration-link check live in services/registration-shared/common.js.
const { getPool, orgQuery, validateLink } = createRegistrationDb({ prefix: 'EB', tokenTable: 'me_registration_tokens' })

// ── GET /api/validate — the form's first call, to show/hide itself ──────────
app.get('/api/validate', async (req, res) => {
  const { org, key } = req.query
  res.json({ ok: await validateLink(org, key) })
})

// ── LGD location lookups — the same governed reference data and query shapes as the
// monolith's /api/lgd (lib/lgdRouter.js), read through this service's pool.
app.use('/api', createLgdRouter(getPool, { requireState: true }))

const GENDERS    = ['Male', 'Female', 'Other']
const CATEGORIES = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']

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
  const productionResult = validateProductionSystems(production_systems, { required: false })
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
