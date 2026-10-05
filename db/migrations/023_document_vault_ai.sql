-- db/migrations/023_document_vault_ai.sql
--
-- Document Vault AI read: adds a place to store extracted plain text so
-- uploaded documents (PDF/DOCX/XLSX/PPTX) can be viewed/downloaded and
-- grounded into an AI chat (see routes/documents.routes.js,
-- lib/extractDocumentText.js). `status` already existed (defaulting to
-- 'indexed') — it now gets real meaning: 'indexed' when text extraction
-- succeeded, 'unsupported' when the file type can't be parsed or extraction
-- failed.

ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS extracted_text TEXT;
