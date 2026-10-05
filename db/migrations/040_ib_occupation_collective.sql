-- db/migrations/040_ib_occupation_collective.sql
--
-- Individual Beneficiary registration form: add Occupation (free text) and
-- Member of Collective (yes/no). Table-level GRANT INSERT/SELECT already on
-- individual_beneficiaries (db/migrations/038) covers new columns too — no
-- additional GRANT needed.

ALTER TABLE individual_beneficiaries
  ADD COLUMN IF NOT EXISTS occupation            TEXT,
  ADD COLUMN IF NOT EXISTS member_of_collective  BOOLEAN;
