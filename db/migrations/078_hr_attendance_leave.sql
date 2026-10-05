-- db/migrations/078_hr_attendance_leave.sql
-- HR Management bounded context — employee attendance + leave management.
-- Owned by the HR microservice (services/hr), which connects as the
-- dedicated hr_service role below (same Database-per-Service-via-RLS pattern
-- as 003_rw_rls.sql for the Report Writer service).
--
-- HR-only attributes (the "is HR" approver flag, an employee's work location)
-- live in hr_employee_profiles instead of new columns on `users`, so the HR
-- service never writes to a table the monolith owns — it only reads a few
-- users columns (name, role, manager_id) through a column-level grant.
--
-- Run as the app's own DB user so it owns the tables — the monolith serves
-- /api/hr in-process until services/hr is on Cloud Run. Production is Neon
-- (DATABASE_URL secret): Neon console → SQL Editor → neondb, role neondb_owner.
-- Idempotent: safe to re-run (e.g. later as a superuser to add hr_service).
--
-- Additive and reversible:
--   DROP TABLE hr_sync_receipts, hr_attendance_corrections, hr_attendance,
--              hr_leave_requests, hr_leave_types, hr_holidays,
--              hr_employee_profiles, hr_locations, hr_settings;
--   REVOKE ALL ON users FROM hr_service; DROP ROLE hr_service;

-- ── Service role ─────────────────────────────────────────────────────────────
-- Only needed once services/hr runs on Cloud Run. Without CREATEROLE the
-- tables are still created; re-run this file as a superuser to add the role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hr_service') THEN
    BEGIN
      CREATE ROLE hr_service LOGIN;
      -- Password is set separately via Secret Manager:
      -- ALTER ROLE hr_service PASSWORD '<password-from-secret-manager>';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'hr_service not created (no CREATEROLE). Not needed until services/hr runs on Cloud Run.';
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hr_service') THEN
    GRANT USAGE ON SCHEMA public TO hr_service;
    -- Read-only, and only the columns HR needs. users already has an
    -- org-isolation RLS policy (014_rls_gap_backfill.sql) that applies to this role.
    GRANT SELECT (id, org_id, firebase_uid, phone, name, role, manager_id) ON users TO hr_service;
  END IF;
END $$;

-- ── Per-org settings ─────────────────────────────────────────────────────────
-- weekly_offs: weekday (0 = Sunday … 6 = Saturday) → which occurrences of that
-- weekday in a month are off. {"0":[1,2,3,4,5]} = every Sunday;
-- {"6":[2,4]} = 2nd and 4th Saturday.
CREATE TABLE IF NOT EXISTS hr_settings (
  org_id             UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  gps_mode           TEXT NOT NULL DEFAULT 'optional'
                     CHECK (gps_mode IN ('required', 'optional', 'off')),
  weekly_offs        JSONB NOT NULL DEFAULT '{"0":[1,2,3,4,5]}',
  clock_skew_minutes INT  NOT NULL DEFAULT 10 CHECK (clock_skew_minutes BETWEEN 1 AND 240),
  timezone           TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Work locations (for location-specific holidays, e.g. Chhath for Bihar) ───
CREATE TABLE IF NOT EXISTS hr_locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- ── HR attributes per employee ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_employee_profiles (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  is_hr       BOOLEAN NOT NULL DEFAULT false,
  location_id UUID REFERENCES hr_locations(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_employee_profiles_org ON hr_employee_profiles (org_id);

-- ── Holidays (location_id NULL = org-wide) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL,
  location_id  UUID REFERENCES hr_locations(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- COALESCE so two org-wide (NULL location) rows on the same date collide too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_holidays_org_date_loc
  ON hr_holidays (org_id, holiday_date, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Leave types (admin-configurable, yearly quota, Apr–Mar, no carry-forward) ─
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  annual_quota   NUMERIC(5,1) NOT NULL CHECK (annual_quota >= 0),
  allow_half_day BOOLEAN NOT NULL DEFAULT true,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- ── Leave requests: employee → reporting manager → HR ────────────────────────
CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id      UUID NOT NULL REFERENCES hr_leave_types(id),
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  -- Half-days are single-date requests only.
  day_portion        TEXT NOT NULL DEFAULT 'full'
                     CHECK (day_portion IN ('full', 'first_half', 'second_half')),
  days               NUMERIC(5,1) NOT NULL CHECK (days > 0),
  leave_year         INT NOT NULL,           -- FY start year (Apr–Mar)
  reason             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL
                     CHECK (status IN ('pending_manager', 'pending_hr', 'approved', 'rejected', 'cancelled')),
  manager_id         UUID REFERENCES users(id) ON DELETE SET NULL,  -- approver snapshot at submit time
  manager_action_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  manager_action_at  TIMESTAMPTZ,
  manager_comment    TEXT,
  hr_action_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  hr_action_at       TIMESTAMPTZ,
  hr_comment         TEXT,
  submitted_offline  BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (day_portion = 'full' OR start_date = end_date)
);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_user   ON hr_leave_requests (org_id, user_id, leave_year);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_status ON hr_leave_requests (org_id, status);

-- ── Attendance: one row per employee per work day ────────────────────────────
-- check_in_at / check_out_at hold the server's best estimate of the real time
-- (device time corrected by the clock skew measured at sync); the raw phone
-- time is kept in *_device_at. Entries are flagged (never blocked) when the
-- phone clock was off by more than hr_settings.clock_skew_minutes, or when a
-- required GPS fix couldn't be taken.
CREATE TABLE IF NOT EXISTS hr_attendance (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date                DATE NOT NULL,
  status                   TEXT NOT NULL
                           CHECK (status IN ('present', 'on_field', 'half_day', 'absent')),
  source                   TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'manager')),
  check_in_at              TIMESTAMPTZ,
  check_in_device_at       TIMESTAMPTZ,
  check_in_lat             NUMERIC(9,6),
  check_in_lng             NUMERIC(9,6),
  check_in_accuracy_m      REAL,
  check_in_location_status TEXT CHECK (check_in_location_status IN ('ok', 'denied', 'unavailable', 'off')),
  check_in_offline         BOOLEAN NOT NULL DEFAULT false,
  check_in_clock_skew_s    INT,
  check_out_at             TIMESTAMPTZ,
  check_out_device_at      TIMESTAMPTZ,
  check_out_lat            NUMERIC(9,6),
  check_out_lng            NUMERIC(9,6),
  check_out_accuracy_m     REAL,
  check_out_location_status TEXT CHECK (check_out_location_status IN ('ok', 'denied', 'unavailable', 'off')),
  check_out_offline        BOOLEAN NOT NULL DEFAULT false,
  check_out_clock_skew_s   INT,
  flag_reasons             TEXT[] NOT NULL DEFAULT '{}',
  reviewed_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at              TIMESTAMPTZ,
  marked_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  note                     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_date ON hr_attendance (org_id, work_date);

-- Every manager/HR/admin change to an existing attendance row, with its reason.
CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attendance_id UUID NOT NULL REFERENCES hr_attendance(id) ON DELETE CASCADE,
  changed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,
  before        JSONB NOT NULL,
  after         JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_corrections_att ON hr_attendance_corrections (attendance_id);

-- ── Offline-sync idempotency ─────────────────────────────────────────────────
-- Each queued device action carries a client-generated UUID. Its outcome is
-- stored here so a retry (network dropped after the server committed) replays
-- the stored result instead of applying the action twice.
CREATE TABLE IF NOT EXISTS hr_sync_receipts (
  client_id  UUID PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Grants + org isolation for hr_service ────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hr_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      hr_settings, hr_locations, hr_employee_profiles, hr_holidays, hr_leave_types,
      hr_leave_requests, hr_attendance, hr_attendance_corrections, hr_sync_receipts
    TO hr_service;
  END IF;
  -- Run as someone else (e.g. postgres in Cloud SQL Studio)? Let the
  -- monolith's role in too — it serves /api/hr in-process. As a non-owner it
  -- goes through the org-isolation policies below, which withOrg() satisfies.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldflow_app') AND current_user <> 'fieldflow_app' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      hr_settings, hr_locations, hr_employee_profiles, hr_holidays, hr_leave_types,
      hr_leave_requests, hr_attendance, hr_attendance_corrections, hr_sync_receipts
    TO fieldflow_app;
  END IF;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_settings', 'hr_locations', 'hr_employee_profiles', 'hr_holidays', 'hr_leave_types',
    'hr_leave_requests', 'hr_attendance', 'hr_attendance_corrections', 'hr_sync_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
        t || '_org_isolation', t
      );
    END IF;
  END LOOP;
END $$;
