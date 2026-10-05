-- db/migrations/026_budget_utilisation_reports.sql
--
-- Supports uploading a hierarchical Budget Utilisation Excel (Section >
-- Subsection > Line item, e.g. PERSONNEL > Program > "Program Manager") for
-- one Financial Year + Month at a time. Same cumulative-snapshot model as
-- annual_progress_reports (024): "Expenses up to date" is cumulative-as-of a
-- date, so each row here IS a full snapshot — nothing is ever summed across
-- rows/months, avoiding the double-counting risk that a flat per-month table
-- would introduce for the existing SUM-based budget_heads consumers.
--
-- Identity is (section, budget_head), NOT the sheet's own "Sr No" column —
-- same lesson already learned with annual_progress_reports.activity_sn:
-- position-based identifiers in real-world exports aren't stable enough to
-- trust as a dedup key.

CREATE TABLE IF NOT EXISTS budget_utilisation_reports (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key   TEXT         NOT NULL,
  fy_start_year INT          NOT NULL,   -- e.g. 2026
  month         TEXT         NOT NULL,   -- one of MONTHS ('Apr'..'Mar')
  section       TEXT         NOT NULL,   -- e.g. "PERSONNEL"
  subsection    TEXT,                    -- e.g. "Program" — nullable, not every section has one
  sr_no         TEXT,                    -- display only, e.g. "T 1.1.1" — NOT the identity key
  budget_head   TEXT         NOT NULL,   -- e.g. "Program Manager"
  budget        NUMERIC,
  expenses      NUMERIC,                 -- cumulative "as of" this month
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS budget_utilisation_org_project
  ON budget_utilisation_reports (org_id, project_key, fy_start_year);

CREATE UNIQUE INDEX IF NOT EXISTS budget_utilisation_upsert_key
  ON budget_utilisation_reports (org_id, project_key, fy_start_year, month, section, budget_head);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'budget_utilisation_reports' AND policyname = 'budget_utilisation_reports_org_isolation') THEN
    ALTER TABLE budget_utilisation_reports ENABLE ROW LEVEL SECURITY;
    CREATE POLICY budget_utilisation_reports_org_isolation ON budget_utilisation_reports
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- budget_heads has never had a writer (confirmed: table is currently empty
-- everywhere), so this constraint is safe to add now, before any real data
-- exists — it protects the section-granularity sync-back this feature adds
-- (see routes/budget-utilisation.routes.js) from ever double-inserting a row
-- per (org, project, head).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_heads_org_project_head_key'
  ) THEN
    ALTER TABLE budget_heads
      ADD CONSTRAINT budget_heads_org_project_head_key UNIQUE (org_id, project_key, head);
  END IF;
END $$;
