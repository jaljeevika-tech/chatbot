-- db/migrations/033_budget_utilisation_v2.sql
--
-- Replaces the FY+Month-anchored budget_utilisation_reports (026) with a
-- calendar-agnostic period_month DATE column. The upload format changed:
-- real exports now have ONE COLUMN PER CALENDAR MONTH (real dates as
-- headers), each cell holding THAT MONTH's own actual expense — not a
-- single cumulative "as of" figure per FY+month snapshot. This also lets a
-- project start in any calendar month instead of assuming an April-start
-- fiscal year, which nothing in this feature needs anymore.
--
-- "Cumulative to date" is now a SUM across period_month rows for a line
-- item, computed at read time — never stored, avoiding the double-counting
-- risk the original 026 comment already flagged for a flat per-month table.
--
-- DATA-PRESERVING migration, not a drop-and-recreate: real uploads already
-- exist under the old (fy_start_year, month) schema in production (confirmed
-- 340 rows across 3 projects before this migration was written), so the old
-- table is renamed to a backup, the new table is created alongside it, and
-- every old row is converted into its equivalent real calendar month and
-- copied forward. The mapping is exact and collision-free: the old fiscal
-- month array is always April-anchored (['Apr',...,'Mar']), so
-- (fy_start_year, month) maps 1:1 onto a real (calendar_year, calendar_month)
-- pair, and the old table's own unique key — (org_id, project_key,
-- fy_start_year, month, section, budget_head) — guarantees no two old rows
-- can ever land on the same new (org_id, project_key, period_month, section,
-- budget_head) key. The ON CONFLICT DO NOTHING below is only a defensive
-- no-op for re-running this migration, not something expected to fire.
--
-- Identity remains (section, budget_head), now paired with period_month
-- instead of (fy_start_year, month) — NOT the sheet's own "Sr No" column,
-- same lesson as annual_progress_reports.activity_sn.
--
-- The renamed backup table (budget_utilisation_reports_v1_backup) is left in
-- place, not dropped — safe to drop it yourself once you've confirmed the
-- migrated data looks right in the new dashboard.

-- Only rename if the live table still has the OLD schema (has fy_start_year)
-- and hasn't already been backed up — makes this migration safe to re-run.
-- Renaming a TABLE does NOT rename its INDEXES, and index names must be
-- unique per-schema (not per-table) in Postgres — so the old indexes are
-- explicitly renamed too, freeing up their canonical names for the new
-- table below. Skipping this step silently breaks every `CREATE INDEX IF
-- NOT EXISTS` further down (they'd see the name already taken by the old,
-- still-differently-shaped index and just no-op, leaving the new table with
-- no indexes at all).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'budget_utilisation_reports' AND column_name = 'fy_start_year'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'budget_utilisation_reports_v1_backup'
  ) THEN
    ALTER TABLE budget_utilisation_reports RENAME TO budget_utilisation_reports_v1_backup;
    ALTER INDEX budget_utilisation_reports_pkey RENAME TO budget_utilisation_reports_v1_backup_pkey;
    ALTER INDEX budget_utilisation_org_project RENAME TO budget_utilisation_org_project_v1_backup;
    ALTER INDEX budget_utilisation_upsert_key RENAME TO budget_utilisation_upsert_key_v1_backup;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS budget_utilisation_reports (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key   TEXT         NOT NULL,
  period_month  DATE         NOT NULL,   -- always the 1st of the month, e.g. 2026-04-01
  section       TEXT         NOT NULL,   -- e.g. "PERSONNEL"
  subsection    TEXT,                    -- e.g. "Program" — nullable, not every section has one
  sr_no         TEXT,                    -- display only, e.g. "T1" — NOT the identity key
  budget_head   TEXT         NOT NULL,   -- e.g. "Program Manager"
  budget        NUMERIC,                 -- one-time total for the line item; repeated on every period row
  expenses      NUMERIC,                 -- THIS MONTH's own actual spend, not cumulative
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS budget_utilisation_org_project
  ON budget_utilisation_reports (org_id, project_key, period_month);

CREATE UNIQUE INDEX IF NOT EXISTS budget_utilisation_upsert_key
  ON budget_utilisation_reports (org_id, project_key, period_month, section, budget_head);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'budget_utilisation_reports' AND policyname = 'budget_utilisation_reports_org_isolation') THEN
    ALTER TABLE budget_utilisation_reports ENABLE ROW LEVEL SECURITY;
    CREATE POLICY budget_utilisation_reports_org_isolation ON budget_utilisation_reports
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;

