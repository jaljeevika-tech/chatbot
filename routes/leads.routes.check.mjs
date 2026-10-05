// Run: node routes/leads.routes.check.mjs — self-check for the public lead form validator.
import assert from 'node:assert/strict'
import { validateLead } from './leads.routes.js'

const ok = { name: ' Asha ', org_name: 'Seva Trust', email: 'Asha@Seva.org', phone: '+91 98765 43210' }
assert.deepEqual(validateLead(ok).lead.email, 'asha@seva.org')
assert.equal(validateLead(ok).lead.name, 'Asha')
assert.ok(validateLead({ ...ok, name: '' }).error)
assert.ok(validateLead({ ...ok, email: 'nope' }).error)
assert.ok(validateLead({ ...ok, phone: 'call me' }).error)
assert.equal(validateLead({ ...ok, message: 'x'.repeat(5000) }).lead.message.length, 2000)
console.log('leads validator ok')
