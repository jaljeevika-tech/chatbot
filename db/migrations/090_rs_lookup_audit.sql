-- 090_rs_lookup_audit.sql — the public resource registration form's
-- "Fetch Details" lookup (services/resource GET /api/lookup) returns a
-- beneficiary's name, phone and location to anyone holding the org's link,
-- so every lookup is recorded in audit_log. rs_service only needs INSERT;
-- audit_log's existing org-isolation RLS policy scopes the write to the
-- link's org (orgQuery sets app.current_org_id).
--
-- Additive + reversible:
--   REVOKE INSERT ON audit_log FROM rs_service;
--   REVOKE USAGE ON SEQUENCE audit_log_id_seq FROM rs_service;
-- Run in the Neon SQL Editor as neondb_owner, BEFORE deploying the resource
-- service (its lookup refuses to serve details if the audit write fails).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rs_service') THEN
    GRANT INSERT ON audit_log TO rs_service;
    GRANT USAGE ON SEQUENCE audit_log_id_seq TO rs_service;
  END IF;
END $$;
