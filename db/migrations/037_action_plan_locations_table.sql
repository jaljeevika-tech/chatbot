-- db/migrations/037_action_plan_locations_table.sql
--
-- A project can now cover more than one location — multiple Districts,
-- Blocks, Panchayats and/or Villages, each independently selected via the
-- "+ New Project" form's cascading LGD fields (035_lgd_admin_divisions.sql).
-- Each row here is one complete, independently-chosen State→...→Village
-- chain (not all levels required — a location can stop at District).
--
-- The singular location_* columns added on action_plans in
-- 036_action_plan_lgd_location.sql are left in place as a denormalized
-- "primary location" (the first entry) for any simple single-value display;
-- this table is the source of truth for the full list.

CREATE TABLE IF NOT EXISTS action_plan_locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_plan_id  UUID NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state_code      INTEGER REFERENCES lgd_states(code),
  state_name      TEXT,
  district_code   INTEGER REFERENCES lgd_districts(code),
  district_name   TEXT,
  block_code      INTEGER REFERENCES lgd_blocks(code),
  block_name      TEXT,
  panchayat_code  INTEGER REFERENCES lgd_panchayats(code),
  panchayat_name  TEXT,
  village_code    INTEGER REFERENCES lgd_villages(code),
  village_name    TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS action_plan_locations_plan ON action_plan_locations (action_plan_id, sort_order);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'action_plan_locations' AND policyname = 'action_plan_locations_org_isolation') THEN
    ALTER TABLE action_plan_locations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY action_plan_locations_org_isolation ON action_plan_locations
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
