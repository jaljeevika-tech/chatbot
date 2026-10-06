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
// GET    /hr-dashboard                                   built-in HR dashboard (admins + HR users)
// GET    /builtin-dashboards/:key?project=               org's saved layout for a built-in dashboard (null = as shipped)
// GET    /superadmin/org/:id/custom-dashboards/builtin       every built-in dashboard: panels + saved layout
// PUT    /superadmin/org/:id/custom-dashboards/builtin/:key  { widgets } — save the org's layout
// DELETE /superadmin/org/:id/custom-dashboards/builtin/:key  reset to the shipped layout

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
  // HR (services/hr tables). No per-employee group-by: custom dashboards can be visible to all staff.
  hr_attendance:                { label: 'HR attendance', date: 'work_date', project: false, dims: { status: 'Status', source: 'Recorded by', location: 'Location' },
    metrics: {
      days:    ['Attendance days', 'count(*)'],
      present: ['Present days (office + field)', "count(*) FILTER (WHERE status IN ('present', 'on_field'))"],
      half:    ['Half days', "count(*) FILTER (WHERE status = 'half_day')"],
      absent:  ['Absent days', "count(*) FILTER (WHERE status = 'absent')"],
      people:  ['People attending (unique)', "count(DISTINCT user_id) FILTER (WHERE status <> 'absent')"],
      hours:   ['Hours worked', 'COALESCE(round(sum(worked_minutes) / 60.0, 1), 0)'],
      late:    ['Late check-ins', 'count(*) FILTER (WHERE late_minutes > 0)'],
      flagged: ['Flagged, awaiting review', 'count(*) FILTER (WHERE cardinality(flag_reasons) > 0 AND reviewed_at IS NULL)'],
    } },
  hr_leave_requests:            { label: 'HR leave', date: 'start_date', project: false, dims: { leave_type: 'Leave type', status: 'Status', location: 'Location' },
    metrics: {
      requests: ['Leave requests', 'count(*)'],
      approved: ['Approved leave days', "COALESCE(sum(days) FILTER (WHERE status = 'approved'), 0)"],
      pending:  ['Pending leave requests', "count(*) FILTER (WHERE status IN ('pending_manager', 'pending_hr'))"],
      // ponytail: IST "today"; read hr_settings.timezone if an org outside India uses HR.
      today:    ['People on leave today', "count(DISTINCT user_id) FILTER (WHERE status = 'approved' AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date)"],
    } },
}

// Group-bys that aren't plain columns of the table (looked up per row).
const DIM_SQL = {
  location:   `(SELECT l.name FROM hr_employee_profiles p JOIN hr_locations l ON l.id = p.location_id WHERE p.user_id = t.user_id)`,
  leave_type: `(SELECT lt.name FROM hr_leave_types lt WHERE lt.id = t.leave_type_id)`,
  status:     `initcap(replace(t.status, '_', ' '))`,   // on_field → On Field
}

export const CHARTS = ['kpi', 'bar', 'line', 'pie', 'table']

