// DOCX export for performance reviews (14 sections) using the `docx` package.
// buildReviewDocx(payload) → Promise<Buffer>

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ShadingType,
} from 'docx'

const PURPLE = '341272'
const GRAY = '6B7280'
const LIGHT = 'F3F4F6'

function H1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, color: PURPLE, size: 28 })],
  })
}
function H2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, color: PURPLE, size: 22 })],
  })
}
function P(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: text ?? '', ...opts })],
  })
}
function B(text) { return new TextRun({ text: text ?? '', bold: true }) }
function T(text) { return new TextRun({ text: text ?? '' }) }

const NO_BORDER = {
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
}

function cell(text, opts = {}) {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.header ? { type: ShadingType.CLEAR, color: 'auto', fill: LIGHT } : undefined,
    children: [
      new Paragraph({
        alignment: opts.align || AlignmentType.LEFT,
        children: [new TextRun({ text: String(text ?? ''), bold: !!opts.header, size: 18 })],
      }),
    ],
  })
}

function headerRow(...labels) {
  return new TableRow({
    tableHeader: true,
    children: labels.map(l => cell(l, { header: true })),
  })
}

function table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  })
}

// ── Section builders ────────────────────────────────────────────────────────

function sectionActivityOverview(p) {
  const ws = p.worker_stats
  if (!ws) return []
  const q = ws.quality || {}
  const qualityRows = [
    ['Description Quality', `${q.description ?? 0}%`],
    ['Beneficiary Data',    `${q.beneficiaries ?? 0}%`],
    ['Photo Attached',      `${q.photo ?? 0}%`],
    ['Location Tagged',     `${q.location ?? 0}%`],
    ['Overall Quality',     `${q.overall ?? 0}%`],
  ]
  return [
    H1('2. Activity Overview'),
    table([
      headerRow('Metric', 'Value'),
      new TableRow({ children: [cell('Total Reports'),    cell(String(ws.reportCount ?? 0))] }),
      new TableRow({ children: [cell('Last 30 Days'),     cell(String(ws.recentCount ?? 0))] }),
      new TableRow({ children: [cell('Beneficiaries'),    cell(String(ws.totalBenef ?? 0))] }),
    ]),
    P(' '),
    H2('Report Quality'),
    table([
      headerRow('Quality Metric', 'Percentage'),
      ...qualityRows.map(([label, val]) => new TableRow({ children: [cell(label), cell(val)] })),
    ]),
  ]
}

function sectionAreaBreakdown(p) {
  const ws = p.worker_stats
  if (!ws || !ws.areaBreakdown?.length) return []
  const totalReports = ws.areaBreakdown.reduce((s, r) => s + r.reports, 0)
  const totalBenef   = ws.areaBreakdown.reduce((s, r) => s + r.benef,   0)
  return [
    H1('3. Area Breakdown'),
    table([
      headerRow('Area', 'Reports', 'Beneficiaries', 'Photos %', 'Located %'),
      ...ws.areaBreakdown.map(r => new TableRow({ children: [
        cell(r.area),
        cell(String(r.reports)),
        cell(String(r.benef)),
        cell(`${r.photosPct ?? 0}%`),
        cell(`${r.locatedPct ?? 0}%`),
      ] })),
      new TableRow({ children: [
        cell('Total', { header: true }),
        cell(String(totalReports), { header: true }),
        cell(String(totalBenef),   { header: true }),
        cell(''),
        cell(''),
      ] }),
    ]),
  ]
}

function sectionAiAnalysis(p) {
  if (!p.ai_analysis) return []
  const lines = String(p.ai_analysis).split('\n').filter(l => l.trim())
  return [
    H1('4. AI Analysis'),
    ...lines.map(line => P(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''))),
  ]
}

function sectionEmployee(p) {
  const e = p.employee || {}
  const period = p.period || {}
  return [
    H1('1. Employee Details'),
    table([
      headerRow('Field', 'Details'),
      new TableRow({ children: [cell('Employee Name'), cell(e.name)] }),
      new TableRow({ children: [cell('Designation'), cell(e.designation)] }),
      new TableRow({ children: [cell('Department'), cell(e.department)] }),
      new TableRow({ children: [cell('Review Period'), cell(`${period.label} (${period.start} → ${period.end})`)] }),
      new TableRow({ children: [cell('Reporting Manager'), cell(e.manager_name || '—')] }),
      new TableRow({ children: [cell('Review Date'), cell(new Date().toLocaleDateString('en-IN'))] }),
    ]),
  ]
}

