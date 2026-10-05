-- db/migrations/050_credit_grant_access.sql
--
-- Credit/Grant Access — MIS > Credit/Grant Access sub-tab. Same
-- UID-resolves-to-beneficiary-type upload flow and blank-UID -> Indirect
-- Beneficiary handling (047) as Training/Input Distribution/Scheme Access
-- (046/048/049), but a richer source sheet (Credit-Grant.xlsx: UID, Name,
-- Contact No., Credit/Grant Source, Credit/Grant Type, Name of
-- Credit/Grant Entity, Amount, Date, Place) — five "what happened" columns
-- instead of one, since a credit/grant record needs more than a single
-- label to be useful (who gave it, what kind, how much).
--
-- credit_grant_source is the one required field (mirrors
-- training_topic/input_distributed/scheme_name's role in the sibling
-- tables) — everything else can be blank and the row is still a real,
-- useful record (e.g. amount not yet disbursed/known).

CREATE TABLE IF NOT EXISTS credit_grant_access (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid       TEXT         NOT NULL,
  beneficiary_type      TEXT         NOT NULL CHECK (beneficiary_type IN ('Individual Beneficiary', 'Micro-Entrepreneur', 'Collective', 'Indirect Beneficiary')),
  beneficiary_name      TEXT,
  contact_no            TEXT,
  credit_grant_source   TEXT         NOT NULL,   -- e.g. Bank, Govt. Scheme, NGO, SHG/Cooperative
  credit_grant_type     TEXT,                    -- e.g. Loan, Grant, Subsidy
  entity_name           TEXT,                    -- Name of Credit/Grant Entity
  amount                NUMERIC,
  access_date           DATE,
  place                 TEXT,
  uploaded_by           TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_grant_access_org         ON credit_grant_access (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_grant_access_beneficiary ON credit_grant_access (org_id, beneficiary_uid);
CREATE INDEX IF NOT EXISTS idx_credit_grant_access_type        ON credit_grant_access (org_id, beneficiary_type);

-- Identity for re-upload safety: source + entity + date, rather than just
-- source + date (046/048/049's shape) — a beneficiary can plausibly get two
-- DIFFERENT loans from the same source on the same date (e.g. a bank AND a
-- cooperative both categorized "Bank" isn't right, but two distinct
-- entities under the same source easily could be), so entity_name is part
-- of the key too. A row with no date (or no entity) always inserts fresh
-- (NULL <> NULL in a unique index) — same accepted gap as the sibling tables.
CREATE UNIQUE INDEX IF NOT EXISTS credit_grant_access_upsert_key
  ON credit_grant_access (org_id, beneficiary_uid, credit_grant_source, entity_name, access_date);

ALTER TABLE credit_grant_access ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_grant_access' AND policyname = 'credit_grant_access_org_isolation') THEN
    CREATE POLICY credit_grant_access_org_isolation ON credit_grant_access
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
