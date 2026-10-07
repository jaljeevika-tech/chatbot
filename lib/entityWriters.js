// lib/entityWriters.js — write a built-in form's answers into its real table.
//
// Each writer mirrors its registration service's POST /api/register
// (services/individual-beneficiary, micro-entrepreneur, collective, resource) or
// routes/beneficiaries.routes.js: same validation, duplicate rule, UID sequence
// and DPDP encryption, so a record looks the same whichever path created it.
// Rules are re-checked here even though the form already enforces them, because
// admins may relax a system field's constraint in the builder.
//
// Answers arrive already evaluated (lib/odkForm.js evaluateForm): non-relevant
// answers dropped, numbers coerced, selects as choice names. System fields go to
// columns; everything else goes to custom_data.

import { SYSTEM_FIELDS, UTILITY_BRANCHES, choiceValue, utilityKgName } from './forms.js'
import { encryptPii, hashContactNo } from './piiCrypto.js'

export class WriteError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = (msg) => { throw new WriteError(400, msg) }

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
function nonNeg(v, label, integer = false) {
  const n = num(v)
  if (n === null) return null
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) bad(`${label} must be a non-negative ${integer ? 'whole number' : 'number'}`)
  return n
}
const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

// Same as the services: first 3 letters of the district, or GEN.
export function districtCode(district) {
  const letters = String(district || '').toUpperCase().replace(/[^A-Z]/g, '')
  return letters ? letters.slice(0, 3) : 'GEN'
}

/** Splits answers into system values and custom_data by the entity's system field names. */
export function splitAnswers(entity, data) {
  const names = new Set(SYSTEM_FIELDS[entity].map(r => r.name))
  const system = {}, custom = {}
  for (const [k, v] of Object.entries(data)) (names.has(k) ? system : custom)[k] = v
  return { system, custom }
}

function productionSystems(s, required) {
  const out = []
  for (const name of Array.isArray(s.production_systems) ? s.production_systems : []) {
    const type = choiceValue('production_system', name)
    if (!type || out.some(p => p.type === type)) continue
    out.push(type === 'Livestock'
      ? { type, livestock_count: nonNeg(s.livestock_count, 'Number of Livestock', true) }
      : { type, production_quintal: nonNeg(s[`${type.toLowerCase()}_quintal`], `${type} production (Quintal)`) })
  }
  if (required && !out.length) bad('Select at least one Type of Production System')
  return out
}

function contact(s) {
  const c = text(s.contact_no)
  if (!c || !/^\d{10}$/.test(c)) bad('A valid 10-digit contact number is required')
  return c
}

async function nextSeq(client, table, orgId) {
  const { rows } = await client.query(
    `INSERT INTO ${table} (org_id, next_val) VALUES ($1, 1)
     ON CONFLICT (org_id) DO UPDATE SET next_val = ${table}.next_val + 1 RETURNING next_val`, [orgId])
  return rows[0].next_val
}

// (phone hash, name) identity — several family members can share one phone.
async function assertNotDuplicate(client, table, nameCol, orgId, hash, name, what) {
  const { rows } = await client.query(
    `SELECT uid, ${nameCol} AS n FROM ${table} WHERE org_id = $1 AND contact_no_hash = $2 AND lower(trim(${nameCol})) = lower($3)`,
    [orgId, hash, name])
  if (rows[0]) throw new WriteError(409, `${what} "${rows[0].n}" is already registered with this contact number (${rows[0].uid}).`)
}

const lgdCols = (s) => [text(s.state), text(s.district), text(s.block), text(s.village)]

