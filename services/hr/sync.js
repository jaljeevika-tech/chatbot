// services/hr/sync.js — POST /api/hr/sync: the single write path for attendance/leave.
// Each action runs in its own transaction, keyed by a client UUID; outcomes are kept
// in hr_sync_receipts so a retry replays the stored result instead of re-applying.
// retryable: false = rejected, drop it; retryable: true = server trouble, keep queued.

import { HttpError, withOrg } from './db.js'
import { UUID_RE, loadSettings } from './context.js'
import { dispatch } from './notify.js'
import {
  cancelLeave, checkIn, checkOut, decideLeave, markAttendance, requestLeave, reviewFlag,
} from './actions.js'

const HANDLERS = {
  check_in:        checkIn,
  check_out:       checkOut,
  mark_attendance: markAttendance,
  review_flag:     reviewFlag,
  leave_request:   requestLeave,
  leave_cancel:    cancelLeave,
  leave_decision:  decideLeave,
}

const MAX_ACTIONS = 50

export async function processSync(orgId, me, body) {
  const serverNow = new Date()
  const sentAt = new Date(body?.sentAt)
  if (Number.isNaN(sentAt.getTime())) throw new HttpError(400, 'sentAt is required.')
  const actions = Array.isArray(body?.actions) ? body.actions : []
  if (actions.length > MAX_ACTIONS) throw new HttpError(400, `Send at most ${MAX_ACTIONS} actions at a time.`)

  // Phone clock vs server clock, measured right now. Network latency is
  // seconds; the flag threshold is minutes.
  const skewMs = serverNow.getTime() - sentAt.getTime()
  const results = []
  const outbox = []   // notifications from committed actions only
  for (const action of actions) {
    results.push(await processOne(orgId, me, action, serverNow, skewMs, outbox))
  }
  await dispatch(orgId, outbox)
  return { serverTime: serverNow.toISOString(), results }
}

async function processOne(orgId, me, action, serverNow, skewMs, outbox) {
  const clientId = String(action?.clientId ?? '')
  const reject = (error) => ({ clientId, ok: false, error, retryable: false })
  if (!UUID_RE.test(clientId)) return reject('Invalid action id.')
  const handler = HANDLERS[action.kind]
  if (!handler) return reject(`Unknown action "${action.kind}".`)
  const createdAt = new Date(action.createdAt)
  if (Number.isNaN(createdAt.getTime())) return reject('Missing action time.')
  const timing = { serverNow, skewMs, createdAt, offline: !!action.offline }

  const notify = []
  try {
    const out = await withOrg(orgId, async (client) => {
      // Serialise concurrent sends of the same action (two tabs syncing at once).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hr-sync:${clientId}`])
      const prior = await client.query(
        `SELECT user_id, result FROM hr_sync_receipts WHERE client_id = $1`, [clientId])
      if (prior.rows[0]) {
        if (prior.rows[0].user_id !== me.id) return reject('Action id already used.')
        return { clientId, ...prior.rows[0].result, replayed: true }
      }
      const settings = await loadSettings(client, orgId)
      const data = await handler(client, { orgId, me, settings, notify }, action.payload ?? {}, timing)
      const result = { ok: true, data }
      await storeReceipt(client, clientId, orgId, me.id, action.kind, result)
      return { clientId, ...result }
    })
    // Committed (and not a replay — that returns before the handler runs).
    outbox.push(...notify)
    return out
  } catch (e) {
    if (e instanceof HttpError) {
      // Record the rejection too, so a retry gets the same answer instead of
      // being re-evaluated against data that has moved on since.
      const result = { ok: false, error: e.message, retryable: false }
      await withOrg(orgId, (c) => storeReceipt(c, clientId, orgId, me.id, action.kind, result))
        .catch((err) => console.warn(`[hr-sync] receipt for rejected ${clientId} not stored:`, err.message))
      return { clientId, ...result }
    }
    console.error(`[hr-sync] ${action.kind} ${clientId} failed:`, e)
    return { clientId, ok: false, error: 'Server error — it will retry automatically.', retryable: true }
  }
}

function storeReceipt(client, clientId, orgId, userId, kind, result) {
  return client.query(
    `INSERT INTO hr_sync_receipts (client_id, org_id, user_id, kind, result)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (client_id) DO NOTHING`,
    [clientId, orgId, userId, kind, result])
}
