// Run: node lib/subscriptionGuard.check.mjs — self-check for per-app plan gating.
import assert from 'node:assert/strict'
import { appForPath, planAllowsPath, computeAccess } from './subscriptionGuard.js'

// Paths map to apps; core and field-capture paths stay unmapped.
assert.equal(appForPath('/forms'), 'forms')
assert.equal(appForPath('/forms/abc/submissions'), 'forms')
assert.equal(appForPath('/performance/reviews'), 'hr')
assert.equal(appForPath('/wa/flows/generate'), 'engage')
assert.equal(appForPath('/wa/reports/submit'), null)   // field capture, every plan
assert.equal(appForPath('/wa/webhook'), null)
assert.equal(appForPath('/formsx'), null)              // prefix must end at a segment
assert.equal(appForPath('/compliance-support'), null)  // MIS activity, not Compliance
assert.equal(appForPath('/projects/x/beneficiaries'), null)

// null / missing apps = everything (no behaviour change for existing plans).
assert.ok(planAllowsPath(null, '/forms'))
assert.ok(planAllowsPath({ apps: null }, '/hr/attendance'))
assert.ok(planAllowsPath({}, '/finance-mgmt/advances'))

// A plan that lists its apps blocks the rest but never core paths.
const hrOnly = { apps: ['hr'] }
assert.ok(planAllowsPath(hrOnly, '/hr/leave'))
assert.ok(!planAllowsPath(hrOnly, '/forms'))
assert.ok(!planAllowsPath(hrOnly, '/compliance-items'))
assert.ok(planAllowsPath(hrOnly, '/org/metadata'))
assert.ok(!planAllowsPath({ apps: [] }, '/hr/leave'))

// computeAccess carries apps through; a missing column (undefined) becomes null.
assert.deepEqual(computeAccess({ plan_id: 'p', apps: ['hr'] }).plan.apps, ['hr'])
assert.equal(computeAccess({ plan_id: 'p' }).plan.apps, null)

console.log('subscriptionGuard.check: ok')
