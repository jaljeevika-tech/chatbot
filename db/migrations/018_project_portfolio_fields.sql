-- db/migrations/018_project_portfolio_fields.sql
--
-- Portfolio Overview / Org Dashboard need donor, region, budget, end date,
-- and health/compliance status per action plan ("project"). Health and
-- compliance are computed by default (health from the same on-track/behind
-- math ActionPlanTab.tsx already derives client-side from planned vs achieved;
-- compliance from compliance_items due dates, see 021_compliance_items.sql) —
-- the *_override columns let an admin manually pin a color when the computed
-- one is wrong, mirroring how project_deliverables.quality_flag already works
-- as a soft override elsewhere in this codebase.

ALTER TABLE action_plans
  ADD COLUMN IF NOT EXISTS donor                TEXT,
  ADD COLUMN IF NOT EXISTS region                TEXT,
  ADD COLUMN IF NOT EXISTS budget                NUMERIC,
  ADD COLUMN IF NOT EXISTS end_date              DATE,
  ADD COLUMN IF NOT EXISTS health_override       TEXT CHECK (health_override IN ('green', 'amber', 'red')),
  ADD COLUMN IF NOT EXISTS compliance_override    TEXT CHECK (compliance_override IN ('green', 'amber', 'red'));
