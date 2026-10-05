-- 011_performance_review.sql — Performance Review feature (Phase A foundation)
--
-- Adds:
--   • performance_reviews        — per-employee per-period review record
--   • performance_action_items   — action plan items attached to a review
--
-- Idempotent (IF NOT EXISTS everywhere). Safe to re-run. Pairs with
-- lib/aiAgent.js::initAiLayer() which can apply the same DDL on boot.

CREATE TABLE IF NOT EXISTS performance_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id     UUID REFERENCES users(id),
  period_label    TEXT NOT NULL,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  ai_draft        JSONB NOT NULL,
  final_scores    JSONB,
  final_rating    TEXT,
  final_decision  TEXT,
  reviewer_notes  TEXT,
  employee_ack    BOOLEAN DEFAULT false,
  employee_ack_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalised_at    TIMESTAMPTZ,
  UNIQUE (org_id, employee_id, period_label)
);

CREATE INDEX IF NOT EXISTS idx_pr_org_emp
  ON performance_reviews(org_id, employee_id, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_pr_status
  ON performance_reviews(org_id, status, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_pr_reviewer
  ON performance_reviews(org_id, reviewer_id, status)
  WHERE reviewer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS performance_action_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  timeline_days   INT,
  expected_result TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pr_action_review
  ON performance_action_items(review_id, status);
