// Deterministic field-report analytics (totals, trends, top performers, geography,
// barriers, outliers). Output is a superset of nlp.js analyzeFieldData so they're swappable.

import { getPool } from '../../../db/pool.js'

// Barrier terms (shared with memoryExtractor.js)
const BARRIER_TERMS = [
  'no water','water shortage','drought','flood','waterlogging',
  'no access','road blocked','connectivity','remote',
  'conflict','dispute','resistance',
  'migration','migrated',
  'no funds','funding','budget',
  'delay','delayed','pending',
  'absent','refused','unwilling',
  'problem','issue','challenge','difficult','barrier',
  'no response','blocked','incomplete',
  'disease','illness','sick','unwell','health',
  'low attendance','not attended',
  'awareness','illiterate','education',
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function _num(val) { return parseInt(String(val ?? 0)) || 0 }

function _groupBy(rows, key) {
  const map = new Map()
  for (const r of rows) {
    const k = String(r[key] || '').trim() || '(unknown)'
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

function _topN(map, n = 5) {
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, n)
}

function _uniq(arr) { return [...new Set(arr.filter(Boolean))] }

function _sumBenef(rows) {
  return rows.reduce((s, r) => s + _num(r.beneficiaries ?? r.beneficiary_count), 0)
}

function _monthKey(r) {
  const d = new Date(r.timestamp || r.created_at || 0)
  return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
}

// ── Outlier detection (1.5 × IQR) ────────────────────────────────────────────
function _detectOutliers(values) {
  if (values.length < 4) return []
  const sorted  = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1
  const lo  = q1 - 1.5 * iqr
  const hi  = q3 + 1.5 * iqr
  return values.filter(v => v < lo || v > hi)
}

// ── Month-over-month trend ────────────────────────────────────────────────────
function _trend(rows) {
  const byMonth = new Map()
  for (const r of rows) {
    const mk = _monthKey(r)
    if (!mk) continue
    if (!byMonth.has(mk)) byMonth.set(mk, { count: 0, beneficiaries: 0 })
    const m = byMonth.get(mk)
    m.count++
    m.beneficiaries += _num(r.beneficiaries ?? r.beneficiary_count)
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (months.length < 2) return null

  const last    = months[months.length - 1][1]
  const prev    = months[months.length - 2][1]
  const pctReports = prev.count > 0
    ? Math.round((last.count - prev.count) / prev.count * 100) : null
  const pctBenef = prev.beneficiaries > 0
    ? Math.round((last.beneficiaries - prev.beneficiaries) / prev.beneficiaries * 100) : null

  return {
    recentMonth:     months[months.length - 1][0],
    reportsDelta:    pctReports,
    beneficiariesDelta: pctBenef,
    direction:       pctReports === null ? 'stable'
                     : pctReports > 5 ? 'up' : pctReports < -5 ? 'down' : 'stable',
    monthlyData:     months.map(([month, data]) => ({ month, ...data })),
  }
}

// ── Barrier detection ─────────────────────────────────────────────────────────
function _detectBarriers(rows) {
  const counts = new Map()
  const examples = new Map()
  for (const r of rows) {
    if (!r.description) continue
    const d = r.description.toLowerCase()
    for (const term of BARRIER_TERMS) {
      if (d.includes(term)) {
        counts.set(term, (counts.get(term) || 0) + 1)
        if (!examples.has(term)) examples.set(term, String(r.description).slice(0, 100))
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term, count]) => ({ term, count, example: examples.get(term) || '' }))
}

// ── Main analyzer ─────────────────────────────────────────────────────────────
/** Analyze a batch of field reports deterministically (partial match to analyzeFieldData's output). */
export async function analyze(reports, instruction = '', orgId = null) {
  if (!reports?.length) return {}

  const total = reports.length
  const totalBenef = _sumBenef(reports)
  const avgBenef   = total > 0 ? Math.round(totalBenef / total) : 0

  // ── Worker breakdown ─────────────────────────────────────────────────────
  const byWorker   = _groupBy(reports, 'worker_name')
  const topWorkers = _topN(byWorker, 5).map(([name, rows]) => ({
    name,
    reports:       rows.length,
    beneficiaries: _sumBenef(rows),
    projects:      _uniq(rows.map(r => r.project)).slice(0, 4),
    states:        _uniq(rows.map(r => r.state)).slice(0, 3),
  }))

  // ── Project breakdown ────────────────────────────────────────────────────
  const byProject   = _groupBy(reports, 'project')
  const topProjects = _topN(byProject, 5).map(([proj, rows]) => ({
    project:       proj,
    reports:       rows.length,
    beneficiaries: _sumBenef(rows),
    workers:       _uniq(rows.map(r => r.worker_name)).length,
    states:        _uniq(rows.map(r => r.state)).slice(0, 5),
  }))

  // ── Geographic breakdown ─────────────────────────────────────────────────
  const byState   = _groupBy(reports, 'state')
  const topStates = _topN(byState, 6).map(([state, rows]) => ({
    state, reports: rows.length, beneficiaries: _sumBenef(rows),
  }))

  const byLocation   = _groupBy(reports, 'location')
  const topLocations = _topN(byLocation, 8).map(([loc, rows]) => ({
    location: loc, reports: rows.length,
  }))

  const geographicHighlight = (() => {
    if (!topStates.length) return 'No geographic data available.'
    const stateList = topStates.slice(0, 3).map(s =>
      `${s.state} (${s.reports} reports, ${s.beneficiaries.toLocaleString()} beneficiaries)`
    ).join(', ')
    return `Work spans ${topStates.length} states; top: ${stateList}.`
  })()

  // ── Areas of intervention ────────────────────────────────────────────────
  const byArea   = _groupBy(reports, 'area')
  const topAreas = _topN(byArea, 5).map(([area, rows]) => ({
    area, reports: rows.length, beneficiaries: _sumBenef(rows),
  }))

  // ── Trends ───────────────────────────────────────────────────────────────
  const trend = _trend(reports)

  // ── Outliers ─────────────────────────────────────────────────────────────
  const benefValues = reports.map(r => _num(r.beneficiaries ?? r.beneficiary_count)).filter(v => v > 0)
  const outlierValues = _detectOutliers(benefValues)
  const outlierReports = outlierValues.length
    ? reports.filter(r => outlierValues.includes(_num(r.beneficiaries ?? r.beneficiary_count)))
    : []

  // ── Barriers ─────────────────────────────────────────────────────────────
  const barriers = _detectBarriers(reports)

  // ── Data quality ─────────────────────────────────────────────────────────
  const missingLocation    = reports.filter(r => !r.location && !r.state).length
  const missingBenef       = reports.filter(r => !_num(r.beneficiaries ?? r.beneficiary_count)).length
  const missingDescription = reports.filter(r => !r.description?.trim()).length

  // ── Key patterns (computable, no model needed) ────────────────────────────
  const patterns = []
  if (trend?.direction === 'up' && trend.reportsDelta > 10)
    patterns.push(`Report volume increased ${trend.reportsDelta}% month-over-month.`)
  if (trend?.direction === 'down' && trend.reportsDelta < -10)
    patterns.push(`Report volume declined ${Math.abs(trend.reportsDelta)}% month-over-month.`)
  if (topWorkers[0]) {
    const tw = topWorkers[0]
    patterns.push(`${tw.name} is the most active worker with ${tw.reports} reports and ${tw.beneficiaries.toLocaleString()} beneficiaries reached.`)
  }
  if (topProjects[0]) {
    const tp = topProjects[0]
    patterns.push(`"${tp.project}" leads with ${tp.reports} reports across ${tp.workers} workers.`)
  }
  if (barriers.length) {
    patterns.push(`Top challenge reported: "${barriers[0].term}" (${barriers[0].count} mentions).`)
  }
  if (missingLocation > total * 0.2)
    patterns.push(`${Math.round(missingLocation/total*100)}% of reports are missing location data.`)

  // ── Standout numbers ─────────────────────────────────────────────────────
  const standout = [
    { stat: `${totalBenef.toLocaleString()} total beneficiaries`, context: `across ${total} field reports` },
    { stat: `${topWorkers.length} active workers`, context: `submitting reports in this period` },
    { stat: `${topProjects.length} active projects`, context: `tracked across ${topStates.length} states` },
  ]
  if (outlierReports.length) {
    const top = outlierReports.sort((a, b) =>
      _num(b.beneficiaries ?? b.beneficiary_count) - _num(a.beneficiaries ?? a.beneficiary_count))[0]
    standout.push({
      stat: `${_num(top.beneficiaries ?? top.beneficiary_count).toLocaleString()} beneficiaries in one report`,
      context: `by ${top.worker_name || 'a worker'} in ${top.location || top.state || 'the field'}`,
    })
  }

  return {
    // Partial match to analyzeFieldData output — model can enrich top_stories + emotional_core
    key_patterns:          patterns,
    standout_numbers:      standout,
    geographic_highlights: geographicHighlight,

    // Extended analytics beyond analyzeFieldData, used by admin/reports
    totals:        { reports: total, beneficiaries: totalBenef, avgBenefPerReport: avgBenef },
    topWorkers,
    topProjects,
    topStates,
    topLocations,
    topAreas,
    barriers,
    trend,
    dataQuality: { missingLocation, missingBenef, missingDescription, total },
    outlierReports: outlierReports.slice(0, 3),
  }
}

// ── Quick stats (lightweight, no caching needed) ───────────────────────────────
/** Summary stats for one worker's reports (admin worker analytics panel). */
export function workerStats(reports) {
  if (!reports?.length) return { reports: 0, beneficiaries: 0, projects: [], states: [], areas: [] }
  return {
    reports:       reports.length,
    beneficiaries: _sumBenef(reports),
    projects:      _uniq(reports.map(r => r.project)).filter(Boolean),
    states:        _uniq(reports.map(r => r.state)).filter(Boolean),
    areas:         _uniq(reports.map(r => r.area)).filter(Boolean),
    barriers:      _detectBarriers(reports).slice(0, 3),
  }
}
