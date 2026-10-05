-- db/migrations/022_financial_tracker.sql
--
-- Financial Tracker: budget utilisation by head, and monthly utilisation
-- certificate (UC) submission status, both per-project.

CREATE TABLE IF NOT EXISTS budget_heads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key  TEXT NOT NULL,
  head         TEXT NOT NULL,
  budget       NUMERIC NOT NULL DEFAULT 0,
  utilised     NUMERIC NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS budget_heads_org_proj
  ON budget_heads (org_id, project_key);

CREATE TABLE IF NOT EXISTS utilisation_certificates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key    TEXT NOT NULL,
  period_month   DATE NOT NULL,
  submitted_date DATE,
  status         TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Submitted')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS utilisation_certificates_org_proj
  ON utilisation_certificates (org_id, project_key, period_month DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'budget_heads' AND policyname = 'budget_heads_org_isolation') THEN
    ALTER TABLE budget_heads ENABLE ROW LEVEL SECURITY;
    CREATE POLICY budget_heads_org_isolation ON budget_heads
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'utilisation_certificates' AND policyname = 'utilisation_certificates_org_isolation') THEN
    ALTER TABLE utilisation_certificates ENABLE ROW LEVEL SECURITY;
    CREATE POLICY utilisation_certificates_org_isolation ON utilisation_certificates
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
