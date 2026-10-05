// lib/searchSql.js — shared free-text search for the registration roster endpoints.
// Trims the term and escapes LIKE wildcards. contact_no is encrypted at rest, so mobile
// numbers are matched via the contact_no_hash blind index (an exact HMAC), hashing the
// common typed forms (raw, digits only, 10-digit, 91/+91-prefixed).

import { hashContactNo } from './piiCrypto.js'

export function normalizeSearch(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ')
}

// Postgres LIKE's default escape character is backslash.
export function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`
}

function contactHashCandidates(term) {
  if (!/^[+\d][\d\s-]*$/.test(term)) return []
  const digits = term.replace(/\D/g, '')
  if (digits.length < 7) return []
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  const forms = new Set([term, digits, last10])
  if (last10.length === 10) { forms.add(`91${last10}`); forms.add(`+91${last10}`); forms.add(`+91 ${last10}`) }
  return [...forms].map(hashContactNo).filter(Boolean)
}

/**
 * Pushes the search params onto `values` and returns a SQL condition, or
 * null when the (trimmed) term is empty.
 *   columns     — plaintext columns to ILIKE against
 *   contactHash — true for tables with an encrypted contact_no + contact_no_hash
 *                 (also keeps an ILIKE on legacy not-yet-backfilled plaintext)
 */
export function buildSearchCondition(rawSearch, values, { columns, contactHash = false, prefix = '' }) {
  const term = normalizeSearch(rawSearch)
  if (!term) return null
  values.push(likePattern(term))
  const likeIdx = values.length
  const ors = columns.map(c => `${prefix}${c} ILIKE $${likeIdx}`)
  if (contactHash) {
    ors.push(`${prefix}contact_no ILIKE $${likeIdx}`)
    const hashes = contactHashCandidates(term)
    if (hashes.length) {
      values.push(hashes)
      ors.push(`${prefix}contact_no_hash = ANY($${values.length}::text[])`)
    }
  }
  return `(${ors.join(' OR ')})`
}
