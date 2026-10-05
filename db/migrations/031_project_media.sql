-- db/migrations/031_project_media.sql
--
-- Media Library uploads: per-project video/audio/picture/PDF files, uploaded
-- directly (unlike the rest of Media Library, which is a read-only view over
-- Google-Sheets/WhatsApp attachment URLs — see MediaLibraryTab.tsx). Mirrors
-- the Document Vault pattern exactly (019_document_vault.sql): base64 data
-- URL stored directly in storage_path, no object storage wired up yet. Files
-- are capped at 25MB client- and server-side (see routes/media.routes.js)
-- since large video blows up a Postgres row.

CREATE TABLE IF NOT EXISTS project_media (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key  TEXT NOT NULL,
  media_type   TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio', 'pdf', 'other')),
  name         TEXT NOT NULL,
  file_type    TEXT,
  size_bytes   BIGINT,
  storage_path TEXT NOT NULL,
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_media_org_proj
  ON project_media (org_id, project_key, media_type);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'project_media' AND policyname = 'project_media_org_isolation') THEN
    ALTER TABLE project_media ENABLE ROW LEVEL SECURITY;
    CREATE POLICY project_media_org_isolation ON project_media
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
