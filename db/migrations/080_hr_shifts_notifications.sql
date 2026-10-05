-- db/migrations/080_hr_shifts_notifications.sql
-- HR Management round 2: shifts (with late / early-leave / short-day
-- marking), reporting-manager setup from HR Settings, notification settings
-- + missed-check-in reminder log, and employee email for notifications.
-- Builds on 078_hr_attendance_leave.sql.
--
-- Run as the app's own DB user (production: Neon → SQL Editor → neondb,
-- role neondb_owner). Idempotent. Additive and reversible:
--   DROP TABLE hr_reminders_sent; ALTER TABLE hr_attendance DROP COLUMN shift_id,
--     DROP COLUMN late_minutes, DROP COLUMN early_leave_minutes, DROP COLUMN worked_minutes;
--   ALTER TABLE hr_employee_profiles DROP COLUMN shift_id, DROP COLUMN email;
--   ALTER TABLE hr_locations DROP COLUMN shift_id; ALTER TABLE hr_settings DROP COLUMN notifications;
--   DROP TABLE hr_shifts;

-- ── Shifts ───────────────────────────────────────────────────────────────────
-- end_time < start_time = the shift ends the next day (night shift).
-- min_full_day_minutes: a self check-in/out day shorter than this becomes Half day.
CREATE TABLE IF NOT EXISTS hr_shifts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  start_time           TIME NOT NULL,
  end_time             TIME NOT NULL,
  grace_minutes        INT  NOT NULL DEFAULT 15  CHECK (grace_minutes BETWEEN 0 AND 240),
  min_full_day_minutes INT  NOT NULL DEFAULT 360 CHECK (min_full_day_minutes BETWEEN 0 AND 1440),
  is_default           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
-- At most one org-wide default shift.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_shifts_default ON hr_shifts (org_id) WHERE is_default;

-- Shift precedence: employee's own → their location's → org default.
ALTER TABLE hr_employee_profiles ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES hr_shifts(id) ON DELETE SET NULL;
ALTER TABLE hr_employee_profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE hr_locations         ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES hr_shifts(id) ON DELETE SET NULL;

-- Computed at check-in / check-out against the shift in force that day.
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS shift_id            UUID REFERENCES hr_shifts(id) ON DELETE SET NULL;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS late_minutes        INT;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS early_leave_minutes INT;
ALTER TABLE hr_attendance ADD COLUMN IF NOT EXISTS worked_minutes      INT;

-- ── Notifications ────────────────────────────────────────────────────────────
-- { emailEnabled, whatsappEnabled, whatsappTemplate, whatsappLang,
--   events: { leaveRequested, leaveDecided, attendanceMarked, checkInOut, missedCheckIn },
--   reminderAfterMinutes }  — defaults live in services/hr/notify.js.
ALTER TABLE hr_settings ADD COLUMN IF NOT EXISTS notifications JSONB NOT NULL DEFAULT '{}';

-- One missed-check-in reminder per person per day, even with several app
-- instances running the reminder job (insert-first dedupe).
CREATE TABLE IF NOT EXISTS hr_reminders_sent (
  org_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  kind      TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, work_date, kind)
);

-- ── Org isolation + grants ───────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_shifts', 'hr_reminders_sent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
        t || '_org_isolation', t
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hr_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON hr_shifts, hr_reminders_sent TO hr_service;
    -- Org chart shows designations; HR Settings sets reporting managers.
    GRANT SELECT (designation) ON users TO hr_service;
    GRANT UPDATE (manager_id)  ON users TO hr_service;
    -- WhatsApp notifications use the org's own Meta number (token stored encrypted).
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'wa_config') THEN
      GRANT SELECT (org_id, phone_number_id, access_token, enabled) ON wa_config TO hr_service;
    END IF;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldflow_app') AND current_user <> 'fieldflow_app' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON hr_shifts, hr_reminders_sent TO fieldflow_app;
  END IF;
END $$;
