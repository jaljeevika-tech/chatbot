-- db/migrations/077_budget_grant_period.sql
-- Records the upload period ("From month" – "To month" on the Budget
-- Utilisation upload form) that a project's headline Total Budget was
-- entered for. The grant stays keyed by fy_start_year (the FY "From month"
-- falls in — see 066_budget_utilisation_fy_grants.sql), but the figure is
-- really for THIS period, which can be shorter than an Apr–Mar FY or run
-- across two FYs (e.g. an Oct–Sep project year). The Financial Tracker's
-- KPI cards scope Total Budget / Expenses / Balance to this period instead
-- of assuming Apr–Mar. NULL on both = the plain Apr–Mar FY (every grant
-- entered before this migration).
--
-- Additive and reversible:
--   ALTER TABLE budget_utilisation_fy_grants DROP COLUMN period_from, DROP COLUMN period_to;

ALTER TABLE budget_utilisation_fy_grants ADD COLUMN IF NOT EXISTS period_from DATE;
ALTER TABLE budget_utilisation_fy_grants ADD COLUMN IF NOT EXISTS period_to   DATE;
