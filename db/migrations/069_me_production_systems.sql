-- db/migrations/069_me_production_systems.sql
--
-- Micro-Entrepreneur Registration: a NEW "Type of Production System"
-- multiselect (Aquaculture/Agriculture/Livestock/Horticulture, each with
-- its own quantity — Quintal for the first three, a headcount for
-- Livestock), same shape and same JSONB-array escape hatch as
-- 067_ib_production_systems.sql / 068_cb_production_systems.sql. Unlike
-- those two, there is no prior single-select field here to replace — this
-- form never had a production_type/current_production_ton pair, since not
-- every micro-enterprise is farming/aquaculture-based (e.g. a tailor, a
-- grocery shop). Optional, same as the Collective form's version.

ALTER TABLE micro_entrepreneurs
  ADD COLUMN IF NOT EXISTS production_systems JSONB NOT NULL DEFAULT '[]'::jsonb;
