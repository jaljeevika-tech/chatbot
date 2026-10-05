-- db/migrations/060_ib_me_category.sql
--
-- Individual Beneficiary and Micro-Entrepreneur registration forms: add
-- Category (social category — General/OBC/SC/ST/EWS), same standard
-- classification used across Indian government and NGO beneficiary forms.
-- Table-level GRANT INSERT/SELECT already on individual_beneficiaries
-- (038) and micro_entrepreneurs (041) covers new columns too — no
-- additional GRANT needed. Same pattern as 040_ib_occupation_collective.sql.

ALTER TABLE individual_beneficiaries
  ADD COLUMN IF NOT EXISTS category TEXT CHECK (category IN ('General', 'OBC', 'SC', 'ST', 'EWS'));

ALTER TABLE micro_entrepreneurs
  ADD COLUMN IF NOT EXISTS category TEXT CHECK (category IN ('General', 'OBC', 'SC', 'ST', 'EWS'));
