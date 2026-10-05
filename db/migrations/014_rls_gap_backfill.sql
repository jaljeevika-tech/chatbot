-- db/migrations/014_rls_gap_backfill.sql
--
-- BUG: 003_rw_rls.sql established Row-Level-Security as the tenant-isolation
-- backstop for org-scoped tables (004_saved_reports.sql followed the same
-- pattern), but every migration after that — 005 (whatsapp_submissions),
-- 006 (wa_config/wa_contacts/wa_flows/wa_sessions/wa_messages/wa_broadcasts),
-- 007 (org_prompts), 008/009 (ai_memories/ai_interactions/ai_settings),
-- 010 (reconciliation_checks), 011 (performance_reviews) — added new
-- org-scoped tables WITHOUT RLS. `users` itself (001) never got it either.
-- These tables hold WhatsApp conversation content, AI prompts/memories, and
-- HR performance-review data — exactly the tables where a single missed
-- `WHERE org_id = ...` in app code becomes a full cross-tenant data leak with
-- no second layer of defense.
--
-- Fix: enable RLS + an org_isolation policy on each, mirroring the existing
-- pattern in 004_saved_reports.sql. Idempotent — safe to re-run.
--
-- NOT included here: ai_learning_candidates / ai_rule_versions (org_id is
-- nullable TEXT there, used to represent "global/default" rules — enabling a
-- naive org-scoped policy would hide those global rows from every org-scoped
-- query, which is a behavior change that needs product sign-off, not a blind
-- migration). performance_action_items has no org_id column of its own; it is
-- scoped indirectly via review_id -> performance_reviews.org_id, and app code
-- (routes/performance.routes.js) was verified during audit to always re-derive
-- org scope server-side before touching it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_org_isolation') THEN
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    CREATE POLICY users_org_isolation ON users
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_submissions' AND policyname = 'whatsapp_submissions_org_isolation') THEN
    ALTER TABLE whatsapp_submissions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_submissions_org_isolation ON whatsapp_submissions
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_config' AND policyname = 'wa_config_org_isolation') THEN
    ALTER TABLE wa_config ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_config_org_isolation ON wa_config
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_contacts' AND policyname = 'wa_contacts_org_isolation') THEN
    ALTER TABLE wa_contacts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_contacts_org_isolation ON wa_contacts
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_flows' AND policyname = 'wa_flows_org_isolation') THEN
    ALTER TABLE wa_flows ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_flows_org_isolation ON wa_flows
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_sessions' AND policyname = 'wa_sessions_org_isolation') THEN
    ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_sessions_org_isolation ON wa_sessions
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_messages' AND policyname = 'wa_messages_org_isolation') THEN
    ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_messages_org_isolation ON wa_messages
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wa_broadcasts' AND policyname = 'wa_broadcasts_org_isolation') THEN
    ALTER TABLE wa_broadcasts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wa_broadcasts_org_isolation ON wa_broadcasts
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'org_prompts' AND policyname = 'org_prompts_org_isolation') THEN
    ALTER TABLE org_prompts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY org_prompts_org_isolation ON org_prompts
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'reconciliation_checks' AND policyname = 'reconciliation_checks_org_isolation') THEN
    ALTER TABLE reconciliation_checks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY reconciliation_checks_org_isolation ON reconciliation_checks
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'performance_reviews' AND policyname = 'performance_reviews_org_isolation') THEN
    ALTER TABLE performance_reviews ENABLE ROW LEVEL SECURITY;
    CREATE POLICY performance_reviews_org_isolation ON performance_reviews
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;

  -- ai_memories / ai_interactions / ai_settings — org_id is TEXT NOT NULL here
  -- (not UUID like the tables above), so this is a plain text comparison.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_memories')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_memories' AND policyname = 'ai_memories_org_isolation') THEN
    ALTER TABLE ai_memories ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ai_memories_org_isolation ON ai_memories
      USING (org_id = current_setting('app.current_org_id', true));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_interactions')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_interactions' AND policyname = 'ai_interactions_org_isolation') THEN
    ALTER TABLE ai_interactions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ai_interactions_org_isolation ON ai_interactions
      USING (org_id = current_setting('app.current_org_id', true));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_settings')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_settings' AND policyname = 'ai_settings_org_isolation') THEN
    ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ai_settings_org_isolation ON ai_settings
      USING (org_id = current_setting('app.current_org_id', true));
  END IF;
END $$;
