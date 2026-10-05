-- db/migrations/073_notebooks.sql
--
-- Persistence for the "Ask AI" NotebookLM-style feature (see routes/notebooks.routes.js
-- and src/components/notebook/NotebookHome.tsx). Previously sources/chat history lived
-- only in React state inside NotebookPage.tsx and were lost on refresh — this lets a
-- user create, name, and switch between multiple saved notebooks, matching NotebookLM's
-- per-account multi-notebook model. Scoped to org_id + created_by_uid (personal
-- notebooks within an org, not shared org-wide like most other tables here).

CREATE TABLE IF NOT EXISTS notebooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  created_by_uid  TEXT NOT NULL,
  created_by_name TEXT,
  name            TEXT NOT NULL DEFAULT 'Untitled notebook',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notebook_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,
  char_count  INT NOT NULL,
  image_urls  JSONB,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notebook_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notebooks_org_user_idx  ON notebooks (org_id, created_by_uid);
CREATE INDEX IF NOT EXISTS notebook_sources_nb_idx ON notebook_sources (notebook_id);
CREATE INDEX IF NOT EXISTS notebook_messages_nb_idx ON notebook_messages (notebook_id);
