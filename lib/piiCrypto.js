// lib/piiCrypto.js — field-level encryption for beneficiary PII, on top of lib/crypto.js
// (same enc:v1: format and key). services/individual-beneficiary, micro-entrepreneur and
// collective can't import lib/, so each carries a copy of this logic — keep them in sync.

import { encryptSecret, decryptSecret } from './crypto.js'
import crypto from 'crypto'

export function encryptPii(value) {
  if (value === null || value === undefined || value === '') return null
  return encryptSecret(String(value))
}

export function decryptPii(value) {
  if (value === null || value === undefined || value === '') return null
  return decryptSecret(value)
}

// Deterministic blind index so contact_no duplicate checks still work (GCM's random IV
// means ciphertexts never match). Key is HMAC-derived from ENCRYPTION_KEY for separation.
function _hashKey() {
  const base = (process.env.ENCRYPTION_KEY || '').trim() || `${process.env.FIREBASE_PROJECT_ID || 'fieldflow'}::ff-rotation-2026`
  return crypto.createHmac('sha256', base).update('fieldflow:contact_no_hash:v1').digest()
}

export function hashContactNo(value) {
  if (!value) return null
  return crypto.createHmac('sha256', _hashKey()).update(String(value).trim()).digest('hex')
}

// Plaintext column → _enc (and _hash) columns per table (migration 064). `village` is
// deliberately not encrypted: the beneficiary routes filter, ILIKE-search and group by it.
export const PII_FIELD_MAP = {
  individual_beneficiaries: {
    contact_no:         { encCol: 'contact_no_enc', hashCol: 'contact_no_hash' },
    current_income_inr: { encCol: 'current_income_inr_enc' },
    panchayat:          { encCol: 'panchayat_enc' },
  },
  micro_entrepreneurs: {
    contact_no:          { encCol: 'contact_no_enc', hashCol: 'contact_no_hash' },
    current_revenue_inr: { encCol: 'current_revenue_inr_enc' },
    panchayat:           { encCol: 'panchayat_enc' },
  },
  collectives: {
    contact_no:             { encCol: 'contact_no_enc', hashCol: 'contact_no_hash' },
    per_capita_income_inr: { encCol: 'per_capita_income_inr_enc' },
    panchayat:              { encCol: 'panchayat_enc' },
  },
}

/**
 * Mutates `row`: decrypts populated _enc columns into the plaintext-named field (rows not
 * yet backfilled keep their plaintext) and strips _enc/_hash so the row is client-safe.
 */
export function decryptRowInPlace(table, row) {
  const map = PII_FIELD_MAP[table]
  if (!map || !row) return row
  for (const [plainCol, spec] of Object.entries(map)) {
    if (row[spec.encCol]) row[plainCol] = decryptPii(row[spec.encCol])
    delete row[spec.encCol]
    if (spec.hashCol) delete row[spec.hashCol]
  }
  return row
}

/**
 * Rewrites mapped keys of a { column: value } patch to their _enc/_hash columns and nulls
 * the plaintext column so no stale plaintext survives. Caller must still check the
 * resulting column names exist before building a SET clause.
 */
export function encryptMappedFields(table, updates) {
  const map = PII_FIELD_MAP[table]
  if (!map) return { ...updates }
  const out = {}
  for (const [key, value] of Object.entries(updates)) {
    const spec = map[key]
    if (!spec) { out[key] = value; continue }
    out[spec.encCol] = value ? encryptPii(value) : null
    if (spec.hashCol) out[spec.hashCol] = value ? hashContactNo(value) : null
    out[key] = null
  }
  return out
}
