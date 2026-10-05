// Shared UID-prefix → beneficiary-type resolution.

const PREFIX_SPECS = {
  'IB-': { type: 'Individual Beneficiary', table: 'individual_beneficiaries' },
  'EB-': { type: 'Micro-Entrepreneur',     table: 'micro_entrepreneurs' },
  'CB-': { type: 'Collective',             table: 'collectives' },
  'XB-': { type: 'Indirect Beneficiary',   table: 'indirect_beneficiaries' },
}

/**
 * @returns {{ normalizedUid: string, type: string } | null}
 */
export function resolveBeneficiaryType(uid) {
  const spec = resolveBeneficiarySpec(uid)
  return spec ? { normalizedUid: spec.normalizedUid, type: spec.type } : null
}

/**
 * Full lookup spec including the backing table (same routing as
 * beneficiary-profile.routes.js's local beneficiaryLookupSpec).
 * @returns {{ normalizedUid: string, type: string, table: string } | null}
 */
export function resolveBeneficiarySpec(uid) {
  const u = String(uid || '').trim().toUpperCase()
  for (const [prefix, spec] of Object.entries(PREFIX_SPECS)) {
    if (u.startsWith(prefix)) return { normalizedUid: u, ...spec }
  }
  return null
}

export const BENEFICIARY_UID_PREFIX_HINT =
  'UID must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)'
