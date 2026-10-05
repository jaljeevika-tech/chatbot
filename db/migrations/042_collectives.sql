-- db/migrations/042_collectives.sql
--
-- Collective Registration — Database-per-Service isolation, same pattern as
-- db/migrations/038_individual_beneficiaries.sql and 041_micro_entrepreneurs.sql.
-- Owned by the standalone services/collective/ microservice (a public,
-- no-login registration form for field staff). The monolith reads the
-- roster directly (fieldflow_app bypasses RLS) for the Beneficiaries tab >
-- Collective sub-tab, and mints/rotates each org's registration link.
-- Org-wide, not per-project. UID prefix is CB- ("Collective Beneficiary"),
-- deliberately distinct from IB- (Individual Beneficiary) and EB-
-- (Micro-Entrepreneur) so the three record types never look alike in lists
-- or exports.
--
-- Own bounded context (own role, own tables, own token/seq tables) — same
-- rationale as 041: rotating one form's link must never affect another's.

-- ── Dedicated DB role for the microservice ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cb_service') THEN
    CREATE ROLE cb_service LOGIN;
    -- Password set separately via Secret Manager:
    -- ALTER ROLE cb_service PASSWORD '<password-from-secret-manager>';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO cb_service;

-- ── cb_registration_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cb_registration_tokens (
  org_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- ── collective_seq ─────────────────────────────────────────────────────────────
-- Per-org counter for the CB-0001, CB-0002, ... UID.
CREATE TABLE IF NOT EXISTS collective_seq (
  org_id   UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_val INTEGER NOT NULL DEFAULT 0
);

-- ── collectives ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collectives (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid                      TEXT NOT NULL,
  collective_name          TEXT NOT NULL,
  collective_type          TEXT CHECK (collective_type IN ('FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective')),
  lead_person_name         TEXT,
  contact_no               TEXT,
  state                    TEXT,
  district                 TEXT,
  block                    TEXT,
  panchayat                TEXT,
  village                  TEXT,
  male_count               INTEGER,
  female_count             INTEGER,
  focus_area               TEXT,
  current_revenue_inr      NUMERIC,
  production_type          TEXT CHECK (production_type IN ('Agriculture', 'Aquaculture')),
  current_production_ton   NUMERIC,
  per_capita_income_inr    NUMERIC,
  credit_access_inr        NUMERIC,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_collectives_org
  ON collectives (org_id, created_at DESC);

-- ── Grants ─────────────────────────────────────────────────────────────────────
GRANT SELECT ON cb_registration_tokens TO cb_service;
GRANT SELECT, INSERT, UPDATE ON collective_seq TO cb_service;
GRANT SELECT, INSERT ON collectives TO cb_service;

-- Same State/District/Block/Panchayat/Village LGD reference data as the
-- Individual Beneficiary and Micro-Entrepreneur forms.
GRANT SELECT ON lgd_states, lgd_districts, lgd_blocks, lgd_panchayats, lgd_villages TO cb_service;

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE cb_registration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE collective_seq         ENABLE ROW LEVEL SECURITY;
ALTER TABLE collectives            ENABLE ROW LEVEL SECURITY;

ALTER TABLE cb_registration_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE collective_seq         FORCE ROW LEVEL SECURITY;
ALTER TABLE collectives            FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cb_registration_tokens' AND policyname = 'cb_tokens_org_isolation') THEN
    CREATE POLICY cb_tokens_org_isolation ON cb_registration_tokens
      FOR ALL TO cb_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collective_seq' AND policyname = 'cb_seq_org_isolation') THEN
    CREATE POLICY cb_seq_org_isolation ON collective_seq
      FOR ALL TO cb_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collectives' AND policyname = 'cb_collectives_org_isolation') THEN
    CREATE POLICY cb_collectives_org_isolation ON collectives
      FOR ALL TO cb_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
END $$;

-- fieldflow_app (monolith) bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cb_registration_tokens' AND policyname = 'cb_tokens_admin_bypass') THEN
    CREATE POLICY cb_tokens_admin_bypass ON cb_registration_tokens FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collective_seq' AND policyname = 'cb_seq_admin_bypass') THEN
    CREATE POLICY cb_seq_admin_bypass ON collective_seq FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collectives' AND policyname = 'cb_collectives_admin_bypass') THEN
    CREATE POLICY cb_collectives_admin_bypass ON collectives FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
END $$;
