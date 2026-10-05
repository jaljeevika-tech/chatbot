-- db/migrations/015_wa_config_app_secret.sql
--
-- BUG: routes/wa-platform.routes.js reads/writes wa_config.app_secret (used to
-- verify Meta webhook signatures per-org — see the app_secret usage around the
-- POST /wa/config handler and the webhook signature check), but no migration
-- ever created that column on wa_config (006_whatsapp_platform.sql only has
-- phone_number_id, access_token, webhook_secret, business_id, display_phone,
-- enabled). The first time any org saves a WhatsApp config with an app secret,
-- the INSERT/UPDATE fails with "column app_secret does not exist".

ALTER TABLE wa_config ADD COLUMN IF NOT EXISTS app_secret TEXT;
