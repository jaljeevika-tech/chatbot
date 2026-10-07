// lib/forms.js — form builder schema: built-in (system) fields per entity form,
// normalisation of client-sent schemas, and validation for save/publish.
//
// A schema is XLSForm-shaped JSON so it maps 1:1 to XForm XML for ODK Collect:
//   { settings: { form_title }, survey: [row...], choices: { list_name: [{ name, label }] } }
// Rows are flat; groups/repeats are begin_*/end_* rows, exactly like XLSForm.
// Expressions (relevant/constraint/calculation/repeat_count/default) are ODK
// XPath and reference other questions as ${name}.
//
// System fields are the columns the rest of FieldFlow reads (dashboards, MIS,
// AI prompts). They can be relabelled, reordered, given hints/conditions and
// (if optional) hidden by skip logic — never deleted, renamed or retyped.
// Their column mapping is ALWAYS taken from SYSTEM_FIELDS below, never from
// the client, so a crafted schema can't point a custom field at a real column.

import { checkExpr } from './odkForm.js'

export const QUESTION_TYPES = [
  'text', 'integer', 'decimal', 'date', 'time', 'datetime',
  'select_one', 'select_multiple', 'geopoint', 'image', 'audio', 'barcode',
  'note', 'calculate',
]
export const STRUCTURE_TYPES = ['begin_group', 'end_group', 'begin_repeat', 'end_repeat']
const ALL_TYPES = new Set([...QUESTION_TYPES, ...STRUCTURE_TYPES])
const SELECT_TYPES = new Set(['select_one', 'select_multiple'])
const NAMELESS = new Set(['end_group', 'end_repeat'])

const NAME_RE   = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/  // XML element name subset
const CHOICE_RE = /^[A-Za-z0-9_.-]{1,64}$/         // no spaces: select_multiple answers are space-separated
const REF_RE    = /\$\{([^}]*)\}/g
const EXPR_KEYS = ['relevant', 'constraint', 'calculation', 'repeat_count', 'default']
const TEXT_KEYS = ['label', 'hint', 'constraint_message', 'appearance', ...EXPR_KEYS]
const MAX_ROWS = 1000, MAX_TEXT = 2000, MAX_CHOICES = 500

export const ENTITY_FORMS = {
  individual_beneficiary: 'Individual Beneficiary',
  micro_entrepreneur:     'Micro-Entrepreneur',
  collective:             'Collective',
  beneficiary:            'Project Beneficiary (legacy)',
  resource:               'Resource',
  user:                   'User',
  project:                'Project',
}

const GENDER   = ['Male', 'Female', 'Other']
const CATEGORY = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']
const PRODUCTION = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']

// The LGD location cascade (state → village) is rendered from the lgd_* tables;
// appearance tells the web renderer / XForm builder which level each one is.
const lgd = (required) => ['state', 'district', 'block', 'panchayat', 'village'].map(level =>
  ({ type: 'text', name: level, label: level[0].toUpperCase() + level.slice(1), required: required && level !== 'panchayat' && level !== 'village', appearance: `lgd-${level}` }))

// production_systems JSONB = [{ type, production_quintal } | { type: 'Livestock', livestock_count }]
const production = (required) => [
  { type: 'select_multiple', name: 'production_systems', label: 'Type of Production System', list: 'production_system', required, column: 'production_systems' },
  ...['Aquaculture', 'Agriculture', 'Horticulture'].map(t => ({
    type: 'decimal', name: `${t.toLowerCase()}_quintal`, label: `${t} production (Quintal)`,
    relevant: `selected(\${production_systems}, '${t}')`, constraint: '. >= 0', column: 'production_systems',
  })),
  { type: 'integer', name: 'livestock_count', label: 'Number of Livestock', relevant: `selected(\${production_systems}, 'Livestock')`, constraint: '. >= 0', column: 'production_systems' },
]

const sys = (rows) => rows.map(r => ({ column: r.name, ...r, system: true }))

