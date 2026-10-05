// Columns cleared per table when a beneficiary is anonymized, shared by
// beneficiary-erasure.routes.js and lib/retention.js so both agree on "anonymized".
// Only name/contact/granular location/income are cleared; area-level fields and
// aggregate figures stay for filters and MEAL reporting. This is separate from
// at-rest encryption (lib/piiCrypto.js): `village` isn't encrypted (it would break
// filtering) but is cleared here. Both plaintext and *_enc/*_hash columns are
// cleared, since newer rows keep their data only in the encrypted ones.
export const ANONYMIZE_SPECS = {
  individual_beneficiaries: [
    { column: 'name', value: '[anonymized]' }, // NOT NULL — can't null it out
    { column: 'contact_no', value: null },
    { column: 'contact_no_enc', value: null },
    { column: 'contact_no_hash', value: null },
    { column: 'panchayat', value: null },
    { column: 'panchayat_enc', value: null },
    { column: 'village', value: null },
    { column: 'current_income_inr', value: null },
    { column: 'current_income_inr_enc', value: null },
  ],
  micro_entrepreneurs: [
    { column: 'name', value: '[anonymized]' },
    { column: 'contact_no', value: null },
    { column: 'contact_no_enc', value: null },
    { column: 'contact_no_hash', value: null },
    { column: 'panchayat', value: null },
    { column: 'panchayat_enc', value: null },
    { column: 'village', value: null },
    { column: 'current_revenue_inr', value: null },
    { column: 'current_revenue_inr_enc', value: null },
  ],
  collectives: [
    // collective_name names the group (SHG, FPO…), not a person; lead_person_name does.
    { column: 'lead_person_name', value: null },
    { column: 'contact_no', value: null },
    { column: 'contact_no_enc', value: null },
    { column: 'contact_no_hash', value: null },
    { column: 'panchayat', value: null },
    { column: 'panchayat_enc', value: null },
    { column: 'village', value: null },
    { column: 'per_capita_income_inr', value: null },
    { column: 'per_capita_income_inr_enc', value: null },
  ],
  indirect_beneficiaries: [
    { column: 'name', value: null },
    { column: 'contact_no', value: null },
    { column: 'place', value: null },
  ],
}

// MIS/resource tables keep their own snapshot of the beneficiary's name and
// contact (copied at upload time), keyed only by beneficiary_uid. Anonymizing
// the registry row alone left those copies behind, so they're cleared too.
// beneficiary_mis_records (027) isn't here: it has no beneficiary_uid, only
// a free-text name, so there's no safe way to tie a row to one person.
export const LINKED_PII_SPECS = {
  trainings: ['beneficiary_name', 'contact_no'],
  input_distributions: ['beneficiary_name', 'contact_no'],
  scheme_access: ['beneficiary_name', 'contact_no'],
  credit_grant_access: ['beneficiary_name', 'contact_no'],
  business_development_support: ['beneficiary_name', 'contact_no'],
  compliance_support: ['beneficiary_name', 'contact_no'],
  exposure_visits: ['beneficiary_name', 'contact_no'],
  income: ['beneficiary_name', 'contact_no'],
  resources: ['beneficiary_name'],
}

// Clears the snapshots above for the given beneficiary uids in one org.
// `db` is a pool or a client already inside a transaction.
export async function clearLinkedPii(db, orgId, uids) {
  if (!uids.length) return
  for (const [table, cols] of Object.entries(LINKED_PII_SPECS)) {
    await db.query(
      `UPDATE ${table} SET ${cols.map(c => `${c} = NULL`).join(', ')}
       WHERE org_id = $1 AND beneficiary_uid = ANY($2::text[])`,
      [orgId, uids]
    )
  }
}
