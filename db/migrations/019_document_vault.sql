-- db/migrations/019_document_vault.sql
--
-- Document Vault: per-project files grouped into 4 tabs (legal/financial/
-- progress/knowledge). project_key is a loose TEXT match against
-- action_plans.project_key (no FK), matching the existing loose-coupling
-- convention project_deliverables already uses — plans can be soft-deleted
-- and restored, so a hard FK would complicate that flow.

CREATE TABLE IF NOT EXISTS project_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key  TEXT NOT NULL,
  vault_tab    TEXT NOT NULL DEFAULT 'legal' CHECK (vault_tab IN ('legal', 'financial', 'progress', 'knowledge')),
  name         TEXT NOT NULL,
  file_type    TEXT,
  storage_path TEXT NOT NULL,
  uploaded_by  TEXT,
  status       TEXT NOT NULL DEFAULT 'indexed',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_documents_org_proj
  ON project_documents (org_id, project_key, vault_tab);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_documents' AND policyname = 'project_documents_org_isolation') THEN
    ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY project_documents_org_isolation ON project_documents
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
