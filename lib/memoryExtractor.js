// lib/memoryExtractor.js — AI memory extraction from field reports.
// Per-report keyword heuristics (no AI cost) plus a periodic Gemini batch pass
// over Sheet + DB reports, re-run every AUTO_SEED_INTERVAL submissions.

import { getPool }         from '../db/pool.js'
import { reinforceMemory } from './aiAgent.js'

// ── Config ────────────────────────────────────────────────────────────────────
// Re-seed the AI memory from all reports every N new WhatsApp submissions
const AUTO_SEED_INTERVAL = 25

// ── Common barrier / challenge keywords ──────────────────────────────────────
const BARRIER_TERMS = [
  'no water', 'water shortage', 'drought', 'flood', 'waterlogging',
  'no access', 'road blocked', 'connectivity', 'remote',
  'conflict', 'dispute', 'resistance',
  'migration', 'migrated',
  'no funds', 'funding', 'budget',
  'delay', 'delayed', 'pending',
  'absent', 'refused', 'unwilling',
  'problem', 'issue', 'challenge', 'difficult', 'barrier',
  'no response', 'blocked', 'incomplete',
  'disease', 'illness', 'sick', 'unwell', 'health',
  'low attendance', 'not attended',
  'awareness', 'illiterate', 'education',
]

// ── Gemini endpoint (non-streaming JSON) ──────────────────────────────────────
const GEMINI_JSON_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEET FETCHER (server-side CSV parser)
// ─────────────────────────────────────────────────────────────────────────────

/** Quote-aware CSV parser (good enough for Sheets exports); returns header-keyed objects. */
function parseCSV(text) {
  // Quote-aware across the whole text, not per line: quoted fields can
  // contain newlines (multi-line "Description" cells).
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows = []
  let row = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++ } // escaped quote
        else inQ = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      row.push(cur); cur = ''
    } else if (ch === '\n') {
      row.push(cur); cur = ''
      rows.push(row); row = []
    } else {
      cur += ch
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  if (rows.length < 2) return []

  const headers = rows[0].map(v => v.trim())
  return rows.slice(1)
    .filter(r => r.some(v => v.trim() !== ''))
    .map(vals => {
      const obj = {}
      headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim() })
      return obj
    })
}

