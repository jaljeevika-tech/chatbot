-- db/migrations/053_campaign.sql
--
-- Campaign — MIS > Campaign sub-tab. A seventh category added on top of
-- the original six (Training/Input Distribution/Scheme Access/Credit-Grant
-- Access/Business Development Support/Compliance Support — 046/048/049/
-- 050/051/052). Structurally identical to Training (046) — same
-- source-sheet shape (UID, Name, Contact No., Campaign, Date, Place), same
-- UID-resolves-to-beneficiary-type upload flow, same blank-UID -> Indirect
-- Beneficiary handling (047) — just a different "what happened" column
-- (campaign_name). See 046's header for the full rationale; not repeated
-- here.

CREATE TABLE IF NOT EXISTS campaign (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  campaign_name     TEXT         NOT NULL,
  campaign_date     DATE,
  place             TEXT,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_org         ON campaign (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_beneficiary  ON campaign (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_campaign_type         ON campaign (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS campaign_upsert_key
  ON campaign (org_id, beneficiary_uid, campaign_name, campaign_date);

ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'campaign' AND policyname = 'campaign_org_isolation') THEN
    CREATE POLICY campaign_org_isolation ON campaign
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
