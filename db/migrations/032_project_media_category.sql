-- db/migrations/032_project_media_category.sql
--
-- Adds a content/topic category to Media Library uploads (project_media),
-- distinct from media_type (the technical image/video/audio/pdf bucket).
-- Shares the same admin-configurable list as the Document Vault's report
-- categories (organizations.metadata.reportCategories) for one taxonomy
-- across both features — no CHECK constraint, same free-text convention as
-- project_documents.report_category.
ALTER TABLE project_media ADD COLUMN IF NOT EXISTS category TEXT;