-- Convert every old (fy_start_year, month) row into its real calendar month
-- and copy it forward. calendar_year = fy_start_year, except Jan/Feb/Mar
-- which roll into fy_start_year + 1 (the old array's April-anchored FY
-- wraps the calendar year at January).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'budget_utilisation_reports_v1_backup') THEN
    INSERT INTO budget_utilisation_reports
      (org_id, project_key, period_month, section, subsection, sr_no, budget_head, budget, expenses, uploaded_by, created_at, updated_at)
    SELECT
      org_id, project_key,
      make_date(
        fy_start_year + (CASE WHEN month IN ('Jan', 'Feb', 'Mar') THEN 1 ELSE 0 END),
        (CASE month
           WHEN 'Apr' THEN 4  WHEN 'May' THEN 5  WHEN 'Jun' THEN 6  WHEN 'Jul' THEN 7
           WHEN 'Aug' THEN 8  WHEN 'Sep' THEN 9  WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11
           WHEN 'Dec' THEN 12 WHEN 'Jan' THEN 1  WHEN 'Feb' THEN 2  WHEN 'Mar' THEN 3
         END),
        1
      ) AS period_month,
      section, subsection, sr_no, budget_head, budget, expenses, uploaded_by, created_at, updated_at
    FROM budget_utilisation_reports_v1_backup
    ON CONFLICT (org_id, project_key, period_month, section, budget_head) DO NOTHING;
  END IF;
END $$;

-- budget_heads (022) is unchanged structurally and keeps its existing
-- unique constraint (org_id, project_key, head) from migration 026 — still
-- read by action-plan.routes.js for portfolio/project-card budget% rollups.
-- What changes is WHAT gets written into it: now a cumulative-to-date SUM
-- across every uploaded period_month per section (each line item's most
-- recently-known budget, summed with its cumulative expenses), not one
-- snapshot's value. Resynced here immediately (same logic as
-- resyncBudgetHeads() in routes/budget-utilisation.routes.js) so portfolio/
-- project-card rollups reflect the migrated data right away, not just after
-- the next upload.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'budget_utilisation_reports_v1_backup') THEN
    INSERT INTO budget_heads (org_id, project_key, head, budget, utilised, updated_at)
    SELECT latest_budget.org_id, latest_budget.project_key, latest_budget.section,
           SUM(latest_budget.budget)::numeric, SUM(exp_sum.expenses)::numeric, NOW()
    FROM (
      SELECT DISTINCT ON (org_id, project_key, section, budget_head) org_id, project_key, section, budget_head, budget
      FROM budget_utilisation_reports
      ORDER BY org_id, project_key, section, budget_head, period_month DESC
    ) latest_budget
    JOIN (
      SELECT org_id, project_key, section, budget_head, SUM(expenses) AS expenses
      FROM budget_utilisation_reports
      GROUP BY org_id, project_key, section, budget_head
    ) exp_sum USING (org_id, project_key, section, budget_head)
    GROUP BY latest_budget.org_id, latest_budget.project_key, latest_budget.section
    ON CONFLICT (org_id, project_key, head) DO UPDATE SET budget = EXCLUDED.budget, utilised = EXCLUDED.utilised, updated_at = NOW();
  END IF;
END $$;
