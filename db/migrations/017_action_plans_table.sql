-- db/migrations/017_action_plans_table.sql
--
-- action_plans is only created by lib/aiAgent.js::initAiLayer() at Node process
-- boot time (Action Plan v3, multi-project Excel upload). Replaying
-- db/migrations/*.sql alone (fresh database / disaster recovery) has no table
-- for downstream migrations (018+) to ALTER unless the app has already booted
-- once. This formalizes it as a real migration, matching lib/aiAgent.js's
-- definition exactly. CREATE ... IF NOT EXISTS makes this a no-op where the
-- app already created it at runtime. Mirrors 016_project_deliverables_table.sql.

CREATE TABLE IF NOT EXISTS action_plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key  TEXT NOT NULL,
  name         TEXT NOT NULL,
  year         INT,
  start_month  INT  DEFAULT 4,
  locations    TEXT[] NOT NULL DEFAULT '{}',
  activities   JSONB  NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active       BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (org_id, project_key)
);

CREATE INDEX IF NOT EXISTS action_plans_org_active
  ON action_plans (org_id, active, updated_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'action_plans' AND policyname = 'action_plans_org_isolation') THEN
    ALTER TABLE action_plans ENABLE ROW LEVEL SECURITY;
    CREATE POLICY action_plans_org_isolation ON action_plans
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
