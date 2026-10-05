-- db/migrations/041_micro_entrepreneurs.sql
--
-- Micro-Entrepreneur Registration — Database-per-Service isolation, same
-- pattern as db/migrations/038_individual_beneficiaries.sql. Owned by the
-- standalone services/micro-entrepreneur/ microservice (a public,
-- no-login registration form for field staff). The monolith reads the
-- roster directly (fieldflow_app bypasses RLS) for the Beneficiaries tab >
-- Micro-Entrepreneur sub-tab, and mints/rotates each org's registration
-- link. Org-wide, not per-project — same rationale as individual beneficiaries.
--
-- Kept as its own bounded context (own role, own tables, own token/seq
-- tables) rather than reusing individual_beneficiaries' — rotating one
-- registration link must never affect the other, and each service's DB role
-- should only ever reach the tables it actually owns.

-- ── Dedicated DB role for the microservice ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eb_service') THEN
    CREATE ROLE eb_service LOGIN;
    -- Password set separately via Secret Manager:
    -- ALTER ROLE eb_service PASSWORD '<password-from-secret-manager>';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO eb_service;

-- ── me_registration_tokens ────────────────────────────────────────────────────
-- One shareable link per org, same model as ib_registration_tokens.
CREATE TABLE IF NOT EXISTS me_registration_tokens (
  org_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- ── micro_entrepreneur_seq ────────────────────────────────────────────────────
-- Per-org counter for the EB-0001, EB-0002, ... UID.
CREATE TABLE IF NOT EXISTS micro_entrepreneur_seq (
  org_id   UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_val INTEGER NOT NULL DEFAULT 0
);

-- ── micro_entrepreneurs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS micro_entrepreneurs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid                      TEXT NOT NULL,
  name                     TEXT NOT NULL,
  contact_no               TEXT,
  state                    TEXT,
  district                 TEXT,
  block                    TEXT,
  panchayat                TEXT,
  village                  TEXT,
  gender                   TEXT,
  enterprise_name          TEXT,
  business_activity        TEXT,
  current_revenue_inr      NUMERIC,
  current_employee_count   INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_micro_entrepreneurs_org
  ON micro_entrepreneurs (org_id, created_at DESC);

-- ── Grants ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON me_registration_tokens TO eb_service;
GRANT SELECT, INSERT, UPDATE ON micro_entrepreneur_seq TO eb_service;
GRANT SELECT, INSERT ON micro_entrepreneurs TO eb_service;

-- Same State/District/Block/Panchayat/Village LGD reference data as the
-- Individual Beneficiary form and the "+ New Project" form (see
-- db/migrations/039_ib_lgd_read_access.sql) — no RLS on these, plain
-- read grant.
GRANT SELECT ON lgd_states, lgd_districts, lgd_blocks, lgd_panchayats, lgd_villages TO eb_service;

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE me_registration_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE micro_entrepreneur_seq   ENABLE ROW LEVEL SECURITY;
ALTER TABLE micro_entrepreneurs      ENABLE ROW LEVEL SECURITY;

ALTER TABLE me_registration_tokens   FORCE ROW LEVEL SECURITY;
ALTER TABLE micro_entrepreneur_seq   FORCE ROW LEVEL SECURITY;
ALTER TABLE micro_entrepreneurs      FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'me_registration_tokens' AND policyname = 'me_tokens_org_isolation') THEN
    CREATE POLICY me_tokens_org_isolation ON me_registration_tokens
      FOR ALL TO eb_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'micro_entrepreneur_seq' AND policyname = 'me_seq_org_isolation') THEN
    CREATE POLICY me_seq_org_isolation ON micro_entrepreneur_seq
      FOR ALL TO eb_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'micro_entrepreneurs' AND policyname = 'me_entrepreneurs_org_isolation') THEN
    CREATE POLICY me_entrepreneurs_org_isolation ON micro_entrepreneurs
      FOR ALL TO eb_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
END $$;

-- fieldflow_app (monolith) bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'me_registration_tokens' AND policyname = 'me_tokens_admin_bypass') THEN
    CREATE POLICY me_tokens_admin_bypass ON me_registration_tokens FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'micro_entrepreneur_seq' AND policyname = 'me_seq_admin_bypass') THEN
    CREATE POLICY me_seq_admin_bypass ON micro_entrepreneur_seq FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'micro_entrepreneurs' AND policyname = 'me_entrepreneurs_admin_bypass') THEN
    CREATE POLICY me_entrepreneurs_admin_bypass ON micro_entrepreneurs FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
END $$;
