-- db/migrations/076_category_ebc_minority.sql
--
-- Adds EBC (Extremely Backward Class) and Minority to the Category options
-- on the Individual Beneficiary and Micro-Entrepreneur registration forms.
-- 060 created `category` with an inline CHECK, which Postgres auto-named
-- <table>_category_check; replace it with the widened list. Additive for
-- existing data — every value the old CHECK allowed is still allowed.

ALTER TABLE individual_beneficiaries DROP CONSTRAINT IF EXISTS individual_beneficiaries_category_check;
ALTER TABLE individual_beneficiaries
  ADD CONSTRAINT individual_beneficiaries_category_check
  CHECK (category IN ('General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority'));

ALTER TABLE micro_entrepreneurs DROP CONSTRAINT IF EXISTS micro_entrepreneurs_category_check;
ALTER TABLE micro_entrepreneurs
  ADD CONSTRAINT micro_entrepreneurs_category_check
  CHECK (category IN ('General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority'));
