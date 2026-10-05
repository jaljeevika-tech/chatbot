-- db/migrations/081_hr_shift_hours.sql
-- Shifts become "hours per day" first: most field staff work a number of
-- hours, not fixed clock times. start_time / end_time become optional — set
-- them only for fixed-timing (office) shifts, which then also get late /
-- early-leave marking. Builds on 080_hr_shifts_notifications.sql.
--
-- Run as the app's own DB user (production: Neon → neondb, neondb_owner).
-- Additive, idempotent; safe with the code deployed before it.
-- Reverse: ALTER TABLE hr_shifts DROP CONSTRAINT hr_shifts_timing_pair,
--   DROP COLUMN required_minutes; (and re-add NOT NULL once every row has times)

ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS required_minutes INT NOT NULL DEFAULT 480
  CHECK (required_minutes BETWEEN 30 AND 1440);

-- Existing timed shifts: required hours = their length.
UPDATE hr_shifts
   SET required_minutes = (EXTRACT(EPOCH FROM (end_time - start_time))::int / 60 + 1440) % 1440
 WHERE start_time IS NOT NULL AND end_time IS NOT NULL AND start_time <> end_time
   AND required_minutes = 480;

ALTER TABLE hr_shifts ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE hr_shifts ALTER COLUMN end_time   DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_shifts_timing_pair') THEN
    ALTER TABLE hr_shifts ADD CONSTRAINT hr_shifts_timing_pair
      CHECK ((start_time IS NULL) = (end_time IS NULL));
  END IF;
END $$;
