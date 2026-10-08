// lib/beneficiaryProfilePdf.js — A4 PDF of one beneficiary's full profile,
// mirroring BeneficiaryProfileDetail. `payload` is exactly what
// GET /api/beneficiary-profile/:uid returns.

import PDFDocument from 'pdfkit'

// ── Page geometry (A4 points) — identical to performanceReview/pdfBuilder.js ─
const PW  = 595.28
const PH  = 841.89
const M   = 50
const CW  = PW - M * 2 // 495.28
const BOT = PH - M - 20

// ── Brand palette ────────────────────────────────────────────────────────────
const PURPLE = '#341272'
const GPURPLE = '#C4B5FD'
const GRAY   = '#6B7280'
const LIGHT  = '#F3F4F6'
const ALT    = '#FAFAFA'
const BGRID  = '#E5E7EB'
const BLACK  = '#111827'

function _checkPage(doc, y, need = 30) {
  if (y + need > BOT) { doc.addPage(); return M }
  return y
}

function _h1(doc, text, y) {
  y = _checkPage(doc, y, 34)
  doc.font('Helvetica-Bold').fontSize(12).fillColor(PURPLE).text(text, M, y, { width: CW })
  y += 16
  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(GPURPLE).lineWidth(0.5).stroke()
  return y + 8
}

function _h2(doc, text, y) {
  y = _checkPage(doc, y, 24)
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PURPLE).text(text, M, y, { width: CW })
  return y + 16
}

function _para(doc, text, y) {
  const s = String(text ?? '').slice(0, 3000)
  const h = doc.font('Helvetica').fontSize(9).heightOfString(s, { width: CW }) + 4
  y = _checkPage(doc, y, h)
  doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(s, M, y, { width: CW })
  return y + h + 4
}

// headers: string[]; rows: (string | { v, bold? })[][]; colWidths must sum to CW
function _table(doc, headers, rows, colWidths, startY) {
  const PAD = 4
  let y = _checkPage(doc, startY, 22)

  function rowH(cells, bold) {
    let max = 18
    for (let i = 0; i < cells.length; i++) {
      const v = typeof cells[i] === 'object' && cells[i] !== null ? cells[i].v : String(cells[i] ?? '')
      const h = doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
                    .fontSize(8).heightOfString(String(v ?? ''), { width: colWidths[i] - PAD * 2 }) + PAD * 2
      if (h > max) max = h
    }
    return max
  }

  const hh = rowH(headers, true)
  y = _checkPage(doc, y, hh)
  doc.rect(M, y, CW, hh).fill(LIGHT)
  let x = M
  for (let i = 0; i < headers.length; i++) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PURPLE)
       .text(String(headers[i]), x + PAD, y + PAD, { width: colWidths[i] - PAD * 2, lineBreak: false, ellipsis: true })
    x += colWidths[i]
  }
  doc.rect(M, y, CW, hh).stroke(BGRID)
  y += hh

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    const rh = rowH(row, false)
    y = _checkPage(doc, y, rh)

    doc.rect(M, y, CW, rh).fill(r % 2 === 0 ? ALT : '#FFFFFF')

    x = M
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]
      const cellVal  = (typeof cell === 'object' && cell !== null) ? String(cell.v ?? '') : String(cell ?? '')
      const cellBold = (typeof cell === 'object' && cell !== null) ? !!cell.bold : false
      doc.font(cellBold ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(8).fillColor(BLACK)
         .text(cellVal, x + PAD, y + PAD, { width: colWidths[i] - PAD * 2 })
      x += colWidths[i]
    }
    doc.rect(M, y, CW, rh).stroke(BGRID)
    y += rh
  }

  return y + 10
}

// The footer sits inside the bottom margin, and pdfkit's .text() adds a new
// page for anything past page.maxY(); zero margins.bottom for the draw, then
// restore it. `watermark` is an optional second line recording who exported
// the PDF, when and why.
function _stampFooters(doc, label, watermark) {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    const savedBottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font('Helvetica').fontSize(7).fillColor(GRAY)
       .text(`${label} · Confidential`, M, PH - 28, { width: CW * 0.7, lineBreak: false })
       .text(`Page ${i + 1} of ${range.count}`, M, PH - 28, { width: CW, align: 'right', lineBreak: false })
    if (watermark) {
      doc.font('Helvetica').fontSize(7).fillColor(GRAY)
         .text(watermark, M, PH - 20, { width: CW, lineBreak: false })
    }
    doc.page.margins.bottom = savedBottomMargin
  }
}

