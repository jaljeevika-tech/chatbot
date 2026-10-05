-- db/migrations/063_dsr_requests.sql
--
-- DPDP Act 2023 / DPDP Rules 2025 compliance — Phase 2 (DSR intake + fulfillment).
--
-- dsr_requests tracks a beneficiary's (or their representative's) request
-- for access, correction, erasure, or portability — staff-mediated intake
-- only for now (a field worker/manager logs the request on the
-- beneficiary's behalf; there is no public self-service form yet — that is
-- deliberately out of scope, see the Phase 2 plan's "self-service DSR"
-- item). due_at is computed from the org's configured SLA
-- (organizations.metadata->'dpdp'->>'dsr_sla_days') — left unset by
-- default; the app must show "SLA not configured" rather than assume a
-- number until the board picks one.
--
-- Also closes a Phase 0 gap: indirect_beneficiaries was left out of
-- 061_dpdp_foundational_columns.sql's lifecycle columns even though it's
-- one of the four UID-prefixed beneficiary types (XB-) the erasure/DSR
-- routes need to handle uniformly.

CREATE TABLE IF NOT EXISTS dsr_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid   TEXT NOT NULL,
  beneficiary_type  TEXT NOT NULL,
  request_type      TEXT NOT NULL CHECK (request_type IN ('access', 'correction', 'erasure', 'portability')),
  status            TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'in_progress', 'fulfilled', 'rejected', 'withdrawn')),
  requested_by      TEXT,
  intake_channel    TEXT,
  correction_detail JSONB,
  handled_by_uid    TEXT,
  handled_by_name   TEXT,
  resolution_note   TEXT,
  due_at            TIMESTAMPTZ,
  fulfilled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dsr_requests_org_status
  ON dsr_requests (org_id, status, due_at);

ALTER TABLE indirect_beneficiaries
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
