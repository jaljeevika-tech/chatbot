-- db/migrations/038_individual_beneficiaries.sql
--
-- Individual Beneficiary Registration — Database-per-Service isolation (same
-- pattern as 003_rw_rls.sql for the Report Writer service). This bounded
-- context is owned by services/individual-beneficiary/ (Cloud Run), a
-- standalone microservice serving a public registration form to field staff.
-- The monolith (fieldflow_app role) reads the resulting roster directly for
-- the Beneficiaries tab > Individual Beneficiary sub-tab — same convention as
-- the existing `beneficiaries` / `beneficiary_mis_records` tables.
--
-- Unlike the per-project `beneficiaries` table, this roster is org-wide (no
-- project_key) — the registration form doesn't collect a project, matching
-- the field list actually requested.

-- ── Dedicated DB role for the microservice ───────────────────────────────────
-- Scoped to ONLY the three tables below — never organizations, users, etc.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ib_service') THEN
    CREATE ROLE ib_service LOGIN;
    -- Password set separately via Secret Manager:
    -- ALTER ROLE ib_service PASSWORD '<password-from-secret-manager>';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ib_service;

-- ── ib_registration_tokens ────────────────────────────────────────────────────
-- One shareable link per org. The monolith creates/rotates the token (admin
-- action); the microservice only ever reads it to validate an incoming
-- ?org=<id>&key=<token> link before accepting registrations.
CREATE TABLE IF NOT EXISTS ib_registration_tokens (
  org_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- ── individual_beneficiary_seq ────────────────────────────────────────────────
-- Per-org counter for the IB-0001, IB-0002, ... UID. A single UPSERT
-- (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) is the atomic
-- allocation — no separate read-then-write race window.
CREATE TABLE IF NOT EXISTS individual_beneficiary_seq (
  org_id   UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_val INTEGER NOT NULL DEFAULT 0
);

-- ── individual_beneficiaries ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS individual_beneficiaries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid                     TEXT NOT NULL,
  name                    TEXT NOT NULL,
  contact_no              TEXT,
  state                   TEXT,
  district                TEXT,
  block                   TEXT,
  panchayat               TEXT,
  village                 TEXT,
  gender                  TEXT,
  current_income_inr      NUMERIC,
  production_type         TEXT CHECK (production_type IN ('Aquaculture', 'Agriculture')),
  current_production_ton  NUMERIC,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_individual_beneficiaries_org
  ON individual_beneficiaries (org_id, created_at DESC);

-- ── Grants ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON ib_registration_tokens TO ib_service;
GRANT SELECT, INSERT, UPDATE ON individual_beneficiary_seq TO ib_service;
GRANT SELECT, INSERT ON individual_beneficiaries TO ib_service;

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE ib_registration_tokens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE individual_beneficiary_seq  ENABLE ROW LEVEL SECURITY;
ALTER TABLE individual_beneficiaries    ENABLE ROW LEVEL SECURITY;

ALTER TABLE ib_registration_tokens      FORCE ROW LEVEL SECURITY;
ALTER TABLE individual_beneficiary_seq  FORCE ROW LEVEL SECURITY;
ALTER TABLE individual_beneficiaries    FORCE ROW LEVEL SECURITY;

-- The microservice sets `SET LOCAL app.current_org_id` from the org_id in the
-- registration link's query string BEFORE it trusts anything else — the token
-- comparison below then runs scoped to that single org, so a guessed org_id
-- with the wrong key simply matches zero rows rather than leaking another
-- org's token.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ib_registration_tokens' AND policyname = 'ib_tokens_org_isolation') THEN
    CREATE POLICY ib_tokens_org_isolation ON ib_registration_tokens
      FOR ALL TO ib_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'individual_beneficiary_seq' AND policyname = 'ib_seq_org_isolation') THEN
    CREATE POLICY ib_seq_org_isolation ON individual_beneficiary_seq
      FOR ALL TO ib_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'individual_beneficiaries' AND policyname = 'ib_beneficiaries_org_isolation') THEN
    CREATE POLICY ib_beneficiaries_org_isolation ON individual_beneficiaries
      FOR ALL TO ib_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
END $$;

-- fieldflow_app (monolith) bypasses RLS — it reads/writes the token (to build
-- the shareable link) and reads the roster (Beneficiaries tab) unrestricted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ib_registration_tokens' AND policyname = 'ib_tokens_admin_bypass') THEN
    CREATE POLICY ib_tokens_admin_bypass ON ib_registration_tokens FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'individual_beneficiary_seq' AND policyname = 'ib_seq_admin_bypass') THEN
    CREATE POLICY ib_seq_admin_bypass ON individual_beneficiary_seq FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'individual_beneficiaries' AND policyname = 'ib_beneficiaries_admin_bypass') THEN
    CREATE POLICY ib_beneficiaries_admin_bypass ON individual_beneficiaries FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
END $$;