async function individualBeneficiary(client, orgId, s, custom) {
  const name = text(s.name) || bad('Name is required')
  const phone = contact(s)
  const production = productionSystems(s, true)
  const income = nonNeg(s.current_income_inr, 'Current Income')
  const hash = hashContactNo(phone)
  await assertNotDuplicate(client, 'individual_beneficiaries', 'name', orgId, hash, name, 'Beneficiary')
  const uid = `IB-${districtCode(s.district)}-${await nextSeq(client, 'individual_beneficiary_seq', orgId)}`
  const [state, district, block, village] = lgdCols(s)
  const { rows } = await client.query(
    `INSERT INTO individual_beneficiaries
       (org_id, uid, name, contact_no_enc, contact_no_hash, state, district, block, panchayat_enc, village,
        gender, category, occupation, current_income_inr_enc, production_systems, member_of_collective, custom_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, uid`,
    [orgId, uid, name, encryptPii(phone), hash, state, district, block, encryptPii(text(s.panchayat)), village,
      choiceValue('gender', s.gender), choiceValue('category', s.category), text(s.occupation), encryptPii(income),
      JSON.stringify(production), choiceValue('yes_no', s.member_of_collective), JSON.stringify(custom)])
  return { id: rows[0].id, uid: rows[0].uid, label: name }
}

async function microEntrepreneur(client, orgId, s, custom) {
  const name = text(s.name) || bad('Name is required')
  const phone = contact(s)
  const production = productionSystems(s, false)
  const revenue = nonNeg(s.current_revenue_inr, 'Current Revenue')
  const employees = nonNeg(s.current_employee_count, 'Current No. of Employees', true)
  const hash = hashContactNo(phone)
  await assertNotDuplicate(client, 'micro_entrepreneurs', 'name', orgId, hash, name, 'Micro-entrepreneur')
  const uid = `EB-${districtCode(s.district)}-${await nextSeq(client, 'micro_entrepreneur_seq', orgId)}`
  const [state, district, block, village] = lgdCols(s)
  const { rows } = await client.query(
    `INSERT INTO micro_entrepreneurs
       (org_id, uid, name, contact_no_enc, contact_no_hash, state, district, block, panchayat_enc, village,
        gender, category, enterprise_name, business_activity, current_revenue_inr_enc, current_employee_count,
        production_systems, custom_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id, uid`,
    [orgId, uid, name, encryptPii(phone), hash, state, district, block, encryptPii(text(s.panchayat)), village,
      choiceValue('gender', s.gender), choiceValue('category', s.category), text(s.enterprise_name), text(s.business_activity),
      encryptPii(revenue), employees, JSON.stringify(production), JSON.stringify(custom)])
  return { id: rows[0].id, uid: rows[0].uid, label: name }
}

async function collective(client, orgId, s, custom) {
  const name = text(s.collective_name) || bad('Collective Name is required')
  const type = choiceValue('collective_type', s.collective_type) || bad('Type of Collective is required')
  const lead = text(s.lead_person_name) || bad('Lead Person Name is required')
  const phone = contact(s)
  const production = productionSystems(s, false)
  const male = nonNeg(s.male_count, 'No. of Male', true)
  const female = nonNeg(s.female_count, 'No. of Female', true)
  const revenue = nonNeg(s.current_revenue_inr, 'Current Revenue')
  const perCapita = nonNeg(s.per_capita_income_inr, 'Current per capita income')
  const credit = nonNeg(s.credit_access_inr, 'Current credit access')
  const hash = hashContactNo(phone)
  await assertNotDuplicate(client, 'collectives', 'collective_name', orgId, hash, name, 'Collective')
  const uid = `CB-${districtCode(s.district)}-${await nextSeq(client, 'collective_seq', orgId)}`
  const [state, district, block, village] = lgdCols(s)
  const { rows } = await client.query(
    `INSERT INTO collectives
       (org_id, uid, collective_name, collective_type, lead_person_name, contact_no_enc, contact_no_hash,
        state, district, block, panchayat_enc, village, male_count, female_count,
        focus_area, current_revenue_inr, production_systems, per_capita_income_inr_enc, credit_access_inr, custom_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, uid`,
    [orgId, uid, name, type, lead, encryptPii(phone), hash, state, district, block, encryptPii(text(s.panchayat)), village,
      male, female, text(s.focus_area), revenue, JSON.stringify(production), encryptPii(perCapita), credit, JSON.stringify(custom)])
  return { id: rows[0].id, uid: rows[0].uid, label: name }
}

