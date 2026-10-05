-- 012_subject_employee_in_saved_reports.sql
-- "Generate Report for Other" — adds subject/generator attribution to saved AI reports
--
-- Additive only. Idempotent (IF NOT EXISTS everywhere). Safe to re-run.

ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS subject_employee_ids   UUID[],
  ADD COLUMN IF NOT EXISTS subject_employee_names TEXT[],
  ADD COLUMN IF NOT EXISTS generated_by_name      TEXT,
  ADD COLUMN IF NOT EXISTS report_kind            TEXT;  -- 'self' | 'for_other' | 'team' | NULL (legacy)

-- GIN index lets "show me all reports about employee X" run in O(log n).
-- Used by the Performance Review modal footer link + the "On you" filter chip
-- in the employee Saved Reports view.
CREATE INDEX IF NOT EXISTS idx_saved_reports_subjects
  ON saved_reports USING GIN (subject_employee_ids);

-- Secondary partial index for the kind filter on the Saved Reports list.
CREATE INDEX IF NOT EXISTS idx_saved_reports_kind
  ON saved_reports (org_id, report_kind, created_at DESC)
  WHERE report_kind IS NOT NULL;
