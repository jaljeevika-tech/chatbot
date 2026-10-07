// Leaf module: types, category configs and field formatting shared by the
// beneficiary-profile components. Must not import any component (circular imports have crashed prod).

export type CategoryKey = 'individual' | 'entrepreneur' | 'collective'

export interface RosterRow {
  id: string
  uid: string
  displayName: string
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  village: string | null
  [key: string]: unknown
}
export interface RosterData {
  rows: RosterRow[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Record<string, number>
  states: string[]
  districts: string[]
  blocks: string[]
  villages: string[]
}
export const EMPTY_ROSTER: RosterData = { rows: [], totalRows: 0, page: 0, pageSize: 50, kpis: { total: 0 }, states: [], districts: [], blocks: [], villages: [] }

// One label:value row on the printable ID card (BeneficiaryIdCard in IdCards.tsx).
export interface CardField {
  label: string
  of: (raw: any) => unknown
}

export interface CategoryConfig {
  key: CategoryKey
  label: string
  endpoint: string
  searchPlaceholder: string
  nameOf: (raw: any) => string
  subLabelOf: (raw: any) => string // one distinguishing extra field shown under the name
  kpiTiles: { label: string; value: (kpis: Record<string, number>) => string | number; note?: (kpis: Record<string, number>) => string }[]
  // ID card fields, top to bottom. The roster row already carries them (and the
  // profile record is a superset), so the card needs no extra fetch.
  cardFields: CardField[]
}

export function inr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

// production_systems as one string (Livestock is a headcount, the rest are in
// Quintal). Older registrations only have the single production_type field.
function productionSystemsSummary(r: any): string {
  if (Array.isArray(r.production_systems) && r.production_systems.length) {
    return r.production_systems
      .map((p: any) => `${p.type}: ${p.type === 'Livestock' ? (p.livestock_count ?? '—') : (p.production_quintal != null ? `${p.production_quintal} qtl` : '—')}`)
      .join(', ')
  }
  return r.production_type || ''
}

const pctOf = (part: number | undefined, whole: number | undefined) =>
  whole ? `${Math.round(((part ?? 0) / whole) * 100)}%` : ''
const qtl = (n: number | undefined) => `${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} qtl`

// Counts come from each list endpoint's kpis (lib/productionSystemsSql.js);
// the note is Quintal produced, or a livestock headcount.
export const PRODUCTION_TILES: { label: string; countKey: string; note: (k: Record<string, number>) => string }[] = [
  { label: 'Aquaculture',  countKey: 'aquaculture',  note: k => qtl(k.aquacultureQtl) },
  { label: 'Agriculture',  countKey: 'agriculture',  note: k => qtl(k.agricultureQtl) },
  { label: 'Livestock',    countKey: 'livestock',    note: k => `${(k.totalLivestock ?? 0).toLocaleString('en-IN')} livestock` },
  { label: 'Horticulture', countKey: 'horticulture', note: k => qtl(k.horticultureQtl) },
]

export const CATEGORIES: CategoryConfig[] = [
  {
    key: 'individual', label: 'Individual Beneficiary', endpoint: '/api/individual-beneficiaries',
    searchPlaceholder: 'Search UID, name, mobile or village…',
    nameOf: r => r.name, subLabelOf: r => productionSystemsSummary(r) || r.occupation || '—',
    kpiTiles: [
      { label: 'Total Beneficiaries', value: k => k.total ?? 0 },
      { label: 'Male', value: k => k.male ?? 0, note: k => pctOf(k.male, k.total) },
      { label: 'Female', value: k => k.female ?? 0, note: k => pctOf(k.female, k.total) },
      { label: 'Collective Members', value: k => k.collectiveMembers ?? 0, note: k => pctOf(k.collectiveMembers, k.total) },
      { label: 'Avg. Income', value: k => inr(k.avgIncome) },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',      of: r => r.name },
      { label: 'Mobile',    of: r => r.contact_no },
      { label: 'Gender',    of: r => r.gender },
      { label: 'Occupation',of: r => r.occupation || productionSystemsSummary(r) },
      { label: 'State',     of: r => r.state },
      { label: 'District',  of: r => r.district },
      { label: 'Block',     of: r => r.block },
      { label: 'Panchayat', of: r => r.panchayat },
      { label: 'Village',   of: r => r.village },
    ],
  },
  {
    key: 'entrepreneur', label: 'Micro-Entrepreneur', endpoint: '/api/micro-entrepreneurs',
    searchPlaceholder: 'Search UID, name, mobile, village or enterprise…',
    nameOf: r => r.name, subLabelOf: r => r.enterprise_name || r.business_activity || '—',
    kpiTiles: [
      { label: 'Total Entrepreneurs', value: k => k.total ?? 0 },
      { label: 'Male', value: k => k.male ?? 0, note: k => pctOf(k.male, k.total) },
      { label: 'Female', value: k => k.female ?? 0, note: k => pctOf(k.female, k.total) },
      { label: 'Avg. Revenue', value: k => inr(k.avgRevenue), note: k => `Total ${inr(k.totalRevenue)}` },
      { label: 'Total Employees', value: k => k.totalEmployees ?? 0 },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',       of: r => r.name },
      { label: 'Mobile',     of: r => r.contact_no },
      { label: 'Gender',     of: r => r.gender },
      { label: 'Enterprise', of: r => r.enterprise_name || r.business_activity },
      { label: 'State',      of: r => r.state },
      { label: 'District',   of: r => r.district },
      { label: 'Block',      of: r => r.block },
      { label: 'Panchayat',  of: r => r.panchayat },
      { label: 'Village',    of: r => r.village },
    ],
  },
  {
    key: 'collective', label: 'Collective', endpoint: '/api/collectives',
    searchPlaceholder: 'Search UID, name, lead person, mobile or village…',
    nameOf: r => r.collective_name, subLabelOf: r => r.collective_type || r.focus_area || '—',
    kpiTiles: [
      { label: 'Total Collectives', value: k => k.total ?? 0 },
      { label: 'Total Members', value: k => (k.totalMale ?? 0) + (k.totalFemale ?? 0), note: k => `${k.totalMale ?? 0} Male · ${k.totalFemale ?? 0} Female` },
      { label: 'Avg. Revenue', value: k => inr(k.avgRevenue), note: k => `Total ${inr(k.totalRevenue)}` },
      { label: 'Total Credit Access', value: k => inr(k.totalCreditAccess) },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',        of: r => r.collective_name },
      { label: 'Lead Person', of: r => r.lead_person_name },
      { label: 'Mobile',      of: r => r.contact_no },
      { label: 'Type',        of: r => r.collective_type },
      { label: 'State',       of: r => r.state },
      { label: 'District',    of: r => r.district },
      { label: 'Block',       of: r => r.block },
      { label: 'Panchayat',   of: r => r.panchayat },
      { label: 'Village',     of: r => r.village },
    ],
  },
]

// Indirect Beneficiaries (XB-) have no roster tab, but the profile endpoint
// still resolves their UIDs, so the ID card needs a field list for them.
const INDIRECT_CARD_FIELDS: CardField[] = [
  { label: 'Name',   of: r => r.name },
  { label: 'Mobile', of: r => r.contact_no },
  { label: 'Place',  of: r => r.place },
]

// typeLabel is the profile endpoint's `type` value (beneficiaryLookupSpec).
export function cardFieldsForType(typeLabel: string): CardField[] {
  return CATEGORIES.find(c => c.label === typeLabel)?.cardFields ?? INDIRECT_CARD_FIELDS
}

// ── Field labels + formatting for the "complete detail" grid ──────────────
export const HIDDEN_FIELDS = new Set(['id', 'org_id'])
const CURRENCY_FIELDS = ['income_inr', 'revenue_inr', 'credit_access_inr', 'amount']
const DATE_FIELDS = ['created_at', '_date']
const BOOLEAN_LABELS: Record<string, string> = { true: 'Yes', false: 'No' }

export function humanizeKey(key: string): string {
  return key
    .replace(/_inr$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

export function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    if (!value.length) return '—'
    // Livestock is a headcount; the other systems are in Quintal.
    if (key === 'production_systems') return value.map(p => `${p.type}: ${p.type === 'Livestock' ? (p.livestock_count ?? '—') : (p.production_quintal != null ? `${p.production_quintal} qtl` : '—')}`).join(', ')
    return value.map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ')
  }
  if (typeof value === 'boolean') return BOOLEAN_LABELS[String(value)]
  if (typeof value === 'object') return JSON.stringify(value)
  if (CURRENCY_FIELDS.some(f => key.endsWith(f)) && typeof value === 'number') return inr(value)
  if (DATE_FIELDS.some(f => key.endsWith(f)) && typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }
  if (key.endsWith('_ton') && typeof value === 'number') return `${value.toLocaleString('en-IN')} ton`
  return String(value)
}

// Read-only even in edit mode. The server ignores writes to uid/created_at
// (PROTECTED_COLUMNS), and production_systems is a JSONB array that needs the
// registration form's editor rather than a plain input.
export const READONLY_DETAIL_FIELDS = new Set(['uid', 'created_at', 'production_systems', 'custom_data'])

// Columns with DB CHECK constraints get a <select> so a typo can't be rejected
// by the constraint.
export const FIELD_OPTIONS: Record<string, string[]> = {
  gender:          ['Male', 'Female', 'Other'],
  category:        ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority'],
  production_type: ['Aquaculture', 'Agriculture'],
}
