-- db/migrations/049_scheme_access.sql
--
-- Scheme Access — MIS > Scheme Access sub-tab. Structurally identical to
-- Training (046) and Input Distribution (048) — same source-sheet shape
-- (UID, Name, Contact No., Scheme, Date, Place), same
-- UID-resolves-to-beneficiary-type upload flow, same blank-UID ->
-- Indirect Beneficiary handling (047) — just a different "what happened"
-- column (scheme_name instead of training_topic/input_distributed). See
-- 046's header for the full rationale; not repeated here.

CREATE TABLE IF NOT EXISTS scheme_access (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  scheme_name       TEXT         NOT NULL,
  access_date       DATE,
  place             TEXT,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheme_access_org         ON scheme_access (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheme_access_beneficiary ON scheme_access (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_scheme_access_type        ON scheme_access (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS scheme_access_upsert_key
  ON scheme_access (org_id, beneficiary_uid, scheme_name, access_date);

ALTER TABLE scheme_access ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'scheme_access' AND policyname = 'scheme_access_org_isolation') THEN
    CREATE POLICY scheme_access_org_isolation ON scheme_access
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
