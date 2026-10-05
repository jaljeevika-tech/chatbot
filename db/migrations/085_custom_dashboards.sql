-- 085_custom_dashboards.sql — super-admin-built dashboards per org
-- (services/dashboard/src/custom.js; shown in the org's "Custom dashboards" tab).
--
-- Additive + reversible (DROP TABLE custom_dashboards). Run in the Neon SQL Editor as neondb_owner.
--
-- widgets is a JSON array of { id, title, metric, chart, groupBy, projectKey, from, to, wide }.
-- metric/groupBy are validated against the service's fixed catalog on every save,
-- so no SQL is ever stored here.

CREATE TABLE IF NOT EXISTS custom_dashboards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  visible_to  TEXT NOT NULL DEFAULT 'all' CHECK (visible_to IN ('all', 'admin')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  widgets     JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(widgets) = 'array'),
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_dashboards_org ON custom_dashboards (org_id, sort_order);
