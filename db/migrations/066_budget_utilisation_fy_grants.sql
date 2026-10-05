-- db/migrations/066_budget_utilisation_fy_grants.sql
--
-- Real multi-year projects get their grant SANCTIONED one Financial Year at a
-- time (a donor commits a specific amount for a specific FY period, not one
-- lump sum for the project's whole lifetime) — and a project can start in any
-- calendar month of its first FY, with budget allocated from that month
-- onward. Previously this Financial Tracker had exactly ONE headline "Total
-- Budget" for the entire project (action_plans.budget), which can't express
-- "₹12L for FY25-26, ₹15L for FY26-27".
--
-- This table holds that per-FY grant. action_plans.budget is kept in sync as
-- SUM(total_budget) across every FY here (see resyncFyTotal() in
-- routes/budget-utilisation.routes.js) so existing lifetime-total consumers
-- elsewhere (Portfolio Overview, Project Dashboard cards) keep working
-- unchanged — they only ever wanted "the project's total budget", which is
-- now the sum of every year's grant instead of one manually-set number.
--
-- fy_start_year follows the same Apr-Mar convention as the rest of this
-- codebase (AnnualProgressReportPage.tsx, action-plan.routes.js's AP_MONTHS):
-- FY "2025-26" is stored as fy_start_year = 2025.
CREATE TABLE IF NOT EXISTS budget_utilisation_fy_grants (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key   TEXT         NOT NULL,
  fy_start_year INT          NOT NULL,
  total_budget  NUMERIC      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_utilisation_fy_grants_key
  ON budget_utilisation_fy_grants (org_id, project_key, fy_start_year);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'budget_utilisation_fy_grants' AND policyname = 'budget_utilisation_fy_grants_org_isolation') THEN
    ALTER TABLE budget_utilisation_fy_grants ENABLE ROW LEVEL SECURITY;
    CREATE POLICY budget_utilisation_fy_grants_org_isolation ON budget_utilisation_fy_grants
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- Backfill: every project that already has a lifetime action_plans.budget
-- (set via the old single-figure upload flow) gets that whole amount
-- attributed to its OWN start Financial Year, so existing projects don't
-- suddenly show ₹0 for "All Years" until someone re-uploads. This is a
-- one-time best-effort migration of old data, not a design statement about
-- which year the money actually belonged to — real per-year amounts should
-- be re-entered via the upload flow once this ships.
INSERT INTO budget_utilisation_fy_grants (org_id, project_key, fy_start_year, total_budget)
SELECT ap.org_id, ap.project_key,
       CASE WHEN COALESCE(ap.start_month, 4) >= 4 THEN ap.year ELSE ap.year - 1 END,
       ap.budget
FROM action_plans ap
WHERE ap.budget IS NOT NULL AND ap.budget > 0 AND ap.project_key IS NOT NULL
ON CONFLICT (org_id, project_key, fy_start_year) DO NOTHING;
