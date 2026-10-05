-- 034_wa_config_phone_unique.sql
-- Security fix: prevent two orgs from ever registering the same WhatsApp
-- phone_number_id. Without this, the inbound-webhook resolver's
-- `SELECT ... WHERE phone_number_id = $1 ... LIMIT 1` lookup (routes/wa-platform.routes.js)
-- would be decided by incidental row order rather than real ownership,
-- letting a second org's PUT /api/wa/config claim a number already in use
-- and misattribute (and expose) the true owner's inbound messages/contacts.
-- Applied 2026-08-11 directly against the live DB (no pre-existing duplicates
-- found) — this file documents it for future environments/rebuilds.

ALTER TABLE wa_config
  ADD CONSTRAINT wa_config_phone_number_id_unique UNIQUE (phone_number_id);
