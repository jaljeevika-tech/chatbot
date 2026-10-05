#!/usr/bin/env node
// scripts/verify-correctness.mjs — End-to-end driver for the data-correctness layer.
//
// What it does:
//   1. Connects to DATABASE_URL (Neon)
//   2. Verifies migration 010 columns + reconciliation_checks table exist
//   3. Runs each layer in isolation against synthetic payloads
//   4. Runs reconciliation against the first available org
//   5. Reports pass/fail per check
//
// Usage:
//   DATABASE_URL='postgresql://…'  node scripts/verify-correctness.mjs
//   DATABASE_URL='postgresql://…'  node scripts/verify-correctness.mjs --org=<uuid>
//
// Optional env:
//   GEMINI_API_KEY     — enables LLM semantic-pass checks (anomaly + hallucination)
//   ORG_ID             — pin to a specific org (else picks first by created_at)
//   VERBOSE=1          — full verdict objects in output
//
// Safe to re-run. Writes to audit_log + reconciliation_checks; does NOT
// touch daily_reports / saved_reports / project_deliverables.

import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg
const VERBOSE = process.env.VERBOSE === '1'

let pool
let passes = 0
let fails = 0
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (ok) { passes++; console.log(`  ✅ ${name}`) }
  else    { fails++;  console.log(`  ❌ ${name} — ${detail}`) }
  if (VERBOSE && detail && ok) console.log('     ', detail)
}

async function step(title, fn) {
  console.log(`\n▶ ${title}`)
  try { await fn() }
  catch (e) {
    fails++
    console.error(`  💥 ${title} threw: ${e.message}`)
    if (VERBOSE) console.error(e.stack)
  }
}