// Beneficiary UID → owning table, same prefixes as services/resource beneficiaryLookupSpec.
const BENEFICIARY_TABLES = {
  'IB-': { table: 'individual_beneficiaries', nameCol: 'name', type: 'Individual Beneficiary', prefix: 'IB' },
  'EB-': { table: 'micro_entrepreneurs', nameCol: 'name', type: 'Micro-Entrepreneur', prefix: 'EB' },
  'CB-': { table: 'collectives', nameCol: 'collective_name', type: 'Collective', prefix: 'CB' },
}
const RESOURCE_UID_PREFIX = { 'Freshwater Wetland': 'FW', 'Coastal Wetland': 'CW', 'Agricultural Land': 'AG', 'Brackish Water': 'BW' }

/** Resolves a beneficiary UID (any case) → { uid, name, type, prefix, district, location }; WriteError if invalid/unknown. */
export async function findBeneficiary(db, orgId, rawUid) {
  const uid = (text(rawUid) || bad('Beneficiary UID is required')).toUpperCase()
  const spec = BENEFICIARY_TABLES[uid.slice(0, 3)] || bad('UID must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur) or CB- (Collective)')
  const { rows } = await db.query(
    `SELECT uid, ${spec.nameCol} AS name, village, block, district, state FROM ${spec.table} WHERE org_id = $1 AND uid = $2 AND deleted_at IS NULL`, [orgId, uid])
  if (!rows[0]) throw new WriteError(404, `No beneficiary found for ${uid}`)
  const r = rows[0]
  return { uid: r.uid, name: r.name, type: spec.type, prefix: spec.prefix, district: r.district,
    location: [r.village, r.block, r.district, r.state].filter(Boolean).join(', ') }
}

