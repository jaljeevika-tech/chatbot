-- db/migrations/043_resources.sql
--
-- Resource Registration — maps a physical resource (Wetland or Agricultural
-- Land) to an existing beneficiary (Individual Beneficiary, Micro-Entrepreneur,
-- or Collective), identified by that beneficiary's UID. Same
-- database-per-service isolation pattern as 038/041/042, owned by the
-- standalone services/resource/ microservice.
--
-- UID prefix is per resource type — WB- for Wetland, AG- for Agricultural
-- Land — and each type counts independently per org (resource_seq is keyed
-- by (org_id, resource_type), not just org_id), so e.g. WB-0001 and AG-0001
-- can both exist for the same org without colliding.
--
-- Unlike the other three registration forms, this one needs to READ across
-- bounded contexts: given a beneficiary UID typed into the form, it must
-- look up that beneficiary's details in whichever of
-- individual_beneficiaries / micro_entrepreneurs / collectives actually
-- owns that UID (determined by prefix — IB-/EB-/CB-). Rather than grant
-- rs_service a blanket bypass, each of those three tables gets one new
-- SELECT-only, org-scoped policy for rs_service — same org_id-scoping
-- mechanism as every other policy here, just read-only and additive to the
-- existing ib_service/eb_service/cb_service/fieldflow_app policies (nothing
-- about those changes).

-- ── Dedicated DB role for the microservice ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rs_service') THEN
    CREATE ROLE rs_service LOGIN;
    -- Password set separately via Secret Manager:
    -- ALTER ROLE rs_service PASSWORD '<password-from-secret-manager>';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rs_service;

-- ── rs_registration_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rs_registration_tokens (
  org_id     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- ── resource_seq ───────────────────────────────────────────────────────────────
-- Per-org, per-resource-type counter — Wetland (WB-####) and Agricultural
-- Land (AG-####) each get their own independent 0001, 0002, ... sequence.
CREATE TABLE IF NOT EXISTS resource_seq (
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Wetland', 'Agricultural Land')),
  next_val      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, resource_type)
);

-- ── resources ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid               TEXT NOT NULL,
  resource_type     TEXT NOT NULL CHECK (resource_type IN ('Wetland', 'Agricultural Land')),
  beneficiary_uid   TEXT NOT NULL,
  -- Which of the three registration forms beneficiary_uid resolved against
  -- at registration time — kept alongside a denormalized name snapshot so
  -- the roster never needs a live cross-table join (and still displays
  -- sensibly if the source beneficiary record is later edited or removed).
  beneficiary_type  TEXT NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective')),
  beneficiary_name  TEXT,
  latitude          NUMERIC,
  longitude         NUMERIC,
  area_acre         NUMERIC,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_resources_org        ON resources (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_beneficiary ON resources (org_id, beneficiary_uid);

-- ── Grants: rs_service's own tables ───────────────────────────────────────────
GRANT SELECT ON rs_registration_tokens TO rs_service;
GRANT SELECT, INSERT, UPDATE ON resource_seq TO rs_service;
GRANT SELECT, INSERT ON resources TO rs_service;

-- Same State/District/Block/Panchayat/Village LGD reference data as the
-- other registration forms — not used for a location cascade here (this
-- form captures GPS coordinates instead) but kept available in case a
-- future revision wants to show/confirm the beneficiary's registered
-- location alongside the fetched detail.
GRANT SELECT ON lgd_states, lgd_districts, lgd_blocks, lgd_panchayats, lgd_villages TO rs_service;

ALTER TABLE rs_registration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_seq           ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources              ENABLE ROW LEVEL SECURITY;

ALTER TABLE rs_registration_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_seq           FORCE ROW LEVEL SECURITY;
ALTER TABLE resources              FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rs_registration_tokens' AND policyname = 'rs_tokens_org_isolation') THEN
    CREATE POLICY rs_tokens_org_isolation ON rs_registration_tokens
      FOR ALL TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resource_seq' AND policyname = 'rs_seq_org_isolation') THEN
    CREATE POLICY rs_seq_org_isolation ON resource_seq
      FOR ALL TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resources' AND policyname = 'rs_resources_org_isolation') THEN
    CREATE POLICY rs_resources_org_isolation ON resources
      FOR ALL TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true))
      WITH CHECK (org_id::text = current_setting('app.current_org_id', true));
  END IF;
END $$;

-- fieldflow_app (monolith) bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rs_registration_tokens' AND policyname = 'rs_tokens_admin_bypass') THEN
    CREATE POLICY rs_tokens_admin_bypass ON rs_registration_tokens FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resource_seq' AND policyname = 'rs_seq_admin_bypass') THEN
    CREATE POLICY rs_seq_admin_bypass ON resource_seq FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'resources' AND policyname = 'rs_resources_admin_bypass') THEN
    CREATE POLICY rs_resources_admin_bypass ON resources FOR ALL TO fieldflow_app USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Cross-context read access: rs_service may look up (SELECT-only) a
-- beneficiary by UID in each of the three other services' tables, scoped to
-- the same org as its own registration link. Additive — does not touch the
-- existing ib_service/eb_service/cb_service/fieldflow_app policies on these
-- tables from migrations 038/041/042.
GRANT SELECT ON individual_beneficiaries TO rs_service;
GRANT SELECT ON micro_entrepreneurs      TO rs_service;
GRANT SELECT ON collectives              TO rs_service;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'individual_beneficiaries' AND policyname = 'ib_beneficiaries_rs_lookup') THEN
    CREATE POLICY ib_beneficiaries_rs_lookup ON individual_beneficiaries
      FOR SELECT TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'micro_entrepreneurs' AND policyname = 'me_entrepreneurs_rs_lookup') THEN
    CREATE POLICY me_entrepreneurs_rs_lookup ON micro_entrepreneurs
      FOR SELECT TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collectives' AND policyname = 'cb_collectives_rs_lookup') THEN
    CREATE POLICY cb_collectives_rs_lookup ON collectives
      FOR SELECT TO rs_service
      USING (org_id::text = current_setting('app.current_org_id', true));
  END IF;
END $$;
