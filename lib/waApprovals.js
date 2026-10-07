// WhatsApp "Approve" button for HR leave and Finance advance/settlement approvals.
// The approval templates (services/hr/notify.js, services/finance/src/notify.js)
// carry a quick-reply payload ffa:<kind>:<stage>:<id>. A tap gets a confirm prompt
// (Yes / No reply buttons, quoting the original message); "Yes" runs the normal
// approve route as the user who owns the sending phone, so every permission and
// state check is the same as in the app.
//
// Attendance reminders carry ffa:<checkin|checkout>:-:<userId>. A tap asks for a
// location share and remembers the intent on the wa_contacts row for 15 minutes;
// the location that comes back checks the sender in/out through /hr/sync.

import { randomUUID } from 'crypto'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TAP_RE     = new RegExp(`^ffa:(leave|advance|settlement):(-|manager|finance):(${UUID})$`, 'i')
const CONFIRM_RE = new RegExp(`^ffa-ok:(leave|advance|settlement):(-|manager|finance):(${UUID})$`, 'i')
const NOUN = { leave: 'leave request', advance: 'advance', settlement: 'settlement' }
const ATT_TAP_RE = new RegExp(`^ffa:(checkin|checkout):-:(${UUID})$`, 'i')
const ATT_WINDOW_MS = 15 * 60_000
const ATT = {
  checkin:  { verb: 'check in',  action: 'check_in',  done: 'Checked in' },
  checkout: { verb: 'check out', action: 'check_out', done: 'Checked out' },
}

/** Handles approval taps; returns true when the event was one (caller stops there). */
export async function handleApprovalReply(event, { orgId, pool, waClient, contact, duplicate = false }) {
  const att = ATT_TAP_RE.exec(event.buttonPayload || '')
  const pending = contact?.fields?.ff_attendance
  if (event.messageType === 'location' && pending?.done === event.messageId) return true   // redelivery
  const locationReply = event.messageType === 'location' && ATT[pending?.kind] && Date.now() - pending.at < ATT_WINDOW_MS
  if (att || locationReply) {
    if (duplicate) return true
    if (att) await askLocation(event, att[1], { pool, waClient, contact })
    else await recordAttendance(event, pending.kind, { orgId, pool, waClient, contact })
    return true
  }
  const isOurs = TAP_RE.test(event.buttonPayload || '') || /^ffa-(ok|no)/.test(event.interactiveId || '')
  if (!isOurs) return false
  if (duplicate) return true
  const tap = TAP_RE.exec(event.buttonPayload || '')
  if (tap) {
    const [, kind, stage, id] = tap
    await waClient._post({
      to: event.from,
      context: event.raw?.context?.id ? { message_id: event.raw.context.id } : undefined,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `Approve this ${NOUN[kind]}? Open the link in the message to review it first.` },
        action: { buttons: [
          { type: 'reply', reply: { id: `ffa-ok:${kind}:${stage}:${id}`, title: 'Yes, approve' } },
          { type: 'reply', reply: { id: 'ffa-no', title: 'No' } },
        ] },
      },
    })
    return true
  }
  if (event.interactiveId === 'ffa-no') {
    await waClient.sendText(event.from, 'OK — not approved. You can review it on FieldFlow any time.')
    return true
  }
  const ok = CONFIRM_RE.exec(event.interactiveId || '')
  if (!ok) return false

  const [, kind, stage, id] = ok
  let reply
  try {
    const user = await approverFor(pool, orgId, event.from)
    if (!user) {
      reply = 'This WhatsApp number is not linked to an active FieldFlow user, so it cannot approve. Please approve on FieldFlow.'
    } else {
      const err = await approve(orgId, user, kind, stage, id)
      reply = err ? `Not approved: ${err}` : `✓ Approved. Thank you, ${user.name}.`
    }
  } catch (e) {
    console.error('[wa-approve] failed:', e.message)
    reply = 'Something went wrong — it was not approved. Please approve on FieldFlow.'
  }
  await waClient.sendText(event.from, reply)
  return true
}

async function askLocation(event, kind, { pool, waClient, contact }) {
  await setPending(pool, contact, { kind, at: Date.now() })
  await waClient._post({
    to: event.from,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: `Share your current location to ${ATT[kind].verb}.` },
      action: { name: 'send_location' },
    },
  })
}

