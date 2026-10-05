-- db/migrations/045_resource_production_system.sql
--
-- Resource Registration redesign: "Type of Resource" (Wetland/Agricultural
-- Land) becomes "Type of Production System" (Freshwater Wetland / Coastal
-- Wetland / Agricultural Land / Brackish Water), each branching into its
-- own follow-up questions:
--
--   Freshwater Wetland -> Type of Resource (Chour/Moen/Dhar/Pond)
--                       -> Area (Acre)
--                       -> Resource Access (Owned/Leased/Common)
--                       -> Resource Utility multiselect (Fishery/Makhana/Singhara) + KG each
--   Coastal Wetland     -> Type of Resource (Raft/Mangroves)
--                            Raft      -> No. of Raft -> Resource Utility multiselect
--                                         (Seaweed/Oyster/Mussel/Fish/Crab) + KG each
--                            Mangroves -> Area (Acre)
--   Agricultural Land   -> Area (Acre)
--                       -> Resource Utility multiselect (Bio Fortified Crop/Millet Crop/
--                          Pulse Crop/Grain Crop/Oil Seed Crop) + KG each
--   Brackish Water      -> (no follow-up questions yet)
--
-- The three fixed wetland-utility columns from 044 (fish_farming_kg/
-- makhan_farming_kg/singhara_farming_kg) only ever covered ONE of what are
-- now three differently-shaped multiselect-with-quantity lists (3 options,
-- 5 options, 5 options, and growing). Rather than keep adding a nullable
-- column per option across an expanding set of branches, this collapses
-- them into one JSONB array — same escape-hatch pattern as
-- beneficiary_mis_records.attributes for "varies in shape, individually
-- low-value for direct SQL filtering" data: [{"utility":"Fishery","production_kg":120}, ...].
--
-- resources currently has 0 rows in production (confirmed before writing
-- this migration) so there's no real data to preserve across the dropped
-- columns / changed CHECK constraints.

-- ── Retire the old wetland-only utility columns ──────────────────────────────
ALTER TABLE resources
  DROP COLUMN IF EXISTS fish_farming_kg,
  DROP COLUMN IF EXISTS makhan_farming_kg,
  DROP COLUMN IF EXISTS singhara_farming_kg;

-- ── New branch-specific columns ───────────────────────────────────────────────
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS water_body_type   TEXT CHECK (water_body_type IN ('Chour', 'Moen', 'Dhar', 'Pond')),
  ADD COLUMN IF NOT EXISTS resource_access   TEXT CHECK (resource_access IN ('Owned', 'Leased', 'Common')),
  ADD COLUMN IF NOT EXISTS wetland_structure TEXT CHECK (wetland_structure IN ('Raft', 'Mangroves')),
  ADD COLUMN IF NOT EXISTS raft_count        INTEGER,
  ADD COLUMN IF NOT EXISTS resource_utility  JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── resource_type: Wetland/Agricultural Land -> the 4 production systems ────
-- resource_seq rows keyed by the retired 'Wetland' value can't survive the
-- new CHECK below (it's no longer in the allowed set) — safe to drop, it's
-- just a counter, not historical data. 'Agricultural Land' stays valid and
-- is left untouched, so its running count is unaffected.
DELETE FROM resource_seq WHERE resource_type = 'Wetland';

ALTER TABLE resources        DROP CONSTRAINT IF EXISTS resources_resource_type_check;
ALTER TABLE resource_seq     DROP CONSTRAINT IF EXISTS resource_seq_resource_type_check;

ALTER TABLE resources ADD CONSTRAINT resources_resource_type_check
  CHECK (resource_type IN ('Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water'));
ALTER TABLE resource_seq ADD CONSTRAINT resource_seq_resource_type_check
  CHECK (resource_type IN ('Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water'));
