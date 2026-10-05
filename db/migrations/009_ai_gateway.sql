-- 009_ai_gateway.sql — Local-first AI layer: observability columns + learning tables
-- Run via initAiLayer() at server startup (idempotent — all statements use IF NOT EXISTS / IF NOT EXISTS column tricks)

-- ── Extend ai_interactions with observability ─────────────────────────────────
ALTER TABLE ai_interactions
  ADD COLUMN IF NOT EXISTS route_used      TEXT,
  ADD COLUMN IF NOT EXISTS confidence      REAL,
  ADD COLUMN IF NOT EXISTS latency_ms      INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd        NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS fallback_reason TEXT,
  ADD COLUMN IF NOT EXISTS provider        TEXT;   -- 'local' | 'self_hosted' | 'gemini'

CREATE INDEX IF NOT EXISTS ai_interactions_provider
  ON ai_interactions (org_id, provider, created_at DESC);

-- ── Extend ai_memories with lifecycle columns ─────────────────────────────────
-- status: observed → candidate → validated → approved → active | rejected
ALTER TABLE ai_memories
  ADD COLUMN IF NOT EXISTS status                TEXT    NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS version               INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_interaction_id INTEGER
    REFERENCES ai_interactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_memories_status
  ON ai_memories (org_id, status);

-- ── Learning candidates (proposed rule/template improvements) ─────────────────
-- type: 'intent_alias' | 'slot_pattern' | 'template_section' | 'scoring_weight'
-- status: 'pending' | 'approved' | 'rejected' | 'promoted'
CREATE TABLE IF NOT EXISTS ai_learning_candidates (
  id              SERIAL       PRIMARY KEY,
  org_id          TEXT,
  type            TEXT         NOT NULL,
  feature         TEXT         NOT NULL,
  proposed_change JSONB        NOT NULL,
  evidence_count  INTEGER      NOT NULL DEFAULT 0,
  eval_score      REAL,
  status          TEXT         NOT NULL DEFAULT 'pending',
  reviewed_by     TEXT,
  review_note     TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  promoted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_candidates_status
  ON ai_learning_candidates (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_candidates_org_feature
  ON ai_learning_candidates (org_id, feature, status);

-- ── Versioned rule / template store ──────────────────────────────────────────
-- rule_type: 'intent_matcher' | 'slot_extractor' | 'report_template' |
--            'whatsapp_template' | 'scoring_weights' | 'glossary'
CREATE TABLE IF NOT EXISTS ai_rule_versions (
  id           SERIAL       PRIMARY KEY,
  org_id       TEXT,
  feature      TEXT         NOT NULL,
  rule_type    TEXT         NOT NULL,
  version      INTEGER      NOT NULL DEFAULT 1,
  config       JSONB        NOT NULL,
  eval_metrics JSONB,
  active       BOOLEAN      NOT NULL DEFAULT false,
  promoted_by  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  UNIQUE (org_id, feature, rule_type, version)
);

CREATE INDEX IF NOT EXISTS ai_rule_versions_active
  ON ai_rule_versions (org_id, feature, rule_type)
  WHERE active = true;

-- ── Per-org AI settings ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_settings (
  org_id              TEXT         PRIMARY KEY,
  external_enabled    BOOLEAN      NOT NULL DEFAULT true,
  local_model_url     TEXT,
  local_model_name    TEXT,
  budget_usd_daily    NUMERIC(8,4) NOT NULL DEFAULT 5.0,
  feature_policies    JSONB        NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by          TEXT
);
