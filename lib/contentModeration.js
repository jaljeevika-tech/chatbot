// lib/contentModeration.js — regex-based PII masking and profanity/abuse flagging
// for user-submitted text (WhatsApp logs, daily reports, transcripts, AI prompts).
// Never blocks; callers decide policy. Errs toward false positives since it only flags.

// ── PII regex patterns ──────────────────────────────────────────────────────

// Aadhaar: 12 digits, optionally split as 4-4-4. Validate via Verhoeff checksum.
const AADHAAR_RE = /\b(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b/g

// PAN: AAAAA9999A (5 letters, 4 digits, 1 letter). 4th letter encodes type (P=individual, C=company, etc).
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g

// Indian mobile: 10 digits starting with 6-9, optionally prefixed with +91 / 0 / 91-
const MOBILE_RE = /(?:\+?91[\s-]?|0)?[6-9]\d{9}\b/g

// Bank account: 9-18 digits — too noisy to mask globally; only mask if labeled
const BANK_LABELED_RE = /\b(?:a\/?c|account|acc\.?|खाता)[\s.#:]*([0-9]{9,18})\b/gi

// IFSC: 4 letters + 0 + 6 alphanumeric
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// Credit card: 13-19 digits, Luhn-validated to reduce false-positives
const CC_RE = /\b(?:\d[ -]?){13,19}\b/g

// ── Verhoeff (Aadhaar) ──────────────────────────────────────────────────────
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
]
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
]

function isValidAadhaar(digits) {
  if (!/^\d{12}$/.test(digits)) return false
  let c = 0
  const arr = digits.split('').reverse().map(Number)
  for (let i = 0; i < arr.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][arr[i]]]
  return c === 0
}

// ── Luhn (credit card) ──────────────────────────────────────────────────────
function isLuhn(digits) {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// ── Profanity list (small, intentionally minimal) ───────────────────────────
// We don't try to be a full filter — that's a losing game. Just catch the
// most-cited strong terms so the manager sees a flag and can intervene.
const PROFANITY_TERMS = [
  // English (strong only — we don't want false positives on routine language)
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'bastard',
  // Hindi (Roman script) — strong slurs
  'madarchod', 'bhenchod', 'chutiya', 'gaandu', 'kameena', 'haramkhor', 'saala',
  // Devanagari strong terms
  'मादरचोद', 'भेनचोद', 'चूतिया', 'गांडू', 'कमीना', 'हरामखोर',
]
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY_TERMS.join('|')})\\b`, 'gi')

// ── Targeted abuse hints ────────────────────────────────────────────────────
// Patterns that combine a second-person pronoun + a strong term suggest the
// message is directed AT someone rather than expressed in frustration.
const ABUSE_HINT_RE = /\b(you|tum|tu|aap|आप|तुम|तू)\b.{0,20}\b(idiot|stupid|बेवकूफ|पागल|मूर्ख)\b/gi

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan text for PII/profanity. With opts.redact=false, text is returned unchanged
 * alongside the findings counts and a severity of 'clean' | 'low' | 'medium' | 'high'.
 */
export function moderate(text, opts = {}) {
  const redact = opts.redact !== false
  const findings = {
    aadhaar: 0, pan: 0, mobile: 0, bank: 0,
    ifsc: 0, email: 0, creditCard: 0,
    profanity: 0, abuseHints: 0,
  }
  if (typeof text !== 'string' || !text) {
    return {
      text: text || '',
      findings,
      hasPii: false,
      hasProfanity: false,
      hasAbuseHints: false,
      severity: 'clean',
    }
  }

  let out = text

  // Aadhaar only counts when the Verhoeff checksum passes
  out = out.replace(AADHAAR_RE, (match, a, b, c) => {
    const digits = a + b + c
    if (!isValidAadhaar(digits)) return match
    findings.aadhaar++
    return redact ? 'XXXX-XXXX-' + c : match
  })

  out = out.replace(PAN_RE, (match) => {
    findings.pan++
    return redact ? '*****-' + match.slice(-1) : match
  })

  out = out.replace(CC_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '')
    if (digits.length < 13 || digits.length > 19) return match
    if (!isLuhn(digits)) return match
    findings.creditCard++
    return redact ? '****-****-****-' + digits.slice(-4) : match
  })

  // Mobile (Indian) — after credit card to avoid double-matching
  out = out.replace(MOBILE_RE, (match) => {
    findings.mobile++
    const last4 = match.slice(-4)
    return redact ? '+91 ***** ' + last4 : match
  })

  out = out.replace(BANK_LABELED_RE, (match, num) => {
    findings.bank++
    return redact ? match.replace(num, 'X'.repeat(num.length - 4) + num.slice(-4)) : match
  })

  out = out.replace(IFSC_RE, (match) => {
    findings.ifsc++
    return redact ? match.slice(0, 4) + '0XXXXXX' : match
  })

  out = out.replace(EMAIL_RE, (match) => {
    findings.email++
    if (!redact) return match
    const [user, domain] = match.split('@')
    const maskedUser = user.length > 2 ? user[0] + '***' + user.slice(-1) : '***'
    return maskedUser + '@' + domain
  })

  // Profanity (flag only — never auto-mask; the manager decides)
  const profMatches = text.match(PROFANITY_RE)
  if (profMatches) findings.profanity = profMatches.length

  const abuseMatches = text.match(ABUSE_HINT_RE)
  if (abuseMatches) findings.abuseHints = abuseMatches.length

  const hasPii = findings.aadhaar + findings.pan + findings.mobile +
                  findings.bank + findings.ifsc + findings.email +
                  findings.creditCard > 0
  const hasProfanity = findings.profanity > 0
  const hasAbuseHints = findings.abuseHints > 0

  let severity = 'clean'
  if (hasAbuseHints || findings.profanity >= 2) severity = 'high'
  else if (hasProfanity || findings.aadhaar > 0 || findings.creditCard > 0) severity = 'medium'
  else if (hasPii) severity = 'low'

  return { text: out, findings, hasPii, hasProfanity, hasAbuseHints, severity }
}

/** Redact only — returns the cleaned string. */
export function redact(text) {
  return moderate(text, { redact: true }).text
}

/** Scan only — returns findings without modifying text. */
export function scan(text) {
  return moderate(text, { redact: false })
}
