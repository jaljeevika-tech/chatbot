// services/dashboard/src/custom.js — super-admin-built dashboards (custom_dashboards, migration 085).
//
// A widget picks a metric from the fixed CATALOG below, a group-by and a chart type.
// SQL is assembled only from these whitelisted identifiers; user values (org, project,
// dates) are always bind parameters. No free-form SQL, so tenants stay isolated.
// Encrypted PII columns (contact_no, incomes, panchayat — lib/piiCrypto.js) are never offered.
//
// GET    /custom-dashboards                              dashboards visible to the caller
// GET    /custom-dashboards/:id/data                     every widget's rows
// GET    /superadmin/org/:id/custom-dashboards/catalog   metrics + group-bys for the builder
// GET    /superadmin/org/:id/custom-dashboards           all of that org's dashboards
// POST   /superadmin/org/:id/custom-dashboards           { title, visible_to, sort_order, widgets }
// PUT    /superadmin/org/:id/custom-dashboards/:dashId   same body
// DELETE /superadmin/org/:id/custom-dashboards/:dashId
// POST   /superadmin/org/:id/custom-dashboards/preview   { widget } → rows (builder live preview)

import { Router } from 'express'
import { getPool } from './pool.js'

const BT = { beneficiary_type: 'Beneficiary type' }
const LOC = { state: 'State', district: 'District', block: 'Block' }