async function resource(client, orgId, s, custom) {
  const beneficiary = await findBeneficiary(client, orgId, s.beneficiary_uid)

  const type = choiceValue('resource_type', s.resource_type) || bad('Type of Production System is required')
  let lat = null, lng = null
  if (text(s.location)) {
    [lat, lng] = String(s.location).trim().split(/\s+/).map(Number)
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) bad('GPS Location is invalid')
  }

  // Re-derive which branch fields apply (services/resource does the same) — anything
  // else is forced to null/[] whatever the form's skip logic was edited to.
  let waterBody = null, access = null, structure = null, rafts = null, areaApplies = false, branch = null
  if (type === 'Freshwater Wetland') {
    waterBody = choiceValue('water_body_type', s.water_body_type) || bad('Type of Resource is required')
    access = choiceValue('resource_access', s.resource_access)
    areaApplies = true; branch = 'fw_utility'
  } else if (type === 'Coastal Wetland') {
    structure = choiceValue('wetland_structure', s.wetland_structure) || bad('Type of Resource must be Raft or Mangroves')
    if (structure === 'Raft') { rafts = nonNeg(s.raft_count, 'No. of Raft', true); branch = 'raft_utility' } else areaApplies = true
  } else if (type === 'Agricultural Land') {
    areaApplies = true; branch = 'agri_utility'
  }
  const area = areaApplies ? nonNeg(s.area_acre, 'Area in Acre') : null
  const utility = []
  if (branch) {
    for (const name of Array.isArray(s[branch]) ? s[branch] : []) {
      const option = choiceValue(branch, name)
      if (!option || !UTILITY_BRANCHES[branch].options.includes(option) || utility.some(u => u.utility === option)) continue
      utility.push({ utility: option, production_kg: nonNeg(s[utilityKgName(option)], `${option} production (KG)`) })
    }
  }

  // Duplicate = same beneficiary + type + every detail (coordinates to ~1 m), as in the service.
  const { rows: existing } = await client.query(
    `SELECT uid, latitude, longitude, area_acre, water_body_type, resource_access, wetland_structure, raft_count, resource_utility
       FROM resources WHERE org_id = $1 AND beneficiary_uid = $2 AND resource_type = $3`, [orgId, beneficiary.uid, type])
  const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const round = (v) => (v === null ? null : Math.round(v * 1e5) / 1e5)
  const sig = (list) => JSON.stringify((Array.isArray(list) ? list : []).slice().sort((a, b) => String(a.utility).localeCompare(String(b.utility))))
  const dup = existing.find(r => round(n(r.latitude)) === round(lat) && round(n(r.longitude)) === round(lng) && n(r.area_acre) === area &&
    (r.water_body_type || null) === waterBody && (r.resource_access || null) === access && (r.wetland_structure || null) === structure &&
    (r.raft_count ?? null) === (rafts ?? null) && sig(r.resource_utility) === sig(utility))
  if (dup) throw new WriteError(409, `This resource has already been registered (${dup.uid}) for this beneficiary with the same location, area and details.`)

  const { rows: seq } = await client.query(
    `INSERT INTO resource_seq (org_id, resource_type, next_val) VALUES ($1, $2, 1)
     ON CONFLICT (org_id, resource_type) DO UPDATE SET next_val = resource_seq.next_val + 1 RETURNING next_val`, [orgId, type])
  const uid = `${RESOURCE_UID_PREFIX[type]}-${beneficiary.prefix}-${districtCode(beneficiary.district)}-${seq[0].next_val}`
  const { rows } = await client.query(
    `INSERT INTO resources
       (org_id, uid, resource_type, beneficiary_uid, beneficiary_type, beneficiary_name, latitude, longitude, area_acre,
        water_body_type, resource_access, wetland_structure, raft_count, resource_utility, custom_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, uid`,
    [orgId, uid, type, beneficiary.uid, beneficiary.type, beneficiary.name, lat, lng, area, waterBody, access, structure, rafts,
      JSON.stringify(utility), JSON.stringify(custom)])
  return { id: rows[0].id, uid: rows[0].uid, label: `${type} for ${beneficiary.name}` }
}

async function projectBeneficiary(client, orgId, s, custom, { projects }) {
  const name = text(s.name) || bad('Name is required')
  const projectKey = text(s.project_key)
  if (!projectKey || !projects.some(p => String(p.id) === projectKey)) bad('Pick one of your organisation\'s projects')
  const { rows } = await client.query(
    `INSERT INTO beneficiaries (org_id, project_key, name, gender, location, category, enrolled_date, status, custom_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'Active'),$9) RETURNING id`,
    [orgId, projectKey, name, choiceValue('gender', s.gender), text(s.location), text(s.category), text(s.enrolled_date),
      choiceValue('beneficiary_status', s.status), JSON.stringify(custom)])
  return { id: rows[0].id, uid: rows[0].id, label: name }
}

// Entity forms staff can fill from the Forms tab. user/project custom fields are
// edited in their admin screens instead (not field-collected records).
export const ENTITY_WRITERS = {
  individual_beneficiary: individualBeneficiary,
  micro_entrepreneur: microEntrepreneur,
  collective,
  resource,
  beneficiary: projectBeneficiary,
}
// The legacy per-project roster is editor-only (routes/beneficiaries.routes.js requireEditor).
export const WRITER_ROLES = { beneficiary: ['admin', 'manager', 'superadmin'] }

/** Runs the entity's writer inside the caller's transaction. */
export function writeEntity(client, entity, orgId, data, ctx = {}) {
  const { system, custom } = splitAnswers(entity, data)
  return ENTITY_WRITERS[entity](client, orgId, system, custom, { projects: [], ...ctx })
}
