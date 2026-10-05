// Per-category settings for MisUploadModal. Leaf module: only utils/theme
// imports, so every MIS page can import it without creating cycles.

import type { ReactNode } from 'react'
import { excelCellToIsoDate } from '../../utils/format'
import { FF } from '../../theme/colors'

export type MisRow = Record<string, any>

export type MisUploadConfig = {
  label: string                // "Upload {label} Records", "Drop the {label} .xlsx"
  columns: string              // shown in the help box and the "no rows found" error
  notes: ReactNode             // help text after the column list
  endpoint: string
  templateUrl: string
  templateFile: string
  templateHint?: string
  cellDates?: boolean
  isHeaderCell: (n: string) => boolean
  columnMatchers: Record<string, (n: string) => boolean>
  requiredColumns: string[]
  // get(key) is the cell under that column, or undefined if the sheet lacks it.
  // Return null to skip the row.
  parseRow: (get: (key: string) => any, XLSX: any) => MisRow | null
  previewStats?: (rows: MisRow[]) => ReactNode
  previewLine: (r: MisRow) => string
}

type Get = (key: string) => any

const text = (v: any) => String(v ?? '').trim()
const textOrNull = (v: any) => text(v) || null

function cellToInt(v: any): number | null {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

const isUid = (n: string) => n === 'uid'
const isDate = (n: string) => n === 'date'
const isPlace = (n: string) => n === 'place'

// A blank UID is kept, not skipped: the server turns it into an Indirect Beneficiary.
const BENEFICIARY_COLUMNS = {
  uid: isUid,
  name: (n: string) => n === 'name',
  contact: (n: string) => n.includes('contact'),
  date: isDate,
  place: isPlace,
}

function beneficiaryFields(get: Get) {
  return { uid: text(get('uid')), name: textOrNull(get('name')), contact_no: textOrNull(get('contact')) }
}

function dateAndPlace(get: Get, XLSX: any) {
  return { date: excelCellToIsoDate(XLSX, get('date')), place: textOrNull(get('place')) }
}

const beneficiaryLine = (r: MisRow, detail: string) =>
  `• ${r.uid || '(no UID → Indirect Beneficiary)'} — ${r.name || '—'} — ${detail}`

function uidStats(rows: MisRow[]) {
  return (
    <div>
      <strong style={{ color: FF.tealDark }}>With UID:</strong> {rows.filter(r => r.uid).length}
      {' · '}
      <strong style={{ color: FF.tealDark }}>No UID (→ Indirect Beneficiary):</strong> {rows.filter(r => !r.uid).length}
    </div>
  )
}

const BENEFICIARY_NOTES = (
  <>
    Each row's UID is matched against Individual Beneficiary / Micro-Entrepreneur / Collective records
    (by its IB-/EB-/CB- prefix) — rows are sorted onto the right sub-tab automatically. Name &amp; Contact
    No. are for your reference only; the beneficiary's own record is always used. A row with{' '}
    <strong>no UID</strong> is not rejected — it's saved as an Indirect Beneficiary (visible under
    Beneficiaries &gt; Indirect Beneficiary), using their Contact No. as the identity — the same
    mobile number always resolves to the same record, so it's never registered twice.
  </>
)

export const TRAINING_UPLOAD: MisUploadConfig = {
  label: 'Training',
  columns: 'UID, Name, Contact No., Training topic, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/trainings/bulk-upload',
  templateUrl: '/api/trainings-template.xlsx',
  templateFile: 'training-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: { ...BENEFICIARY_COLUMNS, topic: n => n.includes('training topic') || n.includes('topic') },
  requiredColumns: ['uid', 'topic'],
  parseRow: (get, XLSX) => {
    const topic = text(get('topic'))
    if (!topic) return null
    return { ...beneficiaryFields(get), training_topic: topic, ...dateAndPlace(get, XLSX) }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.training_topic),
}

export const INPUT_DISTRIBUTION_UPLOAD: MisUploadConfig = {
  label: 'Input Distribution',
  columns: 'UID, Name, Contact No., Input Distributed, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/input-distributions/bulk-upload',
  templateUrl: '/api/input-distributions-template.xlsx',
  templateFile: 'input-distribution-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: { ...BENEFICIARY_COLUMNS, item: n => n.includes('input distributed') || n.includes('input') },
  requiredColumns: ['uid', 'item'],
  parseRow: (get, XLSX) => {
    const item = text(get('item'))
    if (!item) return null
    return { ...beneficiaryFields(get), input_distributed: item, ...dateAndPlace(get, XLSX) }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.input_distributed),
}

export const SCHEME_ACCESS_UPLOAD: MisUploadConfig = {
  label: 'Scheme Access',
  columns: 'UID, Name, Contact No., Scheme, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/scheme-access/bulk-upload',
  templateUrl: '/api/scheme-access-template.xlsx',
  templateFile: 'scheme-access-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: { ...BENEFICIARY_COLUMNS, scheme: n => n.includes('scheme') },
  requiredColumns: ['uid', 'scheme'],
  parseRow: (get, XLSX) => {
    const scheme = text(get('scheme'))
    if (!scheme) return null
    return { ...beneficiaryFields(get), scheme_name: scheme, ...dateAndPlace(get, XLSX) }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.scheme_name),
}

