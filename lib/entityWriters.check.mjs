// node lib/entityWriters.check.mjs — profile edit: row → form answers → columns round-trips.
import assert from 'node:assert/strict'
import { entityColumns, profileAnswers } from './entityWriters.js'

const ib = {
  name: 'Sita Devi', contact_no: '9876543210', state: 'Bihar', district: 'Purnia', block: null, panchayat: 'X', village: 'Y',
  gender: 'Female', category: 'OBC', occupation: 'Farmer', current_income_inr: '0', member_of_collective: true,
  production_systems: [{ type: 'Aquaculture', production_quintal: 2.5 }, { type: 'Livestock', livestock_count: 3 }],
  custom_data: { fav_fish: 'rohu' },
}
const a = profileAnswers('individual_beneficiary', ib)
assert.equal(a.member_of_collective, 'yes')
assert.deepEqual(a.production_systems, ['Aquaculture', 'Livestock'])
assert.equal(a.aquaculture_quintal, 2.5)
assert.equal(a.fav_fish, 'rohu')
const cols = entityColumns('individual_beneficiary', a)
assert.equal(cols.member_of_collective, true)
assert.equal(cols.current_income_inr, 0)
assert.deepEqual(cols.production_systems, ib.production_systems)

// Collective type values with spaces map to ODK-safe choice names and back.
const cb = profileAnswers('collective', { collective_name: 'G', collective_type: 'Vendor Collective', lead_person_name: 'L', contact_no: '9876543210' })
assert.equal(cb.collective_type, 'Vendor_Collective')
assert.equal(entityColumns('collective', cb).collective_type, 'Vendor Collective')

// Legacy single production_type prefills production_systems.
assert.deepEqual(profileAnswers('micro_entrepreneur', { production_type: 'Agriculture' }).production_systems, ['Agriculture'])
assert.throws(() => entityColumns('individual_beneficiary', { ...a, contact_no: '123' }), /10-digit/)
console.log('entityWriters checks passed')