// ── Step 1: Schema verification ─────────────────────────────────────────────
async function verifySchema() {
  const checks = [
    { table: 'reconciliation_checks', col: 'id' },
    { table: 'daily_reports',         col: 'quality_flag' },
    { table: 'daily_reports',         col: 'quality_confidence' },
    { table: 'saved_reports',         col: 'quality_flag' },
    { table: 'saved_reports',         col: 'grounding_score' },
    { table: 'saved_reports',         col: 'lineage' },
    { table: 'project_deliverables',  col: 'quality_flag' },
  ]
  for (const c of checks) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [c.table, c.col]
    )
    record(`${c.table}.${c.col} exists`, rows.length > 0,
      rows.length > 0 ? '' : 'apply db/migrations/010_data_correctness.sql')
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'reconciliation_checks'`
  )
  record('reconciliation_checks table present', rows.length > 0)
}

// ── Step 2: Pick an org to test against ─────────────────────────────────────
async function pickOrg() {
  if (process.env.ORG_ID) return process.env.ORG_ID
  const argOrg = process.argv.find(a => a.startsWith('--org='))?.split('=')[1]
  if (argOrg) return argOrg
  const { rows } = await pool.query(
    `SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1`
  )
  if (!rows[0]) throw new Error('No organizations in the DB — create one first')
  return rows[0].id
}

// ── Step 3: Layer 1 — anomaly detection ─────────────────────────────────────
async function verifyAnomaly(orgId) {
  const { check } = await import('../lib/dataCorrectness/index.js')

  // Case 3a: clean submission
  const v1 = await check('anomaly', {
    beneficiaries: 15,
    description:   'Trained a group of women on pond hygiene in Khagaria',
    report_date:   new Date().toISOString().slice(0, 10),
    location:      'Khagaria',
    area_of_intervention: 'training',
  }, { orgId, kind: 'daily_report' })
  record('clean submission → allow', v1.action === 'allow' && v1.severity === 'clean',
    `severity=${v1.severity} action=${v1.action} reasons=${JSON.stringify(v1.reasons)}`)

  // Case 3b: negative beneficiaries → high severity
  const v2 = await check('anomaly', {
    beneficiaries: -5,
    description: 'Test',
    report_date: new Date().toISOString().slice(0, 10),
  }, { orgId, kind: 'daily_report' })
  record('negative beneficiaries → high severity', v2.severity === 'high',
    `severity=${v2.severity} action=${v2.action}`)

  // Case 3c: future date → severe
  const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
  const v3 = await check('anomaly', {
    beneficiaries: 12,
    description: 'Plan: visit next week',
    report_date: future,
  }, { orgId, kind: 'daily_report' })
  record('future report_date → flagged', v3.severity !== 'clean',
    `severity=${v3.severity} reasons=${JSON.stringify(v3.reasons)}`)

  // Case 3d: training with 0 beneficiaries → flagged
  const v4 = await check('anomaly', {
    beneficiaries: 0,
    description: 'Training session on water management',
    report_date: new Date().toISOString().slice(0, 10),
    area_of_intervention: 'training',
  }, { orgId, kind: 'daily_report' })
  record('training + 0 beneficiaries → flagged', v4.severity !== 'clean',
    `severity=${v4.severity}`)

  // Case 3e: plan-vs-actual breach
  const v5 = await check('anomaly', {
    planned: 100, achieved: 350,
    report_date: new Date().toISOString().slice(0, 10),
  }, { orgId, kind: 'action_plan_cell' })
  record('achieved 3.5× planned → high severity', v5.severity === 'high',
    `severity=${v5.severity}`)
}

// ── Step 4: Layer 2 — hallucination guard ───────────────────────────────────
async function verifyHallucination(orgId) {
  const { check } = await import('../lib/dataCorrectness/index.js')

  const sources = [
    { id: '00000000-0000-0000-0000-000000000001', beneficiaries: 12, location: 'Khagaria', project: 'Fisheries', worker_name: 'Priya Kumari', report_date: '2026-06-01' },
    { id: '00000000-0000-0000-0000-000000000002', beneficiaries: 18, location: 'Saharsa',   project: 'Fisheries', worker_name: 'Rahul Singh',  report_date: '2026-06-02' },
    { id: '00000000-0000-0000-0000-000000000003', beneficiaries: 22, location: 'Madhubani', project: 'Fisheries', worker_name: 'Priya Kumari', report_date: '2026-06-03' },
  ]

  // Case 4a: grounded output (sum = 52, exact mention)
  const grounded = `## Q1 Progress\n\nThe team reached 52 beneficiaries across Khagaria, Saharsa, and Madhubani.\n\n- r1: Priya led a session for 12 women.\n- r2: Rahul covered 18 in Saharsa.\n- r3: Priya again in Madhubani — 22.`
  const v1 = await check('hallucination', { output: grounded, sources }, { orgId, kind: 'saved_report' })
  record('grounded output → allow', v1.action === 'allow',
    `severity=${v1.severity} grounding=${v1.grounding_score?.toFixed(2)} suspicious=${v1.suspicious?.length}`)

  // Case 4b: fabricated number (240 not in sources)
  const fabricated = `## Q1 Progress\n\nThe team reached 240 beneficiaries this quarter — a record-breaking number across our 12 partner villages.`
  const v2 = await check('hallucination', { output: fabricated, sources }, { orgId, kind: 'saved_report' })
  record('fabricated 240 → flagged', v2.severity !== 'clean' && v2.action !== 'allow',
    `severity=${v2.severity} grounding=${v2.grounding_score?.toFixed(2)} reasons=${JSON.stringify(v2.reasons.slice(0,2))}`)

  // Case 4c: broken citation (r5 doesn't exist in 3-source set)
  const brokenCite = `## Progress\n\nA major milestone was reached — see r5 for the full breakdown.`
  const v3 = await check('hallucination', { output: brokenCite, sources }, { orgId, kind: 'saved_report' })
  record('broken citation (r5 of 3) → flagged', v3.severity !== 'clean',
    `severity=${v3.severity} reasons=${JSON.stringify(v3.reasons.slice(0,2))}`)

  // Case 4d: story_finder — narrative prose grounded in ONE cited source row,
  // with sentence-initial connectives ("Across", "Following", "During") and a
  // name ("Firoz") that only lives in the source's free-text description, not
  // any structured field. Regression guard for the bug where every Story
  // Finder narrative was dropped: the entity NER mistook ordinary
  // sentence-opening words for unmatched proper nouns, and the adversarial
  // judge prompt (built for literal donor-report drafts) flagged normal
  // narrative embellishment as fabrication.
  const storySources = [{
    id: '00000000-0000-0000-0000-000000000010', location: 'Pipra Block', state: 'Bihar',
    project: 'Fisheries', beneficiaries: 8, report_date: '2026-02-10',
    description: 'Distributed fish seed packets to nursery farmers in Pipra Block. Local agent Firoz coordinated transport with Nandan Kumar.',
  }]
  const storyNarrative = `Across Pipra Block and surrounding villages in Bihar, early morning saw hundreds of fish seed packets being received. Following the arrival, local agent Firoz helped coordinate the handover, working alongside Nandan Kumar to ensure 8 nursery fish farmers each got their share. During the distribution, the team observed visible excitement among the farmers, who were eager to begin restocking their ponds.`
  const v4 = await check('hallucination', { output: storyNarrative, sources: storySources }, { orgId, kind: 'story_finder' })
  record('story_finder: grounded narrative w/ connectives + description-only name → not dropped',
    v4.severity !== 'high',
    `severity=${v4.severity} grounding=${v4.grounding_score?.toFixed(2)} reasons=${JSON.stringify(v4.reasons)}`)

  // Case 4e: story_finder — genuinely fabricated narrative (invented number,
  // place, and name) against the same single source row must still be caught.
  const fabricatedStory = `Asha Devi distributed seed packets to 500 farmers in Surat. Rajesh Mehta from the donor committee praised the milestone.`
  const v5 = await check('hallucination', { output: fabricatedStory, sources: storySources }, { orgId, kind: 'story_finder' })
  record('story_finder: fabricated number/place/name → still flagged',
    v5.severity !== 'clean',
    `severity=${v5.severity} grounding=${v5.grounding_score?.toFixed(2)}`)
}

