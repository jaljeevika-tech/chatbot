-- Migration 006: Native WhatsApp Platform
-- Replaces Glific dependency with a self-hosted WhatsApp chatbot engine
-- powered by Meta WhatsApp Cloud API.

-- ── Per-org WhatsApp API config ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_config (
  org_id           UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number_id  TEXT NOT NULL,          -- Meta phone_number_id
  access_token     TEXT NOT NULL,          -- Meta permanent access token (System User)
  webhook_secret   TEXT,                   -- Arbitrary secret for X-Hub-Signature-256 verify
  business_id      TEXT,                   -- WhatsApp Business Account ID
  display_phone    TEXT,                   -- Human-readable number (e.g. +91 98765 43210)
  enabled          BOOLEAN  DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── WhatsApp contacts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wa_id       TEXT NOT NULL,               -- WhatsApp phone (e.g. 919876543210)
  name        TEXT,                        -- WhatsApp profile name
  fields      JSONB NOT NULL DEFAULT '{}', -- custom data saved during flows
  opted_in    BOOLEAN DEFAULT true,
  tags        TEXT[]  DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_org ON wa_contacts(org_id, last_seen DESC);

-- ── Flow definitions ──────────────────────────────────────────────────────────
-- nodes is a JSONB array of node objects (see flowEngine.js for schema)
CREATE TABLE IF NOT EXISTS wa_flows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  trigger_keywords  TEXT[] DEFAULT '{}',   -- keywords that start this flow (case-insensitive)
  is_default        BOOLEAN DEFAULT false, -- triggered when no keyword matches
  nodes             JSONB NOT NULL DEFAULT '[]',
  is_active         BOOLEAN DEFAULT false,
  created_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_flows_org ON wa_flows(org_id, is_active, updated_at DESC);

-- ── Active conversation sessions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  flow_id       UUID NOT NULL REFERENCES wa_flows(id) ON DELETE CASCADE,
  current_node  TEXT NOT NULL,             -- id of the node waiting for input
  collected     JSONB NOT NULL DEFAULT '{}', -- all variables collected so far
  status        TEXT NOT NULL DEFAULT 'active', -- active | completed | expired | abandoned
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_contact ON wa_sessions(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_org     ON wa_sessions(org_id, status, updated_at DESC);

-- ── Message log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES wa_contacts(id) ON DELETE SET NULL,
  session_id     UUID REFERENCES wa_sessions(id) ON DELETE SET NULL,
  wa_message_id  TEXT,                     -- Meta's message ID (wamid.xxx)
  direction      TEXT NOT NULL,            -- 'inbound' | 'outbound'
  type           TEXT NOT NULL,            -- 'text' | 'interactive' | 'image' | 'location' | 'template'
  content        JSONB NOT NULL,           -- full message payload
  status         TEXT DEFAULT 'sent',      -- sent | delivered | read | failed
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_contact ON wa_messages(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_org     ON wa_messages(org_id, created_at DESC);

-- Idempotency key for inbound dedup (Meta retries same wamid up to 3x).
-- MUST be a non-partial unique index — partial indexes don't satisfy
-- ON CONFLICT (wa_message_id) inference. NULLs are distinct in PG unique
-- indexes by default, so outbound rows (wa_message_id = NULL) are fine.
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_wa_message_id_key
  ON wa_messages (wa_message_id);

-- ── Broadcasts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_broadcasts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  message_body TEXT NOT NULL,
  recipient_filter JSONB DEFAULT '{}',    -- tag filters used to select recipients
  total_sent   INT DEFAULT 0,
  total_failed INT DEFAULT 0,
  status       TEXT DEFAULT 'draft',      -- draft | sending | done | failed
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);
