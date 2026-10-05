-- db/migrations/079_finance_management.sql
--
-- Finance Management tab — owned by the Finance microservice (services/finance).
-- Bounded context: advances, advance settlements, ledger-statement requests,
-- and the in-app notifications they raise. The Compliance Calendar sub-tab
-- reuses the existing compliance_items table (021) unchanged.
--
-- Workflow (agreed 2026-10-03):
--   Advance:    requester → reporting manager → Finance (approve, then record
--               disbursement). Charged to a project; budget line optional and
--               READ-ONLY — nothing here ever writes to budget_utilisation_reports.
--   Settlement: requester submits bills against a disbursed advance (partial
--               settlements allowed, a bill per expense line) → manager → Finance.
--               Finance records refunds (spent < advance) / reimbursements
--               (spent > advance); the advance auto-closes at a zero balance.
--   Ledger:     requester → Finance. Own staff ledger is generated from the rows
--               below; vendor / other ledgers are answered with an uploaded file.
--
-- "Finance" = fm_profiles.is_finance (set by admins), not a new role. Kept in
-- the service's own table (like HR's is_hr) so the service never writes users.
--
-- Additive only. Files (bills, statements) are stored base64 in fm_files, same
-- MVP convention as project_documents (no object-storage bucket yet).

-- ── Per-user Finance profile: Finance-team flag + notification email ──────────
CREATE TABLE IF NOT EXISTS fm_profiles (
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_finance  BOOLEAN NOT NULL DEFAULT false,
  email       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ── Per-org settings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_settings (
  org_id      UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}',   -- { email_enabled, whatsapp_enabled, whatsapp_template, whatsapp_lang, expense_categories[] }
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Reference-number counters (per org, per kind, per Apr–Mar FY) ─────────────
CREATE TABLE IF NOT EXISTS fm_counters (
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,          -- 'ADV' | 'STL' | 'LDG'
  fy       TEXT NOT NULL,          -- e.g. '2026-27'
  last_no  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, kind, fy)
);

-- ── Uploaded files (bills, ledger statements) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by  UUID REFERENCES users(id),
  purpose      TEXT NOT NULL CHECK (purpose IN ('bill', 'statement')),
  file_name    TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INT  NOT NULL,
  data_base64  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_files_org ON fm_files (org_id, created_at DESC);

-- ── Advances ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_advances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref_no              TEXT NOT NULL,
  requester_id        UUID NOT NULL REFERENCES users(id),
  manager_id          UUID REFERENCES users(id),        -- approver for the manager step
  project_key         TEXT NOT NULL,
  project_name        TEXT,                             -- snapshot for display
  budget_section      TEXT,                             -- optional, read-only link to the Financial Tracker
  budget_head         TEXT,
  purpose             TEXT NOT NULL,
  amount_requested    NUMERIC(14,2) NOT NULL CHECK (amount_requested > 0),
  amount_approved     NUMERIC(14,2),
  needed_by           DATE,
  activity_from       DATE,
  activity_to         DATE,
  status              TEXT NOT NULL DEFAULT 'pending_manager'
                      CHECK (status IN ('pending_manager', 'pending_finance', 'approved', 'disbursed',
                                        'settled', 'rejected', 'cancelled')),
  manager_action_by   UUID REFERENCES users(id),
  manager_action_at   TIMESTAMPTZ,
  manager_note        TEXT,
  finance_action_by   UUID REFERENCES users(id),
  finance_action_at   TIMESTAMPTZ,
  finance_note        TEXT,
  disbursed_amount    NUMERIC(14,2),
  disbursed_on        DATE,
  payment_mode        TEXT CHECK (payment_mode IN ('bank_transfer', 'upi', 'cheque', 'cash')),
  payment_ref         TEXT,
  disbursed_by        UUID REFERENCES users(id),
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, ref_no)
);
CREATE INDEX IF NOT EXISTS fm_advances_org_status    ON fm_advances (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS fm_advances_org_requester ON fm_advances (org_id, requester_id);
CREATE INDEX IF NOT EXISTS fm_advances_org_manager   ON fm_advances (org_id, manager_id);

-- ── Settlements (one advance → many partial settlements) ──────────────────────
CREATE TABLE IF NOT EXISTS fm_settlements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref_no              TEXT NOT NULL,
  advance_id          UUID NOT NULL REFERENCES fm_advances(id) ON DELETE CASCADE,
  submitted_by        UUID NOT NULL REFERENCES users(id),
  manager_id          UUID REFERENCES users(id),
  note                TEXT,
  amount_claimed      NUMERIC(14,2) NOT NULL CHECK (amount_claimed > 0),
  amount_approved     NUMERIC(14,2),
  status              TEXT NOT NULL DEFAULT 'pending_manager'
                      CHECK (status IN ('pending_manager', 'pending_finance', 'approved', 'rejected', 'cancelled')),
  manager_action_by   UUID REFERENCES users(id),
  manager_action_at   TIMESTAMPTZ,
  manager_note        TEXT,
  finance_action_by   UUID REFERENCES users(id),
  finance_action_at   TIMESTAMPTZ,
  finance_note        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, ref_no)
);
CREATE INDEX IF NOT EXISTS fm_settlements_org_advance ON fm_settlements (org_id, advance_id);
CREATE INDEX IF NOT EXISTS fm_settlements_org_status  ON fm_settlements (org_id, status);

