// Single source of truth for the 8 MIS import templates, read by both the Data
// Sources mapping UI (GET /api/mis-templates/:key) and the validator in
// data-sources.routes.js so they can't drift.
// Server-side `xlsx` is only used to *write* our own templates; untrusted uploads
// are never parsed here (docs/Technical.md §7.11).

export const IMPORT_TYPES = [
  {
    key: 'indicator_framework',
    label: 'Indicator framework',
    columns: [
      { key: 'code', label: 'Code', type: 'text', required: true, notes: 'Unique within the project, e.g. A1 / O1 / OC1 / IM1' },
      { key: 'name', label: 'Indicator Name', type: 'text', required: true, notes: '' },
      { key: 'level', label: 'Level', type: 'select', required: true, options: ['activity', 'output', 'outcome', 'impact'], notes: 'One of: activity, output, outcome, impact' },
      { key: 'unit', label: 'Unit', type: 'text', required: false, notes: 'e.g. kg, households, %, count' },
      { key: 'frequency', label: 'Frequency', type: 'select', required: false, options: ['monthly', 'quarterly', 'annual', 'baseline_endline'], notes: 'Defaults to monthly if left blank' },
      { key: 'aggregation_method', label: 'Aggregation Method', type: 'select', required: false, options: ['sum', 'cumulative', 'average', 'latest', 'percentage'], notes: 'Defaults to sum if left blank' },
      { key: 'annual_target', label: 'Annual Target', type: 'number', required: false, notes: 'Project-wide target for the current financial year' },
      { key: 'baseline_value', label: 'Baseline Value', type: 'number', required: false, notes: '' },
      { key: 'data_source', label: 'Data Source', type: 'text', required: false, notes: 'Where this indicator is measured from, e.g. field survey, MIS register' },
      { key: 'responsible_person', label: 'Responsible Person', type: 'text', required: false, notes: '' },
      { key: 'definition', label: 'Definition', type: 'text', required: false, notes: 'How this indicator is defined/calculated' },
    ],
    sampleRow: { code: 'OC1', name: 'Fish yield per household', level: 'outcome', unit: 'kg', frequency: 'annual', aggregation_method: 'average', annual_target: 120, baseline_value: 60, data_source: 'Field survey', responsible_person: 'Project Lead', definition: 'Average annual fish yield per participating household' },
  },
  {
    key: 'monthly_plan_actual',
    label: 'Monthly plan and actual',
    columns: [
      { key: 'indicator_code', label: 'Indicator Code', type: 'text', required: true, notes: 'Must match an existing Indicator Framework code' },
      { key: 'financial_year', label: 'Financial Year', type: 'number', required: true, notes: 'Start year of the FY, e.g. 2026 for FY2026-27' },
      { key: 'month', label: 'Month', type: 'select', required: true, options: ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'], notes: '' },
      { key: 'geography', label: 'Geography', type: 'text', required: false, notes: 'Leave blank for project-wide rows' },
      { key: 'plan', label: 'Plan', type: 'number', required: false, notes: 'Leave blank rather than entering 0 if no plan exists yet' },
      { key: 'actual', label: 'Actual', type: 'number', required: false, notes: 'Leave blank rather than entering 0 if not yet reported' },
      { key: 'remarks', label: 'Remarks', type: 'text', required: false, notes: '' },
    ],
    sampleRow: { indicator_code: 'OC1', financial_year: 2026, month: 'Jun', geography: 'Supaul', plan: 10, actual: 8, remarks: 'On track' },
  },
  {
    key: 'beneficiary_master',
    label: 'Beneficiary master',
    columns: [
      { key: 'block', label: 'Block', type: 'text', required: true, notes: '' },
      { key: 'panchayat', label: 'Panchayat', type: 'text', required: false, notes: '' },
      { key: 'village', label: 'Village', type: 'text', required: false, notes: '' },
      { key: 'beneficiary_name', label: 'Beneficiary Name', type: 'text', required: true, notes: '' },
      { key: 'farmer_id', label: 'Farmer ID', type: 'text', required: false, notes: '' },
      { key: 'contact_no', label: 'Contact No.', type: 'text', required: false, notes: '' },
      { key: 'gender', label: 'Gender', type: 'select', required: false, options: ['Male', 'Female', 'Other'], notes: 'Leave blank if unknown — never inferred' },
      { key: 'benf_type', label: 'Beneficiary Type', type: 'select', required: false, options: ['Individual', 'Cooperative Member', 'Fish Vendor', 'Both', 'All'], notes: '' },
      { key: 'cooperative_name', label: 'Cooperative Name', type: 'text', required: false, notes: '' },
    ],
    sampleRow: { block: 'Triveniganj', panchayat: 'Bhagwatipur', village: 'Rampur', beneficiary_name: 'Ravindra Mukhiya', farmer_id: 'F-0231', contact_no: '9800000000', gender: 'Male', benf_type: 'Individual', cooperative_name: '' },
  },
  {
    key: 'beneficiary_intervention',
    label: 'Beneficiary intervention',
    columns: [
      { key: 'farmer_id', label: 'Farmer ID', type: 'text', required: true, notes: 'Must match a Beneficiary Master record' },
      { key: 'intervention_type', label: 'Intervention Type', type: 'text', required: true, notes: 'e.g. Credit Linkage, Training, Input Support' },
      { key: 'intervention_date', label: 'Intervention Date', type: 'date', required: true, notes: 'YYYY-MM-DD' },
      { key: 'indicator_code', label: 'Indicator Code', type: 'text', required: false, notes: 'Which indicator this intervention contributes to, if any' },
      { key: 'quantity', label: 'Quantity', type: 'number', required: false, notes: '' },
      { key: 'unit', label: 'Unit', type: 'text', required: false, notes: '' },
    ],
    sampleRow: { farmer_id: 'F-0231', intervention_type: 'Credit Linkage', intervention_date: '2026-06-15', indicator_code: 'O2', quantity: 25000, unit: 'INR' },
  },
  {
    key: 'baseline_current',
    label: 'Baseline and current values',
    columns: [
      { key: 'indicator_code', label: 'Indicator Code', type: 'text', required: true, notes: 'Must match an existing Indicator Framework code' },
      { key: 'geography', label: 'Geography', type: 'text', required: false, notes: 'Leave blank for project-wide' },
      { key: 'measurement_type', label: 'Measurement Type', type: 'select', required: true, options: ['baseline', 'midline', 'endline'], notes: '' },
      { key: 'value', label: 'Value', type: 'number', required: true, notes: '' },
      { key: 'measurement_date', label: 'Measurement Date', type: 'date', required: false, notes: 'YYYY-MM-DD' },
    ],
    sampleRow: { indicator_code: 'OC1', geography: 'Supaul', measurement_type: 'baseline', value: 60, measurement_date: '2025-04-01' },
  },
  {
    key: 'training_attendance',
    label: 'Training attendance',
    columns: [
      { key: 'training_name', label: 'Training Name', type: 'text', required: true, notes: '' },
      { key: 'training_date', label: 'Training Date', type: 'date', required: true, notes: 'YYYY-MM-DD' },
      { key: 'block', label: 'Block', type: 'text', required: false, notes: '' },
      { key: 'village', label: 'Village', type: 'text', required: false, notes: '' },
      { key: 'beneficiary_name', label: 'Beneficiary Name', type: 'text', required: true, notes: '' },
      { key: 'gender', label: 'Gender', type: 'select', required: false, options: ['Male', 'Female', 'Other'], notes: 'Leave blank if unknown — never inferred' },
      { key: 'attendance_status', label: 'Attendance Status', type: 'select', required: false, options: ['Present', 'Absent'], notes: 'Defaults to flagged-for-review if left blank, never assumed Present' },
    ],
    sampleRow: { training_name: 'Pond & Water Management', training_date: '2026-05-10', block: 'Triveniganj', village: 'Rampur', beneficiary_name: 'Ravindra Mukhiya', gender: 'Male', attendance_status: 'Present' },
  },
  {
    key: 'market_linkage',
    label: 'Market linkage',
    columns: [
      { key: 'farmer_id', label: 'Farmer ID', type: 'text', required: true, notes: 'Must match a Beneficiary Master record' },
      { key: 'market_name', label: 'Market Name', type: 'text', required: true, notes: '' },
      { key: 'linkage_type', label: 'Linkage Type', type: 'text', required: false, notes: 'e.g. direct sale, aggregator, cooperative' },
      { key: 'produce', label: 'Produce', type: 'text', required: false, notes: '' },
      { key: 'quantity_sold', label: 'Quantity Sold', type: 'number', required: false, notes: '' },
      { key: 'sale_value', label: 'Sale Value', type: 'number', required: false, notes: 'In INR' },
      { key: 'sale_date', label: 'Sale Date', type: 'date', required: false, notes: 'YYYY-MM-DD' },
    ],
    sampleRow: { farmer_id: 'F-0231', market_name: 'Triveniganj Haat', linkage_type: 'direct sale', produce: 'Fish', quantity_sold: 40, sale_value: 6000, sale_date: '2026-06-20' },
  },
  {
    key: 'geography_master',
    label: 'Geography master',
    columns: [
      { key: 'state', label: 'State', type: 'text', required: true, notes: '' },
      { key: 'district', label: 'District', type: 'text', required: false, notes: '' },
      { key: 'block', label: 'Block', type: 'text', required: true, notes: '' },
      { key: 'panchayat', label: 'Panchayat', type: 'text', required: false, notes: '' },
      { key: 'village', label: 'Village', type: 'text', required: false, notes: '' },
      { key: 'geography_code', label: 'Geography Code', type: 'text', required: false, notes: 'Internal code if one already exists' },
    ],
    sampleRow: { state: 'Bihar', district: 'Supaul', block: 'Triveniganj', panchayat: 'Bhagwatipur', village: 'Rampur', geography_code: '' },
  },
]

export function getImportType(key) {
  return IMPORT_TYPES.find(t => t.key === key) || null
}

// Duplicate-detection key: a full-row match on purpose. Any differing column (e.g.
// the same beneficiary at two trainings, or two people sharing a name in a block)
// makes the rows distinct; only literal copies collide.
export function identityKeyFor(importTypeKey, row) {
  const type = getImportType(importTypeKey)
  if (!type) return null
  return type.columns.map(c => String(row[c.key] ?? '').trim().toLowerCase()).join('|')
}

const NUM_RE = /^-?\d+(\.\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Validates one client-mapped row against its import type. Never invents a value
// for a missing/ambiguous field — reports an error/warning instead.
export function validateRow(importTypeKey, row) {
  const type = getImportType(importTypeKey)
  if (!type) return { errors: [`Unknown import type "${importTypeKey}"`], warnings: [] }

  const errors = []
  const warnings = []

  for (const col of type.columns) {
    const raw = row[col.key]
    const isBlank = raw === undefined || raw === null || String(raw).trim() === ''

    if (col.required && isBlank) {
      errors.push(`${col.label} is required`)
      continue
    }
    if (isBlank) continue

    const value = String(raw).trim()
    if (col.type === 'number' && !NUM_RE.test(value)) {
      errors.push(`${col.label} must be a number (got "${value}")`)
    }
    if (col.type === 'date' && !DATE_RE.test(value)) {
      errors.push(`${col.label} must be a date in YYYY-MM-DD format (got "${value}")`)
    }
    if (col.type === 'select' && Array.isArray(col.options) && !col.options.includes(value)) {
      warnings.push(`${col.label} value "${value}" is not one of the expected values (${col.options.join(', ')}) — flagged, not auto-corrected`)
    }
  }

  return { errors, warnings }
}

// Builds a workbook (as a Buffer) for one import type: a "Template" sheet
// with headers + one sample row, and a "Field Guide" sheet documenting
// type/required-optional/validation notes/reference values.
export async function buildTemplateWorkbook(importTypeKey) {
  const type = getImportType(importTypeKey)
  if (!type) throw new Error(`Unknown import type "${importTypeKey}"`)

  const XLSX = await import('xlsx')
  const headers = type.columns.map(c => c.label)
  const sampleRow = type.columns.map(c => type.sampleRow?.[c.key] ?? '')

  const templateSheet = XLSX.utils.aoa_to_sheet([headers, sampleRow])

  const guideRows = [
    ['Field', 'Required?', 'Data Type', 'Validation Notes', 'Reference Values'],
    ...type.columns.map(c => [
      c.label,
      c.required ? 'Required' : 'Optional',
      c.type,
      c.notes || '',
      Array.isArray(c.options) ? c.options.join(', ') : '',
    ]),
  ]
  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, templateSheet, 'Template')
  XLSX.utils.book_append_sheet(wb, guideSheet, 'Field Guide')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}