/** Fetch the org's Sheet reports in whatsapp_submissions row shape. */
async function fetchSheetReports(sheetId) {
  if (!sheetId) return []
  try {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn('[memoryExtractor] Sheet fetch failed:', res.status)
      return []
    }
    const csv = await res.text()
    const rows = parseCSV(csv)

    return rows
      .filter(r => r['Description'] || r['Project'])  // skip blank rows
      .map(r => ({
        worker_name:  r['Name']                     || '',
        project:      r['Project']                  || '',
        state:        r['State']                    || '',
        location:     r['Location']                 || '',
        area:         r['Area of Intervention']     || '',
        beneficiaries:r['Beneficiaries']            || '0',
        description:  r['Description']              || '',
        created_at:   r['Timestamp']                || '',
        _source:      'sheet',
      }))
  } catch (e) {
    console.warn('[memoryExtractor] fetchSheetReports error:', e.message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEURISTIC EXTRACTION (per-report, no AI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract facts from one report into ai_memories. Fire-and-forget; also kicks
 * off a background re-seed every AUTO_SEED_INTERVAL reports.
 * @param {string} [apiKey]  needed for auto re-seed; omit to skip it
 */
export function extractReportHeuristics(orgId, { workerName, project, state, location, area, description, beneficiaries }, apiKey) {
  if (!orgId) return

  const loc   = [location, state].filter(Boolean).join(', ')
  const benef = parseInt(String(beneficiaries ?? 0)) || 0

  // ── Worker insight ─────────────────────────────────────────────────────────
  if (workerName && workerName !== 'Unknown') {
    const facts = [
      project   && `project "${project}"`,
      loc       && `active in ${loc}`,
      area      && `area: ${area}`,
      benef > 0 && `typical reach ~${benef} beneficiaries`,
    ].filter(Boolean)
    if (facts.length) {
      reinforceMemory(orgId, 'worker_insight', workerName,
        `Field worker — ${facts.join('; ')}.`, 0.8, 'whatsapp').catch(() => {})
    }
  }

  // ── Project pattern ────────────────────────────────────────────────────────
  if (project && loc) {
    reinforceMemory(orgId, 'project_pattern', project,
      `Active in ${loc}${area ? `, focusing on ${area}` : ''}.`,
      0.7, 'whatsapp').catch(() => {})
  }

  // ── Barrier pattern (keyword detection) ───────────────────────────────────
  if (description) {
    const descLower = description.toLowerCase()
    const matched = BARRIER_TERMS.find(term => descLower.includes(term))
    if (matched) {
      reinforceMemory(orgId, 'barrier_pattern', matched,
        `Mentioned in ${loc || 'field'} reports${project ? ` (${project})` : ''}: "${description.slice(0, 120)}"`,
        0.6, 'whatsapp').catch(() => {})
    }
  }

  // ── Periodic auto re-seed ──────────────────────────────────────────────────
  if (apiKey) {
    const pool = getPool()
    pool.query(
      `SELECT COUNT(*) AS cnt FROM whatsapp_submissions WHERE org_id = $1`,
      [orgId]
    ).then(({ rows }) => {
      const count = parseInt(rows[0].cnt)
      if (count > 0 && count % AUTO_SEED_INTERVAL === 0) {
        console.log(`[memoryExtractor] Auto-seeding at report #${count} for org ${orgId}`)
        batchExtractMemories(orgId, apiKey, () => {}).catch(e =>
          console.warn('[memoryExtractor] auto-seed error:', e.message)
        )
      }
    }).catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI BATCH EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/** Merge Sheet + DB rows, deduped on worker_name + first 60 chars of description. */
function mergeReports(sheetRows, dbRows) {
  const seen = new Set()
  const all  = []

  function add(r) {
    const key = `${(r.worker_name || '').toLowerCase()}|${String(r.description || '').slice(0, 60).toLowerCase()}`
    if (!seen.has(key)) { seen.add(key); all.push(r) }
  }

  // Sheet is canonical — add first so dupes from DB are dropped
  for (const r of sheetRows) add(r)
  for (const r of dbRows)    add(r)

  return all
}

// ── Server-side aggregation helpers ──────────────────────────────────────────
// Pre-aggregate so the Gemini prompt stays compact at any report volume.

function groupBy(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const k = String(keyFn(r) || '').trim()
    if (!k) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

function topN(map, n = 50) {
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, n)
}

function uniq(arr) { return [...new Set(arr.filter(Boolean))] }

/** Compact (~3-8 KB) aggregated summary for Gemini. */
function buildAggregatedPrompt(rows) {
  // ── Worker summaries ──────────────────────────────────────────────────────
  const byWorker = groupBy(rows, r => r.worker_name)
  const workerLines = topN(byWorker, 60).map(([name, rs]) => {
    const projects  = uniq(rs.map(r => r.project)).slice(0, 6).join(', ')
    const states    = uniq(rs.map(r => r.state)).slice(0, 5).join(', ')
    const locs      = uniq(rs.map(r => r.location)).slice(0, 5).join(', ')
    const areas     = uniq(rs.map(r => r.area)).slice(0, 4).join(', ')
    const totalB    = rs.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
    // Two representative description snippets
    const snips     = rs.filter(r => r.description?.trim()).slice(0, 2)
                        .map(r => `"${String(r.description).trim().slice(0, 80)}"`).join(' | ')
    return `• ${name} (${rs.length} reports, ${totalB} beneficiaries) — projects: ${projects || '?'} | states: ${states || '?'} | locations: ${locs || '?'} | areas: ${areas || '?'}${snips ? ` | samples: ${snips}` : ''}`
  }).join('\n')

  // ── Project summaries ────────────────────────────────────────────────────
  const byProject = groupBy(rows, r => r.project)
  const projectLines = topN(byProject, 30).map(([proj, rs]) => {
    const states    = uniq(rs.map(r => r.state)).slice(0, 6).join(', ')
    const locs      = uniq(rs.map(r => r.location)).slice(0, 6).join(', ')
    const areas     = uniq(rs.map(r => r.area)).slice(0, 5).join(', ')
    const workers   = uniq(rs.map(r => r.worker_name)).length
    const totalB    = rs.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
    return `• ${proj} (${rs.length} reports, ${totalB} total beneficiaries, ${workers} workers) — states: ${states || '?'} | locations: ${locs || '?'} | areas: ${areas || '?'}`
  }).join('\n')

  // ── Barrier keyword counts ────────────────────────────────────────────────
  const barrierCounts = new Map()
  for (const r of rows) {
    if (!r.description) continue
    const d = r.description.toLowerCase()
    for (const term of BARRIER_TERMS) {
      if (d.includes(term)) barrierCounts.set(term, (barrierCounts.get(term) || 0) + 1)
    }
  }
  const barrierLines = [...barrierCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([term, cnt]) => `• "${term}": ${cnt} mentions`)
    .join('\n')

  // ── Org-level stats ───────────────────────────────────────────────────────
  const totalB  = rows.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
  const topStates = topN(groupBy(rows, r => r.state), 6).map(([s, rs]) => `${s} (${rs.length})`).join(', ')
  const topAreas  = topN(groupBy(rows, r => r.area),  6).map(([a, rs]) => `${a} (${rs.length})`).join(', ')
  const dates     = rows.map(r => String(r.created_at).slice(0, 10)).filter(Boolean).sort()
  const dateRange = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : 'unknown'

  return { workerLines, projectLines, barrierLines, topStates, topAreas, totalB, dateRange }
}

/**
 * Gemini batch extraction over all of an org's reports (Sheet is canonical).
 * @param {function} onProgress — callback(text) for SSE progress lines
 * @returns {Promise<{workers, projects, barriers, orgContext, total, summary}>}
 */
export async function batchExtractMemories(orgId, apiKey, onProgress = () => {}) {
  const pool = getPool()

  // ── 1. Fetch org metadata (sheet ID) ────────────────────────────────────
  const { rows: orgRows } = await pool.query(
    `SELECT metadata FROM organizations WHERE id = $1`,
    [orgId]
  )
  const sheetId = orgRows[0]?.metadata?.data_sources?.reports_sheet_id

  // ── 2. Load DB submissions ───────────────────────────────────────────────
  onProgress('Reading reports from database…')
  const { rows: dbRows } = await pool.query(
    `SELECT worker_name, project, state, location, area, beneficiaries, description, created_at
     FROM whatsapp_submissions
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT 500`,
    [orgId]
  )

  // ── 3. Fetch Google Sheet reports ────────────────────────────────────────
  let sheetRows = []
  if (sheetId) {
    onProgress('Fetching reports from Google Sheets…')
    sheetRows = await fetchSheetReports(sheetId)
  }

  // ── 4. Merge & deduplicate ───────────────────────────────────────────────
  const merged = mergeReports(sheetRows, dbRows)
  const total  = merged.length

  if (!total) {
    onProgress('No reports found for this organisation yet.')
    return { workers: 0, projects: 0, barriers: 0, orgContext: false, total: 0 }
  }

  onProgress(`Processing ${total} reports…`)

  // ── 5. Pre-aggregate server-side ─────────────────────────────────────────
  const { workerLines, projectLines, barrierLines, topStates, topAreas, totalB, dateRange } =
    buildAggregatedPrompt(merged)

  // ── 6. Gemini JSON analysis on aggregated data ───────────────────────────
  const prompt = `You are an expert field-operations analyst for an NGO. Based on the pre-aggregated statistics below, write structured AI memory entries.

ORG STATS: ${total} reports | ${totalB} total beneficiaries | date range: ${dateRange}
Top states: ${topStates}
Top areas: ${topAreas}

WORKER ACTIVITY (sorted by report count):
${workerLines}

PROJECT ACTIVITY (sorted by report count):
${projectLines}

CHALLENGE KEYWORD FREQUENCY (from report descriptions):
${barrierLines || '(none detected)'}

Return ONLY valid JSON:
{
  "worker_profiles": [
    {"name": "<exact worker name>", "profile": "<2 sentences: projects covered, states/locations active in, beneficiary scale, any notable pattern>"}
  ],
  "project_patterns": [
    {"project": "<exact project name>", "pattern": "<2 sentences: geographic spread, key intervention areas, scale and frequency>"}
  ],
  "barriers": [
    {"barrier": "<2-4 word label>", "context": "<1 sentence: frequency, which projects/states affected>"}
  ],
  "org_context": "<3 sentences: overall geographic footprint, primary work types, scale of operations>"
}

Rules: include all workers with 2+ reports; all projects with 3+ reports; top 8 barriers by frequency.`

  const geminiRes = await fetch(GEMINI_JSON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  })

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '')
    throw new Error(`Gemini error ${geminiRes.status}: ${errText.slice(0, 300)}`)
  }

  const geminiJson = await geminiRes.json()
  const rawText = (geminiJson.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought).map(p => p.text || '').join('')

  let parsed
  try { parsed = JSON.parse(rawText) } catch {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    try { parsed = JSON.parse(cleaned) } catch {
      const match = rawText.match(/\{[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0])
      else throw new Error(`AI returned malformed JSON: ${rawText.slice(0, 200)}`)
    }
  }

  // ── 7. Persist memories ──────────────────────────────────────────────────
  let workers = 0, projects = 0, barriers = 0, orgContext = false

  for (const w of (parsed.worker_profiles || [])) {
    if (w.name && w.profile) {
      await reinforceMemory(orgId, 'worker_insight', w.name, w.profile, 0.9, 'batch_seed')
      workers++
    }
  }
  for (const p of (parsed.project_patterns || [])) {
    if (p.project && p.pattern) {
      await reinforceMemory(orgId, 'project_pattern', p.project, p.pattern, 0.9, 'batch_seed')
      projects++
    }
  }
  for (const b of (parsed.barriers || [])) {
    if (b.barrier && b.context) {
      await reinforceMemory(orgId, 'barrier_pattern', b.barrier, b.context, 0.85, 'batch_seed')
      barriers++
    }
  }
  if (parsed.org_context) {
    await reinforceMemory(orgId, 'org_context', '', parsed.org_context, 1.0, 'batch_seed')
    orgContext = true
  }

  const summary = `Seeded ${workers} worker profiles, ${projects} project patterns, ${barriers} barriers${orgContext ? ' + org overview' : ''} from ${total} reports.`
  onProgress(summary)
  return { workers, projects, barriers, orgContext, total, summary }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SEED CHECK
// ─────────────────────────────────────────────────────────────────────────────

/** True if the org has no AI memories yet (needs initial seed). */
export async function orgNeedsInitialSeed(orgId) {
  if (!orgId) return false
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT 1 FROM ai_memories WHERE org_id = $1 LIMIT 1`,
      [orgId]
    )
    return rows.length === 0
  } catch { return false }
}
