-- db/migrations/054_exposure_visits.sql
--
-- Exposure Visit — MIS > Exposure Visit sub-tab. Eighth category, added on
-- top of the original six (046/048/049/050/051/052) plus Campaign (053).
-- Same UID-resolves-to-beneficiary-type upload flow and blank-UID ->
-- Indirect Beneficiary handling (047) as every sibling, but the source
-- sheet (Exposure Visit.xlsx) has a different shape: UID, Name, Contact
-- No., Purpose of Exposure Visit, Place of Exposure Visit, Date — no bare
-- "Place" column (the "Place of Exposure Visit" column fills that role
-- specifically for this visit), so this table has `purpose` (required,
-- mirrors training_topic's role) and `visit_place` instead of a generic
-- `place`.

CREATE TABLE IF NOT EXISTS exposure_visits (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  purpose           TEXT         NOT NULL,   -- Purpose of Exposure Visit
  visit_place       TEXT,                    -- Place of Exposure Visit
  visit_date        DATE,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exposure_visits_org         ON exposure_visits (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exposure_visits_beneficiary ON exposure_visits (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_exposure_visits_type        ON exposure_visits (org_id, beneficiary_type);

-- Same re-upload-is-safe identity as trainings_upsert_key (046) — a row
-- with no date always inserts fresh (NULL <> NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS exposure_visits_upsert_key
  ON exposure_visits (org_id, beneficiary_uid, purpose, visit_date);

ALTER TABLE exposure_visits ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exposure_visits' AND policyname = 'exposure_visits_org_isolation') THEN
    CREATE POLICY exposure_visits_org_isolation ON exposure_visits
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
