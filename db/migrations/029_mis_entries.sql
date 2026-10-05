-- db/migrations/029_mis_entries.sql
--
-- Phase 2 of the MIS module: Monthly Plan/Actual entry + evidence, backing
-- the Draft -> Submitted -> Verified -> Approved/Rejected -> Reopened
-- workflow (spec §8). See routes/mis-entries.routes.js and
-- lib/misCalculations.js for how these rows get turned into cumulative
-- plan/actual/achievement figures — this table stores one MONTH'S INCREMENT
-- per row, never a running cumulative total (that distinction matters: see
-- 024_annual_progress_reports.sql for the opposite convention and why mixing
-- the two would double-count).
--
-- scope/scope_value mirrors indicator_targets (028) instead of a bespoke
-- geography column, so actuals and targets compare on the same key.

CREATE TABLE IF NOT EXISTS indicator_monthly_entries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key     TEXT         NOT NULL,
  indicator_id    UUID         NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  fy_start_year   INT          NOT NULL,
  month           TEXT         NOT NULL CHECK (month IN ('Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar')),
  scope           TEXT         NOT NULL DEFAULT 'project' CHECK (scope IN ('org', 'project', 'geography', 'gender', 'beneficiary_category')),
  scope_value     TEXT,
  plan            NUMERIC,
  actual          NUMERIC,
  remarks         TEXT,
  status          TEXT         NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'verified', 'approved', 'rejected')),
  submitted_at    TIMESTAMPTZ,
  submitted_by    TEXT,
  verified_at     TIMESTAMPTZ,
  verified_by     TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  rejected_at     TIMESTAMPTZ,
  rejected_by     TEXT,
  rejected_reason TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One entry per indicator/month/scope combination — COALESCE so two 'project'
-- scope rows (both scope_value NULL) still collide correctly, same idiom as
-- indicator_targets_key in 028.
CREATE UNIQUE INDEX IF NOT EXISTS indicator_monthly_entries_key
  ON indicator_monthly_entries (indicator_id, fy_start_year, month, scope, COALESCE(scope_value, ''));

CREATE INDEX IF NOT EXISTS indicator_monthly_entries_org_project_idx
  ON indicator_monthly_entries (org_id, project_key, fy_start_year, status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indicator_monthly_entries' AND policyname = 'indicator_monthly_entries_org_isolation') THEN
    ALTER TABLE indicator_monthly_entries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY indicator_monthly_entries_org_isolation ON indicator_monthly_entries
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- ── Evidence ──────────────────────────────────────────────────────────────
-- Same inline-base64-in-Postgres pattern as project_documents (019) — no
-- object storage wired up in this codebase yet. One row per file (not a
-- JSONB array) so a single file can be streamed back without parsing the
-- whole entry row.
CREATE TABLE IF NOT EXISTS indicator_entry_evidence (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      UUID         NOT NULL REFERENCES indicator_monthly_entries(id) ON DELETE CASCADE,
  filename      TEXT         NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  data_base64   TEXT         NOT NULL,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS indicator_entry_evidence_entry_idx
  ON indicator_entry_evidence (entry_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indicator_entry_evidence' AND policyname = 'indicator_entry_evidence_org_isolation') THEN
    ALTER TABLE indicator_entry_evidence ENABLE ROW LEVEL SECURITY;
    CREATE POLICY indicator_entry_evidence_org_isolation ON indicator_entry_evidence
      USING (entry_id IN (SELECT id FROM indicator_monthly_entries WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
  END IF;
END $$;