// Built-in dashboards a super admin can rearrange per org (db/migrations/086).
// Each panel is an existing section of that page, wrapped in <Panel id> on the
// frontend — keys must match those ids. [key, label, full width by default]
export const BUILTINS = {
  orgdash: { label: 'Org Dashboard', project: false, panels: [
    ['kpis', 'Headline KPIs', true], ['growth', 'Combined growth — plan vs actual', false], ['health', 'Portfolio health', false],
    ['footprint', 'Footprint', true], ['digital', 'Digital footprint', true], ['impact', 'Impact indicators', true],
    ['funnel', 'System drops — beneficiary → outcome funnel', true], ['barriers', 'Barriers detected', false],
    ['nextsteps', 'Recommended next steps', false], ['projects', 'Per-project comparison', true],
  ] },
  project: { label: 'Project Dashboard', project: true, panels: [
    ['summary', 'Project summary', true], ['focus', 'Focus areas & AI narrative', true], ['kpis', 'Headline KPIs', true],
    ['progress', 'Cumulative progress — plan vs actual', true], ['actionplan', 'Action plan progress', true],
    ['beneficiaries', 'Beneficiaries', true], ['socio', 'Socio-economic impact', true], ['mis', 'MIS activity', true],
    ['indicators', 'Indicator performance', true], ['compliance', 'Compliance & deadlines', true],
  ] },
  impact: { label: 'Impact Dashboard', project: false, panels: [
    ['framework', 'Impact framework matrix', true], ['outcomes', 'Outcome indicators', true], ['toc', 'Theory of change', true],
    ['sdg', 'SDG progress', true], ['logic', 'Logic model', true], ['quality', 'Data quality scorecard', true],
  ] },
  beneficiaries: { label: 'Beneficiary Registration dashboard', project: false, panels: [
    ['coverage', 'Geographic coverage', true], ['totals', 'Registration totals', true], ['individuals', 'Individual beneficiaries', true],
    ['micro', 'Micro-entrepreneurs', false], ['collectives', 'Collectives', false], ['production', 'Beneficiaries by production system', true],
    ['productionByType', 'Production system by beneficiary type', false], ['social', 'Social category', false],
    ['collectiveTypes', 'Collectives by type', false], ['resourceTypes', 'Resources by type', false],
    ['freshwaterType', 'Freshwater · type of resource', false], ['freshwaterAccess', 'Freshwater · resource access', false],
    ['coastalType', 'Coastal · type of resource', false], ['resourceArea', 'Resource area & rafts', false],
    ['utility', 'Resource utility', false], ['byState', 'Registrations by state', true],
    ['byLocation', 'Beneficiaries by location', true], ['resourceMap', 'Resource locations', true],
  ] },
}
/** The shipped layout: every panel, in page order. */
export const defaultBuiltinWidgets = key =>
  BUILTINS[key].panels.map(([panel, title, wide]) => ({ id: `p_${panel}`, chart: 'panel', panel, title, wide }))

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
export function cleanWidget(w, i = 0, builtinKey = null) {
  const at = `Widget ${i + 1}`
  if (!w || typeof w !== 'object') throw new Error(`${at}: invalid`)
  if (w.chart === 'panel') {
    const p = builtinKey && BUILTINS[builtinKey].panels.find(([k]) => k === w.panel)
    if (!p) throw new Error(`${at}: unknown section`)
    return { id: `p_${p[0]}`, chart: 'panel', panel: p[0], title: p[1], wide: !!w.wide }
  }
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
      : `COALESCE(NULLIF(trim((${DIM_SQL[w.groupBy] ?? `t.${w.groupBy}`})::text), ''), 'Not set')`
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
      `SELECT ${COLS} FROM custom_dashboards WHERE org_id = $1 AND builtin_key IS NULL AND (visible_to = 'all' OR $2) ORDER BY sort_order, title`,
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
      `SELECT widgets FROM custom_dashboards WHERE id = $1 AND org_id = $2 AND builtin_key IS NULL AND (visible_to = 'all' OR $3)`,
      [req.params.id, req.user.orgId, isAdmin(req.user.role)]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await runAll(req.user.orgId, rows[0].widgets))
  } catch (e) {
    console.error('[custom-dashboards] data', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Built-in HR dashboard (HR tab → Dashboard) ──────────────────────────────
// Same widgets as a custom dashboard, with dates relative to today.
export function hrDashboardWidgets(today) {
  const month = today.slice(0, 8) + '01'
  const [y, m] = today.split('-').map(Number)
  const leaveYear = `${m >= 4 ? y : y - 1}-04-01`
  const sixMonths = new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 10)
  const w = (id, title, metric, chart, groupBy, from = '', to = '', wide = false) => cleanWidget({ id, title, metric, chart, groupBy, from, to, wide })
  return [
    w('present', 'Present today', 'hr_attendance.present', 'kpi', 'none', today, today),
    w('onleave', 'On leave today', 'hr_leave_requests.today', 'kpi', 'none'),
    w('pending', 'Leave requests pending', 'hr_leave_requests.pending', 'kpi', 'none'),
    w('flagged', 'Attendance flagged for review (this month)', 'hr_attendance.flagged', 'kpi', 'none', month, today),
    w('status', 'Attendance this month by status', 'hr_attendance.days', 'pie', 'status', month, today),
    w('location', 'Present days this month by location', 'hr_attendance.present', 'bar', 'location', month, today),
    w('trend', 'Present days by month', 'hr_attendance.present', 'line', 'month', sixMonths, today, true),
    w('leavetype', 'Approved leave days this leave year by type', 'hr_leave_requests.approved', 'bar', 'leave_type', leaveYear),
    w('hours', 'Hours worked this month by location', 'hr_attendance.hours', 'table', 'location', month, today),
  ]
}

router.get('/hr-dashboard', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Authentication required' })
  try {
    if (!isAdmin(req.user.role)) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM users u JOIN hr_employee_profiles p ON p.user_id = u.id
          WHERE u.org_id = $1 AND u.firebase_uid = $2 AND p.is_hr`, [req.user.orgId, req.user.uid || ''])
      if (!rows.length) return res.status(403).json({ error: 'Only HR and admins can see the HR dashboard.' })
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const widgets = hrDashboardWidgets(today)
    res.json({ widgets, data: await runAll(req.user.orgId, widgets) })
  } catch (e) {
    if (e.code === '42P01') return res.status(503).json({ error: 'HR Management is not set up for this organisation yet.' })
    console.error('[hr-dashboard]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Built-in dashboards: the org's saved layout ─────────────────────────────
// Every built-in dashboard reads behind requireEditor, so other roles (and orgs
// with no saved layout) get { widgets: null } and the page renders as shipped.
const PROJECT_RE = /^[\w.-]{1,100}$/

router.get('/builtin-dashboards/:key', async (req, res) => {
  if (!req.user?.orgId) return res.status(401).json({ error: 'Authentication required' })
  const b = BUILTINS[req.params.key]
  if (!b) return res.status(404).json({ error: 'Not found' })
  if (!['admin', 'superadmin', 'manager'].includes(req.user.role)) return res.json({ widgets: null })
  try {
    const { rows } = await getPool().query(
      `SELECT widgets FROM custom_dashboards WHERE org_id = $1 AND builtin_key = $2`, [req.user.orgId, req.params.key])
    if (!rows[0]) return res.json({ widgets: null })
    const widgets = rows[0].widgets
    // On the Project Dashboard a widget with no project of its own follows the open project.
    const project = b.project && PROJECT_RE.test(String(req.query.project || '')) ? String(req.query.project) : ''
    const catalog = widgets.filter(w => w.chart !== 'panel')
      .map(w => (project && !w.projectKey && CATALOG_BY_KEY.get(w.metric)?.projectScoped ? { ...w, projectKey: project } : w))
    res.json({ widgets, data: await runAll(req.user.orgId, catalog) })
  } catch (e) {
    // Table/column missing (migration 085/086 not run) → behave as "not customised".
    if (e.code === '42P01' || e.code === '42703') return res.json({ widgets: null })
    console.error('[builtin-dashboards]', e)
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
    const { rows } = await getPool().query(`SELECT ${COLS} FROM custom_dashboards WHERE org_id = $1 AND builtin_key IS NULL ORDER BY sort_order, title`, [req.params.id])
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
           WHERE org_id = $1 AND id = $7 AND builtin_key IS NULL RETURNING ${COLS}`, [...args, dashId])
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

router.get(`${SA}/builtin`, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT builtin_key, widgets, updated_at FROM custom_dashboards WHERE org_id = $1 AND builtin_key IS NOT NULL`, [req.params.id])
    const saved = new Map(rows.map(r => [r.builtin_key, r]))
    res.json(Object.entries(BUILTINS).map(([key, b]) => ({
      key, label: b.label, projectScoped: b.project,
      panels: b.panels.map(([k, label, wide]) => ({ key: k, label, wide })),
      defaults: defaultBuiltinWidgets(key),
      widgets: saved.get(key)?.widgets ?? null,
      updated_at: saved.get(key)?.updated_at ?? null,
    })))
  } catch (e) {
    console.error('[builtin-dashboards] sa list', e)
    const notMigrated = e.code === '42P01' || e.code === '42703'
    res.status(notMigrated ? 503 : 500).json({ error: notMigrated ? 'Run migration 086 first' : 'Internal server error' })
  }
})

router.put(`${SA}/builtin/:key`, async (req, res) => {
  const key = req.params.key
  if (!BUILTINS[key]) return res.status(404).json({ error: 'Not found' })
  let widgets
  try {
    const list = req.body?.widgets
    if (!Array.isArray(list) || !list.length || list.length > MAX_WIDGETS + BUILTINS[key].panels.length) throw new Error('Add at least one section or widget')
    widgets = list.map((w, i) => cleanWidget(w, i, key))
    const ids = widgets.map(w => w.id)
    if (new Set(ids).size !== ids.length) throw new Error('Each section can only appear once')
  } catch (e) { return res.status(400).json({ error: e.message }) }
  try {
    const { rows } = await getPool().query(
      `INSERT INTO custom_dashboards (org_id, builtin_key, title, widgets, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, builtin_key) WHERE builtin_key IS NOT NULL
       DO UPDATE SET widgets = EXCLUDED.widgets, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, builtin_key, widgets, updated_at`,
      [req.params.id, key, BUILTINS[key].label, JSON.stringify(widgets), req.user.uid || null])
    res.json(rows[0])
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Organisation not found' })
    console.error('[builtin-dashboards] save', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete(`${SA}/builtin/:key`, async (req, res) => {
  if (!BUILTINS[req.params.key]) return res.status(404).json({ error: 'Not found' })
  try {
    const { rows } = await getPool().query(
      `DELETE FROM custom_dashboards WHERE org_id = $1 AND builtin_key = $2 RETURNING id`, [req.params.id, req.params.key])
    res.json({ ok: true, id: rows[0]?.id ?? null })
  } catch (e) {
    console.error('[builtin-dashboards] reset', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete(`${SA}/:dashId`, async (req, res) => {
  if (!UUID_RE.test(req.params.dashId)) return res.status(404).json({ error: 'Not found' })
  try {
    const { rowCount } = await getPool().query(`DELETE FROM custom_dashboards WHERE org_id = $1 AND id = $2 AND builtin_key IS NULL`, [req.params.id, req.params.dashId])
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true, id: req.params.dashId })
  } catch (e) {
    console.error('[custom-dashboards] delete', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
