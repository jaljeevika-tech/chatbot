-- db/migrations/025_annual_progress_category.sql
--
-- AI-assigned category (Training, Exposure Visit, Enterprise & Livelihood, ...)
-- for annual_progress_reports activities — the uploaded template has no
-- category column of its own (unlike action_plans.activities, which gets one
-- straight from its Excel sheet), so this is populated on demand via
-- POST /api/action-plans/:id/annual-progress/categorize, not at upload time.

ALTER TABLE annual_progress_reports
  ADD COLUMN IF NOT EXISTS category TEXT;
