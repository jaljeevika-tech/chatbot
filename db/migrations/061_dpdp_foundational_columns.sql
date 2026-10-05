-- db/migrations/061_dpdp_foundational_columns.sql
--
-- DPDP Act 2023 / DPDP Rules 2025 compliance — Phase 0 (foundational schema).
-- Adds the columns later phases build on:
--   - is_minor / date_of_birth: lets Phase 1 gate photo/name-attribution
--     consent behind parent-guardian sign-off for beneficiaries under 18.
--     is_minor is the operative flag (captured directly at registration);
--     date_of_birth is optional supplementary data, since exact DOB is often
--     unknown/approximate for this population.
--   - deleted_at / anonymized_at: two distinct nullable timestamps, not one
--     soft-delete boolean, because a DSR-driven erasure (Phase 2) and a
--     routine retention-driven anonymization (Phase 3) are legally different
--     events that need to be queryable and audit-logged separately.
--   - audit_log.request_id: correlates every write a single DSR fulfillment
--     makes (Phase 2), so a request's full trail is reconstructable by
--     filtering audit_log on one id.
--
-- collectives intentionally does NOT get is_minor/date_of_birth — it's a
-- group/org record, not a single data subject — but still gets
-- deleted_at/anonymized_at for the same erasure/retention lifecycle.
--
-- All additive (ADD COLUMN IF NOT EXISTS) — safe to re-run, no data rewrite.

ALTER TABLE beneficiaries
  ADD COLUMN IF NOT EXISTS is_minor      BOOLEAN,
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE individual_beneficiaries
  ADD COLUMN IF NOT EXISTS is_minor      BOOLEAN,
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE micro_entrepreneurs
  ADD COLUMN IF NOT EXISTS is_minor      BOOLEAN,
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE collectives
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS audit_log_request_id_idx
  ON audit_log (request_id)
  WHERE request_id IS NOT NULL;
