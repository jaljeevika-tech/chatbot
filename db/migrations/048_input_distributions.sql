-- db/migrations/048_input_distributions.sql
--
-- Input Distribution — MIS > Input Distribution sub-tab. Structurally
-- identical to Training (046_trainings.sql) — same source-sheet shape
-- (UID, Name, Contact No., Input Distributed, Date, Place), same
-- UID-resolves-to-beneficiary-type upload flow, same blank-UID ->
-- Indirect Beneficiary handling (047) — just a different "what happened"
-- column (input_distributed instead of training_topic). See 046's header
-- for the full rationale; not repeated here.

CREATE TABLE IF NOT EXISTS input_distributions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid    TEXT         NOT NULL,
  beneficiary_type   TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name   TEXT,
  contact_no         TEXT,
  input_distributed  TEXT         NOT NULL,
  distribution_date  DATE,
  place              TEXT,
  uploaded_by        TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_input_distributions_org         ON input_distributions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_input_distributions_beneficiary ON input_distributions (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_input_distributions_type        ON input_distributions (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS input_distributions_upsert_key
  ON input_distributions (org_id, beneficiary_uid, input_distributed, distribution_date);

ALTER TABLE input_distributions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'input_distributions' AND policyname = 'input_distributions_org_isolation') THEN
    CREATE POLICY input_distributions_org_isolation ON input_distributions
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
