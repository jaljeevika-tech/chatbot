-- db/migrations/047_indirect_beneficiaries.sql
--
-- Indirect Beneficiary — a fourth, lightweight registry alongside Individual
-- Beneficiary / Micro-Entrepreneur / Collective (038/041/042), for people who
-- show up in an MIS upload (Training first; Input Distribution, Scheme
-- Access, Credit/Grant Access, Business Development Support, Compliance
-- Support to follow) with NO Beneficiary UID cell filled in. Rather than
-- rejecting those rows, routes/trainings.routes.js (and future sibling
-- upload routes) auto-creates or reuses an Indirect Beneficiary record —
-- minted here, own UID prefix XB- ("indirect Beneficiary" — chosen to not
-- collide visually with IB-/EB-/CB-) — and tags the MIS row's
-- beneficiary_type as 'Indirect Beneficiary' against it.
--
-- Unlike the other three, there is no dedicated public registration form —
-- these rows only ever come from the monolith's own upload handlers, which
-- already bypass RLS (fieldflow_app), so no separate DB role is needed.
--
-- Identity for reuse across uploads: the MOBILE NUMBER itself (normalized to
-- bare digits — see routes/trainings.routes.js's normalizePhone) becomes the
-- UID, e.g. XB-9669902999 — so the same phone number always resolves to the
-- exact same record no matter how the Name cell is spelled, and never
-- re-registers as a duplicate. (org_id, lower(trim(name)), contact_no) is
-- the fallback identity for the rarer row that gives a name but no usable
-- phone number; a row with neither can't be matched at all and always
-- mints a fresh sequential XB-#### UID — an accepted gap, same as 027's
-- sl_no fallback.

CREATE TABLE IF NOT EXISTS indirect_beneficiary_seq (
  org_id   UUID    PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_val INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indirect_beneficiaries (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid        TEXT        NOT NULL,
  name       TEXT,
  contact_no TEXT,
  place      TEXT,
  source     TEXT,        -- which MIS category first created this record, e.g. 'training'
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);

-- Partial unique index (not a plain UNIQUE constraint) so the "no name" rows
-- described above are exempt — a plain UNIQUE would treat every all-NULL row
-- as non-conflicting anyway, but being explicit here documents the intent.
CREATE UNIQUE INDEX IF NOT EXISTS indirect_beneficiaries_identity
  ON indirect_beneficiaries (org_id, lower(trim(name)), contact_no)
  WHERE name IS NOT NULL AND trim(name) <> '';

CREATE INDEX IF NOT EXISTS idx_indirect_beneficiaries_org ON indirect_beneficiaries (org_id, created_at DESC);

ALTER TABLE indirect_beneficiary_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE indirect_beneficiaries   ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indirect_beneficiary_seq' AND policyname = 'indirect_beneficiary_seq_org_isolation') THEN
    CREATE POLICY indirect_beneficiary_seq_org_isolation ON indirect_beneficiary_seq
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'indirect_beneficiaries' AND policyname = 'indirect_beneficiaries_org_isolation') THEN
    CREATE POLICY indirect_beneficiaries_org_isolation ON indirect_beneficiaries
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
