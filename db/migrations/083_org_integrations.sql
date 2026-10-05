-- 083_org_integrations.sql — Super Admin Phase 2 (email, invites, password reset)
--
-- Additive + reversible. Run in the Neon SQL Editor as neondb_owner.
--
-- 1. org_email_config — how each org sends email. mode 'platform' (default,
--    "Org via FieldFlow" through the platform provider) or 'smtp' (the org's
--    own server). smtp_pass is AES-GCM encrypted by lib/crypto.js.
-- 2. email_log — one row per send attempt, so support can answer "did the
--    invite go out?" without provider dashboards. Body is never stored.
-- 3. users.email — needed for invite / password-reset links.
-- 4. auth_tokens — single-use invite / reset tokens. Only the SHA-256 of the
--    token is stored, so a DB read can't be turned into a login.

CREATE TABLE IF NOT EXISTS org_email_config (
  org_id            UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL DEFAULT 'platform' CHECK (mode IN ('platform', 'smtp')),
  from_name         TEXT,                 -- display name; default "<Org> via FieldFlow"
  reply_to          TEXT,
  smtp_host         TEXT,
  smtp_port         INTEGER,
  smtp_secure       BOOLEAN DEFAULT true, -- true = implicit TLS (465), false = STARTTLS (587)
  smtp_user         TEXT,
  smtp_pass         TEXT,                 -- encrypted (enc:v1:…)
  smtp_from_email   TEXT,
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_error   TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- invite | reset | test | notification
  to_address  TEXT NOT NULL,
  subject     TEXT,
  provider    TEXT,                       -- resend | smtp | platform-smtp
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_log_org_idx ON email_log (org_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_by  TEXT,                       -- uid of the admin who sent it, or 'self' for forgot-password
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, created_at DESC);

-- Rollback:
--   DROP TABLE IF EXISTS auth_tokens;
--   ALTER TABLE users DROP COLUMN IF EXISTS email;
--   DROP TABLE IF EXISTS email_log;
--   DROP TABLE IF EXISTS org_email_config;
