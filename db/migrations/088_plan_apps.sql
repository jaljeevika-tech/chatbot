-- 088_plan_apps.sql — which sellable apps a plan includes (platform spec Phase 0).
-- NULL = every app, so all existing plans keep everything (no behaviour change).
-- App keys: forms, hr, finance, engage, compliance (lib/subscriptionGuard.js APP_PREFIXES).
--
-- Additive + reversible:  ALTER TABLE plans DROP COLUMN apps;
-- Run in the Neon SQL Editor as neondb_owner. Applied to Neon prod 2026-10-08.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS apps TEXT[];