CREATE TABLE IF NOT EXISTS fm_settlement_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  settlement_id    UUID NOT NULL REFERENCES fm_settlements(id) ON DELETE CASCADE,
  expense_date     DATE NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  amount_approved  NUMERIC(14,2),                       -- Finance may disallow part of a line
  bill_file_id     UUID NOT NULL REFERENCES fm_files(id),
  sort_order       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fm_settlement_lines_settlement ON fm_settlement_lines (settlement_id, sort_order);

-- ── Refunds / reimbursements that square an advance's balance ─────────────────
CREATE TABLE IF NOT EXISTS fm_advance_adjustments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  advance_id    UUID NOT NULL REFERENCES fm_advances(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('refund', 'reimbursement')),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  txn_date      DATE NOT NULL,
  payment_mode  TEXT CHECK (payment_mode IN ('bank_transfer', 'upi', 'cheque', 'cash')),
  payment_ref   TEXT,
  note          TEXT,
  recorded_by   UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_advance_adjustments_advance ON fm_advance_adjustments (org_id, advance_id);

-- ── Ledger-statement requests ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_ledger_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref_no             TEXT NOT NULL,
  requester_id       UUID NOT NULL REFERENCES users(id),
  ledger_type        TEXT NOT NULL CHECK (ledger_type IN ('staff', 'vendor', 'other')),
  party_name         TEXT,                               -- vendor / other ledger name
  from_date          DATE NOT NULL,
  to_date            DATE NOT NULL,
  purpose            TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'fulfilled', 'rejected', 'cancelled')),
  statement_file_id  UUID REFERENCES fm_files(id),
  finance_action_by  UUID REFERENCES users(id),
  finance_action_at  TIMESTAMPTZ,
  finance_note       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, ref_no),
  CHECK (to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS fm_ledger_requests_org_status ON fm_ledger_requests (org_id, status, created_at DESC);

-- ── Audit trail (every state change on an advance / settlement / ledger request) ─
CREATE TABLE IF NOT EXISTS fm_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('advance', 'settlement', 'ledger')),
  entity_id    UUID NOT NULL,
  action       TEXT NOT NULL,
  actor_id     UUID REFERENCES users(id),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_events_entity ON fm_events (org_id, entity_type, entity_id, created_at);

-- ── In-app notifications ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT,
  entity_type  TEXT,
  entity_id    UUID,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_notifications_user ON fm_notifications (org_id, user_id, created_at DESC);

-- ── Row-level security (same org-isolation policy as every other tenant table) ─
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fm_profiles', 'fm_settings', 'fm_counters', 'fm_files', 'fm_advances', 'fm_settlements',
                           'fm_settlement_lines', 'fm_advance_adjustments', 'fm_ledger_requests',
                           'fm_events', 'fm_notifications']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_org_isolation') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
        t || '_org_isolation', t);
    END IF;
  END LOOP;
END $$;

-- ── Dedicated DB role for the Finance Cloud Run service ───────────────────────
-- Full access to fm_* only; read-only access to the shared tables it needs.
-- Password is set out-of-band:
--   ALTER ROLE fm_service PASSWORD '<from Secret Manager FM_DB_PASSWORD>';
-- Skipped with a NOTICE where the migrating user can't create roles (e.g. some
-- managed Postgres tiers) — the monolith's in-process path doesn't need it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fm_service') THEN
    CREATE ROLE fm_service LOGIN;
  END IF;
  GRANT USAGE ON SCHEMA public TO fm_service;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    fm_profiles, fm_settings, fm_counters, fm_files, fm_advances, fm_settlements, fm_settlement_lines,
    fm_advance_adjustments, fm_ledger_requests, fm_events, fm_notifications
    TO fm_service;
  -- Whole-row SELECT on users: the router reads the live-only `active` /
  -- `designation` columns via to_jsonb(u), which needs every column.
  GRANT SELECT ON users, budget_utilisation_reports, wa_config TO fm_service;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'fm_service role/grants skipped: %', SQLERRM;
END $$;
