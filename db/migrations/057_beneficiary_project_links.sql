-- db/migrations/057_beneficiary_project_links.sql
--
-- Beneficiary Project Links — which project(s) a beneficiary is connected
-- to, for the Beneficiary Profile page (Complete Detail > Connected
-- Projects). Individual Beneficiary / Micro-Entrepreneur / Collective /
-- Indirect Beneficiary registration is org-wide with no project_key at all
-- (see db/migrations/038_individual_beneficiaries.sql's header) — a
-- beneficiary can legitimately be served by more than one project over
-- time, so this is a many-to-many join table rather than a single
-- project_key column on each registry table.
--
-- project_key is a loose TEXT match against action_plans.project_key (no
-- FK) — same convention as project_documents (019), project_media (031),
-- etc. — plans can be soft-deleted/restored, so a hard FK would complicate
-- that flow.

CREATE TABLE IF NOT EXISTS beneficiary_project_links (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid  TEXT         NOT NULL,
  beneficiary_type TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  project_key      TEXT         NOT NULL,
  linked_by        TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beneficiary_project_links_beneficiary
  ON beneficiary_project_links (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_beneficiary_project_links_project
  ON beneficiary_project_links (org_id, project_key);

-- One row per (beneficiary, project) — re-linking the same project is a
-- no-op, not a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS beneficiary_project_links_upsert_key
  ON beneficiary_project_links (org_id, beneficiary_uid, project_key);

ALTER TABLE beneficiary_project_links ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'beneficiary_project_links' AND policyname = 'beneficiary_project_links_org_isolation') THEN
    CREATE POLICY beneficiary_project_links_org_isolation ON beneficiary_project_links
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
