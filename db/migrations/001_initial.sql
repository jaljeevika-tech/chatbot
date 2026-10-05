-- FieldFlow Multi-Tenant Schema
-- Run once against your Cloud SQL PostgreSQL instance:
--   psql -h /cloudsql/jems-479908:us-central1:fieldflow-db -U fieldflow_app -d fieldflow -f 001_initial.sql

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ── Organizations (tenant registry) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: migrate existing single tenant (Jaljeevika)
INSERT INTO organizations (slug, name, metadata)
VALUES ('jaljeevika', 'Jaljeevika', '{
  "schema_version": 1,
  "branding": {
    "org_name": "Jaljeevika",
    "tagline": "Empowering Rural Communities",
    "logo_url": "",
    "dashboard_title": "Field Activity Dashboard",
    "theme": {
      "primary": "#16a34a",
      "sidebar": "#341272",
      "accent": "#A78BFA",
      "background": "#F5F3FB"
    }
  },
  "modules": {
    "reports":          { "enabled": true },
    "media_library":    { "enabled": true },
    "notebook":         { "enabled": true },
    "report_writer":    { "enabled": true },
    "finance":          { "enabled": true },
    "worker_analytics": { "enabled": true },
    "social_posts":     { "enabled": true }
  },
  "ai_config": {
    "system_persona": "You are an expert field work analyst for a rural development NGO in India.",
    "default_language": "en",
    "enabled_audiences": ["board", "donor", "funder", "community", "media"]
  },
  "data_sources": {
    "reports_sheet_id": "1qqKey4TOFhCH5lmGX6YOhw7R7SbhZ0S9JwE7oS6durQ",
    "users_sheet_id":   "14qcsnumtAQp2u8mTkQ-3hvioQ_8RDfweNGEZSsv3HrE",
    "bq_dataset":       "jems_data",
    "bq_project":       "jems-479908"
  },
  "custom_fields": {
    "daily_reports": [],
    "users": []
  },
  "projects": [
    { "id": "dasara",          "label": "Dasara",                    "color": "#f97316" },
    { "id": "kosi",            "label": "Kosi Sahajivan",            "color": "#3b82f6" },
    { "id": "ecric",           "label": "UNDP ECRIC Project",        "color": "#8b5cf6" },
    { "id": "tatwa",           "label": "TATWA",                     "color": "#6366f1" },
    { "id": "internal_program","label": "Internal Program",          "color": "#ec4899" },
    { "id": "arogya",          "label": "Arogya Anna Herbelife",     "color": "#10b981" },
    { "id": "fpo_madhepura",   "label": "FPO Madhepura – NABARD",    "color": "#f59e0b" },
    { "id": "jal_nidhi",       "label": "Jal Nidhi – Herbalife",     "color": "#0ea5e9" },
    { "id": "water_hyacinth",  "label": "Water Hyacinth – NABARD",   "color": "#84cc16" },
    { "id": "jal_samridhi",    "label": "Jal Smaridhi-APF",          "color": "#a855f7" },
    { "id": "shabri",          "label": "Shabri Mahamandal",         "color": "#dc2626" }
  ]
}')
ON CONFLICT (slug) DO NOTHING;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  firebase_uid TEXT UNIQUE,
  phone        TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'employee'
               CHECK (role IN ('superadmin', 'admin', 'manager', 'employee')),
  manager_id   UUID REFERENCES users(id),
  custom_data  JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone)
);

CREATE INDEX IF NOT EXISTS users_org_id_idx       ON users(org_id);
CREATE INDEX IF NOT EXISTS users_firebase_uid_idx ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS users_phone_idx        ON users(org_id, phone);

-- ── Field Reports ─────────────────────────────────────────────────────────────
-- This table is the target for migrating data out of Google Sheets.
-- During transition, the app reads from Sheets and writes new records here.
CREATE TABLE IF NOT EXISTS daily_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submitted_by         UUID REFERENCES users(id),
  report_date          DATE NOT NULL,
  state                TEXT,
  location             TEXT,
  project              TEXT,
  area_of_intervention TEXT,
  description          TEXT,
  beneficiaries        INT,
  attachment_url       TEXT,
  custom_data          JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daily_reports_org_id_idx ON daily_reports(org_id);
CREATE INDEX IF NOT EXISTS daily_reports_date_idx   ON daily_reports(org_id, report_date DESC);

-- Row-Level Security: belt-and-suspenders isolation at the DB layer
ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON daily_reports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- ── Report Writer Profiles ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rw_profiles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- ── Report Writer Glossary ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rw_glossary (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  definition      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'confirmed')),
  domain          TEXT NOT NULL DEFAULT '',
  first_seen_date DATE,
  UNIQUE (org_id, term)
);

CREATE INDEX IF NOT EXISTS rw_glossary_org_idx ON rw_glossary(org_id);

-- ── Report Writer Drafts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rw_drafts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type  TEXT NOT NULL,
  draft_md     TEXT NOT NULL DEFAULT '',
  final_md     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'refined')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rw_drafts_org_user_idx ON rw_drafts(org_id, user_id);

-- ── Report Writer Feedback ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rw_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  before_text TEXT NOT NULL DEFAULT '',
  after_text  TEXT NOT NULL DEFAULT '',
  lesson      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rw_feedback_org_user_idx ON rw_feedback(org_id, user_id);
