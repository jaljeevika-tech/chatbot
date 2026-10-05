-- db/migrations/021_compliance_items.sql
--
-- Compliance Calendar. project_key is NULLABLE: some items (FCRA renewal, 80G
-- certificate) are org-level, not tied to any one project's action plan.
-- Status is derived from due_date vs NOW() (overdue / upcoming / valid) unless
-- manual_status overrides it, same override convention as 018's health/
-- compliance_override columns on action_plans.

CREATE TABLE IF NOT EXISTS compliance_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key    TEXT,
  item           TEXT NOT NULL,
  due_date       DATE,
  manual_status  TEXT CHECK (manual_status IN ('overdue', 'upcoming', 'valid')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS compliance_items_org_proj
  ON compliance_items (org_id, project_key, due_date);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'compliance_items' AND policyname = 'compliance_items_org_isolation') THEN
    ALTER TABLE compliance_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY compliance_items_org_isolation ON compliance_items
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
