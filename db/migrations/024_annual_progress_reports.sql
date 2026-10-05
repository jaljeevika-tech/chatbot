-- db/migrations/024_annual_progress_reports.sql
--
-- Supports a recurring "Annual Progress Report" Excel upload shape distinct
-- from action_plans.activities[].locations[].monthly: each row here IS a full
-- cumulative-to-date snapshot (target + achievement total + per-location
-- achievement, as of one financial-year/month) rather than an independent
-- monthly increment. That's deliberate — action_plans/project_deliverables
-- assume a year's total is the SUM of 12 independent monthly entries
-- (see ActionPlanTab.tsx's activityTotal()/yearStats), so writing a cumulative
-- "as of June" number into a single month's cell there would double-count
-- once summed against later months. Storing snapshots in their own table,
-- keyed by (project, financial year, month, activity), avoids that: nothing
-- is ever summed across rows, so re-uploading a later month never corrupts
-- an earlier one, and re-uploading the same month just corrects it in place.
--
-- Identity note: real-world exports of this template leave the "S.N." column
-- blank (confirmed against an actual uploaded file), so activity_sn is only a
-- derived display number (row position at upload time), NOT a stable identity
-- across months — a later upload with reordered/added/removed rows would
-- desync a position-based key. activity_name (the one field that's actually
-- populated and semantically stable month to month) is the real identity.

CREATE TABLE IF NOT EXISTS annual_progress_reports (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key        TEXT         NOT NULL,
  fy_start_year      INT          NOT NULL,   -- e.g. 2026, same convention as action_plans.year / periodMath.js currentFY()
  month              TEXT         NOT NULL,   -- one of MONTHS ('Apr'..'Mar')
  activity_sn        INT,                     -- derived row-position display number — NOT the identity key (see above)
  activity_name      TEXT         NOT NULL,
  target             NUMERIC,
  achievement_total  NUMERIC,                 -- cumulative total as of this month
  locations          JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- { "Kusheshwar Sthan": 53, ... } cumulative-as-of-this-month per location
  related_link       TEXT,
  remark             TEXT,
  uploaded_by        TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS annual_progress_org_project
  ON annual_progress_reports (org_id, project_key, fy_start_year);

CREATE UNIQUE INDEX IF NOT EXISTS annual_progress_upsert_key
  ON annual_progress_reports (org_id, project_key, fy_start_year, month, activity_name);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'annual_progress_reports' AND policyname = 'annual_progress_reports_org_isolation') THEN
    ALTER TABLE annual_progress_reports ENABLE ROW LEVEL SECURITY;
    CREATE POLICY annual_progress_reports_org_isolation ON annual_progress_reports
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
