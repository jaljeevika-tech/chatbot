-- db/migrations/070_registration_dedup_hash_unique.sql
--
-- Replaces 059_registration_dedup_unique.sql's dead unique indexes.
--
-- 059 built its DB-level duplicate guarantee on the plaintext `contact_no`
-- column: UNIQUE (org_id, contact_no, lower(trim(name))). That worked at the
-- time, but 064_pii_encryption_columns.sql (DPDP Phase 4) later moved every
-- new registration to write contact_no_enc/contact_no_hash instead, leaving
-- the plaintext contact_no column NULL going forward — and Postgres never
-- treats NULL as equal to NULL in a unique index, so that constraint quietly
-- stopped rejecting anything for every row registered after encryption went
-- live. (Live-data check 2026-09-17: individual_beneficiaries has 647 rows
-- total but only 447 with a non-null plaintext contact_no — the other 200
-- were silently unprotected.) On top of that, a live-index audit the same
-- day found 059's indexes were never actually present on this database at
-- all, so the app-level SELECT-before-INSERT dup check in
-- services/{individual-beneficiary,micro-entrepreneur,collective}/index.js
-- has been the ONLY protection in practice — and that check has an
-- acknowledged race-condition gap (two near-simultaneous submissions can
-- both pass the check before either writes). This is exactly how
-- IB-KUM-445/446 (created ~4 minutes apart, since deleted as a confirmed
-- duplicate) got through.
--
-- Fix: key the unique index on contact_no_hash (the deterministic HMAC
-- already written by every registration path, DPDP-safe since it's not
-- reversible) instead of the now-often-null plaintext column. Same compound
-- identity as before — (org_id, contact_no_hash, lower(trim(name))), or
-- collective_name for collectives — so a shared family phone with a
-- different name still registers fine; only a true resubmission of the
-- same person is rejected, now as a hard DB guarantee instead of a
-- best-effort app-level check.
--
-- Verified before writing this migration: zero existing rows in any of the
-- three tables conflict on this compound key (the one pre-existing
-- conflict, IB-KUM-445/446, was resolved first), so this applies cleanly
-- with no further cleanup.

DROP INDEX IF EXISTS individual_beneficiaries_dup_key;
DROP INDEX IF EXISTS micro_entrepreneurs_dup_key;
DROP INDEX IF EXISTS collectives_dup_key;

CREATE UNIQUE INDEX IF NOT EXISTS individual_beneficiaries_dup_hash_key
  ON individual_beneficiaries (org_id, contact_no_hash, lower(trim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS micro_entrepreneurs_dup_hash_key
  ON micro_entrepreneurs (org_id, contact_no_hash, lower(trim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS collectives_dup_hash_key
  ON collectives (org_id, contact_no_hash, lower(trim(collective_name)));
