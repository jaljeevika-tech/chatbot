-- 082_superadmin_hardening.sql — Super Admin Phase 0 (security hardening)
--
-- Additive + reversible. Run in the Neon SQL Editor as neondb_owner.
--
-- 1. platform_audit_log — every super admin write (org create, metadata patch,
--    plan / subscription change, user create / edit / delete, suspend) is
--    recorded here. Separate from the per-org audit_log because (a) the actor
--    acts across tenants, (b) some actions have no target org (plan CRUD), and
--    (c) audit_log has org-isolation RLS + ON DELETE CASCADE, which would let
--    an org deletion erase the record of who deleted it.
-- 2. organizations.subscription_status gains 'suspended' (manual kill switch,
--    read-only immediately, no grace period) + suspended_at / suspended_reason.

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id             BIGSERIAL    PRIMARY KEY,
  actor_uid      TEXT         NOT NULL,
  actor_name     TEXT,
  actor_org_id   UUID,
  action         TEXT         NOT NULL,
  target_org_id  UUID,                      -- no FK on purpose: survives org deletion
  target_type    TEXT,
  target_id      TEXT,
  diff           JSONB,                     -- secrets are redacted before insert
  ip             TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_audit_log_created_idx ON platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_org_idx     ON platform_audit_log (target_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_action_idx  ON platform_audit_log (action, created_at DESC);

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_subscription_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_subscription_status_check
  CHECK (subscription_status IN ('active','trialing','expired','inactive','suspended'));

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Rollback:
--   DROP TABLE IF EXISTS platform_audit_log;
--   UPDATE organizations SET subscription_status = 'inactive' WHERE subscription_status = 'suspended';
--   ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_subscription_status_check;
--   ALTER TABLE organizations ADD CONSTRAINT organizations_subscription_status_check
--     CHECK (subscription_status IN ('active','trialing','expired','inactive'));
--   ALTER TABLE organizations DROP COLUMN IF EXISTS suspended_at, DROP COLUMN IF EXISTS suspended_reason;