// ── Field formatting — server-side copy of BeneficiaryProfilePage.tsx's
// humanizeKey/formatFieldValue. Uses "Rs." because Helvetica has no ₹ glyph.
const HIDDEN_FIELDS = new Set(['id', 'org_id'])
const CURRENCY_FIELDS = ['income_inr', 'revenue_inr', 'credit_access_inr', 'amount']
const DATE_FIELDS = ['created_at', '_date']

function _humanizeKey(key) {
  return key.replace(/_inr$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function _fmtDate(value) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function _fmtValue(key, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (CURRENCY_FIELDS.some(f => key.endsWith(f)) && typeof value === 'number') {
    return `Rs. ${Math.round(value).toLocaleString('en-IN')}`
  }
  if (DATE_FIELDS.some(f => key.endsWith(f)) && typeof value === 'string') return _fmtDate(value)
  if (key.endsWith('_ton') && typeof value === 'number') return `${value.toLocaleString('en-IN')} ton`
  return String(value)
}

// ── Header block (no cover page) ─────────────────────────────────────────────
function _header(doc, payload, orgName) {
  const displayName = payload.profile.name ?? payload.profile.collective_name ?? payload.uid
  let y = M
  doc.rect(M, y, CW, 4).fill(PURPLE)
  y += 16
  doc.font('Helvetica-Bold').fontSize(18).fillColor(PURPLE).text(String(displayName), M, y, { width: CW })
  y += 24
  doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(`${payload.uid} · ${payload.type}`, M, y, { width: CW })
  y += 16
  doc.font('Helvetica').fontSize(8).fillColor(GRAY)
     .text(`${orgName} · Beneficiary Profile · Generated ${new Date().toLocaleDateString('en-IN')}`, M, y, { width: CW })
  y += 16
  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(BGRID).lineWidth(1).stroke()
  return y + 14
}

function _sectionCompleteDetail(doc, payload, y) {
  y = _h1(doc, `Complete Detail (${payload.misRecordCount} intervention record${payload.misRecordCount === 1 ? '' : 's'})`, y)
  const entries = Object.entries(payload.profile).filter(([k]) => !HIDDEN_FIELDS.has(k))
  const rows = entries.map(([k, v]) => [_humanizeKey(k), _fmtValue(k, v)])
  return _table(doc, ['Field', 'Value'], rows, [160, 335.28], y)
}

function _sectionProjects(doc, projects, y) {
  y = _h1(doc, `Projects (${projects.length})`, y)
  if (!projects.length) return _para(doc, 'Not linked to any project yet.', y)
  return _para(doc, projects.map(p => p.name).join(', '), y)
}

function _resourceDetail(r) {
  if (r.resource_type === 'Freshwater Wetland') {
    return [r.water_body_type, r.resource_access].filter(Boolean).join(' · ') || '—'
  }
  if (r.resource_type === 'Coastal Wetland') {
    if (r.wetland_structure === 'Raft') return `Raft${r.raft_count != null ? ` (${r.raft_count})` : ''}`
    return r.wetland_structure || '—'
  }
  return r.area_acre != null ? `${r.area_acre} acre` : '—'
}

function _resourceUtility(entries) {
  if (!entries || !entries.length) return '—'
  return entries.map(e => `${e.utility}${e.production_kg != null ? `: ${e.production_kg} kg` : ''}`).join(', ')
}

function _sectionResources(doc, resources, y) {
  y = _h1(doc, `Resources (${resources.length})`, y)
  if (!resources.length) return _para(doc, 'No resources registered for this beneficiary.', y)
  const rows = resources.map(r => [
    r.resource_type, _resourceDetail(r), _resourceUtility(r.resource_utility), _fmtDate(r.created_at),
  ])
  return _table(doc, ['Type', 'Detail', 'Utility', 'Date'], rows, [120, 150, 145.28, 80], y)
}

// One entry per MIS category; columns mirror MisTable in BeneficiaryProfilePage.tsx.
const MIS_SECTIONS = [
  {
    key: 'training', title: 'Training', primaryLabel: 'Topic',
    primaryOf: r => r.training_topic, dateOf: r => r.training_date, placeOf: r => r.place,
  },
  {
    key: 'inputDistribution', title: 'Input Distribution', primaryLabel: 'Input Distributed',
    primaryOf: r => r.quantity != null ? `${r.input_distributed} — ${Number(r.quantity)}${r.unit ? ' ' + r.unit : ''}` : r.input_distributed, dateOf: r => r.distribution_date, placeOf: r => r.place,
  },
  {
    key: 'schemeAccess', title: 'Scheme Access', primaryLabel: 'Scheme',
    primaryOf: r => r.scheme_name, dateOf: r => r.access_date, placeOf: r => r.place,
  },
  {
    key: 'creditGrantAccess', title: 'Credit/Grant Access', primaryLabel: 'Source',
    primaryOf: r => r.credit_grant_source, dateOf: r => r.access_date, placeOf: r => r.place,
    extra: { label: 'Amount', of: r => r.amount != null ? `Rs. ${Math.round(r.amount).toLocaleString('en-IN')}` : '—' },
  },
  {
    key: 'businessDevelopmentSupport', title: 'Business Development Support', primaryLabel: 'Support Provided',
    primaryOf: r => r.support_provided, dateOf: r => r.support_date, placeOf: r => r.place,
  },
  {
    key: 'complianceSupport', title: 'Compliance Support', primaryLabel: 'Support Provided',
    primaryOf: r => r.compliance_support_provided, dateOf: r => r.support_date, placeOf: r => r.place,
  },
  {
    key: 'exposureVisit', title: 'Exposure Visit', primaryLabel: 'Purpose',
    primaryOf: r => r.purpose, dateOf: r => r.visit_date, placeOf: r => r.visit_place,
  },
]

function _misTable(doc, section, rows, y) {
  y = _h2(doc, `${section.title} (${rows.length})`, y)
  if (!rows.length) return _para(doc, `No ${section.title.toLowerCase()} records for this beneficiary.`, y)

  const headers = [section.primaryLabel]
  const colWidths = section.extra ? [125, 90, 80, 100, 100.28] : [155, 90, 125, 125.28]
  if (section.extra) headers.push(section.extra.label)
  headers.push('Date', 'Place', 'Project')

  const tableRows = rows.map(r => {
    const row = [section.primaryOf(r) || '—']
    if (section.extra) row.push(section.extra.of(r))
    row.push(r.dateVal ?? (section.dateOf(r) ? _fmtDate(section.dateOf(r)) : '—'))
    row.push(section.placeOf(r) || '—')
    row.push(r.project_name || '—')
    return row
  })
  return _table(doc, headers, tableRows, colWidths, y)
}

function _sectionIntervention(doc, mis, y) {
  y = _h1(doc, 'Intervention Recorded Data', y)
  for (const section of MIS_SECTIONS) {
    y = _misTable(doc, section, mis[section.key] || [], y)
  }
  return y
}

/**
 * @param {object} payload  — GET /api/beneficiary-profile/:uid response shape
 * @param {string} [orgName]
 * @param {object} [exportMeta]  — { exportedByName, purpose } for the footer watermark
 * @returns {Promise<Buffer>}
 */
export async function buildBeneficiaryProfilePdf(payload, orgName, exportMeta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: true, bufferPages: true })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const displayName = payload.profile.name ?? payload.profile.collective_name ?? payload.uid
    const label = orgName ? `${orgName} · ${displayName}` : String(displayName)
    const watermark = exportMeta
      ? `Exported by ${exportMeta.exportedByName || 'unknown user'} on ${new Date().toLocaleString('en-IN')} · Purpose: ${exportMeta.purpose || 'unspecified'}`
      : null

    let y = _header(doc, payload, orgName || 'FieldFlow')
    y = _sectionCompleteDetail(doc, payload, y)
    y = _sectionProjects(doc, payload.projects, y)
    y = _sectionResources(doc, payload.resources, y)
    _sectionIntervention(doc, payload.mis, y)

    _stampFooters(doc, label, watermark)
    doc.end()
  })
}
