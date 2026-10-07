// Run: node lib/forms.check.mjs — self-check for the form builder schema validator.
import assert from 'node:assert/strict'
import { ENTITY_FORMS, defaultSchema, normalizeSchema, validateSchema } from './forms.js'

// Every built-in default is publishable as-is.
for (const key of Object.keys(ENTITY_FORMS)) {
  const s = normalizeSchema(defaultSchema(key), key)
  assert.deepEqual(validateSchema(s, key), [], key)
}

const base = () => normalizeSchema(defaultSchema('user'), 'user')
const errs = (s, prev) => validateSchema(s, 'user', prev).join('\n')

// Client can't forge a column mapping onto a custom field.
const forged = normalizeSchema({ ...base(), survey: [...base().survey, { type: 'text', name: 'x', label: 'X', system: true, column: 'role' }] }, 'user')
assert.equal(forged.survey.at(-1).column, undefined)

// System field rules.
let s = base(); s.survey = s.survey.filter(r => r.name !== 'phone')
assert.match(errs(s), /"phone" is missing/)
s = base(); s.survey.find(r => r.name === 'role').type = 'text'
assert.match(errs(s), /must stay type select_one/)
s = base(); s.survey.find(r => r.name === 'name').required = false
assert.match(errs(s), /must stay required/)
s = base(); s.choices.user_role.push({ name: 'owner', label: 'Owner' })
assert.match(errs(s), /aren't accepted by the database/)

// Structure, names, refs, choices.
s = base(); s.survey.push({ type: 'begin_repeat', name: 'kids', label: 'Kids' }, { type: 'text', name: 'kid', label: 'Kid' })
assert.match(errs(s), /never closed/)
s.survey.push({ type: 'end_group', name: '' })
assert.match(errs(s), /no matching begin/)
s = base(); s.survey.push({ type: 'text', name: 'name', label: 'Dup' }, { type: 'text', name: '9bad', label: 'B' })
assert.match(errs(s), /used twice/); assert.match(errs(s), /must start with a letter/)
s = base(); s.survey.push({ type: 'integer', name: 'age', label: 'Age', relevant: '${nope} > 1' })
assert.match(errs(s), /unknown question \$\{nope\}/)
s = base(); s.survey.push({ type: 'select_one', name: 'fav', label: 'Fav', list: 'colours' }); s.choices.colours = [{ name: 'dark red', label: 'Dark red' }]
assert.match(errs(s), /no spaces/)
s = base(); s.survey.push({ type: 'calculate', name: 'c', label: '' })
assert.match(errs(s), /calculation is required/)

// A valid custom block: group + repeat + calculate + skip logic.
s = base(); s.survey.push(
  { type: 'begin_group', name: 'hh', label: 'Household' },
  { type: 'integer', name: 'members', label: 'Members', constraint: '. > 0' },
  { type: 'begin_repeat', name: 'member', label: 'Member', repeat_count: '${members}' },
  { type: 'text', name: 'm_name', label: 'Name' },
  { type: 'end_repeat', name: '' },
  { type: 'calculate', name: 'double', calculation: '${members} * 2' },
  { type: 'end_group', name: '' },
)
assert.deepEqual(validateSchema(normalizeSchema(s, 'user'), 'user'), [])

// Soft versioning: published fields can be archived, not deleted or retyped.
const prev = normalizeSchema(s, 'user')
const next = structuredClone(prev); next.survey = next.survey.filter(r => r.name !== 'm_name')
assert.match(errs(next, prev), /archive it instead/)
const retyped = structuredClone(prev); retyped.survey.find(r => r.name === 'members').type = 'decimal'
assert.match(errs(retyped, prev), /changing its type/)
const archived = structuredClone(prev); archived.survey.find(r => r.name === 'm_name').archived = true
assert.deepEqual(validateSchema(archived, 'user', prev), [])

// Expression syntax is checked with the same engine the web form runs.
s = base(); s.survey.push({ type: 'integer', name: 'age', label: 'Age', relevant: 'age > 1' })
assert.match(errs(s), /relevant has an error/)

console.log('forms validator ok')