// table → date column (null = undated), project-scoped?, group-by columns, metrics (key → [label, SQL aggregate])
const SOURCES = {
  trainings:                    { label: 'Training', date: 'training_date', project: true, dims: { ...BT, training_topic: 'Topic', place: 'Place' },
    metrics: { records: ['Training records', 'count(*)'], people: ['People trained (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  input_distributions:          { label: 'Input distribution', date: 'distribution_date', project: true, dims: { ...BT, input_distributed: 'Input' },
    metrics: { records: ['Inputs distributed (records)', 'count(*)'], people: ['People reached (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  scheme_access:                { label: 'Scheme access', date: 'access_date', project: true, dims: { ...BT, scheme_name: 'Scheme' },
    metrics: { records: ['Scheme linkages', 'count(*)'], people: ['People linked (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  credit_grant_access:          { label: 'Credit / grant access', date: 'access_date', project: true, dims: { ...BT, credit_grant_source: 'Source', credit_grant_type: 'Type' },
    metrics: { records: ['Credit / grant records', 'count(*)'], amount: ['Amount mobilised (₹)', 'COALESCE(sum(amount), 0)'], people: ['People reached (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  business_development_support: { label: 'Business development support', date: 'support_date', project: true, dims: { ...BT, support_provided: 'Support' },
    metrics: { records: ['Support records', 'count(*)'], people: ['People supported (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  compliance_support:           { label: 'Compliance support', date: 'support_date', project: true, dims: { ...BT, compliance_support_provided: 'Support' },
    metrics: { records: ['Support records', 'count(*)'], people: ['People supported (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  exposure_visits:              { label: 'Exposure visits', date: 'visit_date', project: true, dims: { ...BT, purpose: 'Purpose' },
    metrics: { records: ['Visit records', 'count(*)'], people: ['People on visits (unique)', 'count(DISTINCT beneficiary_uid)'] } },
  campaign:                     { label: 'Campaigns', date: 'campaign_date', project: true, dims: { campaign_name: 'Campaign', place: 'Place' },
    metrics: { records: ['Campaigns held', 'count(*)'], attendees: ['Attendees', 'COALESCE(sum(total_attendees), 0)'], female: ['Female attendees', 'COALESCE(sum(female_count), 0)'] } },
  community_meeting:            { label: 'Community meetings', date: 'meeting_date', project: true, dims: { purpose: 'Purpose', place: 'Place' },
    metrics: { records: ['Meetings held', 'count(*)'], attendees: ['Attendees', 'COALESCE(sum(total_attendees), 0)'], female: ['Female attendees', 'COALESCE(sum(female_count), 0)'] } },
  income:                       { label: 'Income', date: null, project: true, dims: { ...BT, financial_year: 'Financial year', income_source: 'Income source' },
    metrics: { realised: ['Income realised (₹)', 'COALESCE(sum(income_realised), 0)'], people: ['People with income records', 'count(DISTINCT beneficiary_uid)'] } },
  budget_utilisation_reports:   { label: 'Financial tracker', date: 'period_month', project: true, dims: { section: 'Section', budget_head: 'Budget head' },
    metrics: { spent: ['Expenses (₹)', 'COALESCE(sum(expenses), 0)'] } },
  individual_beneficiaries:     { label: 'Individual beneficiaries', date: 'created_at', project: false, dims: { ...LOC, gender: 'Gender', production_type: 'Production type' },
    metrics: { count: ['Registered individuals', 'count(*)'], female: ['Registered women', "count(*) FILTER (WHERE gender = 'Female')"], production: ['Production (tonnes)', 'COALESCE(sum(current_production_ton), 0)'] } },
  micro_entrepreneurs:          { label: 'Micro-entrepreneurs', date: 'created_at', project: false, dims: { ...LOC, gender: 'Gender', business_activity: 'Business activity' },
    metrics: { count: ['Registered micro-entrepreneurs', 'count(*)'], employees: ['Employees', 'COALESCE(sum(current_employee_count), 0)'] } },
  collectives:                  { label: 'Collectives', date: 'created_at', project: false, dims: { ...LOC, collective_type: 'Collective type', focus_area: 'Focus area' },
    metrics: { count: ['Registered collectives', 'count(*)'], members: ['Members', 'COALESCE(sum(COALESCE(male_count, 0) + COALESCE(female_count, 0)), 0)'] } },
}

export const CHARTS = ['kpi', 'bar', 'line', 'pie', 'table']

// Flat, client-safe view: [{ key: 'trainings.people', label, source, groupBys: [{ key, label }] }]
export const CATALOG = Object.entries(SOURCES).flatMap(([table, s]) => {
  const groupBys = [
    ...(s.date ? [{ key: 'month', label: 'Month' }] : []),
    ...(s.project ? [{ key: 'project', label: 'Project' }] : []),
    ...Object.entries(s.dims).map(([key, label]) => ({ key, label })),
  ]
  return Object.entries(s.metrics).map(([m, [label]]) => ({
    key: `${table}.${m}`, label, source: s.label, dated: !!s.date, projectScoped: s.project, groupBys,
  }))
})
const CATALOG_BY_KEY = new Map(CATALOG.map(c => [c.key, c]))

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-fA-F-]{36}$/
const MAX_WIDGETS = 24
const MAX_ROWS = 50 // ponytail: fixed top-50 per widget; add paging if a table widget ever needs more

/** Validate one widget from the builder; returns a clean copy or throws a message. */
export function cleanWidget(w, i = 0) {
  const at = `Widget ${i + 1}`
  if (!w || typeof w !== 'object') throw new Error(`${at}: invalid`)
  const meta = CATALOG_BY_KEY.get(w.metric)
  if (!meta) throw new Error(`${at}: unknown metric`)
  if (!CHARTS.includes(w.chart)) throw new Error(`${at}: unknown chart type`)
  const groupBy = w.chart === 'kpi' ? 'none' : String(w.groupBy || '')
  if (groupBy !== 'none' && !meta.groupBys.some(g => g.key === groupBy)) throw new Error(`${at}: "${groupBy}" can't group ${meta.label}`)
  for (const k of ['from', 'to']) if (w[k] && !DATE_RE.test(w[k])) throw new Error(`${at}: ${k} must be YYYY-MM-DD`)
  return {
    id: String(w.id || `w${i}`).slice(0, 40),
    title: String(w.title || meta.label).trim().slice(0, 80),
    metric: w.metric, chart: w.chart, groupBy,
    projectKey: meta.projectScoped && w.projectKey ? String(w.projectKey).slice(0, 100) : '',
    from: meta.dated && w.from ? w.from : '',
    to:   meta.dated && w.to   ? w.to   : '',
    wide: !!w.wide,
  }
}

function cleanDashboard(body) {
  const title = String(body?.title || '').trim().slice(0, 120)
  if (!title) throw new Error('Title is required')
  const visible_to = body?.visible_to === 'admin' ? 'admin' : 'all'
  if (!Array.isArray(body?.widgets) || body.widgets.length > MAX_WIDGETS) throw new Error(`Widgets must be a list of at most ${MAX_WIDGETS}`)
  return { title, visible_to, sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0, widgets: body.widgets.map(cleanWidget) }
}

/** Build the SQL for a cleaned widget. Exported for the self-check. */
export function widgetSql(w, orgId) {
  const [table, m] = w.metric.split('.')
  const s = SOURCES[table]
  const params = [orgId]
  const where = ['t.org_id = $1']
  if (w.projectKey) { params.push(w.projectKey); where.push(`t.project_key = $${params.length}`) }
  if (w.from) { params.push(w.from); where.push(`t.${s.date} >= $${params.length}`) }
  if (w.to)   { params.push(w.to);   where.push(`t.${s.date} <= $${params.length}`) }
  const agg = s.metrics[m][1]
  if (w.groupBy === 'none') {
    return { text: `SELECT ${agg}::float8 AS value FROM ${table} t WHERE ${where.join(' AND ')}`, params }
  }
  const label = w.groupBy === 'month'
    ? `to_char(date_trunc('month', t.${s.date}), 'YYYY-MM')`
    : w.groupBy === 'project'
      ? `COALESCE((SELECT a.name FROM action_plans a WHERE a.org_id = t.org_id AND a.project_key = t.project_key LIMIT 1), t.project_key)`
      : `COALESCE(NULLIF(trim(t.${w.groupBy}::text), ''), 'Not set')`
  if (w.groupBy === 'month') where.push(`t.${s.date} IS NOT NULL`)
  return {
    text: `SELECT ${label} AS label, ${agg}::float8 AS value FROM ${table} t WHERE ${where.join(' AND ')}
           GROUP BY 1 ORDER BY ${w.groupBy === 'month' ? '1' : '2 DESC'} LIMIT ${MAX_ROWS}`,
    params,
  }
}

async function runWidget(orgId, w) {
  try {
    const { text, params } = widgetSql(w, orgId)
    const { rows } = await getPool().query(text, params)
    return w.groupBy === 'none' ? { value: Number(rows[0]?.value) || 0 } : { rows: rows.map(r => ({ label: String(r.label), value: Number(r.value) || 0 })) }
  } catch (e) {
    console.error('[custom-dashboards] widget failed:', w.metric, e.message)
    return { error: 'Could not load this widget' }
  }
}

async function runAll(orgId, widgets) {
  const out = {}
  await Promise.all(widgets.map(async w => { out[w.id] = await runWidget(orgId, w) }))
  return out
}

const isAdmin = role => role === 'admin' || role === 'superadmin'
const COLS = 'id, title, visible_to, sort_order, widgets, updated_at'

const router = Router()

router.get('/custom-dashboards', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Authentication required' })
  try {
    const { rows } = await getPool().query(
      `SELECT ${COLS} FROM custom_dashboards WHERE org_id = $1 AND (visible_to = 'all' OR $2) ORDER BY sort_order, title`,
      [req.user.orgId, isAdmin(req.user.role)]
    )
    res.json(rows)
  } catch (e) {
    // Before migration 085 runs the table doesn't exist — show "no dashboards", not an error.
    if (e.code === '42P01') return res.json([])
    console.error('[custom-dashboards] list', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/custom-dashboards/:id/data', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Authentication required' })
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' })
  try {
    const { rows } = await getPool().query(
      `SELECT widgets FROM custom_dashboards WHERE id = $1 AND org_id = $2 AND (visible_to = 'all' OR $3)`,
      [req.params.id, req.user.orgId, isAdmin(req.user.role)]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await runAll(req.user.orgId, rows[0].widgets))
  } catch (e) {
    console.error('[custom-dashboards] data', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Super admin builder ─────────────────────────────────────────────────────
// The monolith's /superadmin guard already ran; checked again because the
// Cloud Run service only trusts the forwarded role.
const SA = '/superadmin/org/:id/custom-dashboards'
router.use(SA, (req, res, next) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' })
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid organisation id' })
  next()
})

router.get(`${SA}/catalog`, (_req, res) => res.json({ metrics: CATALOG, charts: CHARTS }))

router.get(SA, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT ${COLS} FROM custom_dashboards WHERE org_id = $1 ORDER BY sort_order, title`, [req.params.id])
    res.json(rows)
  } catch (e) {
    console.error('[custom-dashboards] sa list', e)
    res.status(e.code === '42P01' ? 503 : 500).json({ error: e.code === '42P01' ? 'Run migration 085 first' : 'Internal server error' })
  }
})

router.post(`${SA}/preview`, async (req, res) => {
  let w
  try { w = cleanWidget(req.body?.widget) } catch (e) { return res.status(400).json({ error: e.message }) }
  res.json(await runWidget(req.params.id, w))
})

async function save(req, res) {
  let d
  try { d = cleanDashboard(req.body) } catch (e) { return res.status(400).json({ error: e.message }) }
  const dashId = req.params.dashId
  if (dashId && !UUID_RE.test(dashId)) return res.status(404).json({ error: 'Not found' })
  try {
    const args = [req.params.id, d.title, d.visible_to, d.sort_order, JSON.stringify(d.widgets), req.user.uid || null]
    const { rows } = dashId
      ? await getPool().query(
          `UPDATE custom_dashboards SET title = $2, visible_to = $3, sort_order = $4, widgets = $5, updated_by = $6, updated_at = now()
           WHERE org_id = $1 AND id = $7 RETURNING ${COLS}`, [...args, dashId])
      : await getPool().query(
          `INSERT INTO custom_dashboards (org_id, title, visible_to, sort_order, widgets, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`, args)
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.status(dashId ? 200 : 201).json(rows[0])
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Organisation not found' })
    console.error('[custom-dashboards] save', e)
    res.status(500).json({ error: 'Internal server error' })
  }
}
router.post(SA, save)
router.put(`${SA}/:dashId`, save)

router.delete(`${SA}/:dashId`, async (req, res) => {
  if (!UUID_RE.test(req.params.dashId)) return res.status(404).json({ error: 'Not found' })
  try {
    const { rowCount } = await getPool().query(`DELETE FROM custom_dashboards WHERE org_id = $1 AND id = $2`, [req.params.id, req.params.dashId])
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true, id: req.params.dashId })
  } catch (e) {
    console.error('[custom-dashboards] delete', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
