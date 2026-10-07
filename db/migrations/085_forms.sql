-- 085_forms.sql — KoBo/ODK-style form builder (super admin + org admin)
--
-- Additive + reversible:
--   DROP TABLE form_media, form_submissions, form_versions, forms;
--   ALTER TABLE individual_beneficiaries|micro_entrepreneurs|collectives|resources DROP COLUMN custom_data;
-- Run in the Neon SQL Editor as neondb_owner.
--
-- A form's published schema is frozen in form_versions.schema (XLSForm-shaped
-- JSON: survey rows + choices + settings), so it maps 1:1 to the XForm XML
-- served to ODK/KoboCollect. Entity forms (beneficiary types, resource, user,
-- project) keep writing their real tables — system fields to columns, custom
-- fields to custom_data — and also log a form_submissions row so every save
-- records the form version it used. Projects stay in organizations.metadata.projects
-- (custom answers in each project's custom_data); no projects table.
-- Monolith-only tables (no microservice role touches them).

CREATE TABLE IF NOT EXISTS forms (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Entity forms use the entity name as key; standalone forms use an admin-chosen
  -- slug. Doubles as the ODK form_id.
  form_key           TEXT NOT NULL CHECK (form_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind               TEXT NOT NULL CHECK (kind IN ('entity', 'custom')),
  title              TEXT NOT NULL,
  current_version_id UUID,                       -- NULL until first publish
  draft_schema       JSONB,                      -- unpublished edits
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, form_key),
  CHECK (kind = 'custom' OR form_key IN
    ('individual_beneficiary', 'micro_entrepreneur', 'collective', 'beneficiary', 'resource', 'user', 'project'))
);

CREATE TABLE IF NOT EXISTS form_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  schema       JSONB NOT NULL,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);

ALTER TABLE forms DROP CONSTRAINT IF EXISTS forms_current_version_fk;
ALTER TABLE forms ADD CONSTRAINT forms_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES form_versions(id);

CREATE TABLE IF NOT EXISTS form_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_id       UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version_id    UUID NOT NULL REFERENCES form_versions(id),
  -- ODK instanceID (uuid:...) or a client-generated id for the web offline
  -- queue — makes resubmits idempotent.
  instance_id   TEXT NOT NULL,
  data          JSONB NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('web', 'odk')),
  submitted_by  UUID REFERENCES users(id),
  entity_row_id TEXT,                            -- row created/updated by an entity form (uuid, uid or project id)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, instance_id)
);

CREATE INDEX IF NOT EXISTS form_submissions_form_idx ON form_submissions (form_id, created_at DESC);

-- Photo/audio/signature answers. Same storage as project_media / document vault:
-- base64 data URL in storage_path, 25MB cap enforced in the route.
CREATE TABLE IF NOT EXISTS form_media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,                   -- the value stored in data for that field
  content_type  TEXT,
  size_bytes    BIGINT,
  storage_path  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, file_name)
);

-- Registration tables had no place for custom answers; users/beneficiaries already do.
ALTER TABLE individual_beneficiaries ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE micro_entrepreneurs      ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE collectives              ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE resources                ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['forms', 'form_versions', 'form_submissions', 'form_media'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_org_isolation') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
        t || '_org_isolation', t);
    END IF;
  END LOOP;
END $$;
