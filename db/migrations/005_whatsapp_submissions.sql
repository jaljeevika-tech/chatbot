-- Migration 005: WhatsApp Submissions Audit Log
-- Stores every report submitted via WhatsApp/Glific for audit purposes.
-- The canonical record is in Google Sheets; this table provides a queryable audit trail.

CREATE TABLE IF NOT EXISTS whatsapp_submissions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone          TEXT        NOT NULL,
  worker_name    TEXT,
  project        TEXT,
  state          TEXT,
  location       TEXT,
  area           TEXT,
  beneficiaries  TEXT,
  description    TEXT,
  photo_url      TEXT,
  raw_payload    JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_submissions_org  ON whatsapp_submissions(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_submissions_phone ON whatsapp_submissions(phone);
