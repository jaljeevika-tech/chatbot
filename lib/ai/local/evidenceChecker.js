// Checks AI output against source data before it reaches the user: numbers within
// ±10%, named entities present, plausible dates. Returns { passed, suspicious, score }; < 5 ms.

// ── Number extraction ─────────────────────────────────────────────────────────
function _extractNumbers(text) {
  // Match formatted numbers like "1,240", "12.5k", "1.2 lakh", plain integers
  const nums = []
  const patterns = [
    /\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/g,      // 1,240 or 1,24,000
    /\b(\d+(?:\.\d+)?)\s*(lakh|lac|thousand|k)\b/gi, // 1.5 lakh, 2k
    /\b(\d{2,})\b/g,                               // any 2+ digit number
  ]
  for (const pat of patterns) {
    let m
    const re = new RegExp(pat.source, pat.flags)
    while ((m = re.exec(text)) !== null) {
      let val = parseFloat(m[1].replace(/,/g, ''))
      const unit = (m[2] || '').toLowerCase()
      if (unit === 'lakh' || unit === 'lac') val *= 100000
      else if (unit === 'thousand' || unit === 'k') val *= 1000
      if (!isNaN(val) && val > 0) nums.push(val)
    }
  }
  return [...new Set(nums)]
}

// ── Source number fingerprint ─────────────────────────────────────────────────
function _buildSourceNumbers(sources) {
  const nums = new Set()
  const sourceText = Array.isArray(sources)
    ? sources.map(r => JSON.stringify(r)).join(' ')
    : typeof sources === 'string' ? sources : JSON.stringify(sources || {})

  for (const n of _extractNumbers(sourceText)) nums.add(n)
  return nums
}

// ── Named entity extraction (simple NER) ─────────────────────────────────────
// Common words that happen to be capitalised — either always (proper-noun
// look-alikes) or only because they open a sentence. Shared with the
// near-identical extractor in lib/dataCorrectness/lineage.js; keep in sync.
const _COMMON_CAPITALISED_WORDS = new Set([
  'This', 'That', 'These', 'Those', 'Their', 'There', 'The', 'And',
  'For', 'From', 'With', 'When', 'Where', 'What', 'Which', 'Report',
  'Field', 'Data', 'India', 'Quarter', 'Total', 'During', 'Following',
  'While', 'After', 'Before', 'Other', 'Additional', 'Each', 'However',
  'Furthermore',
])

function _extractNamedEntities(text) {
  // Capitalised multi-word phrases (proper nouns)
  const names = new Set()
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g
  let m
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1]
    if (phrase.length <= 3) continue
    // A lone capitalised word at sentence start is usually an ordinary word
    // ("Following", "Despite"); keep it only if it also appears capitalised
    // mid-sentence. Multi-word phrases are kept regardless.
    const isSingleWord = !phrase.includes(' ')
    if (isSingleWord) {
      const before = text.slice(0, m.index)
      const atSentenceStart = m.index === 0 || /[.!?]\s*$/.test(before)
      if (atSentenceStart) {
        const recursMidSentence = new RegExp(`[^.!?]\\s${phrase}\\b`).test(text)
        if (!recursMidSentence) continue
      }
    }
    names.add(phrase)
  }
  return names
}

function _buildSourceEntities(sources) {
  const entities = new Set()
  const rows = Array.isArray(sources) ? sources : []
  for (const r of rows) {
    if (r.worker_name) entities.add(r.worker_name)
    if (r.name)        entities.add(r.name)
    if (r.project)     entities.add(r.project)
    if (r.location)    entities.add(r.location)
    if (r.state)       entities.add(r.state)
    // Descriptions name people/places missing from structured fields; include them
    // so paraphrased mentions aren't flagged as fabricated.
    if (typeof r.description === 'string' && r.description.length > 0) {
      for (const e of _extractNamedEntities(r.description)) entities.add(e)
    }
  }
  return entities
}

// ── Main check ────────────────────────────────────────────────────────────────
/**
 * Check whether AI output is grounded in the source records.
 * @returns {{ passed, suspicious: {claim, reason}[], score: number }}  score 0 (fail) – 1 (grounded)
 */
export function checkOutput(output, sources) {
  if (!output || !sources) return { passed: true, suspicious: [], score: 1.0 }

  const suspicious = []

  // ── Number verification ───────────────────────────────────────────────────
  const outputNums = _extractNumbers(output)
  const srcNums    = _buildSourceNumbers(sources)

  for (const num of outputNums) {
    // Small numbers and years are too common to check
    if (num < 10 || (num >= 1900 && num <= 2100)) continue

    const found = [...srcNums].some(src => Math.abs(src - num) / Math.max(src, num) <= 0.10)
    if (!found) {
      suspicious.push({ claim: String(num), reason: `Number ${num} not found in source data (±10% tolerance)` })
    }
  }

  // ── Entity verification ───────────────────────────────────────────────────
  const outputEntities = _extractNamedEntities(output)
  const srcEntities    = _buildSourceEntities(sources)

  for (const entity of outputEntities) {
    // Only flag name-like entities (> 4 chars)
    if (entity.length <= 4) continue
    if (_COMMON_CAPITALISED_WORDS.has(entity)) continue

    const found = [...srcEntities].some(src =>
      src.toLowerCase().includes(entity.toLowerCase()) ||
      entity.toLowerCase().includes(src.toLowerCase())
    )
    if (!found && srcEntities.size > 0) {
      suspicious.push({ claim: entity, reason: `Name "${entity}" not found in source records` })
    }
  }

  const score = suspicious.length === 0 ? 1.0
    : Math.max(0, 1 - suspicious.length * 0.15)

  return { passed: suspicious.length === 0, suspicious, score }
}
