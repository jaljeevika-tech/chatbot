-- db/migrations/046_trainings.sql
--
-- Training — MIS > Training sub-tab. One Excel upload button; each row
-- identifies its beneficiary purely by UID (IB-/EB-/CB- prefix, same
-- convention as 043_resources.sql), and the upload endpoint
-- (routes/trainings.routes.js) resolves that UID against
-- individual_beneficiaries / micro_entrepreneurs / collectives server-side
-- to determine which of the three registries the row belongs to. The UI
-- then shows three sub-tabs (Individual / Micro-Entrepreneurs / Collective)
-- that just filter this one table by beneficiary_type — there's no
-- per-type schema split, since the source sheet (Training.xlsx: UID, Name,
-- Contact No., Training topic, Date, Place) is identical regardless of
-- which registry the UID resolves to.
--
-- Unlike Resources (043), this data is captured by an authenticated
-- admin/manager uploading a sheet inside the app, not a public no-login
-- registration form — so there's no separate microservice or dedicated DB
-- role here. The monolith (fieldflow_app) already bypasses RLS and already
-- reads individual_beneficiaries/micro_entrepreneurs/collectives directly
-- (see routes/individual-beneficiaries.routes.js and resources.routes.js),
-- so resolving the UID happens in routes/trainings.routes.js with a plain
-- pool.query — no new grants/policies needed on those three tables.

CREATE TABLE IF NOT EXISTS trainings (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT         NOT NULL,
  -- Which registry beneficiary_uid resolved against at upload time — kept
  -- alongside a denormalized name snapshot, same rationale as
  -- resources.beneficiary_type/beneficiary_name (043): the roster never
  -- needs a live cross-table join, and still displays sensibly if the
  -- source beneficiary record is later edited/removed. 'Indirect
  -- Beneficiary' covers rows whose UID cell was left blank — see
  -- db/migrations/047_indirect_beneficiaries.sql — rather than rejecting
  -- them outright, since a blank UID is a real, expected case (someone
  -- trained/served who was never individually registered).
  beneficiary_type  TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name  TEXT,
  contact_no        TEXT,
  training_topic    TEXT         NOT NULL,
  training_date     DATE,
  place             TEXT,
  uploaded_by       TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trainings_org         ON trainings (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trainings_beneficiary ON trainings (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_trainings_type        ON trainings (org_id, beneficiary_type);

-- Re-uploading the same sheet updates rather than duplicates — identity is
-- (beneficiary, topic, date), same "safe to re-run" spirit as 027's upsert
-- key. Rows with no date can't dedupe this way (NULL <> NULL in a unique
-- index, so they always insert fresh) — an accepted gap; the source sheet
-- format always carries a Date column.
CREATE UNIQUE INDEX IF NOT EXISTS trainings_upsert_key
  ON trainings (org_id, beneficiary_uid, training_topic, training_date);

ALTER TABLE trainings ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trainings' AND policyname = 'trainings_org_isolation') THEN
    CREATE POLICY trainings_org_isolation ON trainings
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
