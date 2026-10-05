-- db/migrations/064_pii_encryption_columns.sql
--
-- DPDP Act 2023 / DPDP Rules 2025 compliance — Phase 4 (field-level PII encryption).
--
-- Additive, non-destructive: adds parallel *_enc / *_hash columns rather
-- than encrypting the existing plaintext columns in place. New writes
-- (services/individual-beneficiary, services/micro-entrepreneur,
-- services/collective, and the monolith's beneficiary-profile.routes.js
-- PUT / dsr.routes.js correction fulfillment) cut over to the *_enc
-- columns; a backfill script (scripts/backfill-pii-encryption.mjs)
-- populates them for pre-existing rows. The OLD plaintext columns are left
-- in place for now — a LATER, separately-confirmed migration drops them
-- once the cutover is verified stable. This gives a safe rollback point
-- between "encrypted column exists" and "plaintext column is gone."
--
-- contact_no gets BOTH an encrypted column (contact_no_enc, randomized IV
-- — safe at rest, not equality-comparable) AND a deterministic HMAC-SHA256
-- blind-index column (contact_no_hash) — all three registration
-- microservices run an exact-match duplicate-detection query on contact_no
-- at signup; the hash preserves that lookup without storing the phone
-- number itself in a comparable form.
--
-- Column classification note: `village` is NOT encrypted here despite
-- being "granular location" — individual-beneficiaries.routes.js,
-- micro-entrepreneurs.routes.js, and collectives.routes.js all use it as
-- an exact-match filter, an ILIKE search target, AND a distinct-values
-- dropdown. Encrypting it (randomized IV, not equality-comparable) would
-- silently break that filtering for every beneficiary registered after
-- cutover. `panchayat` has no such dependency in any of the three list
-- routes, so it's the one "granular location" field actually encrypted.

ALTER TABLE individual_beneficiaries
  ADD COLUMN IF NOT EXISTS contact_no_enc         TEXT,
  ADD COLUMN IF NOT EXISTS contact_no_hash         TEXT,
  ADD COLUMN IF NOT EXISTS current_income_inr_enc TEXT,
  ADD COLUMN IF NOT EXISTS panchayat_enc          TEXT;

ALTER TABLE micro_entrepreneurs
  ADD COLUMN IF NOT EXISTS contact_no_enc           TEXT,
  ADD COLUMN IF NOT EXISTS contact_no_hash           TEXT,
  ADD COLUMN IF NOT EXISTS current_revenue_inr_enc TEXT,
  ADD COLUMN IF NOT EXISTS panchayat_enc            TEXT;

ALTER TABLE collectives
  ADD COLUMN IF NOT EXISTS contact_no_enc              TEXT,
  ADD COLUMN IF NOT EXISTS contact_no_hash              TEXT,
  ADD COLUMN IF NOT EXISTS per_capita_income_inr_enc TEXT,
  ADD COLUMN IF NOT EXISTS panchayat_enc               TEXT;

CREATE INDEX IF NOT EXISTS idx_individual_beneficiaries_contact_hash ON individual_beneficiaries (org_id, contact_no_hash);
CREATE INDEX IF NOT EXISTS idx_micro_entrepreneurs_contact_hash      ON micro_entrepreneurs (org_id, contact_no_hash);
CREATE INDEX IF NOT EXISTS idx_collectives_contact_hash              ON collectives (org_id, contact_no_hash);
