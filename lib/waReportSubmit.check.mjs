// Run: node lib/waReportSubmit.check.mjs — self-check for gathering WhatsApp report media.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectedMedia, MEDIA_MIME, MAX_MEDIA_PER_REPORT } from './waReportSubmit.js'
import { processReply } from './flowEngine.js'
import { parseWebhookEvents } from './whatsapp.js'

// Single-photo answers and multi-file lists are both picked up; text and internal keys aren't.
const got = collectedMedia({
  name: 'Ramesh',
  photo: { media_id: 'a' },
  files: [{ media_id: 'b' }, { media_id: 'c', mime_type: 'video/mp4' }],
  __handoff: { media_id: 'x' },
})
assert.deepEqual(got.map(m => m.media_id), ['a', 'b', 'c'])
assert.equal(collectedMedia({ files: Array.from({ length: 15 }, (_, i) => ({ media_id: String(i) })) }).length, MAX_MEDIA_PER_REPORT)

// Only browser-safe types are kept.
assert.ok(MEDIA_MIME.test('image/jpeg'))
assert.ok(MEDIA_MIME.test('video/mp4'))
assert.ok(MEDIA_MIME.test('application/pdf'))
assert.ok(!MEDIA_MIME.test('image/svg+xml'))
assert.ok(!MEDIA_MIME.test('text/html'))

// Meta events are type 'message' — a photo must still satisfy a "Photo only" step.
const photoNode = { type: 'wait_input', validation: 'image', save_as: 'photo' }
const metaPhoto = { type: 'message', subType: 'image', text: '', media: { id: 'm1', caption: 'well' } }
const out = processReply(photoNode, metaPhoto, {})
assert.equal(out.photo.media_id, 'm1')
assert.equal(out.__validation_error, undefined)

// Multi-file step: DONE moves on only once at least one file arrived.
const mediaNode = { type: 'wait_input', validation: 'media', save_as: 'files' }
assert.ok(processReply(mediaNode, { type: 'message', text: 'done' }, {}).__validation_error)
assert.equal(processReply(mediaNode, { type: 'message', text: 'done' }, { files: [{ media_id: 'b' }] }).__validation_error, undefined)

// WhatsApp Form: a submitted form (nfm_reply) becomes the same string answers the chat produced.
const [formEvent] = parseWebhookEvents({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '1' },
  messages: [{ from: '919', id: 'w1', timestamp: '1', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent',
    response_json: JSON.stringify({ flow_token: 'fieldflow:f1', project: 'Jal Samradhi', state: 'Bihar', beneficiaries: 25, description: 'Training', bad: { x: 1 }, 'bad key': 'x' }),
  } } }],
} }] }] })
const formNode = { type: 'send_form' }
const answers = processReply(formNode, formEvent, {})
assert.deepEqual(
  { project: answers.project, state: answers.state, beneficiaries: answers.beneficiaries, description: answers.description },
  { project: 'Jal Samradhi', state: 'Bihar', beneficiaries: '25', description: 'Training' },
)
assert.equal(answers.flow_token, undefined)
assert.equal(answers.bad, undefined)
assert.equal(answers['bad key'], undefined)
assert.ok(processReply(formNode, { type: 'message', text: 'hi' }, {}).__validation_error) // typing instead of the form

// The WhatsApp form must send exactly the answers the save step reads, all required,
// with the same choice lists as the Glific reporting flow, saved as the option text.
const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const form = readJson('../docs/whatsapp-flows/field-report.flow.json')
const kids = form.screens[0].layout.children
const footer = kids.find(c => c.type === 'Footer')
// state, name and phone come from the worker's registration, not the form.
const FORM_FIELDS = ['project', 'location', 'beneficiaries', 'area_of_intervention', 'description']
assert.deepEqual(Object.keys(footer['on-click-action'].payload).sort(), [...FORM_FIELDS].sort())
for (const c of kids.filter(c => c.name)) assert.equal(c.required, true, `${c.name} must be required`)
const glific = readJson('../glific/fieldflow-report-flow.json')
const glificLists = Object.fromEntries((glific.flows || [glific]).flatMap(f => f.nodes).flatMap(n => n.actions)
  .filter(a => a.list_items).map(a => [a.name, a.list_items.map(i => i.title)]))
for (const [field, list] of [['project', 'project'], ['area_of_intervention', 'area']]) {
  const opts = kids.find(c => c.name === field)['data-source']
  assert.deepEqual(opts.map(o => o.title), glificLists[list], `${field} options must match the Glific flow`)
  for (const o of opts) assert.equal(o.id, o.title)
}

console.log('waReportSubmit.check: ok')
