-- FieldFlow — Subscription Model Migration
-- Run in Cloud SQL Studio as fieldflow_app on database fieldflow

-- Plans catalogue (superadmin manages these)
CREATE TABLE IF NOT EXISTS plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  description     TEXT DEFAULT '',
  price_monthly   NUMERIC(10,2) DEFAULT 0,
  max_users       INTEGER DEFAULT 10,
  ai_enabled      BOOLEAN DEFAULT false,
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed 4 placeholder plans
INSERT INTO plans (name, slug, description, price_monthly, max_users, ai_enabled, sort_order) VALUES
  ('Free',         'free',         'Trial plan — basic features, no AI', 0,     5,    false, 1),
  ('Starter',      'starter',      'Small teams, all modules, no AI',    2999,  25,   false, 2),
  ('Professional', 'professional', 'Growing orgs with AI features',      6999,  100,  true,  3),
  ('Enterprise',   'enterprise',   'Unlimited users, full AI access',    0,     9999, true,  4)
ON CONFLICT (slug) DO NOTHING;

-- Add subscription columns to organizations
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_id                UUID REFERENCES plans(id),
  ADD COLUMN IF NOT EXISTS subscription_status    TEXT DEFAULT 'inactive'
    CHECK (subscription_status IN ('active','trialing','expired','inactive')),
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_email          TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_notes          TEXT DEFAULT '';

-- Auto-assign existing jaljeevika org to Enterprise (active)
UPDATE organizations
SET   plan_id            = (SELECT id FROM plans WHERE slug = 'enterprise'),
      subscription_status = 'active'
WHERE slug = 'jaljeevika';
