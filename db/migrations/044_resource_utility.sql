-- db/migrations/044_resource_utility.sql
--
-- Resource Utility — asked only when Type of Resource is Wetland: which of
-- Fish Farming / Makhan (fox nut) Farming / Singhara (water chestnut)
-- Farming this wetland is used for, each with its own production in KG.
-- Fixed set of 3 known utilities (not open-ended), so — same convention as
-- production_type/current_production_ton elsewhere in this schema — these
-- get explicit columns rather than a JSONB bag. "Selected" is represented
-- implicitly: a non-null KG value (including 0, for "selected but nothing
-- harvested yet") means that utility was checked; NULL means it wasn't.
-- Agricultural Land resources always get NULL here (see services/resource/index.js).
--
-- Table-level GRANT SELECT/INSERT already on resources (migration 043)
-- covers these new columns too — no additional GRANT needed.

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS fish_farming_kg     NUMERIC,
  ADD COLUMN IF NOT EXISTS makhan_farming_kg    NUMERIC,
  ADD COLUMN IF NOT EXISTS singhara_farming_kg  NUMERIC;
