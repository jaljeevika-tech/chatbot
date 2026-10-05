-- db/migrations/067_ib_production_systems.sql
--
-- Individual Beneficiary Registration: "Production Type" (single-select
-- Aquaculture/Agriculture, paired with one "Current Production (Ton)"
-- value) becomes "Production System" — a multiselect of Aquaculture /
-- Agriculture / Livestock / Horticulture, each carrying its own quantity:
-- production in Quintal for Aquaculture/Agriculture/Horticulture, a plain
-- headcount ("Number of Livestock") for Livestock. Same JSONB-array escape
-- hatch as 045_resource_production_system.sql's resource_utility, for the
-- same reason — a fixed set of nullable columns doesn't fit "a multiselect
-- with a quantity per entry" once there's more than one shape of quantity.
--
-- Shape: [{"type":"Aquaculture","production_quintal":12.5}, {"type":"Livestock","livestock_count":8}, ...]
--
-- production_type / current_production_ton are left in place (NOT dropped)
-- — existing registrations keep their single legacy value readable, same
-- "leave the legacy column NULL going forward" pattern as
-- 064_pii_encryption_columns.sql. New registrations populate only
-- production_systems; production_type/current_production_ton are NULL for
-- every new row from here on. (The production_type CHECK constraint from
-- 038_individual_beneficiaries.sql is untouched — a NULL value always
-- satisfies a CHECK, so no ALTER is needed there.)

ALTER TABLE individual_beneficiaries
  ADD COLUMN IF NOT EXISTS production_systems JSONB NOT NULL DEFAULT '[]'::jsonb;