function sectionScoringModel() {
  return [
    H1('5. AI Scoring Model'),
    P('The AI analysis is based on 4 main factors:'),
    table([
      headerRow('Category', 'Weightage'),
      new TableRow({ children: [cell('Performance KPIs'), cell('40%')] }),
      new TableRow({ children: [cell('Activity Completion'), cell('30%')] }),
      new TableRow({ children: [cell('Key Learning & Development'), cell('20%')] }),
      new TableRow({ children: [cell('Discipline / Behaviour / Consistency'), cell('10%')] }),
    ]),
    P(' '),
    new Paragraph({
      children: [B('Final AI Score = ')],
    }),
    P('(Performance Score × 40%) + (Activity Score × 30%) + (Learning Score × 20%) + (Discipline Score × 10%)'),
  ]
}

function sectionSummary(p) {
  const w = p.weighted || {}
  return [
    H1('6. Overall AI Score Summary'),
    table([
      headerRow('Category', 'Score %', 'Weight', 'Weighted'),
      new TableRow({ children: [
        cell('Performance KPIs'),     cell(`${w.kpi_score}%`),       cell('40%'), cell((w.kpi_score * 0.4).toFixed(1)),
      ] }),
      new TableRow({ children: [
        cell('Activity Completion'),  cell(`${w.activity_score}%`),  cell('30%'), cell((w.activity_score * 0.3).toFixed(1)),
      ] }),
      new TableRow({ children: [
        cell('Key Learning'),         cell(`${w.learning_score}%`),  cell('20%'), cell((w.learning_score * 0.2).toFixed(1)),
      ] }),
      new TableRow({ children: [
        cell('Discipline'),           cell(`${w.discipline_score}%`),cell('10%'), cell((w.discipline_score * 0.1).toFixed(1)),
      ] }),
      new TableRow({ children: [
        cell('Final AI Score', { header: true }),
        cell(''),
        cell(''),
        cell(`${w.final} / 100`, { header: true }),
      ] }),
    ]),
    P(' '),
    new Paragraph({ children: [B('Final Rating: '), T(w.rating || '—')] }),
    new Paragraph({ children: [B('AI Recommendation: '), T(p.recommendation || '—')] }),
  ]
}

function sectionKpis(p) {
  return [
    H1('7. Performance KPI Review'),
    table([
      headerRow('Performance Area', 'Score / 5', 'AI Observation'),
      ...(p.kpis || []).map(k => new TableRow({ children: [
        cell(k.area), cell(k.score?.toFixed?.(1) || k.score), cell(k.observation),
      ] })),
    ]),
  ]
}

function sectionActivities(p) {
  return [
    H1('8. Activity-Based Review'),
    table([
      headerRow('Activity', 'Target', 'Completed', 'Completion %', 'Quality / 5', 'AI Remark'),
      ...(p.activities || []).map(a => new TableRow({ children: [
        cell(a.name), cell(a.target), cell(a.completed), cell(`${a.completion_pct}%`),
        cell(a.quality?.toFixed?.(1) || a.quality), cell(a.remark),
      ] })),
    ]),
  ]
}

function sectionLearning(p) {
  const blocks = [
    H1('9. Key Learning Review'),
    table([
      headerRow('Learning Area', 'Score / 5', 'AI Analysis'),
      ...(p.learning || []).map(l => new TableRow({ children: [
        cell(l.area), cell(l.score?.toFixed?.(1) || l.score), cell(l.observation),
      ] })),
    ]),
  ]
  if (p.learning_insight) {
    blocks.push(new Paragraph({ children: [B('AI Learning Insight: '), T(p.learning_insight)] }))
  }
  return blocks
}

function sectionTrend(p) {
  return [
    H1('10. Monthly Performance Trend'),
    table([
      headerRow('Month', 'Performance %'),
      ...(p.trend || []).map(t => new TableRow({ children: [
        cell(t.month), cell(`${t.score}%`),
      ] })),
    ]),
  ]
}

