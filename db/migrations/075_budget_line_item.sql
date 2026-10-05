-- db/migrations/075_budget_line_item.sql
--
-- Adds a "Budget Line Item" field to budget_utilisation_reports — a short
-- code/reference id (e.g. a donor's own budget-line reference number),
-- distinct from BOTH `sr_no` (this app's own row-type marker / display
-- ordering, e.g. "T1", "T2") and `budget_head` (the section/subsection/line
-- item NAME). Display only, like sr_no — not part of the row's identity key
-- (org_id, project_key, period_month, section, budget_head), since a donor's
-- reference numbering is independent of how this app identifies a line item.
--
-- Nullable and additive only: existing rows (uploaded before this feature)
-- simply have budget_line_item = NULL, rendered as blank/"—" in the UI and
-- template, same convention as sr_no/subsection.

ALTER TABLE budget_utilisation_reports
  ADD COLUMN IF NOT EXISTS budget_line_item TEXT;
