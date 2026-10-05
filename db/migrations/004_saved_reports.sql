-- Migration 004: Saved AI Reports
-- Stores AI-generated field reports so users can revisit them

CREATE TABLE IF NOT EXISTS saved_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   TEXT        NOT NULL,   -- Firebase UID
  title        TEXT        NOT NULL,
  content      TEXT        NOT NULL,   -- Full markdown text
  report_count INT         NOT NULL DEFAULT 0,
  filters      JSONB,                  -- snapshot of ActiveFilters used
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast per-org listing
CREATE INDEX IF NOT EXISTS idx_saved_reports_org ON saved_reports(org_id, created_at DESC);

-- RLS: only rows belonging to the current org are visible
ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY saved_reports_org_isolation ON saved_reports
  USING (org_id = current_setting('app.current_org_id', TRUE)::uuid);
