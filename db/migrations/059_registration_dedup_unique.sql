-- db/migrations/059_registration_dedup_unique.sql
--
-- Closes the race-condition gap left by the app-level duplicate checks in
-- services/individual-beneficiary/index.js, services/micro-entrepreneur/
-- index.js and services/collective/index.js: those services SELECT for an
-- existing match before INSERTing, which is enough for the normal
-- one-at-a-time public-form case but leaves a small window open if two
-- near-simultaneous submissions both pass the check before either writes.
-- These unique indexes make the same rule a hard DB guarantee.
--
-- Identity is deliberately compound — contact number ALONE is not a safe
-- key here. A live-data check (2026-08-19) found 24 individual_beneficiaries
-- groups where several different real people share one family phone (e.g.
-- "Thakur Munnabai" / "Takur Mahesh Singh" / "Thakur Rajaram Singh", same
-- household, same number) — shared phones are the norm in this field
-- context, not an edge case. None of those groups also match by name, so
-- (org_id, contact_no, lower(trim(name))) is the identity: only a
-- resubmission of the SAME person is rejected; a different name on the
-- same phone still goes through. Same reasoning for collectives, keyed by
-- collective_name instead (a lead person could legitimately lead two
-- differently-named collectives on one phone).
--
-- Verified before writing this migration: zero existing rows in any of the
-- three tables conflict on this compound key, so this applies cleanly with
-- no cleanup step needed.
--
-- resources is NOT covered here — a beneficiary can legitimately register
-- more than one Wetland/Agricultural Land, so its duplicate check
-- (services/resource/index.js) is a full-content match, not a fixed key,
-- and doesn't map onto a plain unique index the way these three do.

CREATE UNIQUE INDEX IF NOT EXISTS individual_beneficiaries_dup_key
  ON individual_beneficiaries (org_id, contact_no, lower(trim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS micro_entrepreneurs_dup_key
  ON micro_entrepreneurs (org_id, contact_no, lower(trim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS collectives_dup_key
  ON collectives (org_id, contact_no, lower(trim(collective_name)));
