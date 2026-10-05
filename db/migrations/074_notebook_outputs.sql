-- db/migrations/074_notebook_outputs.sql
--
-- Persists the generated "Ask AI" outputs (Study Guide, Slide Deck, Mind Map,
-- Video Overview) alongside their notebook (db/migrations/073_notebooks.sql),
-- same as sources/messages already are. Previously each output tab
-- (StudyGuide.tsx, SlideDeck.tsx, MindMap.tsx, VideoOverview.tsx) held its
-- generated content only in React state — a refresh or navigating away and
-- back wiped it out even though the notebook's sources/chat history survived.
--
-- One row per (notebook, kind) — kind is a fixed small set ('study_guide',
-- 'slide_deck', 'mind_map', 'video_overview'), data is a JSONB blob whose
-- shape is owned entirely by that output's frontend component, not the DB.

CREATE TABLE IF NOT EXISTS notebook_outputs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notebook_outputs_nb_kind_idx ON notebook_outputs (notebook_id, kind);
