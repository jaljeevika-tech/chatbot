-- db/migrations/068_cb_production_systems.sql
--
-- Collective Registration: same "Type of Production" -> "Type of
-- Production System" multiselect redesign as
-- 067_ib_production_systems.sql, for the same reason. This field was
-- already optional on the Collective form (unlike Individual
-- Beneficiary's, which was required) — that stays true of the multiselect
-- too: an empty production_systems array is valid.
--
-- production_type / current_production_ton are left in place (NOT
-- dropped) — same "leave the legacy column NULL going forward" pattern as
-- 067. New registrations populate only production_systems.

ALTER TABLE collectives
  ADD COLUMN IF NOT EXISTS production_systems JSONB NOT NULL DEFAULT '[]'::jsonb;
