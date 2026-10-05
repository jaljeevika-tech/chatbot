-- db/migrations/016_project_deliverables_table.sql
--
-- BUG: 010_data_correctness.sql runs `ALTER TABLE project_deliverables ADD
-- COLUMN IF NOT EXISTS quality_flag TEXT`, but no .sql migration ever creates
-- project_deliverables — it's only created by lib/aiAgent.js::initAiLayer() at
-- Node process boot time. Replaying db/migrations/*.sql alone (e.g. against a
-- fresh database, or during disaster recovery) fails at 010 with
-- "relation project_deliverables does not exist" unless the app has already
-- booted once. This formalizes that table as a real migration so the
-- migrations directory is self-contained. Matches lib/aiAgent.js's definition
-- exactly; CREATE ... IF NOT EXISTS makes this a no-op on databases where the
-- app already created it at runtime.

CREATE TABLE IF NOT EXISTS project_deliverables (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project     TEXT         NOT NULL,
  indicator   TEXT         NOT NULL,
  planned     NUMERIC,
  achieved    NUMERIC,
  period      TEXT         NOT NULL,
  data_type   TEXT         NOT NULL DEFAULT 'output',
  source_file TEXT,
  uploaded_by TEXT,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_deliverables_org
  ON project_deliverables (org_id, project, period);

CREATE UNIQUE INDEX IF NOT EXISTS project_deliverables_upsert_key
  ON project_deliverables (org_id, project, indicator);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_deliverables' AND policyname = 'project_deliverables_org_isolation') THEN
    ALTER TABLE project_deliverables ENABLE ROW LEVEL SECURITY;
    CREATE POLICY project_deliverables_org_isolation ON project_deliverables
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
