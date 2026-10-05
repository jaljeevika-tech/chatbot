-- db/migrations/028_mis_indicators_and_data_sources.sql
--
-- Phase 1 of the MIS module (Indicator Framework + MIS Data Sources) — backs
-- the "MIS & targets" tab in donor-compliance-wireframes/03_mis_targets.png,
-- which previously had no schema/routes/UI at all. Monthly Plan/Actual entry,
-- the calculation engine, and the MIS Dashboard are later phases; this
-- migration only lays down what those depend on.
--
-- Everything is scoped by (org_id, project_key) — same pattern as
-- beneficiary_mis_records (027) / budget_utilisation_reports (026) — so every
-- project gets its own Indicator Framework and Data Sources, not a shared
-- org-wide list.

CREATE TABLE IF NOT EXISTS indicators (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key         TEXT         NOT NULL,
  code                TEXT         NOT NULL,               -- e.g. A1, O1, OC1, IM1
  name                TEXT         NOT NULL,
  level               TEXT         NOT NULL CHECK (level IN ('activity', 'output', 'outcome', 'impact')),
  unit                TEXT,
  frequency           TEXT         NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'annual', 'baseline_endline')),
  aggregation_method  TEXT         NOT NULL DEFAULT 'sum' CHECK (aggregation_method IN ('sum', 'cumulative', 'average', 'latest', 'percentage')),
  data_source         TEXT,                                -- free-text description of where the numbers come from
  responsible_person  TEXT,
  baseline_value       NUMERIC,
  baseline_date         DATE,
  definition          TEXT,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  archived_at         TIMESTAMPTZ,
  created_by          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Prevents duplicate indicator codes within a project (spec requirement).
CREATE UNIQUE INDEX IF NOT EXISTS indicators_org_project_code_key
  ON indicators (org_id, project_key, code);

