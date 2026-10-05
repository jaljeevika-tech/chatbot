-- db/migrations/020_beneficiaries.sql
--
-- Beneficiaries page: per-project enrollment records. custom_data JSONB lets
-- org-specific extra fields be captured without further schema churn, matching
-- the custom_data JSONB pattern already used for org metadata elsewhere.

CREATE TABLE IF NOT EXISTS beneficiaries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key    TEXT NOT NULL,
  name           TEXT NOT NULL,
  gender         TEXT,
  location       TEXT,
  category       TEXT,
  enrolled_date  DATE,
  status         TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Completed', 'Dropped')),
  custom_data    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS beneficiaries_org_proj
  ON beneficiaries (org_id, project_key, status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'beneficiaries' AND policyname = 'beneficiaries_org_isolation') THEN
    ALTER TABLE beneficiaries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY beneficiaries_org_isolation ON beneficiaries
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