async function recordAttendance(event, kind, { orgId, pool, waClient, contact }) {
  await setPending(pool, contact, { done: event.messageId })
  let reply
  try {
    const user = await approverFor(pool, orgId, event.from)
    if (!user) {
      reply = `This WhatsApp number is not linked to an active FieldFlow user, so it cannot ${ATT[kind].verb}. Please use FieldFlow.`
    } else {
      const err = await hrSync(identFor(orgId, user), ATT[kind].action,
        { location: { status: 'ok', lat: event.locationLat, lng: event.locationLng, accuracy: null } })
      reply = err ? `Could not ${ATT[kind].verb}: ${err}` : `✓ ${ATT[kind].done}. Thank you, ${user.name}.`
    }
  } catch (e) {
    console.error('[wa-attendance] failed:', e.message)
    reply = `Something went wrong — you were not ${ATT[kind].done.toLowerCase()}. Please use FieldFlow.`
  }
  await waClient.sendText(event.from, reply)
}

const setPending = (pool, contact, value) => pool.query(
  `UPDATE wa_contacts SET fields = fields || $1::jsonb WHERE id = $2`,
  [JSON.stringify({ ff_attendance: value }), contact.id])

const identFor = (orgId, user) =>
  ({ orgId, uid: user.firebase_uid || `wa_${user.id}`, role: user.role || 'employee', phone: user.phone })

/** One /hr/sync action as `ident`; returns an error message or null. */
async function hrSync(ident, kind, payload) {
  const { default: hrRoutes } = await import('../routes/hr.routes.js')
  const now = new Date().toISOString()
  const { status, data } = await callRoute(hrRoutes, ident, '/hr/sync', {
    sentAt: now, actions: [{ clientId: randomUUID(), kind, createdAt: now, payload }],
  })
  if (status >= 400) return data?.error || `HR service error ${status}`
  const r = data?.results?.[0]
  return r?.ok ? null : (r?.error || 'HR service error')
}

/** The org's active user whose phone matches the sender (last 10 digits). */
async function approverFor(pool, orgId, waId) {
  const digits = String(waId || '').replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return null
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.role, u.firebase_uid, u.phone FROM users u
      WHERE u.org_id = $1 AND right(regexp_replace(u.phone, '\\D', '', 'g'), 10) = $2
        AND COALESCE((to_jsonb(u) ->> 'active')::boolean, true)
        AND COALESCE((to_jsonb(u) ->> 'exit_date')::date > CURRENT_DATE, true)
      ORDER BY u.created_at LIMIT 1`, [orgId, digits])
  return rows[0] || null
}

/** Runs the app's own approve route as `user`; returns an error message or null. */
async function approve(orgId, user, kind, stage, id) {
  const ident = identFor(orgId, user)
  if (kind === 'leave') {
    return hrSync(ident, 'leave_decision', { requestId: id, decision: 'approve', comment: 'Approved on WhatsApp' })
  }
  if (stage !== 'manager' && stage !== 'finance') return 'Unknown approval step.'
  const { default: fmRoutes } = await import('../routes/finance-mgmt.routes.js')
  const { status, data } = await callRoute(fmRoutes, ident,
    `/finance-mgmt/${kind}s/${id}/${stage}-decision`, { decision: 'approve', note: 'Approved on WhatsApp' })
  return status >= 400 ? (data?.error || `Finance service error ${status}`) : null
}

// ponytail: drives the Express router with a minimal req/res instead of an HTTP
// round trip (which would need a Firebase token). Handlers here only use
// status/json/type/send; add methods if a route starts using others.
function callRoute(router, user, path, body) {
  return new Promise((resolve, reject) => {
    let status = 200
    const done = (data) => { res.headersSent = true; resolve({ status, data }) }
    const res = {
      headersSent: false,
      status(c) { status = c; return res },
      type() { return res },
      setHeader() {},
      json: done,
      send(d) { let j; try { j = JSON.parse(d) } catch { j = { error: String(d) } } done(j) },
    }
    const req = {
      method: 'POST', url: path, originalUrl: `/api${path}`, headers: {}, query: {}, body,
      user, correlationId: randomUUID(),
    }
    router(req, res, (err) => err ? reject(err) : resolve({ status: 404, data: { error: 'Not found' } }))
  })
}
