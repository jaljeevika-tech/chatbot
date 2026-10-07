// node --test — WhatsApp Approve button: tap → confirm prompt, redeliveries ignored.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleApprovalReply } from './waApprovals.js'

const id = '11111111-2222-3333-4444-555555555555'
const setup = () => {
  const sent = []
  return { sent, opts: { orgId: 'o', pool: null, waClient: { _post: async p => sent.push(p), sendText: async (to, t) => sent.push({ to, t }) } } }
}

test('ordinary messages fall through to flows', async () => {
  const { opts } = setup()
  assert.equal(await handleApprovalReply({ from: '919876543210', text: 'hi' }, opts), false)
})

test('Approve tap asks to confirm, quoting the original message', async () => {
  const { sent, opts } = setup()
  assert.equal(await handleApprovalReply({ from: '919876543210', buttonPayload: `ffa:advance:manager:${id}`, raw: { context: { id: 'wamid.X' } } }, opts), true)
  assert.equal(sent[0].context.message_id, 'wamid.X')
  assert.equal(sent[0].interactive.action.buttons[0].reply.id, `ffa-ok:advance:manager:${id}`)
})

test('a redelivered tap is swallowed without replying', async () => {
  const { sent, opts } = setup()
  assert.equal(await handleApprovalReply({ from: '9', interactiveId: `ffa-ok:leave:-:${id}` }, { ...opts, duplicate: true }), true)
  assert.equal(sent.length, 0)
})

const uid = '99999999-2222-3333-4444-555555555555'
const attSetup = (fields = {}) => {
  const sent = [], writes = []
  const pool = { query: async (sql, params) => {
    if (/UPDATE wa_contacts/.test(sql)) { writes.push(JSON.parse(params[0])); return { rows: [] } }
    return { rows: [] }   // users lookup → no linked user
  } }
  const waClient = { _post: async p => sent.push(p), sendText: async (to, t) => sent.push({ to, t }) }
  return { sent, writes, opts: { orgId: 'o', pool, waClient, contact: { id: 'c1', fields } } }
}

test('Check in tap asks for a location and remembers the intent', async () => {
  const { sent, writes, opts } = attSetup()
  assert.equal(await handleApprovalReply({ from: '919876543210', buttonPayload: `ffa:checkin:-:${uid}` }, opts), true)
  assert.equal(sent[0].interactive.type, 'location_request_message')
  assert.equal(writes[0].ff_attendance.kind, 'checkin')
})

test('a location within 15 minutes of the tap is used; the reply says why it failed', async () => {
  const { sent, writes, opts } = attSetup({ ff_attendance: { kind: 'checkout', at: Date.now() } })
  const ev = { from: '919876543210', messageType: 'location', messageId: 'm1', locationLat: 25.6, locationLng: 85.1 }
  assert.equal(await handleApprovalReply(ev, opts), true)
  assert.deepEqual(writes[0].ff_attendance, { done: 'm1' })
  assert.match(sent[0].t, /not linked to an active FieldFlow user/)
})

test('a location with no recent tap goes to the normal flows', async () => {
  const { opts } = attSetup({ ff_attendance: { kind: 'checkin', at: Date.now() - 16 * 60_000 } })
  assert.equal(await handleApprovalReply({ from: '9', messageType: 'location', messageId: 'm2' }, opts), false)
})

test('a redelivered location that was already used is swallowed', async () => {
  const { sent, opts } = attSetup({ ff_attendance: { done: 'm3' } })
  assert.equal(await handleApprovalReply({ from: '9', messageType: 'location', messageId: 'm3' }, opts), true)
  assert.equal(sent.length, 0)
})