export const SYSTEM_FIELDS = {
  individual_beneficiary: sys([
    { type: 'text', name: 'name', label: 'Name', required: true },
    { type: 'text', name: 'contact_no', label: 'Contact No.', appearance: 'numbers', constraint: "regex(., '^[0-9]{10}$')", constraint_message: 'Enter a 10-digit number' },
    ...lgd(true),
    { type: 'select_one', name: 'gender', label: 'Gender', list: 'gender', required: true },
    { type: 'select_one', name: 'category', label: 'Category', list: 'category' },
    { type: 'text', name: 'occupation', label: 'Occupation' },
    { type: 'decimal', name: 'current_income_inr', label: 'Current Income (INR)', constraint: '. >= 0' },
    ...production(true),
    { type: 'select_one', name: 'member_of_collective', label: 'Member of a collective?', list: 'yes_no' },
  ]),
  micro_entrepreneur: sys([
    { type: 'text', name: 'name', label: 'Name', required: true },
    { type: 'text', name: 'contact_no', label: 'Contact No.', appearance: 'numbers', constraint: "regex(., '^[0-9]{10}$')", constraint_message: 'Enter a 10-digit number' },
    ...lgd(true),
    { type: 'select_one', name: 'gender', label: 'Gender', list: 'gender', required: true },
    { type: 'select_one', name: 'category', label: 'Category', list: 'category' },
    { type: 'text', name: 'enterprise_name', label: 'Enterprise Name' },
    { type: 'text', name: 'business_activity', label: 'Business Activity' },
    { type: 'decimal', name: 'current_revenue_inr', label: 'Current Revenue (INR)', constraint: '. >= 0' },
    { type: 'integer', name: 'current_employee_count', label: 'Current Employee Count', constraint: '. >= 0' },
    ...production(false),
  ]),
  collective: sys([
    { type: 'text', name: 'collective_name', label: 'Collective Name', required: true },
    { type: 'select_one', name: 'collective_type', label: 'Collective Type', list: 'collective_type', required: true },
    { type: 'text', name: 'lead_person_name', label: 'Lead Person Name' },
    { type: 'text', name: 'contact_no', label: 'Contact No.', appearance: 'numbers', constraint: "regex(., '^[0-9]{10}$')", constraint_message: 'Enter a 10-digit number' },
    ...lgd(true),
    { type: 'integer', name: 'male_count', label: 'Male Members', constraint: '. >= 0' },
    { type: 'integer', name: 'female_count', label: 'Female Members', constraint: '. >= 0' },
    { type: 'text', name: 'focus_area', label: 'Focus Area' },
    { type: 'decimal', name: 'current_revenue_inr', label: 'Current Revenue (INR)', constraint: '. >= 0' },
    ...production(false),
    { type: 'decimal', name: 'per_capita_income_inr', label: 'Per-capita Income (INR)', constraint: '. >= 0' },
    { type: 'decimal', name: 'credit_access_inr', label: 'Credit Access (INR)', constraint: '. >= 0' },
  ]),
  beneficiary: sys([
    { type: 'text', name: 'name', label: 'Name', required: true },
    { type: 'text', name: 'project_key', label: 'Project', required: true, appearance: 'project' },
    { type: 'select_one', name: 'gender', label: 'Gender', list: 'gender' },
    { type: 'text', name: 'location', label: 'Location' },
    { type: 'text', name: 'category', label: 'Category' },
    { type: 'date', name: 'enrolled_date', label: 'Enrolled Date' },
    { type: 'select_one', name: 'status', label: 'Status', list: 'beneficiary_status', required: true, default: 'Active' },
  ]),
  resource: sys([
    { type: 'text', name: 'beneficiary_uid', label: 'Beneficiary UID', required: true, appearance: 'beneficiary-lookup' },
    { type: 'select_one', name: 'resource_type', label: 'Production System', list: 'resource_type', required: true },
    { type: 'geopoint', name: 'location', label: 'GPS Location', required: true, column: 'latitude,longitude' },
    { type: 'decimal', name: 'area_acre', label: 'Area (acre)', constraint: '. > 0' },
    { type: 'select_one', name: 'water_body_type', label: 'Type of Resource', list: 'water_body_type', relevant: "${resource_type} = 'Freshwater_Wetland'" },
    { type: 'select_one', name: 'resource_access', label: 'Resource Access', list: 'resource_access', relevant: "${resource_type} = 'Freshwater_Wetland'" },
    { type: 'select_one', name: 'wetland_structure', label: 'Type of Resource', list: 'wetland_structure', relevant: "${resource_type} = 'Coastal_Wetland'" },
    { type: 'integer', name: 'raft_count', label: 'Number of Rafts', relevant: "${wetland_structure} = 'Raft'", constraint: '. >= 0' },
    { type: 'select_multiple', name: 'resource_utility', label: 'Resource Utility', list: 'resource_utility', relevant: "${resource_type} != 'Brackish_Water'" },
  ]),
  user: sys([
    { type: 'text', name: 'name', label: 'Name', required: true },
    { type: 'text', name: 'phone', label: 'Phone', required: true, appearance: 'numbers', constraint: "regex(., '^[0-9]{10}$')", constraint_message: 'Enter a 10-digit number' },
    { type: 'select_one', name: 'role', label: 'Role', list: 'user_role', required: true, default: 'employee' },
    { type: 'text', name: 'email', label: 'Email' },
  ]),
  project: sys([
    { type: 'text', name: 'id', label: 'Project ID', required: true, constraint: "regex(., '^[a-z0-9_]+$')", constraint_message: 'Lowercase letters, digits and _ only' },
    { type: 'text', name: 'label', label: 'Project Name', required: true },
    { type: 'text', name: 'color', label: 'Colour', appearance: 'color', default: '#3b82f6' },
  ]),
}