export const BUSINESS_DEVELOPMENT_SUPPORT_UPLOAD: MisUploadConfig = {
  label: 'Business Development Support',
  columns: 'UID, Name, Contact No., Business Development Support, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/business-development-support/bulk-upload',
  templateUrl: '/api/business-development-support-template.xlsx',
  templateFile: 'business-development-support-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: { ...BENEFICIARY_COLUMNS, support: n => n.includes('business development support') || n.includes('support') },
  requiredColumns: ['uid', 'support'],
  parseRow: (get, XLSX) => {
    const support = text(get('support'))
    if (!support) return null
    return { ...beneficiaryFields(get), support_provided: support, ...dateAndPlace(get, XLSX) }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.support_provided),
}

export const COMPLIANCE_SUPPORT_UPLOAD: MisUploadConfig = {
  label: 'Compliance Support',
  columns: 'UID, Name, Contact No., Compliance Support, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/compliance-support/bulk-upload',
  templateUrl: '/api/compliance-support-template.xlsx',
  templateFile: 'compliance-support-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: { ...BENEFICIARY_COLUMNS, support: n => n.includes('compliance support') || n.includes('compliance') },
  requiredColumns: ['uid', 'support'],
  parseRow: (get, XLSX) => {
    const support = text(get('support'))
    if (!support) return null
    return { ...beneficiaryFields(get), compliance_support_provided: support, ...dateAndPlace(get, XLSX) }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.compliance_support_provided),
}

export const CREDIT_GRANT_ACCESS_UPLOAD: MisUploadConfig = {
  label: 'Credit/Grant Access',
  columns: 'UID, Name, Contact No., Credit/Grant Source, Credit/Grant Type, Name of Credit/Grant Entity, Amount, Date, Place',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/credit-grant-access/bulk-upload',
  templateUrl: '/api/credit-grant-access-template.xlsx',
  templateFile: 'credit-grant-access-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: {
    ...BENEFICIARY_COLUMNS,
    source: n => n.includes('source'),
    type: n => n.includes('type'),
    entity: n => n.includes('entity'),
    amount: n => n.includes('amount'),
  },
  requiredColumns: ['uid', 'source'],
  parseRow: (get, XLSX) => {
    const source = text(get('source'))
    if (!source) return null
    const rawAmount = get('amount')
    const amount = rawAmount === '' || rawAmount == null ? null : Number(rawAmount)
    return {
      ...beneficiaryFields(get),
      credit_grant_source: source,
      credit_grant_type: textOrNull(get('type')),
      entity_name: textOrNull(get('entity')),
      amount: amount != null && !isNaN(amount) ? amount : null,
      ...dateAndPlace(get, XLSX),
    }
  },
  previewStats: uidStats,
  previewLine: r =>
    beneficiaryLine(r, r.credit_grant_source) +
    (r.entity_name ? ` (${r.entity_name})` : '') +
    (r.amount != null ? ` — ₹${r.amount.toLocaleString('en-IN')}` : ''),
}

export const EXPOSURE_VISIT_UPLOAD: MisUploadConfig = {
  label: 'Exposure Visit',
  columns: 'UID, Name, Contact No., Purpose of Exposure Visit, Place of Exposure Visit, Date',
  notes: BENEFICIARY_NOTES,
  endpoint: '/api/exposure-visits/bulk-upload',
  templateUrl: '/api/exposure-visits-template.xlsx',
  templateFile: 'exposure-visit-template.xlsx',
  isHeaderCell: isUid,
  columnMatchers: {
    ...BENEFICIARY_COLUMNS,
    // The real sheet's "Purpsoe of Exposure Visit" header is misspelt, so
    // purpose is matched by "exposure visit" minus the Place column.
    place: n => n.includes('place'),
    purpose: n => n.includes('exposure visit') && !n.includes('place'),
  },
  requiredColumns: ['uid', 'purpose'],
  parseRow: (get, XLSX) => {
    const purpose = text(get('purpose'))
    if (!purpose) return null
    return {
      ...beneficiaryFields(get),
      purpose,
      visit_place: textOrNull(get('place')),
      date: excelCellToIsoDate(XLSX, get('date')),
    }
  },
  previewStats: uidStats,
  previewLine: r => beneficiaryLine(r, r.purpose) + (r.visit_place ? ` @ ${r.visit_place}` : ''),
}

const INCOME_SOURCES = ['Fisheries', 'Agriculture', 'Horticulture', 'Livestock', 'Trade', 'Service', 'Labour', 'Other']

function normalizeSource(v: any): string {
  const s = text(v)
  return INCOME_SOURCES.find(opt => opt.toLowerCase() === s.toLowerCase()) || s
}