function sectionAnalysis(p) {
  const blocks = [
    H1('11. AI-Generated Performance Analysis'),
    H2('Overall Analysis'),
    P(p.overall_analysis || `Final score ${p.weighted?.final} places this employee in the ${p.weighted?.rating} band.`),
    H2('Strength Areas'),
    table([
      headerRow('Strength Area', 'Reason'),
      ...(p.strengths || []).map(s => new TableRow({ children: [
        cell(s.area), cell(s.reason),
      ] })),
    ]),
    P(' '),
    H2('Improvement Areas'),
    table([
      headerRow('Improvement Area', 'AI Reason'),
      ...(p.improvements || []).map(s => new TableRow({ children: [
        cell(s.area), cell(s.reason),
      ] })),
    ]),
  ]
  return blocks
}

function sectionRisk(p) {
  const r = p.risk || {}
  const n = p.risk_notes || {}
  const rows = [
    ['Performance Risk',    r.performance,   n.performance],
    ['Growth Potential',    r.growth,        n.growth],
    ['Promotion Readiness', r.promotion,     n.promotion],
    ['Training Need',       r.training_need, n.training_need],
    ['Retention Value',     r.retention,     n.retention],
  ]
  return [
    H1('12. AI Risk & Potential Analysis'),
    table([
      headerRow('Parameter', 'Status', 'AI Interpretation'),
      ...rows.map(([p, s, note]) => new TableRow({ children: [cell(p), cell(s), cell(note)] })),
    ]),
  ]
}

function sectionRecommendation(p) {
  return [
    H1('13. Final AI Recommendation'),
    H2('Recommendation'),
    P(p.recommendation),
    H2('Suggested Action Plan'),
    table([
      headerRow('Action', 'Timeline', 'Expected Result'),
      ...(p.action_plan || []).map(a => new TableRow({ children: [
        cell(a.action), cell(`${a.timeline_days} days`), cell(a.expected_result),
      ] })),
    ]),
  ]
}

function sectionRatingScale(p) {
  const w = p.weighted || {}
  const rows = [
    ['90–100',   'Excellent',         'Promotion / high increment'],
    ['80–89',    'Good',              'Continue / increment recommended'],
    ['70–79',    'Satisfactory',      'Training required'],
    ['60–69',    'Needs Improvement', 'Improvement plan required'],
    ['Below 60', 'Poor',              'Performance improvement plan'],
  ]
  return [
    H1('14. Final Rating Scale'),
    table([
      headerRow('Score', 'Rating', 'Decision'),
      ...rows.map(([s, r, d]) => new TableRow({ children: [cell(s), cell(r), cell(d)] })),
    ]),
    P(' '),
    new Paragraph({ children: [B('Current Employee Final Score: '), T(`${w.final} / 100`)] }),
    new Paragraph({ children: [B('Final Rating: '), T(w.rating || '—')] }),
    new Paragraph({ children: [B('Final Decision: '), T(p.final_decision || '—')] }),
  ]
}

// ── Public ──────────────────────────────────────────────────────────────────

/** Build the review .docx from the payload (ai_draft merged with final_scores). */
export async function buildReviewDocx(payload) {
  const doc = new Document({
    creator: 'FieldFlow',
    title:   `${payload?.employee?.name || 'Employee'} — Performance Review`,
    sections: [{
      properties: {},
      children: [
        // Cover header
        new Paragraph({
          spacing: { after: 200 },
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'AI-Based Employee Performance Analysis', bold: true, size: 36, color: PURPLE })],
        }),
        new Paragraph({
          spacing: { after: 400 },
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'FieldFlow', color: GRAY })],
        }),
        ...sectionEmployee(payload),
        ...sectionActivityOverview(payload),
        ...sectionAreaBreakdown(payload),
        ...sectionAiAnalysis(payload),
        ...sectionScoringModel(),
        ...sectionSummary(payload),
        ...sectionKpis(payload),
        ...sectionActivities(payload),
        ...sectionLearning(payload),
        ...sectionTrend(payload),
        ...sectionAnalysis(payload),
        ...sectionRisk(payload),
        ...sectionRecommendation(payload),
        ...sectionRatingScale(payload),
        // Footer-ish closing
        P(' '),
        new Paragraph({
          spacing: { before: 400 },
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({
            text: `Generated by FieldFlow · ${new Date().toISOString().slice(0, 10)}`,
            color: GRAY,
            italics: true,
            size: 16,
          })],
        }),
      ],
    }],
  })

  return await Packer.toBuffer(doc)
}