// name = ODK-safe value stored in submissions; value = what the DB column holds.
const opts = (values) => values.map(v => ({ name: v.replace(/[^A-Za-z0-9_.-]+/g, '_'), label: v, value: v }))
const yesNo = [{ name: 'yes', label: 'Yes', value: true }, { name: 'no', label: 'No', value: false }]

// Choice lists the system fields use. Values match the CHECK constraints /
// service allow-lists, so a system select always writes a value the column accepts.
export const SYSTEM_CHOICES = {
  gender: opts(GENDER), category: opts(CATEGORY), yes_no: yesNo,
  production_system: opts(PRODUCTION),
  collective_type: opts(['FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective']),
  beneficiary_status: opts(['Active', 'Completed', 'Dropped']),
  resource_type: opts(['Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water']),
  water_body_type: opts(['Chour', 'Moen', 'Dhar', 'Pond']),
  resource_access: opts(['Owned', 'Leased', 'Common']),
  wetland_structure: opts(['Raft', 'Mangroves']),
  resource_utility: opts(['Fishery', 'Makhana', 'Singhara', 'Seaweed', 'Oyster', 'Mussel', 'Fish', 'Crab',
                          'Bio Fortified Crop', 'Millet Crop', 'Pulse Crop', 'Grain Crop', 'Oil Seed Crop']),
  user_role: opts(['admin', 'manager', 'employee']),
}

export function defaultSchema(formKey, title) {
  const survey = (SYSTEM_FIELDS[formKey] || []).map(r => ({ ...r }))
  const lists = new Set(survey.map(r => r.list).filter(Boolean))
  const choices = Object.fromEntries([...lists].map(l => [l, SYSTEM_CHOICES[l].map(({ name, label }) => ({ name, label }))]))
  return { settings: { form_title: title || ENTITY_FORMS[formKey] || formKey }, survey, choices }
}

const str = (v) => (v == null ? undefined : String(v).slice(0, MAX_TEXT))

/** Keep only known keys and re-derive system/column from SYSTEM_FIELDS (never trust the client). */
export function normalizeSchema(input, formKey) {
  const sysByName = new Map((SYSTEM_FIELDS[formKey] || []).map(r => [r.name, r]))
  const survey = (Array.isArray(input?.survey) ? input.survey : []).slice(0, MAX_ROWS).map(raw => {
    const row = { type: str(raw?.type) || '', name: str(raw?.name) || '' }
    for (const k of TEXT_KEYS) { const v = str(raw?.[k]); if (v) row[k] = v }
    if (raw?.list) row.list = str(raw.list)
    if (raw?.required) row.required = true
    if (raw?.archived) row.archived = true
    const s = !NAMELESS.has(row.type) && sysByName.get(row.name)
    if (s) { row.system = true; row.column = s.column }
    return row
  })
  const choices = {}
  for (const [list, items] of Object.entries(input?.choices && typeof input.choices === 'object' ? input.choices : {}).slice(0, 200)) {
    choices[str(list)] = (Array.isArray(items) ? items : []).slice(0, MAX_CHOICES)
      .map(c => ({ name: str(c?.name) || '', label: str(c?.label) || '' }))
  }
  return { settings: { form_title: str(input?.settings?.form_title) || '' }, survey, choices }
}

/**
 * Returns a list of human-readable errors (empty = valid). `previous` is the
 * last published schema: anything it had must still exist with the same type
 * (archive instead of delete), so old submissions stay readable.
 */
