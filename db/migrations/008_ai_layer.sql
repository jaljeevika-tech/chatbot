-- FieldFlow AI Layer — Memory Store + Interaction Log
-- Phase 1: Shared org-scoped memory and learning loop
-- Run once: psql -d fieldflow -f db/migrations/008_ai_layer.sql

-- ── Org-scoped AI memory store ────────────────────────────────────────────────
-- memory_type values: 'org_context' | 'worker_insight' | 'project_pattern'
--                     | 'language_pref' | 'barrier_pattern'
-- subject: worker name, project name, region — '' when global to the org

CREATE TABLE IF NOT EXISTS ai_memories (
  id            SERIAL      PRIMARY KEY,
  org_id        TEXT        NOT NULL,
  memory_type   TEXT        NOT NULL,
  subject       TEXT        NOT NULL DEFAULT '',
  content       TEXT        NOT NULL,
  source        TEXT,                        -- 'toc_analysis' | 'notebook' | 'rw' | 'whatsapp' | 'manual'
  confidence    REAL        NOT NULL DEFAULT 1.0,
  reinforced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique key for upsert (subject='' for org-level entries)
CREATE UNIQUE INDEX IF NOT EXISTS ai_memories_upsert_key
  ON ai_memories (org_id, memory_type, subject);

CREATE INDEX IF NOT EXISTS ai_memories_org_type
  ON ai_memories (org_id, memory_type);

-- ── Interaction log for learning loop ────────────────────────────────────────
-- feature values: 'assistant' | 'toc' | 'notebook' | 'rw' | 'whatsapp'
-- feedback: 1 = thumbs up, -1 = thumbs down, NULL = no feedback yet

CREATE TABLE IF NOT EXISTS ai_interactions (
  id            SERIAL      PRIMARY KEY,
  org_id        TEXT        NOT NULL,
  feature       TEXT        NOT NULL,
  user_message  TEXT,
  ai_response   TEXT,
  feedback      SMALLINT,
  memory_ids    INTEGER[]   NOT NULL DEFAULT '{}',
  tokens_used   INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_interactions_org
  ON ai_interactions (org_id, created_at DESC);
