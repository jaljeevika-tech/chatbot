// Daily cleanup of unbounded tables, so Neon's 0.5 GB free tier doesn't fill and
// PII doesn't linger. Each policy is a bounded "older than N days" DELETE; errors
// are logged, never thrown.

import { getPool } from '../db/pool.js'
import { ANONYMIZE_SPECS, clearLinkedPii } from './anonymizeSpecs.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const POLICIES = [
  // wa_dead_letter — PII (phone, message text) auto-purges 30 days after capture.
  { table: 'wa_dead_letter', column: 'created_at', days: 30 },

  // wa_messages — chat history; reports have already been moved into daily_reports by then.
  { table: 'wa_messages',    column: 'created_at', days: 180 },

  // audit_log — keep a full year for compliance + debugging, then drop.
  { table: 'audit_log',      column: 'created_at', days: 365 },

  // wa_sessions — completed/abandoned only; active sessions are excluded
  { table: 'wa_sessions',    column: 'updated_at', days: 30, where: `status IN ('completed','abandoned','expired')` },
]

// ── DPDP: beneficiary PII anonymization + closed-DSR cleanup ────────────────
// Per-org opt-in via organizations.metadata.dpdp.*_days; orgs without it are untouched,
// since the retention period is a board/counsel decision (GovernanceRequirements.md §12).
// Uses lib/anonymizeSpecs.js, same as beneficiary-erasure.routes.js.
const BENEFICIARY_TABLES = Object.keys(ANONYMIZE_SPECS)

async function runBeneficiaryRetention(pool) {
  const { rows: orgs } = await pool.query(
    `SELECT id, (metadata->'dpdp'->>'beneficiary_retention_days')::int AS retention_days
     FROM organizations
     WHERE metadata->'dpdp'->>'beneficiary_retention_days' IS NOT NULL`
  )
  let total = 0
  for (const org of orgs) {
    if (!org.retention_days || org.retention_days <= 0) continue
    for (const table of BENEFICIARY_TABLES) {
      const columns = ANONYMIZE_SPECS[table]
      try {
        const setSql = columns.map((c, i) => `${c.column} = $${i + 3}`).join(', ')
        const values = [org.id, org.retention_days, ...columns.map(c => c.value)]
        const res = await pool.query(
          `UPDATE ${table} SET ${setSql}, anonymized_at = now()
           WHERE org_id = $1 AND anonymized_at IS NULL AND deleted_at IS NULL
             AND created_at < NOW() - ($2::text || ' days')::interval
           RETURNING uid`,
          values
        )
        // Also clear the name/contact copies the MIS tables hold for them.
        await clearLinkedPii(pool, org.id, res.rows.map(r => r.uid))
        if (res.rowCount > 0) {
          console.log(`[retention] ${table} (org ${org.id}): anonymized ${res.rowCount} rows past ${org.retention_days}-day retention`)
          total += res.rowCount
        }
      } catch (e) {
        console.warn(`[retention] ${table} (org ${org.id}) anonymization failed:`, e.message)
      }
    }
  }
  return total
}

// Closed DSRs are an accountability record with their own per-org opt-in window.
async function runDsrRetention(pool) {
  const { rows: orgs } = await pool.query(
    `SELECT id, (metadata->'dpdp'->>'dsr_retention_days')::int AS retention_days
     FROM organizations
     WHERE metadata->'dpdp'->>'dsr_retention_days' IS NOT NULL`
  )
  let total = 0
  for (const org of orgs) {
    if (!org.retention_days || org.retention_days <= 0) continue
    try {
      const res = await pool.query(
        `DELETE FROM dsr_requests
         WHERE org_id = $1 AND status IN ('fulfilled','rejected','withdrawn')
           AND COALESCE(fulfilled_at, updated_at) < NOW() - ($2::text || ' days')::interval`,
        [org.id, org.retention_days]
      )
      if (res.rowCount > 0) {
        console.log(`[retention] dsr_requests (org ${org.id}): deleted ${res.rowCount} closed requests past ${org.retention_days}-day retention`)
        total += res.rowCount
      }
    } catch (e) {
      console.warn(`[retention] dsr_requests (org ${org.id}) cleanup failed:`, e.message)
    }
  }
  return total
}

async function runOnce() {
  const pool = getPool()
  let total = 0
  for (const p of POLICIES) {
    try {
      const whereExtra = p.where ? `AND ${p.where}` : ''
      const sql = `DELETE FROM ${p.table}
                   WHERE ${p.column} < NOW() - INTERVAL '${p.days} days' ${whereExtra}`
      const res = await pool.query(sql)
      if (res.rowCount > 0) {
        console.log(`[retention] ${p.table}: deleted ${res.rowCount} rows older than ${p.days} days`)
        total += res.rowCount
      }
    } catch (e) {
      console.warn(`[retention] ${p.table} cleanup failed:`, e.message)
    }
  }

  // Hard-delete soft-deleted action_plans older than 30 days (the "grace period")
  try {
    const res = await pool.query(`
      DELETE FROM action_plans
      WHERE active = false AND updated_at < NOW() - INTERVAL '30 days'
    `)
    if (res.rowCount > 0) {
      console.log(`[retention] action_plans: hard-deleted ${res.rowCount} soft-deleted rows past 30-day grace`)
      total += res.rowCount
    }
  } catch (e) {
    console.warn('[retention] action_plans cleanup failed:', e.message)
  }

  total += await runBeneficiaryRetention(pool)
  total += await runDsrRetention(pool)

  if (total > 0) console.log(`[retention] total rows removed/anonymized in this pass: ${total}`)
}

export function startRetention() {
  // Wait 30s after boot so startup migrations aren't competing
  setTimeout(() => {
    runOnce().catch(e => console.warn('[retention] initial pass failed:', e.message))
    setInterval(() => {
      runOnce().catch(e => console.warn('[retention] periodic pass failed:', e.message))
    }, ONE_DAY_MS).unref()
  }, 30_000).unref()
}
