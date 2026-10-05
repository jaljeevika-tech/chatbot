-- db/migrations/081_finance_budget.sql
--
-- Budget Management (Finance Management sub-tab, services/finance). Per grant
-- (project + grant period) the funnel is:
--   approved budget → received from donor → paid out (staff advances +
--   reimbursements − refunds, plus other project expenses) → bills submitted
--   by staff → money in the bank (computed vs statement) → still held by /
--   owed to staff.
--
-- Agreed 2026-10-03: approved budget is ENTERED here (one total per project per
-- grant period, not split by head/FY — never read from or written to the
-- Financial Tracker); several bank accounts, each receipt/payment tagged to an
-- account; computed balance AND Finance-entered statement balance with the
-- difference; other expenses by form or Excel upload; Finance + admins only.
--
-- Additive only. Depends on 079.

-- ── Bank accounts (incl. cash in hand) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fm_bank_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,                          -- e.g. "FCRA Main — SBI NDMB"
  kind             TEXT NOT NULL CHECK (kind IN ('fcra_main', 'fcra_utilisation', 'local', 'cash', 'other')),
  bank_name        TEXT,
  account_last4    TEXT CHECK (account_last4 ~ '^[0-9]{4}$'),  -- last 4 digits only, never the full number
  opening_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_date     DATE NOT NULL,                          -- computed balance counts movements on/after this date
  active           BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- ── Approved budgets (one row per project per grant period) ────────────────────
CREATE TABLE IF NOT EXISTS fm_budgets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key      TEXT NOT NULL,
  project_name     TEXT,
  donor            TEXT,
  grant_ref        TEXT,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  approved_amount  NUMERIC(14,2) NOT NULL CHECK (approved_amount > 0),
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS fm_budgets_org_project ON fm_budgets (org_id, project_key, period_from);

-- ── Money received from the donor against a grant ─────────────────────────────
CREATE TABLE IF NOT EXISTS fm_receipts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  budget_id        UUID NOT NULL REFERENCES fm_budgets(id) ON DELETE RESTRICT,
  bank_account_id  UUID NOT NULL REFERENCES fm_bank_accounts(id),
  received_on      DATE NOT NULL,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tranche          TEXT,                                   -- e.g. "Tranche 2 of 4"
  reference        TEXT,                                   -- UTR / cheque no.
  note             TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_receipts_budget ON fm_receipts (org_id, budget_id, received_on);

-- ── Other project expenses (vendor bills, salaries, rent …) ───────────────────
CREATE TABLE IF NOT EXISTS fm_expenses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_key      TEXT NOT NULL,
  project_name     TEXT,
  bank_account_id  UUID REFERENCES fm_bank_accounts(id),   -- NULL = not tagged (flagged in reconciliation)
  paid_on          DATE NOT NULL,
  category         TEXT NOT NULL,
  payee            TEXT,
  description      TEXT,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  voucher_ref      TEXT,                                   -- Tally voucher no. etc.
  upload_batch     UUID,                                   -- rows from one Excel upload (undo as a unit)
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fm_expenses_project ON fm_expenses (org_id, project_key, paid_on);
CREATE INDEX IF NOT EXISTS fm_expenses_batch   ON fm_expenses (org_id, upload_batch);

-- ── Transfers between the organisation's own accounts ─────────────────────────
CREATE TABLE IF NOT EXISTS fm_transfers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_account_id  UUID NOT NULL REFERENCES fm_bank_accounts(id),
  to_account_id    UUID NOT NULL REFERENCES fm_bank_accounts(id),
  transfer_on      DATE NOT NULL,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reference        TEXT,
  note             TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

-- ── Bank statement balances entered by Finance (for reconciliation) ───────────
CREATE TABLE IF NOT EXISTS fm_bank_statements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id  UUID NOT NULL REFERENCES fm_bank_accounts(id) ON DELETE CASCADE,
  as_of            DATE NOT NULL,
  balance          NUMERIC(14,2) NOT NULL,                 -- may be negative (overdraft)
  note             TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, as_of)
);

-- ── Which account staff payments / refunds / reimbursements went through ──────
ALTER TABLE fm_advances            ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES fm_bank_accounts(id);
ALTER TABLE fm_advance_adjustments ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES fm_bank_accounts(id);

-- ── Widen 079's audit-trail entity types ──────────────────────────────────────
ALTER TABLE fm_events DROP CONSTRAINT IF EXISTS fm_events_entity_type_check;
ALTER TABLE fm_events ADD  CONSTRAINT fm_events_entity_type_check
  CHECK (entity_type IN ('advance', 'settlement', 'ledger', 'budget', 'receipt', 'expense', 'transfer', 'bank_account', 'statement'));

-- ── Row-level security ────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fm_bank_accounts', 'fm_budgets', 'fm_receipts', 'fm_expenses', 'fm_transfers', 'fm_bank_statements']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_org_isolation') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
        t || '_org_isolation', t);
    END IF;
  END LOOP;
END $$;

-- ── fm_service grants (role created in 079; skipped where it doesn't exist) ───
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fm_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      fm_bank_accounts, fm_budgets, fm_receipts, fm_expenses, fm_transfers, fm_bank_statements
      TO fm_service;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'fm_service grants skipped: %', SQLERRM;
END $$;
