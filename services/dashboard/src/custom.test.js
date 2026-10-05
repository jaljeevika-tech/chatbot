// node --test — widget validation + SQL whitelisting for custom dashboards.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanWidget, widgetSql, CATALOG } from './custom.js'

test('rejects anything outside the catalog', () => {
  assert.throws(() => cleanWidget({ metric: 'users.count', chart: 'bar' }), /unknown metric/)
  assert.throws(() => cleanWidget({ metric: 'trainings.people', chart: 'radar' }), /chart/)
  assert.throws(() => cleanWidget({ metric: 'trainings.people', chart: 'bar', groupBy: 'contact_no' }), /can't group/)
  assert.throws(() => cleanWidget({ metric: 'trainings.people', chart: 'bar', groupBy: 'month', from: "1'; DROP" }), /YYYY-MM-DD/)
  // undated / org-wide sources silently drop filters they can't apply
  const w = cleanWidget({ metric: 'individual_beneficiaries.count', chart: 'kpi', projectKey: 'kosi', groupBy: 'district' })
  assert.equal(w.projectKey, ''); assert.equal(w.groupBy, 'none')
})

test('user values are bind params, never SQL text', () => {
  const w = cleanWidget({ metric: 'trainings.people', chart: 'bar', groupBy: 'month', projectKey: "x' OR 1=1", from: '2026-04-01', to: '2027-03-31' })
  const { text, params } = widgetSql(w, 'org-1')
  assert.deepEqual(params, ['org-1', "x' OR 1=1", '2026-04-01', '2027-03-31'])
  assert.ok(!text.includes('OR 1=1'))
  assert.match(text, /t\.project_key = \$2 AND t\.training_date >= \$3 AND t\.training_date <= \$4/)
})

test('every catalog metric builds for every group-by', () => {
  for (const m of CATALOG) for (const g of [{ key: 'none' }, ...m.groupBys]) {
    const w = cleanWidget({ metric: m.key, chart: g.key === 'none' ? 'kpi' : 'bar', groupBy: g.key })
    assert.match(widgetSql(w, 'o').text, /^SELECT /)
  }
})
