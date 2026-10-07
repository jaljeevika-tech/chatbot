// Run: node lib/odkForm.check.mjs — self-check for the ODK expression engine + form evaluator.
import assert from 'node:assert/strict'
import { checkExpr, evaluateForm } from './odkForm.js'

// Syntax: what parses, what's rejected with a useful message.
for (const ok of ['${a} >= 18', ". >= 0 and . <= 120", "selected(${x}, 'a') or not(${b} = '')", 'if(${a} > 1, 2, 3) * -1',
  "regex(., '^[0-9]{10}$')", 'count(${kids}) div 2', 'today() - ${dob} > 365', "concat(${a}, ' ', ${b})", '.5 + 1', 'true()'])
  assert.equal(checkExpr(ok), null, ok)
assert.match(checkExpr('${a} >'), /end of expression/)
assert.match(checkExpr('foo(1)'), /foo\(\) isn't supported/)
assert.match(checkExpr('age > 1'), /refer to questions as/)
assert.match(checkExpr('/data/age > 1'), /unexpected/)
assert.match(checkExpr('(1 + 2'), /expected "\)"/)

const form = (survey, choices = {}) => ({ settings: { form_title: 't' }, survey, choices })
const ev = (survey, data, choices) => evaluateForm(form(survey, choices), data)

// XPath comparison + skip logic: empty number never satisfies >=, '' vs number.
const s1 = [{ type: 'integer', name: 'age', label: 'Age' }, { type: 'text', name: 'job', label: 'Job', required: true, relevant: '${age} >= 18' }]
assert.deepEqual(ev(s1, {}).errors, {})
assert.equal(ev(s1, { age: '17' }).relevant.job, false)
assert.deepEqual(ev(s1, { age: 20 }).errors, { job: 'Required' })
assert.deepEqual(ev(s1, { age: '17', job: 'x' }).data, { age: 17 }) // non-relevant answer dropped

// Types + constraints + select validation.
const s2 = [
  { type: 'text', name: 'phone', label: 'P', constraint: "regex(., '^[0-9]{10}$')", constraint_message: '10 digits' },
  { type: 'select_multiple', name: 'crops', label: 'C', list: 'crops' },
  { type: 'select_one', name: 'yn', label: 'Y', list: 'yn' },
  { type: 'decimal', name: 'area', label: 'A', constraint: '. > 0' },
  { type: 'date', name: 'dob', label: 'D', constraint: '. < today()' },
  { type: 'geopoint', name: 'gps', label: 'G' },
]
const ch = { crops: [{ name: 'rice', label: 'Rice' }, { name: 'wheat', label: 'Wheat' }], yn: [{ name: 'yes', label: 'Yes' }] }
let r = ev(s2, { phone: '123', crops: ['rice', 'maize'], yn: 'no', area: '0', dob: '2999-01-01', gps: '95 10' }, ch)
assert.deepEqual(r.errors, { phone: '10 digits', crops: 'Pick from the options', yn: 'Pick one of the options', area: 'This answer is not allowed', dob: 'This answer is not allowed', gps: 'Invalid GPS location' })
r = ev(s2, { phone: '9876543210', crops: 'rice wheat', yn: 'yes', area: '1.5', dob: '1990-05-01', gps: '25.6 85.1 0 12' }, ch)
assert.deepEqual(r.errors, {}); assert.deepEqual(r.data.crops, ['rice', 'wheat']); assert.equal(r.data.area, 1.5)

// Repeats: sibling refs inside an instance, sum/count from outside, repeat_count, calculate chain.
const s3 = [
  { type: 'integer', name: 'n', label: 'N' },
  { type: 'begin_repeat', name: 'member', label: 'M', repeat_count: '${n}' },
  { type: 'integer', name: 'm_age', label: 'Age' },
  { type: 'text', name: 'school', label: 'School', required: true, relevant: '${m_age} < 18' },
  { type: 'end_repeat', name: '' },
  { type: 'calculate', name: 'doubled', calculation: '${total} * 2' }, // depends on a later calculate
  { type: 'calculate', name: 'total', calculation: 'sum(${m_age})' },
  { type: 'calculate', name: 'kids', calculation: 'count(${member})' },
]
r = ev(s3, { n: 2, member: [{ m_age: 30 }, { m_age: 10 }] })
assert.deepEqual(r.errors, { 'member[1].school': 'Required' })
assert.equal(r.relevant['member[0].school'], false)
assert.equal(r.data.total, '40'); assert.equal(r.data.doubled, '80'); assert.equal(r.data.kids, '2')
assert.equal(ev(s3, { n: 3, member: [{ m_age: 30 }] }).data.member.length, 3)
assert.equal(r.repeatCounts.member, 2)

// Groups gate their children; archived rows keep data, aren't validated.
const s4 = [
  { type: 'select_one', name: 'has', label: 'H', list: 'yn' },
  { type: 'begin_group', name: 'g', label: 'G', relevant: "${has} = 'yes'" },
  { type: 'text', name: 'inner', label: 'I', required: true },
  { type: 'end_group', name: '' },
  { type: 'text', name: 'old', label: 'Old', required: true, archived: true },
]
assert.deepEqual(ev(s4, { has: 'yes', old: 'kept' }, ch).errors, { inner: 'Required' })
assert.deepEqual(ev(s4, { old: 'kept' }, ch).data, { old: 'kept' })

// Dates are days since epoch in arithmetic.
assert.equal(ev([{ type: 'date', name: 'a', label: 'A' }, { type: 'calculate', name: 'd', calculation: "${a} - date('2026-01-01')" }],
  { a: '2026-01-31' }).data.d, '30')
assert.equal(ev([{ type: 'calculate', name: 'd', calculation: "date('2026-01-01')" }], {}).data.d, '2026-01-01')

console.log('odkForm ok')
