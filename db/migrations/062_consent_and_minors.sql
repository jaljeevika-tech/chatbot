-- db/migrations/062_consent_and_minors.sql
--
-- DPDP Act 2023 / DPDP Rules 2025 compliance — Phase 1 (consent capture).
--
-- consent_records is append-only and multi-purpose rather than a single
-- boolean column on each beneficiary table: consent needs a history (grant
-- now, withdraw later) and covers distinct purposes (data collection vs.
-- photo/video vs. naming a beneficiary in a donor report vs. WhatsApp
-- comms) that can each be granted/withdrawn independently. The "current"
-- status for a purpose is simply its most recent row — never UPDATE an
-- existing row, so the full grant/withdraw history survives for audit.
--
-- beneficiary_uid/beneficiary_type follow the same UID-prefix convention
-- used across the app (IB-/EB-/CB-/XB-, see beneficiary-profile.routes.js's
-- beneficiaryLookupSpec) rather than a foreign key, since a single
-- consent record can outlive whichever specific per-project row it was
-- captured against.

CREATE TABLE IF NOT EXISTS consent_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  beneficiary_uid  TEXT NOT NULL,
  beneficiary_type TEXT NOT NULL,
  purpose          TEXT NOT NULL CHECK (purpose IN ('data_collection', 'photo_video', 'named_attribution', 'whatsapp_comms')),
  status           TEXT NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  granted_by       TEXT NOT NULL CHECK (granted_by IN ('self', 'parent_guardian')) DEFAULT 'self',
  recorded_by_uid  TEXT NOT NULL,
  recorded_by_name TEXT,
  method           TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_records_lookup
  ON consent_records (org_id, beneficiary_uid, purpose, created_at DESC);
