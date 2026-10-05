-- db/migrations/071_income.sql
--
-- Income — MIS > Income sub-tab, tenth category alongside Training and its
-- eight siblings (046/048-056). Same shape: one Excel upload button, each
-- row identifies its beneficiary purely by UID (IB-/EB-/CB- prefix), and the
-- upload endpoint (routes/income.routes.js) resolves that UID against
-- individual_beneficiaries / micro_entrepreneurs / collectives server-side —
-- see 046_trainings.sql's header for the full rationale (same UID-routing,
-- same monolith-bypasses-RLS reasoning, same Indirect Beneficiary handling
-- for a blank UID via 047_indirect_beneficiaries.sql).
--
-- Unlike Training, the source sheet has no Contact No. column (UID, Name,
-- Financial Year, Source, Income realised in INR, Place) — a blank-UID row
-- still becomes an Indirect Beneficiary, just matched by name only (no phone
-- number to key off), same fallback resolveIndirectBeneficiary already has.
--
-- income_source is a fixed dropdown (not free text) — the eight income
-- streams the org tracks per beneficiary per financial year. A beneficiary
-- can have income from more than one source in the same year, so identity
-- (see the upsert key below) is per beneficiary+year+source, not just
-- beneficiary+year — one row per source, same "long" shape the rest of MIS
-- uses rather than one wide row with 8 amount columns.
--
-- project_key is included from birth (this table postdates
-- 058_mis_project_scoping.sql), unlike the original nine which had it
-- retrofitted.

CREATE TABLE IF NOT EXISTS income (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  financial_year    TEXT         NOT NULL,
  income_source     TEXT         NOT NULL CHECK (income_source IN ('Fisheries', 'Agriculture', 'Horticulture', 'Livestock', 'Trade', 'Service', 'Labour', 'Other')),
  income_realised   NUMERIC,
  place             TEXT,
  project_key       TEXT         NOT NULL,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_income_org         ON income (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_income_beneficiary ON income (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_income_type        ON income (org_id, beneficiary_type);
CREATE INDEX IF NOT EXISTS idx_income_project     ON income (org_id, project_key, created_at DESC);

-- Re-uploading the same sheet updates rather than duplicates — identity is
-- (beneficiary, financial year, source), same "safe to re-run" spirit as
-- trainings_upsert_key.
CREATE UNIQUE INDEX IF NOT EXISTS income_upsert_key
  ON income (org_id, project_key, beneficiary_uid, financial_year, income_source);

ALTER TABLE income ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'income' AND policyname = 'income_org_isolation') THEN
    CREATE POLICY income_org_isolation ON income
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
