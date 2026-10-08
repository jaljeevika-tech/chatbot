// node --test services/registration-shared/common.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProductionSystems, districtCode } from './common.js'

test('required (individual beneficiary): empty or all-invalid is an error', () => {
  const err = { error: 'Select at least one Type of Production System' }
  assert.deepEqual(validateProductionSystems(undefined, { required: true }), err)
  assert.deepEqual(validateProductionSystems([], { required: true }), err)
  assert.deepEqual(validateProductionSystems([{ type: 'Mining' }], { required: true }), err)
})

test('optional (micro-entrepreneur, collective): absent or empty is valid, non-list is not', () => {
  assert.deepEqual(validateProductionSystems(undefined, { required: false }), { value: [] })
  assert.deepEqual(validateProductionSystems([], { required: false }), { value: [] })
  assert.deepEqual(validateProductionSystems('Agriculture', { required: false }), { error: 'Type of Production System must be a list' })
})

test('parses, dedupes and drops unknown types', () => {
  const r = validateProductionSystems([
    { type: 'Agriculture', production_quintal: '12.5' },
    { type: 'Agriculture', production_quintal: 99 },
    { type: 'Livestock', livestock_count: '4' },
    { type: 'Mining' },
  ], { required: true })
  assert.deepEqual(r, { value: [{ type: 'Agriculture', production_quintal: 12.5 }, { type: 'Livestock', livestock_count: 4 }] })
  assert.match(validateProductionSystems([{ type: 'Livestock', livestock_count: 1.5 }], { required: false }).error, /whole number/)
})

test('districtCode', () => {
  assert.equal(districtCode('Pashchim Champaran'), 'PAS')
  assert.equal(districtCode(''), 'GEN')
})
