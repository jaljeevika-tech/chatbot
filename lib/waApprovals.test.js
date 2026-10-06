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