// Income has no Date column: one row per beneficiary per source per financial year.
export const INCOME_UPLOAD: MisUploadConfig = {
  label: 'Income',
  columns: 'UID, Name, Financial Year, Source, Income realised in INR, Place',
  notes: (
    <>
      Source must be one of <strong>{INCOME_SOURCES.join(', ')}</strong>. Each row's UID is matched against
      Individual Beneficiary / Micro-Entrepreneur / Collective records (by its IB-/EB-/CB- prefix) —
      rows are sorted onto the right sub-tab automatically. A row with <strong>no UID</strong> is not
      rejected — it's saved as an Indirect Beneficiary (visible under Beneficiaries &gt; Indirect
      Beneficiary), matched by name. A beneficiary can have more than one row per Financial Year — one
      per income source.
    </>
  ),
  endpoint: '/api/income/bulk-upload',
  templateUrl: '/api/income-template.xlsx',
  templateFile: 'income-template.xlsx',
  cellDates: true,
  isHeaderCell: isUid,
  columnMatchers: {
    uid: isUid,
    name: BENEFICIARY_COLUMNS.name,
    fy: n => n.includes('financial year'),
    source: n => n === 'source',
    income: n => n.includes('income'),
    place: isPlace,
  },
  requiredColumns: ['uid', 'fy', 'source'],
  parseRow: get => {
    const fy = text(get('fy'))
    const source = normalizeSource(get('source'))
    if (!fy || !source) return null
    const rawIncome = get('income')
    return {
      uid: text(get('uid')),
      name: textOrNull(get('name')),
      financial_year: fy,
      income_source: source,
      income_realised: rawIncome !== '' && !Number.isNaN(Number(rawIncome)) ? Number(rawIncome) : null,
      place: textOrNull(get('place')),
    }
  },
  previewStats: rows => (
    <>
      {uidStats(rows)}
      <div>
        <strong style={{ color: FF.tealDark }}>Unrecognized Source:</strong>{' '}
        {rows.filter(r => !INCOME_SOURCES.includes(r.income_source)).length}
      </div>
    </>
  ),
  previewLine: r => beneficiaryLine(r, `${r.income_source} (${r.financial_year})`),
}

// Campaigns and community meetings are aggregate events with no UID column.
const ATTENDANCE_COLUMNS = {
  total: (n: string) => n.includes('total') && n.includes('attendee'),
  male: (n: string) => n.includes('male') && !n.includes('female'),
  female: (n: string) => n.includes('female'),
  children: (n: string) => n.includes('child'),
  date: isDate,
  place: isPlace,
}

function attendanceFields(get: Get, XLSX: any) {
  return {
    total_attendees: cellToInt(get('total')),
    male_count: cellToInt(get('male')),
    female_count: cellToInt(get('female')),
    children_count: cellToInt(get('children')),
    ...dateAndPlace(get, XLSX),
  }
}

const attendanceSuffix = (r: MisRow) =>
  (r.total_attendees != null ? ` — ${r.total_attendees} attendees` : '') + (r.place ? ` @ ${r.place}` : '')

// The real sheet's header is "Campagin Name", so match on "campa".
const isCampaignName = (n: string) => n.startsWith('campa')

export const CAMPAIGN_UPLOAD: MisUploadConfig = {
  label: 'Campaign',
  columns: 'Campaign Name, Total No. of Attendees, No. of Male, No. of Female, No. of Children, Date, Place',
  notes: 'Campaigns are aggregate events — not linked to a specific beneficiary UID — so this sheet has no UID/Name/Contact No. columns.',
  endpoint: '/api/campaign/bulk-upload',
  templateUrl: '/api/campaign-template.xlsx',
  templateFile: 'campaign-template.xlsx',
  templateHint: 'Pre-formatted columns with a sample row.',
  isHeaderCell: isCampaignName,
  columnMatchers: { name: isCampaignName, ...ATTENDANCE_COLUMNS },
  requiredColumns: ['name'],
  parseRow: (get, XLSX) => {
    const campaignName = text(get('name'))
    if (!campaignName) return null
    return { campaign_name: campaignName, ...attendanceFields(get, XLSX) }
  },
  previewLine: r => `• ${r.campaign_name}` + attendanceSuffix(r),
}

export const COMMUNITY_MEETING_UPLOAD: MisUploadConfig = {
  label: 'Community Meeting',
  columns: 'Purpose of Meeting, Total No. of Attendees, No. of Male, No. of Female, No. of Children, Date, Place',
  notes: 'Community meetings are aggregate events — not linked to a specific beneficiary UID — so this sheet has no UID/Name/Contact No. columns.',
  endpoint: '/api/community-meeting/bulk-upload',
  templateUrl: '/api/community-meeting-template.xlsx',
  templateFile: 'community-meeting-template.xlsx',
  templateHint: 'Pre-formatted columns with a sample row.',
  isHeaderCell: n => n.includes('purpose'),
  columnMatchers: { purpose: n => n.includes('purpose'), ...ATTENDANCE_COLUMNS },
  requiredColumns: ['purpose'],
  parseRow: (get, XLSX) => {
    const purpose = text(get('purpose'))
    if (!purpose) return null
    return { purpose, ...attendanceFields(get, XLSX) }
  },
  previewLine: r => `• ${r.purpose}` + attendanceSuffix(r),
}
