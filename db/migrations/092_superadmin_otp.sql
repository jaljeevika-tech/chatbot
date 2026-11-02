-- 092_superadmin_otp.sql — email one-time codes as the second factor for superadmin sign-in.
-- Codes are stored hashed (sha256), expire after 10 minutes, and lock after 5 attempts (enforced in lib/superadminOtp.js).

CREATE TABLE IF NOT EXISTS superadmin_otp (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS superadmin_otp_user_idx ON superadmin_otp (user_id, created_at DESC);
