-- 086_builtin_dashboard_layouts.sql — per-org layouts for the built-in dashboards
-- (Org / Project / Impact / Beneficiary Registration), edited by the super admin.
--
-- Additive + reversible:
--   DROP INDEX custom_dashboards_builtin_uniq; ALTER TABLE custom_dashboards DROP COLUMN builtin_key;
-- Run in the Neon SQL Editor as neondb_owner.
--
-- A row with builtin_key set replaces that built-in dashboard's default layout for
-- the org: widgets mixes { chart: 'panel', panel } (an existing section, reordered /
-- removed) with ordinary catalog widgets. No row = the dashboard renders as shipped.
-- Rows with builtin_key are never listed as custom dashboards.

ALTER TABLE custom_dashboards ADD COLUMN IF NOT EXISTS builtin_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS custom_dashboards_builtin_uniq
  ON custom_dashboards (org_id, builtin_key) WHERE builtin_key IS NOT NULL;
