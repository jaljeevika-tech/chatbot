-- db/migrations/058_mis_project_scoping.sql
--
-- Project-scopes the nine MIS upload categories (Training/Input
-- Distribution/Scheme Access/Credit-Grant Access/Business Development
-- Support/Compliance Support/Exposure Visit/Campaign/Community Meeting —
-- 046/048/049/050/051/052/053+055/054/056). Until now these were org-wide
-- like the beneficiary registries they link against (see 046's header) —
-- MisPage.tsx even documented this as a known gap ("projectKey is accepted
-- ... but unused ... in case a future category DOES need project scoping").
-- That's now needed: a sheet uploaded while viewing one project should not
-- show up under a different project.
--
-- project_key is a loose TEXT match against action_plans.project_key, no
-- FK — same convention as beneficiary_project_links (057) and
-- project_documents (019): plans can be soft-deleted/restored, so a hard FK
-- would complicate that flow.
--
-- Backfill: every row uploaded before this migration has no project_key.
-- Per instruction, all of it is assigned to 'kosi-2026' (Kosi Sahajivan) —
-- the only sensible single project for data that predates this feature.
-- New uploads use the project the uploader was viewing when they clicked
-- "Upload" (see MisPage.tsx / each Page/Upload-modal pair going forward).

DO $$
DECLARE
  backfill_key CONSTANT TEXT := 'kosi-2026';
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'trainings', 'input_distributions', 'scheme_access', 'credit_grant_access',
    'business_development_support', 'compliance_support', 'exposure_visits',
    'campaign', 'community_meeting'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS project_key TEXT', t);
    EXECUTE format('UPDATE %I SET project_key = $1 WHERE project_key IS NULL', t) USING backfill_key;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN project_key SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_project ON %I (org_id, project_key, created_at DESC)', t, t);
  END LOOP;
END $$;

-- Re-key each upsert unique index to include project_key, so the same
-- beneficiary/event under two different projects is two distinct rows
-- (previously they'd have collided and the second upload would have been
-- silently treated as an update of the first).

DROP INDEX IF EXISTS trainings_upsert_key;
CREATE UNIQUE INDEX trainings_upsert_key
  ON trainings (org_id, project_key, beneficiary_uid, training_topic, training_date);

DROP INDEX IF EXISTS input_distributions_upsert_key;
CREATE UNIQUE INDEX input_distributions_upsert_key
  ON input_distributions (org_id, project_key, beneficiary_uid, input_distributed, distribution_date);

DROP INDEX IF EXISTS scheme_access_upsert_key;
CREATE UNIQUE INDEX scheme_access_upsert_key
  ON scheme_access (org_id, project_key, beneficiary_uid, scheme_name, access_date);

DROP INDEX IF EXISTS credit_grant_access_upsert_key;
CREATE UNIQUE INDEX credit_grant_access_upsert_key
  ON credit_grant_access (org_id, project_key, beneficiary_uid, credit_grant_source, entity_name, access_date);

DROP INDEX IF EXISTS business_development_support_upsert_key;
CREATE UNIQUE INDEX business_development_support_upsert_key
  ON business_development_support (org_id, project_key, beneficiary_uid, support_provided, support_date);

DROP INDEX IF EXISTS compliance_support_upsert_key;
CREATE UNIQUE INDEX compliance_support_upsert_key
  ON compliance_support (org_id, project_key, beneficiary_uid, compliance_support_provided, support_date);

DROP INDEX IF EXISTS exposure_visits_upsert_key;
CREATE UNIQUE INDEX exposure_visits_upsert_key
  ON exposure_visits (org_id, project_key, beneficiary_uid, purpose, visit_date);

DROP INDEX IF EXISTS campaign_upsert_key;
CREATE UNIQUE INDEX campaign_upsert_key
  ON campaign (org_id, project_key, campaign_name, campaign_date, place);

DROP INDEX IF EXISTS community_meeting_upsert_key;
CREATE UNIQUE INDEX community_meeting_upsert_key
  ON community_meeting (org_id, project_key, purpose, meeting_date, place);