CREATE INDEX IF NOT EXISTS indicators_org_project_idx
  ON indicators (org_id, project_key, level);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indicators' AND policyname = 'indicators_org_isolation') THEN
    ALTER TABLE indicators ENABLE ROW LEVEL SECURITY;
    CREATE POLICY indicators_org_isolation ON indicators
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- ── Disaggregation dimensions ────────────────────────────────────────────────
-- One row per dimension an indicator is disaggregated by (gender, age group,
-- social category, ...). No value enum here — the actual breakdown values
-- live wherever the monthly entry / dashboard phase reads them from.
CREATE TABLE IF NOT EXISTS indicator_disaggregations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_id  UUID        NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  dimension     TEXT        NOT NULL CHECK (dimension IN (
                  'gender', 'age_group', 'social_category', 'disability', 'geography',
                  'occupation', 'intervention_type', 'shg_membership', 'waterbody', 'beneficiary_category'
                )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (indicator_id, dimension)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indicator_disaggregations' AND policyname = 'indicator_disaggregations_org_isolation') THEN
    ALTER TABLE indicator_disaggregations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY indicator_disaggregations_org_isolation ON indicator_disaggregations
      USING (indicator_id IN (SELECT id FROM indicators WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
  END IF;
END $$;

-- ── Targets ───────────────────────────────────────────────────────────────
-- One row per (indicator, financial year, scope[, scope_value]) — e.g. the
-- project-wide FY26 target, or a geography-specific FY26 target for "Supaul".
-- scope_value is free text for now (a normalized geography-master table is a
-- later-phase concern); NULL when scope is 'org' or 'project'.
CREATE TABLE IF NOT EXISTS indicator_targets (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_id    UUID         NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  fy_start_year   INT          NOT NULL,
  scope           TEXT         NOT NULL CHECK (scope IN ('org', 'project', 'geography', 'gender', 'beneficiary_category')),
  scope_value     TEXT,
  annual_target   NUMERIC,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- COALESCE so two NULL scope_values (both 'org'/'project' scope) still
-- collide correctly instead of Postgres treating each NULL as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS indicator_targets_key
  ON indicator_targets (indicator_id, fy_start_year, scope, COALESCE(scope_value, ''));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indicator_targets' AND policyname = 'indicator_targets_org_isolation') THEN
    ALTER TABLE indicator_targets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY indicator_targets_org_isolation ON indicator_targets
      USING (indicator_id IN (SELECT id FROM indicators WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
  END IF;
END $$;

-- ── MIS Data Sources ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_sources (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key         TEXT         NOT NULL,
  name                TEXT         NOT NULL,
  source_type         TEXT         NOT NULL CHECK (source_type IN ('excel', 'csv', 'google_sheet')),
  import_type         TEXT         NOT NULL CHECK (import_type IN (
                        'indicator_framework', 'monthly_plan_actual', 'beneficiary_master',
                        'beneficiary_intervention', 'baseline_current', 'training_attendance',
                        'market_linkage', 'geography_master'
                      )),
  status              TEXT         NOT NULL DEFAULT 'draft' CHECK (status IN (
                        'draft', 'uploaded', 'mapping_required', 'validation_failed', 'ready_to_import',
                        'importing', 'imported', 'partially_imported', 'sync_failed', 'archived'
                      )),
  original_filename   TEXT,
  file_size_bytes     BIGINT,
  sheet_name          TEXT,
  google_sheet_url    TEXT,
  google_sheet_id     TEXT,
  last_synced_at      TIMESTAMPTZ,
  mapping_config      JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- { sourceColumn: targetField }
  row_counts          JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- { valid, invalid, duplicate, warning }
  error_rows          JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- capped sample of invalid rows for the error-file download
  created_by          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  archived_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS data_sources_org_project_idx
  ON data_sources (org_id, project_key, status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'data_sources' AND policyname = 'data_sources_org_isolation') THEN
    ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
    CREATE POLICY data_sources_org_isolation ON data_sources
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- Append-only history of confirmed imports (one row per explicit "Import" click).
CREATE TABLE IF NOT EXISTS data_source_imports (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id          UUID         NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  imported_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  imported_by             TEXT,
  valid_count             INT          NOT NULL DEFAULT 0,
  invalid_count           INT          NOT NULL DEFAULT 0,
  duplicate_count         INT          NOT NULL DEFAULT 0,
  warning_count           INT          NOT NULL DEFAULT 0,
  mapping_config_snapshot JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS data_source_imports_source_idx
  ON data_source_imports (data_source_id, imported_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'data_source_imports' AND policyname = 'data_source_imports_org_isolation') THEN
    ALTER TABLE data_source_imports ENABLE ROW LEVEL SECURITY;
    CREATE POLICY data_source_imports_org_isolation ON data_source_imports
      USING (data_source_id IN (SELECT id FROM data_sources WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
  END IF;
END $$;

-- Generic landing table for import types that don't have a dedicated live
-- table yet (beneficiary_intervention, baseline_current, training_attendance,
-- market_linkage, geography_master). Rows land here validated but "staged" —
-- nothing reads them until the Monthly Entry / Dashboard phases need them.
-- indicator_framework rows go to `indicators`; beneficiary_master rows go to
-- the existing `beneficiary_mis_records` (027) instead of landing here.
CREATE TABLE IF NOT EXISTS data_source_staged_rows (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id  UUID         NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  row_index       INT          NOT NULL,
  row_data        JSONB        NOT NULL,
  is_valid        BOOLEAN      NOT NULL DEFAULT true,
  errors          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS data_source_staged_rows_source_idx
  ON data_source_staged_rows (data_source_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'data_source_staged_rows' AND policyname = 'data_source_staged_rows_org_isolation') THEN
    ALTER TABLE data_source_staged_rows ENABLE ROW LEVEL SECURITY;
    CREATE POLICY data_source_staged_rows_org_isolation ON data_source_staged_rows
      USING (data_source_id IN (SELECT id FROM data_sources WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
  END IF;
END $$;

-- ── audit_log ─────────────────────────────────────────────────────────────
-- Correction after checking the live DB: audit_log is NOT missing — it's
-- created at runtime by lib/aiAgent.js's initAiLayer() (id BIGSERIAL,
-- actor_uid TEXT NOT NULL), not by any file in db/migrations. This
-- CREATE TABLE IF NOT EXISTS is therefore a no-op wherever that's already
-- run; it only matters as a fallback for a fresh DB that hasn't. The RLS
-- policy below, however, is new — the aiAgent.js version never enabled RLS
-- on this table, so this migration adds real isolation to it for the first
-- time (columns are otherwise identical, so every existing INSERT still works).
-- Matches lib/aiAgent.js's initAiLayer() schema exactly (id BIGSERIAL,
-- actor_uid NOT NULL) so this is a true no-op wherever that's already run.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL    PRIMARY KEY,
  org_id       UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_uid    TEXT         NOT NULL,
  actor_name   TEXT,
  action       TEXT         NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  diff         JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_org_target_idx
  ON audit_log (org_id, target_type, target_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'audit_log_org_isolation') THEN
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    CREATE POLICY audit_log_org_isolation ON audit_log
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