// ── Step 5: Lineage ─────────────────────────────────────────────────────────
async function verifyLineage() {
  const { buildLineage, resolveClaim } = await import('../lib/dataCorrectness/lineage.js')
  const sources = [
    { id: '00000000-0000-0000-0000-000000000001', beneficiaries: 12, location: 'Khagaria' },
    { id: '00000000-0000-0000-0000-000000000002', beneficiaries: 18, location: 'Saharsa' },
    { id: '00000000-0000-0000-0000-000000000003', beneficiaries: 22, location: 'Madhubani' },
  ]
  const content = `Reached 52 beneficiaries across Khagaria, Saharsa, and Madhubani. Priya led one of the trainings.`
  const lineage = buildLineage(content, sources)
  record('lineage built — numbers + entities', lineage.numbers.length > 0 && lineage.entities.length > 0,
    `numbers=${lineage.numbers.length} entities=${lineage.entities.length}`)

  // The number 52 should attribute to all 3 sources (sum match)
  const idsFor52 = resolveClaim(lineage, '52')
  record('resolveClaim("52") → all 3 source IDs', idsFor52.length === 3,
    `ids=${JSON.stringify(idsFor52)}`)

  // Entity "Khagaria" should point only to row 1
  const idsForKhagaria = resolveClaim(lineage, 'Khagaria')
  record('resolveClaim("Khagaria") → row 1', idsForKhagaria.length === 1 && idsForKhagaria[0].endsWith('001'),
    `ids=${JSON.stringify(idsForKhagaria)}`)
}

// ── Step 6: Period math (fiscal year) ───────────────────────────────────────
async function verifyPeriodMath() {
  const { currentFY, previousFY, currentQuarter, rollingDays } = await import('../lib/dataCorrectness/periodMath.js')

  // April-start org tested on 15 June: should land in FY starting that April.
  const referenceDate = new Date(2026, 5, 15) // June 15, 2026 (month index 5)
  const fy = currentFY({ fiscal_year_start: 'April' }, referenceDate)
  const ok1 = fy.start.getMonth() === 3 /* April */ && fy.start.getFullYear() === 2026
  record('FY (April-start) covering 15 June 2026 begins 1 April 2026',
    ok1, `start=${fy.start.toISOString().slice(0,10)} end=${fy.end.toISOString().slice(0,10)} label=${fy.label}`)

  // January-start org behaves like calendar year
  const cyfy = currentFY({ fiscal_year_start: 'January' }, referenceDate)
  record('FY (Jan-start) for 15 June 2026 → label FY2026',
    cyfy.label === 'FY2026', `label=${cyfy.label}`)

  // Previous FY is exactly one year before
  const prev = previousFY({ fiscal_year_start: 'April' }, referenceDate)
  const ok3 = prev.start.getFullYear() === fy.start.getFullYear() - 1
  record('previousFY is one year before currentFY', ok3, `prev=${prev.label} cur=${fy.label}`)

  // Quarter math
  const q = currentQuarter({ fiscal_year_start: 'April' }, referenceDate)
  record('currentQuarter labelled with FY prefix', /^FY\d{4}-\d{2}Q[1-4]$/.test(q.label),
    `label=${q.label}`)

  // Rolling window
  const r = rollingDays(30, referenceDate)
  const days = (r.end - r.start) / 86400000
  record('rollingDays(30) yields 30-day window', Math.abs(days - 30) < 0.5,
    `start=${r.start.toISOString().slice(0,10)} end=${r.end.toISOString().slice(0,10)}`)
}

