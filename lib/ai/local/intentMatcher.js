// Deterministic WhatsApp intent detection (exact keyword, aliases, trigram
// similarity, built-in Hindi/Hinglish aliases). Returns the matched wa_flows row or null.

import { getPool } from '../../../db/pool.js'

// ── Built-in multilingual keyword mappings ────────────────────────────────────
// keyword → normalized English alias that can match flow trigger_keywords
const LANG_ALIASES = {
  // Hindi / Hinglish common trigger words
  'report': ['report', 'riport', 'रिपोर्ट', 'repo'],
  'attendance': ['attendance', 'attandance', 'hazri', 'हाज़री', 'present', 'উপস্থিতি'],
  'beneficiary': ['beneficiary', 'labharathi', 'लाभार्थी', 'log', 'লাভার্থী'],
  'submit': ['submit', 'send', 'bhejo', 'भेजो', 'jama'],
  'activity': ['activity', 'kaam', 'काम', 'karya', 'कार्य'],
  'help': ['help', 'madad', 'मदद', 'sahayata', 'सहायता', 'helpline'],
  'yes': ['yes', 'haan', 'han', 'हाँ', 'हां', 'ok', 'okay', 'theek', 'ठीक', 'ji', 'जी'],
  'no':  ['no', 'nahi', 'नहीं', 'na', 'nope', 'mat'],
  'today': ['today', 'aaj', 'आज'],
  'start': ['start', 'shuru', 'शुरू', 'begin', 'go'],
  'training': ['training', 'traning', 'prasikshan', 'प्रशिक्षण'],
  'water': ['water', 'pani', 'पानी', 'jal', 'जल'],
  'health': ['health', 'swasthya', 'स्वास्थ्य', 'sehat', 'सेहत'],
  'meeting': ['meeting', 'baithak', 'बैठक', 'milna'],
  'survey': ['survey', 'sarvekshan', 'सर्वेक्षण'],
}

// Build reverse lookup: alias → canonical keyword
const _reverseAlias = new Map()
for (const [canonical, aliases] of Object.entries(LANG_ALIASES)) {
  for (const alias of aliases) {
    _reverseAlias.set(alias.toLowerCase(), canonical)
  }
}

// ── Org alias cache ────────────────────────────────────────────────────────────
const _orgAliasCache = new Map()   // orgId → { aliases: Map, ts }
const ALIAS_TTL      = 10 * 60_000

