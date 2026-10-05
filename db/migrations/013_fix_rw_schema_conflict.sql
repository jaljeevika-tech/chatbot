-- db/migrations/013_fix_rw_schema_conflict.sql
--
-- BUG: 001_initial.sql and 003_rw_rls.sql both do
-- `CREATE TABLE IF NOT EXISTS rw_profiles / rw_drafts / rw_feedback` with two
-- DIFFERENT, incompatible column sets:
--   001 (older/legacy shape): user_id UUID NOT NULL REFERENCES users(id), report_type NOT NULL, ...
--   003 (shape the app actually uses): contributor_id TEXT NOT NULL, contributor_name, voice_profile, ...
-- Because both use IF NOT EXISTS, whichever migration ran first on a given
-- database "won" and the other silently no-op'd. The Report Writer service
-- (services/report-writer/index.js) and routes/report-writer.routes.js query
-- exclusively the 003 (contributor_id-based) shape — on any database where 001
-- won, every Report Writer DB call fails with "column contributor_id does not
-- exist".
--
-- Fix: if a table currently has the 001 (user_id-based) shape, rename it aside
-- (data is preserved, not dropped) and recreate it with the 003 shape the app
-- expects. If it already has the correct shape (or doesn't exist yet), this is
-- a no-op. rw_glossary is NOT affected — both migrations defined it compatibly.

-- ── rw_profiles ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_profiles' AND column_name = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_profiles' AND column_name = 'contributor_id'
  ) THEN
    ALTER TABLE rw_profiles RENAME TO rw_profiles_legacy_001;
    RAISE NOTICE 'rw_profiles had the legacy (001) user_id-based shape — renamed to rw_profiles_legacy_001, data preserved.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rw_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contributor_id   TEXT NOT NULL,
  contributor_name TEXT NOT NULL,
  voice_profile    JSONB DEFAULT '{}',
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, contributor_id)
);

-- ── rw_drafts ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_drafts' AND column_name = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_drafts' AND column_name = 'contributor_id'
  ) THEN
    ALTER TABLE rw_drafts RENAME TO rw_drafts_legacy_001;
    RAISE NOTICE 'rw_drafts had the legacy (001) user_id-based shape — renamed to rw_drafts_legacy_001, data preserved.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rw_drafts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contributor_id TEXT NOT NULL,
  report_type    TEXT DEFAULT '',
  draft_md       TEXT DEFAULT '',
  final_md       TEXT DEFAULT '',
  status         TEXT DEFAULT 'draft' CHECK (status IN ('draft','refined','published')),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ── rw_feedback ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_feedback' AND column_name = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rw_feedback' AND column_name = 'contributor_id'
  ) THEN
    ALTER TABLE rw_feedback RENAME TO rw_feedback_legacy_001;
    RAISE NOTICE 'rw_feedback had the legacy (001) user_id-based shape — renamed to rw_feedback_legacy_001, data preserved.';
  END IF;
END $$;

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

-- ── Indexes (idempotent) ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rw_profiles_org ON rw_profiles (org_id);
CREATE INDEX IF NOT EXISTS idx_rw_drafts_org   ON rw_drafts   (org_id);
CREATE INDEX IF NOT EXISTS idx_rw_feedback_org ON rw_feedback (org_id);

-- ── RLS — re-apply in case the table was just freshly recreated above ──────────
-- (idempotent: skip anything that already exists so this is safe to re-run)
ALTER TABLE rw_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE rw_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE rw_drafts   FORCE ROW LEVEL SECURITY;
ALTER TABLE rw_feedback FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_profiles' AND policyname = 'rw_profiles_org_isolation') THEN
    CREATE POLICY rw_profiles_org_isolation ON rw_profiles FOR ALL TO rw_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_drafts' AND policyname = 'rw_drafts_org_isolation') THEN
    CREATE POLICY rw_drafts_org_isolation ON rw_drafts FOR ALL TO rw_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_feedback' AND policyname = 'rw_feedback_org_isolation') THEN
    CREATE POLICY rw_feedback_org_isolation ON rw_feedback FOR ALL TO rw_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_profiles' AND policyname = 'rw_profiles_admin_bypass') THEN
    CREATE POLICY rw_profiles_admin_bypass ON rw_profiles FOR ALL TO fieldflow_app USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_drafts' AND policyname = 'rw_drafts_admin_bypass') THEN
    CREATE POLICY rw_drafts_admin_bypass ON rw_drafts FOR ALL TO fieldflow_app USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rw_feedback' AND policyname = 'rw_feedback_admin_bypass') THEN
    CREATE POLICY rw_feedback_admin_bypass ON rw_feedback FOR ALL TO fieldflow_app USING (true);
  END IF;
END $$;

-- ── Grants for rw_service role (idempotent; role created in 003) ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rw_service') THEN
    GRANT SELECT, INSERT, UPDATE ON rw_profiles, rw_drafts, rw_feedback TO rw_service;
  END IF;
END $$;
