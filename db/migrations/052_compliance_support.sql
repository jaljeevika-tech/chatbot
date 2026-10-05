-- db/migrations/052_compliance_support.sql
--
-- Compliance Support — MIS > Compliance Support sub-tab. Structurally
-- identical to Training (046) / Input Distribution (048) / Scheme Access
-- (049) / Business Development Support (051) — same source-sheet shape
-- (UID, Name, Contact No., Compliance Support, Date, Place), same
-- UID-resolves-to-beneficiary-type upload flow, same blank-UID ->
-- Indirect Beneficiary handling (047) — just a different "what happened"
-- column (compliance_support_provided). See 046's header for the full
-- rationale; not repeated here. This is the sixth and last MIS category
-- from the original spec (Training, Input Distribution, Scheme Access,
-- Credit/Grant Access, Business Development Support, Compliance Support).

CREATE TABLE IF NOT EXISTS compliance_support (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid             TEXT         NOT NULL,
  beneficiary_type            TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name            TEXT,
  contact_no                  TEXT,
  compliance_support_provided TEXT         NOT NULL,
  support_date                DATE,
  place                       TEXT,
  uploaded_by                 TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_support_org         ON compliance_support (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_support_beneficiary ON compliance_support (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_compliance_support_type        ON compliance_support (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS compliance_support_upsert_key
  ON compliance_support (org_id, beneficiary_uid, compliance_support_provided, support_date);

ALTER TABLE compliance_support ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'compliance_support' AND policyname = 'compliance_support_org_isolation') THEN
    CREATE POLICY compliance_support_org_isolation ON compliance_support
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
