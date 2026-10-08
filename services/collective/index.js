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
// Deploy — build context is the REPO ROOT (shares services/registration-shared, lib/):
//   docker build -f services/collective/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/collective .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/collective
//   gcloud run deploy fieldflow-collective --image asia-south1-docker.pkg.dev/<project>/fieldflow/collective --region asia-south1
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
const PORT = process.env.PORT || 8085

app.use(express.json({ limit: '256kb' }))

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use(correlationId)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'collective', version: '1.0.0' }))

// ── DB (cb_service role on Cloud SQL) — pool, RLS-scoped orgQuery and the
// registration-link check live in services/registration-shared/common.js.
const { getPool, orgQuery, validateLink } = createRegistrationDb({ prefix: 'CB', tokenTable: 'cb_registration_tokens' })

// ── GET /api/validate — the form's first call, to show/hide itself ──────────
app.get('/api/validate', async (req, res) => {
  const { org, key } = req.query
  res.json({ ok: await validateLink(org, key) })
})

// ── LGD location lookups — the same governed reference data and query shapes as the
// monolith's /api/lgd (lib/lgdRouter.js), read through this service's pool.
app.use('/api', createLgdRouter(getPool, { requireState: true }))

const COLLECTIVE_TYPES = ['FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective']

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
  const productionResult = validateProductionSystems(production_systems, { required: false })
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
