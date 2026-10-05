-- Adds an admin-configurable report category and AI-generated tags to each
-- Document Vault file. Distinct from `vault_tab` (the fixed legal/financial/
-- progress/knowledge tab enum) — report_category is a free-text label drawn
-- from the org's admin-managed list (organizations.metadata.reportCategories),
-- so no CHECK constraint here.
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS report_category TEXT;
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
