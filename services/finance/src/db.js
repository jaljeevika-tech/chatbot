// services/finance/src/db.js — org-scoped query helpers for the Finance module.
//
// Every query runs inside a transaction that first sets app.current_org_id,
// so the fm_* RLS policies apply when connected as the restricted fm_service
// role (Cloud Run). As the monolith's table-owner role RLS is bypassed, which
// is why every query below still filters on org_id explicitly as well.

/** Run fn(client) inside one org-scoped transaction and return its result. */
export async function withOrgTx(pool, orgId, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Parameterized set_config (transaction-local) — never string-interpolated.
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(orgId)])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Single org-scoped statement. */
export function orgQuery(pool, orgId, text, values = []) {
  return withOrgTx(pool, orgId, client => client.query(text, values))
}

/** Indian financial year label (Apr–Mar) for a date, e.g. '2026-27'. Uses IST, not the server's timezone. */
export function fyLabel(d = new Date()) {
  const ist = new Date(d.getTime() + 330 * 60 * 1000)
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

/** Next reference number, e.g. ADV/2026-27/0007. Must run inside withOrgTx. */
export async function nextRefNo(client, orgId, kind) {
  const fy = fyLabel()
  const { rows } = await client.query(
    `INSERT INTO fm_counters (org_id, kind, fy, last_no) VALUES ($1, $2, $3, 1)
     ON CONFLICT (org_id, kind, fy) DO UPDATE SET last_no = fm_counters.last_no + 1
     RETURNING last_no`,
    [orgId, kind, fy]
  )
  return `${kind}/${fy}/${String(rows[0].last_no).padStart(4, '0')}`
}

/** Append an audit-trail row. Must run inside withOrgTx. */
export function logEvent(client, orgId, entityType, entityId, action, actorId, note = null) {
  return client.query(
    `INSERT INTO fm_events (org_id, entity_type, entity_id, action, actor_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, entityType, entityId, action, actorId, note]
  )
}
