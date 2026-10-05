-- db/migrations/065_budget_utilisation_plan.sql
--
-- Adds a per-month PLANNED figure alongside the existing per-month ACTUAL
-- expense on budget_utilisation_reports, so the Financial Tracker
-- (BudgetUtilisationPage.tsx) can show "this month's actual spend vs this
-- month's planned budget" per line item ("activity") — previously the only
-- planned figure was a single lifetime `budget` per line item, with no
-- month-by-month plan to compare a given month's actual against.
--
-- Nullable and additive only: existing rows (uploaded before this feature)
-- simply have planned_expenses = NULL, which the UI renders as "no plan set"
-- rather than a false 0% utilisation.

ALTER TABLE budget_utilisation_reports
  ADD COLUMN IF NOT EXISTS planned_expenses NUMERIC;
