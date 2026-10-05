-- db/migrations/027_beneficiary_mis_records.sql
--
-- Beneficiary MIS records — replaces the old bare "Beneficiaries" tab
-- (beneficiaries table) with a richer per-beneficiary dataset matching a
-- real fisheries/livelihoods MIS export (Block > Panchayat > Village, farmer
-- details, trainings, social security schemes, convergence, PG membership,
-- and a long tail of livelihood-component flags), plus income/convergence
-- amounts realised in Rs.
--
-- Identity note: unlike 024_annual_progress_reports.sql (where Sl No is
-- blank in practice and thus useless as identity), this sheet's "Sl No" IS
-- populated and unique per block in the real export (verified against the
-- actual Kosi Sahjivan file: 0 collisions across all 5 blocks, 1491 rows).
-- (block, village, beneficiary_name) was tried first and rejected — the
-- real data has ~110 *different* people sharing the same
-- (village, name) pair (e.g. multiple "Ravindra mukhiya" in the same
-- village with different contact numbers), which silently merged distinct
-- beneficiaries on upload. (block, sl_no, beneficiary_name) is the
-- collision-free identity: sl_no falls back to upload-time row position
-- when blank (a handful of rows in one block sheet), and the name guards
-- against the rare case of two blank/duplicate Sl No values landing on the
-- same fallback position.
--
-- The ~25 training/scheme/component columns vary in shape (Yes/No, a date,
-- an FY string, a scheme name) and are individually low-value for direct SQL
-- filtering, so they're kept in `attributes` JSONB (same escape-hatch
-- pattern as beneficiaries.custom_data / users.custom_data) rather than each
-- getting its own column. Only the fields needed for fast
-- filtering/aggregation (location hierarchy, beneficiary type, the two Rs.
-- sums) are first-class columns.

CREATE TABLE IF NOT EXISTS beneficiary_mis_records (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key             TEXT         NOT NULL,
  block                   TEXT         NOT NULL,
  panchayat               TEXT,
  village                 TEXT,
  sl_no                   INT,                     -- derived row-position display number — NOT the identity key (see above)
  beneficiary_name        TEXT         NOT NULL,
  farmer_id               TEXT,
  contact_no              TEXT,
  benf_type               TEXT,                    -- Individual/Cooperative Member/Both/Fish Vendor/All
  cooperative_name        TEXT,
  cultivating_area_katha  NUMERIC,
  cultivating_area_acre   NUMERIC,
  income_realised         NUMERIC,
  convergence_amount      NUMERIC,
  attributes              JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- trainings, social security, convergence, PG/livelihood-component flags — raw values keyed by normalized field name
  uploaded_by             TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS beneficiary_mis_org_project
  ON beneficiary_mis_records (org_id, project_key, block);

-- DROP + recreate (not just IF NOT EXISTS) so re-running this file after the
-- identity-key fix above also repairs a database where the original
-- (block, village, beneficiary_name) index was already created.
DROP INDEX IF EXISTS beneficiary_mis_upsert_key;
CREATE UNIQUE INDEX beneficiary_mis_upsert_key
  ON beneficiary_mis_records (org_id, project_key, block, sl_no, beneficiary_name);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'beneficiary_mis_records' AND policyname = 'beneficiary_mis_records_org_isolation') THEN
    ALTER TABLE beneficiary_mis_records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY beneficiary_mis_records_org_isolation ON beneficiary_mis_records
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
