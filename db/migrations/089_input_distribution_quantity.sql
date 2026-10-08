-- 089_input_distribution_quantity.sql — MIS > Input Distribution gets
-- Quantity (number) + Unit (No., Kg, Pc, Ltr … free text). Both nullable,
-- so existing rows and old upload sheets keep working unchanged.
--
-- Additive + reversible:
--   ALTER TABLE input_distributions DROP COLUMN quantity, DROP COLUMN unit;
-- Run in the Neon SQL Editor as neondb_owner.

ALTER TABLE input_distributions ADD COLUMN IF NOT EXISTS quantity NUMERIC;
ALTER TABLE input_distributions ADD COLUMN IF NOT EXISTS unit     TEXT;