export function validateSchema(schema, formKey, previous = null) {
  const errors = []
  const { survey, choices } = schema
  if (!schema.settings.form_title) errors.push('Form title is required.')
  if (!survey.some(r => QUESTION_TYPES.includes(r.type) && !r.archived)) errors.push('Add at least one question.')

  const names = new Map()
  const stack = []
  survey.forEach((r, i) => {
    const at = `Row ${i + 1}${r.name ? ` (${r.name})` : ''}`
    if (!ALL_TYPES.has(r.type)) { errors.push(`${at}: unknown type "${r.type}".`); return }
    if (r.type.startsWith('begin_')) stack.push({ kind: r.type.slice(6), name: r.name })
    if (r.type.startsWith('end_')) {
      const open = stack.pop()
      if (!open || open.kind !== r.type.slice(4)) errors.push(`${at}: "${r.type}" has no matching begin.`)
      return
    }
    if (!NAME_RE.test(r.name)) errors.push(`${at}: name must start with a letter or _ and use only letters, digits and _ (max 64).`)
    else if (names.has(r.name)) errors.push(`${at}: name "${r.name}" is used twice.`)
    names.set(r.name, { row: r, inRepeat: stack.some(s => s.kind === 'repeat') })
    if (r.type !== 'calculate' && !r.label) errors.push(`${at}: label is required.`)
    if (r.type === 'calculate' && !r.calculation) errors.push(`${at}: calculation is required.`)
    if (SELECT_TYPES.has(r.type)) {
      const items = choices[r.list]
      if (!r.list || !items?.length) errors.push(`${at}: pick a choice list with at least one option.`)
    }
  })
  for (const open of stack) errors.push(`Group/repeat "${open.name}" is never closed.`)

  for (const [list, items] of Object.entries(choices)) {
    if (!NAME_RE.test(list)) errors.push(`Choice list "${list}": invalid list name.`)
    const seen = new Set()
    for (const c of items) {
      if (!CHOICE_RE.test(c.name)) errors.push(`Choice list "${list}": value "${c.name}" must use letters, digits, _ . - only (no spaces).`)
      else if (seen.has(c.name)) errors.push(`Choice list "${list}": value "${c.name}" is used twice.`)
      seen.add(c.name)
      if (!c.label) errors.push(`Choice list "${list}": option "${c.name}" needs a label.`)
    }
  }

  survey.forEach(r => {
    for (const k of EXPR_KEYS) {
      // default is a literal value in XLSForm, not an expression
      const syntax = r[k] && k !== 'default' ? checkExpr(r[k]) : null
      if (syntax) errors.push(`${r.name || r.type}: ${k} has an error (${syntax}).`)
      for (const [, ref] of (r[k] || '').matchAll(REF_RE)) {
        if (!names.has(ref)) errors.push(`${r.name || r.type}: ${k} refers to unknown question \${${ref}}.`)
      }
    }
  })

  for (const s of SYSTEM_FIELDS[formKey] || []) {
    const got = names.get(s.name)?.row
    if (!got) { errors.push(`Built-in field "${s.name}" is missing.`); continue }
    if (got.type !== s.type) errors.push(`Built-in field "${s.name}" must stay type ${s.type}.`)
    if (got.archived) errors.push(`Built-in field "${s.name}" can't be archived.`)
    if (s.required && !got.required) errors.push(`Built-in field "${s.name}" must stay required.`)
    if (names.get(s.name).inRepeat) errors.push(`Built-in field "${s.name}" can't be inside a repeat.`)
    if (s.list && SELECT_TYPES.has(got.type)) {
      const allowed = new Set(SYSTEM_CHOICES[s.list].map(c => c.name))
      const bad = (choices[got.list] || []).filter(c => !allowed.has(c.name)).map(c => c.name)
      if (bad.length) errors.push(`Built-in field "${s.name}": options ${bad.join(', ')} aren't accepted by the database (you can relabel or remove options, not add new values).`)
    }
  }

  for (const p of previous?.survey || []) {
    if (NAMELESS.has(p.type)) continue
    const got = names.get(p.name)?.row
    if (!got) errors.push(`"${p.name}" was in the published version — archive it instead of deleting, so old answers stay readable.`)
    else if (got.type !== p.type) errors.push(`"${p.name}" was published as ${p.type}; changing its type would break old answers. Add a new question instead.`)
  }
  return errors
}