// ── Step 7: Content moderation + redaction ──────────────────────────────────
async function verifyModeration() {
  const { redact, scan } = await import('../lib/contentModeration.js')

  // Use a known-valid Aadhaar test number (Verhoeff-valid by construction)
  // Reference: UIDAI publishes sample Aadhaar 234123412346 for testing.
  const piiText = 'My Aadhaar is 234123412346 and my mobile is 9876543210. Email me at priya@example.com.'
  const cleaned = redact(piiText)
  const scanned = scan(piiText)
  record('redact() masks mobile number', !cleaned.includes('9876543210'),
    `redacted="${cleaned}"`)
  record('redact() masks email', !cleaned.includes('priya@example.com'),
    `redacted="${cleaned}"`)
  record('scan() counts PII findings', scanned.findings.mobile === 1 && scanned.findings.email === 1,
    `findings=${JSON.stringify(scanned.findings)}`)
}

// ── Step 8: Reconciliation against real org ─────────────────────────────────
async function verifyReconciliation(orgId) {
  const { runReconciliationForOrg } = await import('../lib/dataCorrectness/reconciliation.js')
  const { rows: meta } = await pool.query(
    `SELECT metadata FROM organizations WHERE id = $1`,
    [orgId]
  )
  const orgMeta = meta[0]?.metadata || {}
  const results = await runReconciliationForOrg(pool, orgId, { orgMeta })
  record('reconciliation ran without throwing', Array.isArray(results),
    `results=${JSON.stringify(results.map(r => ({ metric: r.metric, drift: r.driftPct, pass: r.driftPass })))}`)

  // Verify rows actually landed in reconciliation_checks
  const { rows: stored } = await pool.query(
    `SELECT metric, value_a, value_b, drift_pct, drift_pass, period_label
       FROM reconciliation_checks
      WHERE org_id = $1
        AND checked_at >= NOW() - INTERVAL '1 minute'
      ORDER BY checked_at DESC`,
    [orgId]
  )
  record('reconciliation rows persisted', stored.length >= results.length,
    `rows=${stored.length}`)
}

// ── Step 9: Policy round-trip ───────────────────────────────────────────────
async function verifyPolicy(orgId) {
  const { getEnforcementMode, getTolerances, invalidatePolicyCache } = await import('../lib/dataCorrectness/policy.js')
  invalidatePolicyCache(orgId)
  const mode = await getEnforcementMode(orgId)
  record('getEnforcementMode returns "soft" or "tiered"', mode === 'soft' || mode === 'tiered',
    `mode=${mode}`)
  const tols = await getTolerances(orgId)
  record('tolerances object loaded', tols && typeof tols.beneficiaries === 'number',
    `tolerances=${JSON.stringify(tols)}`)
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var required (e.g. postgresql://…neon.tech/…)')
    process.exit(2)
  }
  // The imported modules call getPool() from db/pool.js, which lazy-creates
  // from DATABASE_URL on first use. We share the same connection by using the
  // same env var; we just keep a local pool here for the script's direct queries.
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })

  console.log('FieldFlow Data Correctness — Verification Suite')
  console.log('================================================')

  await step('Step 1 — Schema migration verification', verifySchema)

  const orgId = await pickOrg()
  console.log(`\nUsing org_id: ${orgId}`)

  await step('Step 2 — Layer 1: anomaly detection',     () => verifyAnomaly(orgId))
  await step('Step 3 — Layer 2: hallucination guard',   () => verifyHallucination(orgId))
  await step('Step 4 — Lineage (build + resolve)',      verifyLineage)
  await step('Step 5 — Period math (FY awareness)',     verifyPeriodMath)
  await step('Step 6 — Content moderation (PII)',       verifyModeration)
  await step('Step 7 — Reconciliation (against org)',   () => verifyReconciliation(orgId))
  await step('Step 8 — Policy resolution',              () => verifyPolicy(orgId))

  console.log('\n================================================')
  console.log(`Results: ${passes} passed, ${fails} failed`)
  if (fails > 0) {
    console.log('\nFailing checks:')
    for (const r of results.filter(r => !r.ok)) console.log(`  • ${r.name}: ${r.detail}`)
  }
  await pool.end()
  process.exit(fails > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('FATAL:', e)
  process.exit(2)
})
