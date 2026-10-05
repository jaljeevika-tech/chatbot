-- 010_data_correctness.sql — Data correctness layer (Phase A foundation)
--
-- Adds:
--   • reconciliation_checks       — nightly + on-demand drift detection log
--   • daily_reports.quality_flag, quality_confidence
--   • saved_reports.quality_flag, grounding_score
--   • project_deliverables.quality_flag
--
-- All ADDs use IF NOT EXISTS so this migration is idempotent and safe to run
-- multiple times. Pairs with lib/aiAgent.js::initAiLayer() which can also
-- apply these on boot via runtime DDL.

-- ── New table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,
  source_a      TEXT NOT NULL,
  value_a       NUMERIC,
  source_b      TEXT NOT NULL,
  value_b       NUMERIC,
  drift_pct     NUMERIC,
  drift_pass    BOOLEAN,
  period_label  TEXT,
  checked_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_org_metric
  ON reconciliation_checks (org_id, metric, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_recon_drift_fail
  ON reconciliation_checks (org_id, checked_at DESC)
  WHERE drift_pass = false;

-- ── Quality columns on existing tables ──────────────────────────────────────
ALTER TABLE daily_reports
  ADD COLUMN IF NOT EXISTS quality_flag        TEXT,
  ADD COLUMN IF NOT EXISTS quality_confidence  NUMERIC;

ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS quality_flag    TEXT,
  ADD COLUMN IF NOT EXISTS grounding_score NUMERIC,
  ADD COLUMN IF NOT EXISTS lineage         JSONB;
-- lineage shape:
--   { numbers: [{ value: 240, source_ids: ['<daily_reports.id>', ...], context: '…' }],
--     entities: [{ name: 'Khagaria', source_ids: ['…'] }],
--     source_count: 47 }

ALTER TABLE project_deliverables
  ADD COLUMN IF NOT EXISTS quality_flag    TEXT;

-- Index for the manager dashboard "Needs Attention" query
CREATE INDEX IF NOT EXISTS idx_daily_reports_quality
  ON daily_reports (org_id, quality_flag, report_date DESC)
  WHERE quality_flag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_reports_quality
  ON saved_reports (org_id, quality_flag, created_at DESC)
  WHERE quality_flag IS NOT NULL;
