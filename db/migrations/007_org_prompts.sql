-- 007_org_prompts.sql — Per-organisation AI prompt overrides
-- Each org can override any of the 14 built-in prompts.
-- Unoverridden prompts fall back to the hardcoded system defaults.

CREATE TABLE IF NOT EXISTS org_prompts (
  id          SERIAL PRIMARY KEY,
  org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prompt_id   TEXT        NOT NULL,                        -- e.g. 'report_field_system'
  prompt_text TEXT        NOT NULL,                        -- the custom prompt text
  status      TEXT        NOT NULL DEFAULT 'active',       -- active | testing | disabled
  notes       TEXT        NOT NULL DEFAULT '',             -- admin's notes / change reason
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT        NOT NULL DEFAULT '',             -- uid or name of last editor
  UNIQUE (org_id, prompt_id)
);

CREATE INDEX IF NOT EXISTS org_prompts_org_idx ON org_prompts (org_id);
