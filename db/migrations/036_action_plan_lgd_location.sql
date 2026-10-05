-- db/migrations/036_action_plan_lgd_location.sql
--
-- Structured LGD location (State/District/Block/Panchayat/Village + official
-- government codes) captured by the "+ New Project" form's cascading
-- dropdowns, see 035_lgd_admin_divisions.sql. The existing free-text
-- region TEXT / locations TEXT[] columns (018_project_portfolio_fields.sql)
-- are left as-is and keep being populated with a human-readable display
-- string ("Village, Block, District, State") for anything that already
-- reads them (Portfolio Overview, reports) — these new columns are additive.

ALTER TABLE action_plans
  ADD COLUMN IF NOT EXISTS location_state_code      INTEGER REFERENCES lgd_states(code),
  ADD COLUMN IF NOT EXISTS location_state_name      TEXT,
  ADD COLUMN IF NOT EXISTS location_district_code   INTEGER REFERENCES lgd_districts(code),
  ADD COLUMN IF NOT EXISTS location_district_name   TEXT,
  ADD COLUMN IF NOT EXISTS location_block_code       INTEGER REFERENCES lgd_blocks(code),
  ADD COLUMN IF NOT EXISTS location_block_name       TEXT,
  ADD COLUMN IF NOT EXISTS location_panchayat_code   INTEGER REFERENCES lgd_panchayats(code),
  ADD COLUMN IF NOT EXISTS location_panchayat_name   TEXT,
  ADD COLUMN IF NOT EXISTS location_village_code     INTEGER REFERENCES lgd_villages(code),
  ADD COLUMN IF NOT EXISTS location_village_name     TEXT;
