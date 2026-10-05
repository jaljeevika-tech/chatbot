-- 084_trial_requests.sql — landing page "Start free trial" / "Talk to us" requests
--
-- Additive + reversible (DROP TABLE trial_requests). Run in the Neon SQL Editor as neondb_owner.
-- Written by the public POST /api/public/trial-request; super admin creates the org by hand.

CREATE TABLE IF NOT EXISTS trial_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  org_name    TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  role        TEXT,
  team_size   TEXT,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trial_requests_created_idx ON trial_requests (created_at DESC);
