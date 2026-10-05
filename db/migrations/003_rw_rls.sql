-- db/migrations/003_rw_rls.sql
-- Phase 2: Report Writer Service — Database-per-Service isolation using RLS
-- Run in Cloud SQL Studio as fieldflow_app on database fieldflow

-- ── Create a dedicated DB role for the Report Writer service ──────────────────
-- This role has access ONLY to Report Writer tables — not to organizations, users, etc.
-- Used by the Cloud Run service's DB connection string.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rw_service') THEN
    CREATE ROLE rw_service LOGIN;
    -- Password is set separately via Secret Manager:
    -- ALTER ROLE rw_service PASSWORD '<password-from-secret-manager>';
  END IF;
END $$;

-- Grant minimal privileges (Report Writer tables only)
-- Note: these tables may not exist yet if report_writer module wasn't migrated to DB.
-- This migration prepares the RLS policy for when the tables are created.
GRANT USAGE ON SCHEMA public TO rw_service;

-- ── Report Writer tables (if not already DB-backed) ──────────────────────────
-- Currently rw_* data is in Google Sheets. These tables will receive data when
-- the Report Writer service is extracted to Cloud Run (Phase 2).

CREATE TABLE IF NOT EXISTS rw_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contributor_id  TEXT NOT NULL,
  contributor_name TEXT NOT NULL,
  voice_profile   JSONB DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, contributor_id)
);

CREATE TABLE IF NOT EXISTS rw_glossary (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  term           TEXT NOT NULL,
  definition     TEXT DEFAULT '',
  status         TEXT DEFAULT 'provisional' CHECK (status IN ('provisional','confirmed','deprecated')),
  domain         TEXT DEFAULT '',
  first_seen_date DATE DEFAULT CURRENT_DATE,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, term)
);

CREATE TABLE IF NOT EXISTS rw_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contributor_id  TEXT NOT NULL,
  report_type     TEXT DEFAULT '',
  draft_md        TEXT DEFAULT '',
  final_md        TEXT DEFAULT '',
  status          TEXT DEFAULT 'draft' CHECK (status IN ('draft','refined','published')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rw_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contributor_id TEXT NOT NULL,
  report_type    TEXT DEFAULT '',
  category       TEXT DEFAULT '',
  before_text    TEXT DEFAULT '',
  after_text     TEXT DEFAULT '',
  lesson         TEXT DEFAULT '',
  entry_date     DATE DEFAULT CURRENT_DATE,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ── Grant table-level access to rw_service role ───────────────────────────────
GRANT SELECT, INSERT, UPDATE ON rw_profiles, rw_glossary, rw_drafts, rw_feedback TO rw_service;

-- ── Enable Row Level Security ─────────────────────────────────────────────────
ALTER TABLE rw_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_feedback ENABLE ROW LEVEL SECURITY;

-- ── RLS Policies: rw_service can only see rows for the current org ────────────
-- The rw_service sets app.current_org_id at the start of each request:
--   SET LOCAL app.current_org_id = '<org-uuid-from-token>';

CREATE POLICY rw_profiles_org_isolation ON rw_profiles
  FOR ALL TO rw_service
  USING (org_id::text = current_setting('app.current_org_id', true));

CREATE POLICY rw_glossary_org_isolation ON rw_glossary
  FOR ALL TO rw_service
  USING (org_id::text = current_setting('app.current_org_id', true));

CREATE POLICY rw_drafts_org_isolation ON rw_drafts
  FOR ALL TO rw_service
  USING (org_id::text = current_setting('app.current_org_id', true));

CREATE POLICY rw_feedback_org_isolation ON rw_feedback
  FOR ALL TO rw_service
  USING (org_id::text = current_setting('app.current_org_id', true));

-- ── fieldflow_app (existing main role) bypasses RLS ──────────────────────────
-- The monolith's existing role must still work unimpeded.
ALTER TABLE rw_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE rw_glossary FORCE ROW LEVEL SECURITY;
ALTER TABLE rw_drafts   FORCE ROW LEVEL SECURITY;
ALTER TABLE rw_feedback FORCE ROW LEVEL SECURITY;

-- Grant fieldflow_app a bypass policy so monolith can still access all rows
CREATE POLICY rw_profiles_admin_bypass ON rw_profiles FOR ALL TO fieldflow_app USING (true);
CREATE POLICY rw_glossary_admin_bypass ON rw_glossary FOR ALL TO fieldflow_app USING (true);
CREATE POLICY rw_drafts_admin_bypass   ON rw_drafts   FOR ALL TO fieldflow_app USING (true);
CREATE POLICY rw_feedback_admin_bypass ON rw_feedback FOR ALL TO fieldflow_app USING (true);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rw_profiles_org ON rw_profiles (org_id);
CREATE INDEX IF NOT EXISTS idx_rw_glossary_org ON rw_glossary (org_id);
CREATE INDEX IF NOT EXISTS idx_rw_drafts_org   ON rw_drafts   (org_id);
CREATE INDEX IF NOT EXISTS idx_rw_feedback_org ON rw_feedback (org_id);