async function _loadOrgAliases(orgId) {
  const cached = _orgAliasCache.get(orgId)
  if (cached && Date.now() - cached.ts < ALIAS_TTL) return cached.aliases

  const aliases = new Map()  // alias → canonical
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT config FROM ai_rule_versions
       WHERE (org_id = $1 OR org_id IS NULL)
         AND feature = 'whatsapp'
         AND rule_type = 'intent_matcher'
         AND active = true
       ORDER BY org_id NULLS FIRST`,
      [orgId]
    )
    for (const row of rows) {
      const cfg = row.config || {}
      for (const [canonical, aliasList] of Object.entries(cfg.aliases || {})) {
        for (const a of aliasList) aliases.set(a.toLowerCase(), canonical)
      }
    }
  } catch { /* ignore — use built-ins only */ }

  _orgAliasCache.set(orgId, { aliases, ts: Date.now() })
  return aliases
}

export function invalidateOrgAliases(orgId) { _orgAliasCache.delete(orgId) }

// ── Trigram helpers ───────────────────────────────────────────────────────────
function _trigrams(str) {
  const s = ` ${str.toLowerCase().trim()} `
  const t = new Set()
  for (let i = 0; i < s.length - 2; i++) t.add(s.slice(i, i + 3))
  return t
}

function _trigramSimilarity(a, b) {
  if (!a || !b) return 0
  const ta = _trigrams(a), tb = _trigrams(b)
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

// ── Main intent detector ───────────────────────────────────────────────────────
/** Detect which wa_flows row a message best matches; null below the confidence threshold. */
export async function detectIntent(message, flows, orgId) {
  if (!message?.trim() || !flows?.length) return null

  const msg       = message.trim().toLowerCase()
  const candidates = flows.filter(f => !f.is_default)
  if (!candidates.length) return null

  const orgAliases = orgId ? await _loadOrgAliases(orgId) : new Map()

  // ── Normalize message tokens ──────────────────────────────────────────────
  const tokens = msg.split(/\s+/).map(t => t.replace(/[^a-z0-9ऀ-ॿ]/g, ''))

  function normalize(token) {
    // Check org-specific aliases first, then built-ins
    return orgAliases.get(token) ?? _reverseAlias.get(token) ?? token
  }

  const normalizedTokens = tokens.map(normalize)

  // ── Score each candidate flow ─────────────────────────────────────────────
  const scored = candidates.map(flow => {
    const keywords = (flow.trigger_keywords || []).map(k => k.toLowerCase().trim())
    if (!keywords.length) return { flow, score: 0, method: 'none' }

    // 1. Exact match on any keyword
    for (const kw of keywords) {
      if (msg === kw || msg.includes(kw)) return { flow, score: 1.0, method: 'exact' }
      if (normalizedTokens.includes(kw)) return { flow, score: 0.95, method: 'alias' }
    }

    // 2. Prefix match
    for (const kw of keywords) {
      if (msg.startsWith(kw) || kw.startsWith(msg.slice(0, Math.min(msg.length, 8)))) {
        return { flow, score: 0.85, method: 'prefix' }
      }
    }

    // 3. Token overlap
    const kwTokens = keywords.flatMap(k => k.split(/\s+/))
    const overlap  = normalizedTokens.filter(t => kwTokens.includes(t) || kwTokens.includes(normalize(t)))
    if (overlap.length > 0) {
      const tokenScore = Math.min(0.8, 0.5 + 0.15 * overlap.length)
      return { flow, score: tokenScore, method: 'token' }
    }

    // 4. Trigram similarity on the whole message vs each keyword
    let bestTri = 0
    for (const kw of keywords) {
      bestTri = Math.max(bestTri, _trigramSimilarity(msg, kw))
    }
    if (bestTri > 0.35) return { flow, score: bestTri * 0.7, method: 'trigram' }

    return { flow, score: 0, method: 'none' }
  })

  // Pick highest-scoring candidate above confidence threshold
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 0.55) return null

  return { ...best.flow, _matchScore: best.score, _matchMethod: best.method, confidence: best.score }
}

// ── Alias addition (used by learning loop) ────────────────────────────────────
/** Add alias → canonical mappings for an org (ai_rule_versions; active immediately). */
export async function addAliases(orgId, canonical, aliases) {
  if (!orgId || !canonical || !aliases?.length) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, config, version FROM ai_rule_versions
       WHERE org_id = $1 AND feature = 'whatsapp' AND rule_type = 'intent_matcher' AND active = true
       LIMIT 1`,
      [orgId]
    )
    if (rows.length) {
      const cfg = rows[0].config || {}
      cfg.aliases = cfg.aliases || {}
      cfg.aliases[canonical] = [...new Set([...(cfg.aliases[canonical] || []), ...aliases])]
      await pool.query(
        `UPDATE ai_rule_versions SET config=$1, activated_at=NOW() WHERE id=$2`,
        [cfg, rows[0].id]
      )
    } else {
      await pool.query(
        `INSERT INTO ai_rule_versions (org_id, feature, rule_type, version, config, active, activated_at)
         VALUES ($1, 'whatsapp', 'intent_matcher', 1, $2, true, NOW())`,
        [orgId, { aliases: { [canonical]: aliases } }]
      )
    }
    invalidateOrgAliases(orgId)
  } catch (e) {
    console.warn('[intentMatcher] addAliases error:', e.message)
  }
}
