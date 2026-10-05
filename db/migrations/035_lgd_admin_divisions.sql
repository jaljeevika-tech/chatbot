-- db/migrations/035_lgd_admin_divisions.sql
--
-- Indian government Local Government Directory (LGD) reference data for the
-- State → District → Block → Panchayat → Village cascading dropdowns on the
-- "+ New Project" form (NewProjectModal.tsx), replacing its old free-text
-- "Project Location" input. Source: a March 2022 snapshot of
-- https://lgdirectory.gov.in — see db/seed-data/lgd/README.md for exact
-- provenance and file-by-file notes. This migration only creates the (empty)
-- tables; run `node scripts/import-lgd-data.js` afterward to seed them.
--
-- "Block" = LGD's administrative/revenue Block. "Panchayat" = Gram/Village
-- Panchayat, one tier of LGD's Panchayati Raj Institution hierarchy — a
-- *different* LGD code namespace than Block (see seed-data README), so
-- lgd_panchayats.block_code is derived at import time from villages rather
-- than from an LGD cross-reference column.

CREATE TABLE IF NOT EXISTS lgd_states (
  code   INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  is_ut  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS lgd_districts (
  code        INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  state_code  INTEGER NOT NULL REFERENCES lgd_states(code)
);
CREATE INDEX IF NOT EXISTS lgd_districts_state ON lgd_districts (state_code, name);

CREATE TABLE IF NOT EXISTS lgd_blocks (
  code           INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  district_code  INTEGER NOT NULL REFERENCES lgd_districts(code),
  state_code     INTEGER NOT NULL REFERENCES lgd_states(code)
);
-- text_pattern_ops supports fast prefix search (name LIKE 'foo%') for the
-- type-ahead Block field without needing the pg_trgm extension.
CREATE INDEX IF NOT EXISTS lgd_blocks_district ON lgd_blocks (district_code, name text_pattern_ops);

CREATE TABLE IF NOT EXISTS lgd_panchayats (
  code        INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  block_code  INTEGER REFERENCES lgd_blocks(code),
  state_code  INTEGER NOT NULL REFERENCES lgd_states(code)
);
CREATE INDEX IF NOT EXISTS lgd_panchayats_block ON lgd_panchayats (block_code, name text_pattern_ops);

CREATE TABLE IF NOT EXISTS lgd_villages (
  code              INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  state_code        INTEGER NOT NULL REFERENCES lgd_states(code),
  district_code     INTEGER NOT NULL REFERENCES lgd_districts(code),
  subdistrict_code  INTEGER,
  subdistrict_name  TEXT,
  block_code        INTEGER REFERENCES lgd_blocks(code),
  panchayat_code    INTEGER REFERENCES lgd_panchayats(code)
);
CREATE INDEX IF NOT EXISTS lgd_villages_block     ON lgd_villages (block_code, name text_pattern_ops);
CREATE INDEX IF NOT EXISTS lgd_villages_panchayat ON lgd_villages (panchayat_code, name text_pattern_ops);
