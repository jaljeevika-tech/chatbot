// Maps a saved report's claims (numbers ±10%, capitalised entities ≥ 5 chars, sums)
// back to the daily_reports rows behind them, stored in saved_reports.lineage so
// LineagePanel can answer "where did this number come from?" without the LLM.

const NUMBER_RE = /\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(lakh|lac|thousand|k)?\b/gi
const ENTITY_RE = /\b([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]+){0,2})\b/g

const NUMERIC_FIELDS = ['beneficiaries', 'planned', 'achieved']
const ENTITY_FIELDS  = ['location', 'project', 'worker_name', 'state', 'name']

function _parseNum(numStr, unit) {
  let val = parseFloat(String(numStr).replace(/,/g, ''))
  if (!Number.isFinite(val)) return null
  const u = (unit || '').toLowerCase()
  if (u === 'lakh' || u === 'lac') val *= 100000
  else if (u === 'thousand' || u === 'k') val *= 1000
  return val
}

function _extractNumbersWithContext(text) {
  const out = []
  let m
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags)
  while ((m = re.exec(text)) !== null) {
    const v = _parseNum(m[1], m[2])
    if (v == null || v < 10) continue
    if (v >= 1900 && v <= 2100) continue // skip years
    const start = Math.max(0, m.index - 30)
    const end   = Math.min(text.length, m.index + m[0].length + 30)
    out.push({ value: v, context: text.slice(start, end).replace(/\s+/g, ' ').trim() })
  }
  // Deduplicate by value (keep first context)
  const seen = new Map()
  for (const o of out) {
    if (!seen.has(o.value)) seen.set(o.value, o)
  }
  return [...seen.values()]
}

function _extractEntities(text) {
  const out = new Set()
  let m
  const re = new RegExp(ENTITY_RE.source, ENTITY_RE.flags)
  while ((m = re.exec(text)) !== null) out.add(m[1])
  // Filter out clearly-common words that happen to start sentences
  const ignore = new Set([
    'This', 'That', 'These', 'Those', 'Their', 'There', 'Field', 'Report',
    'India', 'Quarter', 'Total', 'During', 'Following', 'While', 'After',
    'Before', 'Other', 'Additional', 'Each', 'However', 'Furthermore',
  ])
  return [...out].filter(n => !ignore.has(n) && n.length >= 5)
}

/** Build a lineage index for a report against its sources → { numbers, entities, source_count }. */
export function buildLineage(content, sources) {
  if (!content || !Array.isArray(sources) || sources.length === 0) {
    return { numbers: [], entities: [], source_count: 0 }
  }

  const numberClaims = _extractNumbersWithContext(content)
  const entities = _extractEntities(content)

  // Number → source rows whose numeric field matches within 10%
  const numbers = numberClaims.map(claim => {
    const matches = []
    let runningSum = 0
    const sumContributors = []
    for (const r of sources) {
      const rid = r.id || r.uuid || null
      if (!rid) continue
      for (const f of NUMERIC_FIELDS) {
        const v = Number(r[f])
        if (!Number.isFinite(v) || v <= 0) continue
        // Direct match (±10%)
        if (Math.abs(v - claim.value) / Math.max(v, claim.value) <= 0.10) {
          matches.push({ source_id: rid, field: f, value: v, kind: 'direct' })
        } else {
          // Aggregate hypothesis: this row may contribute to a sum
          runningSum += v
          sumContributors.push({ source_id: rid, field: f, value: v })
        }
      }
    }
    // If running sum lands within ±5% of claim, attribute the whole set
    if (matches.length === 0 && runningSum > 0 &&
        Math.abs(runningSum - claim.value) / Math.max(runningSum, claim.value) <= 0.05) {
      for (const c of sumContributors) matches.push({ ...c, kind: 'aggregate' })
    }
    return {
      value: claim.value,
      context: claim.context,
      source_ids: matches.map(m => m.source_id),
      details: matches.slice(0, 50),
    }
  }).filter(n => n.source_ids.length > 0)

  // Entity → source rows mentioning that entity
  const entityIndex = entities.map(ent => {
    const lc = ent.toLowerCase()
    const ids = []
    for (const r of sources) {
      const rid = r.id || r.uuid || null
      if (!rid) continue
      for (const f of ENTITY_FIELDS) {
        const v = r[f]
        if (typeof v === 'string' && v.toLowerCase().includes(lc)) {
          ids.push(rid)
          break
        }
      }
    }
    return { name: ent, source_ids: [...new Set(ids)] }
  }).filter(e => e.source_ids.length > 0)

  return {
    numbers,
    entities: entityIndex,
    source_count: sources.length,
  }
}

/** Source row IDs for one claim (e.g. "240" or "Khagaria") in a saved_reports.lineage value. */
export function resolveClaim(lineage, claim) {
  if (!lineage || !claim) return []
  const trimmed = String(claim).trim()
  // Numeric claim?
  const numMatch = trimmed.match(/^-?\d+(?:\.\d+)?/)
  if (numMatch) {
    const num = parseFloat(numMatch[0])
    for (const entry of (lineage.numbers || [])) {
      if (Math.abs(entry.value - num) / Math.max(entry.value, num) <= 0.10) {
        return entry.source_ids
      }
    }
    return []
  }
  // Entity claim — case-insensitive substring
  const lc = trimmed.toLowerCase()
  for (const e of (lineage.entities || [])) {
    if (e.name.toLowerCase() === lc || e.name.toLowerCase().includes(lc) || lc.includes(e.name.toLowerCase())) {
      return e.source_ids
    }
  }
  return []
}
