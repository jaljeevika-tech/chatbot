-- db/migrations/051_business_development_support.sql
--
-- Business Development Support — MIS > Business Development Support
-- sub-tab. Structurally identical to Training (046) / Input Distribution
-- (048) / Scheme Access (049) — same source-sheet shape (UID, Name,
-- Contact No., Business Development Support, Date, Place), same
-- UID-resolves-to-beneficiary-type upload flow, same blank-UID ->
-- Indirect Beneficiary handling (047) — just a different "what happened"
-- column (support_provided instead of training_topic/input_distributed/
-- scheme_name). See 046's header for the full rationale; not repeated here.

CREATE TABLE IF NOT EXISTS business_development_support (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  support_provided  TEXT         NOT NULL,
  support_date      DATE,
  place             TEXT,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_development_support_org         ON business_development_support (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_development_support_beneficiary ON business_development_support (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_business_development_support_type        ON business_development_support (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS business_development_support_upsert_key
  ON business_development_support (org_id, beneficiary_uid, support_provided, support_date);

ALTER TABLE business_development_support ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_development_support' AND policyname = 'business_development_support_org_isolation') THEN
    CREATE POLICY business_development_support_org_isolation ON business_development_support
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
