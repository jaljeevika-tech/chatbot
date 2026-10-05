// Budget Management routes (/finance-mgmt/budget/*). Per grant: approved → received
// → paid out → bills submitted → utilised → in hand; per bank account, computed vs
// latest statement balance.
//
// Attribution rules (one place, so every number agrees):
//   • receipts belong to the grant they were recorded against (budget_id);
//   • an advance — with all its settlements, refunds and reimbursements —
//     belongs to the grant of its project whose period contains the date it
//     was paid (so a grant's "held by staff" always matches its own advances);
//   • other expenses belong to the grant of their project covering paid_on.
// Grant periods of one project may not overlap, so each item has at most one grant.
//
// Finance team + admins only; every edit is logged in fm_events as "old → new".
// Approved budgets are entered here, never read from or written to the Financial Tracker.
//
// GET    /finance-mgmt/budget/overview
// GET    /finance-mgmt/budget/budgets/:id          grant detail: receipts, expenses, advances
// POST   /finance-mgmt/budget/budgets              PATCH/DELETE /budgets/:id
// GET    /finance-mgmt/budget/receipts             POST, PATCH/DELETE /receipts/:id
// GET    /finance-mgmt/budget/expenses             POST, PATCH/DELETE /expenses/:id
// POST   /finance-mgmt/budget/expenses/bulk        { rows, dry_run } — Excel/CSV upload
// DELETE /finance-mgmt/budget/expenses/batch/:id   undo one upload
// GET    /finance-mgmt/budget/accounts             POST, PATCH /accounts/:id
// POST   /finance-mgmt/budget/statements           PATCH/DELETE /statements/:id
// GET    /finance-mgmt/budget/transfers            POST, PATCH/DELETE /transfers/:id

import { logEvent } from './db.js'
import { diffNote } from './audit.js'

export const ACCOUNT_KINDS = ['fcra_main', 'fcra_utilisation', 'local', 'cash', 'other']
const MAX_BULK_ROWS = 5000
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const UUID = /^[0-9a-fA-F-]{36}$/

// Deploys can reach production before migration 081, so its tables are checked
// first. Positive result cached; negative re-checked every 30 s so no restart is needed.
let schemaReady = false
let schemaCheckedAt = 0
export async function budgetSchemaReady(query) {
  if (schemaReady) return true
  if (Date.now() - schemaCheckedAt < 30_000) return false
  schemaCheckedAt = Date.now()
  const { rows: [r] } = await query(
    `SELECT to_regclass('public.fm_bank_accounts') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'fm_advances' AND column_name = 'bank_account_id') AS ok`)
  schemaReady = r.ok === true
  return schemaReady
}

/** Validate an optional bank account id against this org's active accounts. */
export async function resolveAccount(c, orgId, id, { required = false, label = 'Bank account' } = {}) {
  if (id == null || id === '') {
    if (required) throw Object.assign(new Error(`${label} is required.`), { status: 400 })
    return null
  }
  if (!UUID.test(String(id))) throw Object.assign(new Error(`${label} is not valid.`), { status: 400 })
  const { rows } = await c.query(`SELECT id FROM fm_bank_accounts WHERE org_id = $1 AND id = $2 AND active`, [orgId, id])
  if (!rows[0]) throw Object.assign(new Error(`${label} was not found or is inactive.`), { status: 400 })
  return rows[0].id
}

export function mountBudgetRoutes(router, d) {
  const { h, ID, bad, forbidden, notFound, money, dateStr, text, round2, requireEditor, ADVANCE_SELECT, withBalance, getPool } = d

  const poolQuery = async sql => {
    const c = await getPool().connect()
    try { return await c.query(sql) } finally { c.release() }
  }
  router.use('/finance-mgmt/budget', async (_req, res, next) => {
    try {
      if (await budgetSchemaReady(poolQuery)) return next()
      res.status(503).json({ error: 'Budget Management is not set up yet — database migration 081 needs to be run.' })
    } catch (e) {
      console.error('[finance-mgmt] budget schema check failed:', e.message)
      res.status(500).json({ error: 'Something went wrong. Please try again.' })
    }
  })
  const requireViewer = ctx => { if (!ctx.isFinance && !ctx.isAdmin) throw forbidden('Budget Management is for the Finance team and admins.') }
  const signedMoney = (v, field) => {
    const n = Math.round(Number(v) * 100) / 100
    if (v === '' || v == null || !Number.isFinite(n) || Math.abs(n) > 1e11) throw bad(`${field} must be a number.`)
    return n
  }
  const acct = (c, ctx, id, opts) => resolveAccount(c, ctx.orgId, id, opts).catch(e => { throw e.status ? bad(e.message) : e })

  // ── Shared SQL: every advance that moved money, with its own totals ────────
  // d = the date that places it in a grant period (paid date).
  const ADV_MONEY = `
    SELECT a.id, a.project_key, a.disbursed_on AS d, a.status,
           a.disbursed_amount::float8 AS paid,
           COALESCE(s.claimed, 0)::float8  AS bills_submitted,
           COALESCE(s.approved, 0)::float8 AS bills_approved,
           COALESCE(j.refunds, 0)::float8  AS refunds,
           COALESCE(j.reimb, 0)::float8    AS reimbursements
      FROM fm_advances a
      LEFT JOIN LATERAL (
        SELECT SUM(amount_claimed)  FILTER (WHERE status IN ('pending_manager', 'pending_finance', 'approved')) AS claimed,
               SUM(amount_approved) FILTER (WHERE status = 'approved') AS approved
          FROM fm_settlements WHERE advance_id = a.id) s ON true
      LEFT JOIN LATERAL (
        SELECT SUM(amount) FILTER (WHERE kind = 'refund') AS refunds,
               SUM(amount) FILTER (WHERE kind = 'reimbursement') AS reimb
          FROM fm_advance_adjustments WHERE advance_id = a.id) j ON true
     WHERE a.org_id = $1 AND a.status IN ('disbursed', 'settled') AND a.disbursed_on IS NOT NULL`

  const BUDGET_COLS = `b.id, b.project_key, b.project_name, b.donor, b.grant_ref,
    b.period_from::text AS period_from, b.period_to::text AS period_to,
    b.approved_amount::float8 AS approved, b.notes, b.created_at, b.updated_at`

  /** Funnel numbers for every grant (or one), computed in a single query. */
  async function grantRows(c, orgId, budgetId = null) {
    const { rows } = await c.query(
      `WITH adv AS (${ADV_MONEY})
       SELECT ${BUDGET_COLS},
         (SELECT COALESCE(SUM(r.amount), 0) FROM fm_receipts r WHERE r.org_id = $1 AND r.budget_id = b.id)::float8 AS received,
         x.staff_paid, x.reimbursed, x.refunded, x.bills_submitted, x.bills_approved, x.held_by_staff, x.owed_to_staff, x.open_advances,
         (SELECT COALESCE(SUM(e.amount), 0) FROM fm_expenses e
           WHERE e.org_id = $1 AND e.project_key = b.project_key AND e.paid_on BETWEEN b.period_from AND b.period_to)::float8 AS other_expenses
       FROM fm_budgets b
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(paid), 0)::float8 AS staff_paid,
                COALESCE(SUM(reimbursements), 0)::float8 AS reimbursed,
                COALESCE(SUM(refunds), 0)::float8 AS refunded,
                COALESCE(SUM(bills_submitted), 0)::float8 AS bills_submitted,
                COALESCE(SUM(bills_approved), 0)::float8 AS bills_approved,
                COALESCE(SUM(GREATEST(paid - bills_approved - refunds + reimbursements, 0)) FILTER (WHERE status = 'disbursed'), 0)::float8 AS held_by_staff,
                COALESCE(SUM(GREATEST(-(paid - bills_approved - refunds + reimbursements), 0)) FILTER (WHERE status = 'disbursed'), 0)::float8 AS owed_to_staff,
                COUNT(*) FILTER (WHERE status = 'disbursed')::int AS open_advances
           FROM adv WHERE adv.project_key = b.project_key AND adv.d BETWEEN b.period_from AND b.period_to
       ) x ON true
       WHERE b.org_id = $1 ${budgetId ? 'AND b.id = $2' : ''}
       ORDER BY b.project_name NULLS LAST, b.period_from DESC`,
      budgetId ? [orgId, budgetId] : [orgId])
    return rows.map(r => {
      const paidOut  = round2(r.staff_paid + r.reimbursed - r.refunded + r.other_expenses)
      const utilised = round2(r.bills_approved + r.other_expenses)
      return {
        ...r,
        paid_out: paidOut,
        utilised,
        funds_in_hand: round2(r.received - paidOut),
        pending_from_donor: round2(Math.max(r.approved - r.received, 0)),
        budget_left: round2(r.approved - utilised),
        utilisation_pct: r.approved ? Math.round((utilised / r.approved) * 1000) / 10 : 0,
      }
    })
  }

  /** Per-account computed balance now and as at the latest statement date. */
  async function accountRows(c, orgId) {
    const { rows } = await c.query(
      `WITH mv AS (
         SELECT bank_account_id AS acc, received_on AS d, amount AS amt FROM fm_receipts WHERE org_id = $1
         UNION ALL SELECT bank_account_id, disbursed_on, -disbursed_amount FROM fm_advances
           WHERE org_id = $1 AND bank_account_id IS NOT NULL AND status IN ('disbursed', 'settled') AND disbursed_on IS NOT NULL
         UNION ALL SELECT bank_account_id, txn_date, CASE kind WHEN 'refund' THEN amount ELSE -amount END
           FROM fm_advance_adjustments WHERE org_id = $1 AND bank_account_id IS NOT NULL
         UNION ALL SELECT bank_account_id, paid_on, -amount FROM fm_expenses WHERE org_id = $1 AND bank_account_id IS NOT NULL
         UNION ALL SELECT to_account_id, transfer_on, amount FROM fm_transfers WHERE org_id = $1
         UNION ALL SELECT from_account_id, transfer_on, -amount FROM fm_transfers WHERE org_id = $1
       ),
       st AS (
         SELECT DISTINCT ON (bank_account_id) id, bank_account_id, as_of, balance, note
           FROM fm_bank_statements WHERE org_id = $1 ORDER BY bank_account_id, as_of DESC
       )
       SELECT a.id, a.name, a.kind, a.bank_name, a.account_last4, a.active,
              a.opening_balance::float8 AS opening_balance, a.opening_date::text AS opening_date,
              (a.opening_balance + COALESCE((SELECT SUM(amt) FROM mv WHERE mv.acc = a.id AND mv.d >= a.opening_date), 0))::float8 AS computed_balance,
              st.id AS statement_id, st.as_of::text AS statement_as_of, st.balance::float8 AS statement_balance, st.note AS statement_note,
              CASE WHEN st.as_of IS NULL THEN NULL ELSE
                (a.opening_balance + COALESCE((SELECT SUM(amt) FROM mv WHERE mv.acc = a.id AND mv.d >= a.opening_date AND mv.d <= st.as_of), 0))::float8
              END AS computed_at_statement,
              (SELECT COUNT(*) FROM mv WHERE mv.acc = a.id AND mv.d < a.opening_date)::int AS before_opening
         FROM fm_bank_accounts a LEFT JOIN st ON st.bank_account_id = a.id
        WHERE a.org_id = $1
        ORDER BY a.active DESC, a.name`, [orgId])
    return rows.map(r => ({
      ...r,
      difference: r.statement_balance == null ? null : round2(r.statement_balance - r.computed_at_statement),
    }))
  }

  // ── Overview ───────────────────────────────────────────────────────────────
  router.get('/finance-mgmt/budget/overview', h(async (_req, res, ctx) => {
    requireViewer(ctx)
    const { orgId } = ctx
    const out = await ctx.tx(async c => {
      const grants = await grantRows(c, orgId)
      const accounts = await accountRows(c, orgId)
      // Money that isn't inside any grant period, or isn't tagged to an account.
      const { rows: [gaps] } = await c.query(
        `WITH adv AS (${ADV_MONEY})
         SELECT
           (SELECT COUNT(*) FROM adv WHERE NOT EXISTS (SELECT 1 FROM fm_budgets b WHERE b.org_id = $1
               AND b.project_key = adv.project_key AND adv.d BETWEEN b.period_from AND b.period_to))::int AS adv_outside_n,
           (SELECT COALESCE(SUM(paid), 0) FROM adv WHERE NOT EXISTS (SELECT 1 FROM fm_budgets b WHERE b.org_id = $1
               AND b.project_key = adv.project_key AND adv.d BETWEEN b.period_from AND b.period_to))::float8 AS adv_outside_amt,
           (SELECT COUNT(*) FROM fm_expenses e WHERE e.org_id = $1 AND NOT EXISTS (SELECT 1 FROM fm_budgets b WHERE b.org_id = $1
               AND b.project_key = e.project_key AND e.paid_on BETWEEN b.period_from AND b.period_to))::int AS exp_outside_n,
           (SELECT COALESCE(SUM(amount), 0) FROM fm_expenses e WHERE e.org_id = $1 AND NOT EXISTS (SELECT 1 FROM fm_budgets b WHERE b.org_id = $1
               AND b.project_key = e.project_key AND e.paid_on BETWEEN b.period_from AND b.period_to))::float8 AS exp_outside_amt,
           (SELECT COUNT(*) FROM fm_expenses WHERE org_id = $1 AND bank_account_id IS NULL)::int AS exp_untagged_n,
           (SELECT COALESCE(SUM(amount), 0) FROM fm_expenses WHERE org_id = $1 AND bank_account_id IS NULL)::float8 AS exp_untagged_amt,
           (SELECT COUNT(*) FROM fm_advances WHERE org_id = $1 AND bank_account_id IS NULL AND status IN ('disbursed', 'settled'))::int AS adv_untagged_n,
           (SELECT COALESCE(SUM(disbursed_amount), 0) FROM fm_advances WHERE org_id = $1 AND bank_account_id IS NULL AND status IN ('disbursed', 'settled'))::float8 AS adv_untagged_amt,
           (SELECT COUNT(*) FROM fm_advance_adjustments WHERE org_id = $1 AND bank_account_id IS NULL)::int AS adj_untagged_n`,
        [orgId])
      return { grants, accounts, gaps }
    })
    const sum = k => round2(out.grants.reduce((t, g) => t + (g[k] || 0), 0))
    const totals = Object.fromEntries(['approved', 'received', 'staff_paid', 'reimbursed', 'refunded', 'other_expenses', 'paid_out',
      'bills_submitted', 'bills_approved', 'utilised', 'funds_in_hand', 'pending_from_donor', 'budget_left', 'held_by_staff', 'owed_to_staff']
      .map(k => [k, sum(k)]))
    const active = out.accounts.filter(a => a.active)
    totals.bank_computed = round2(active.reduce((t, a) => t + a.computed_balance, 0))
    // Reconciliation is per account, each on its own statement date — never
    // compare a partial statement total with the all-accounts computed total.
    const withStatement = active.filter(a => a.statement_balance != null)
    totals.bank_accounts = active.length
    totals.bank_reconciled = withStatement.length
    totals.bank_difference = withStatement.length ? round2(withStatement.reduce((t, a) => t + a.difference, 0)) : null
    res.json({ totals, grants: out.grants, accounts: out.accounts, gaps: out.gaps })
  }))

  // ── Budgets (grants) ───────────────────────────────────────────────────────
  function budgetInput(b) {
    const from = dateStr(b.period_from, 'Grant period start')
    const to   = dateStr(b.period_to, 'Grant period end')
    if (to < from) throw bad('Grant period end must be on or after the start.')
    return {
      project_key:  text(b.project_key, 'Project', { required: true, max: 200 }),
      project_name: text(b.project_name, 'Project name', { max: 300 }),
      donor:        text(b.donor, 'Donor', { max: 300 }),
      grant_ref:    text(b.grant_ref, 'Grant reference', { max: 200 }),
      period_from: from, period_to: to,
      approved:     money(b.approved_amount, 'Approved budget'),
      notes:        text(b.notes, 'Notes', { max: 2000 }),
    }
  }
  async function assertNoOverlap(c, orgId, v, exceptId = null) {
    const { rows } = await c.query(
      `SELECT period_from::text AS f, period_to::text AS t FROM fm_budgets
        WHERE org_id = $1 AND project_key = $2 AND period_from <= $4 AND period_to >= $3 ${exceptId ? 'AND id <> $5' : ''} LIMIT 1`,
      exceptId ? [orgId, v.project_key, v.period_from, v.period_to, exceptId] : [orgId, v.project_key, v.period_from, v.period_to])
    if (rows[0]) throw bad(`This project already has a budget for ${rows[0].f} – ${rows[0].t}. Grant periods of one project cannot overlap.`)
  }

  router.post('/finance-mgmt/budget/budgets', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const v = budgetInput(req.body || {})
    const id = await ctx.tx(async c => {
      await assertNoOverlap(c, ctx.orgId, v)
      const { rows: [r] } = await c.query(
        `INSERT INTO fm_budgets (org_id, project_key, project_name, donor, grant_ref, period_from, period_to, approved_amount, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ctx.orgId, v.project_key, v.project_name, v.donor, v.grant_ref, v.period_from, v.period_to, v.approved, v.notes, ctx.me.id])
      await logEvent(c, ctx.orgId, 'budget', r.id, 'created', ctx.me.id, `${v.project_name || v.project_key} ${v.period_from} to ${v.period_to}: approved ${inr(v.approved)}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  router.patch(`/finance-mgmt/budget/budgets/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const v = budgetInput(req.body || {})
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT id, project_key, project_name, donor, grant_ref, period_from::text AS period_from, period_to::text AS period_to,
                approved_amount::float8 AS approved, notes FROM fm_budgets WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Budget not found.')
      const { note } = diffNote({ ...cur, project: cur.project_name || cur.project_key }, { ...v, project: v.project_name || v.project_key },
        [['project', 'Project'], ['donor', 'Donor'], ['grant_ref', 'Grant ref.'], ['period_from', 'Period from'], ['period_to', 'Period to'],
         ['approved', 'Approved budget', 'money'], ['notes', 'Notes']])
      if (!note) throw bad('Nothing was changed.')
      if (cur.project_key !== v.project_key) {
        const { rows: [n] } = await c.query(`SELECT COUNT(*)::int AS n FROM fm_receipts WHERE org_id = $1 AND budget_id = $2`, [ctx.orgId, cur.id])
        if (n.n) throw bad('This budget already has donor receipts — its project cannot be changed.')
      }
      await assertNoOverlap(c, ctx.orgId, v, cur.id)
      await c.query(
        `UPDATE fm_budgets SET project_key = $3, project_name = $4, donor = $5, grant_ref = $6, period_from = $7, period_to = $8,
                approved_amount = $9, notes = $10, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, cur.id, v.project_key, v.project_name, v.donor, v.grant_ref, v.period_from, v.period_to, v.approved, v.notes])
      await logEvent(c, ctx.orgId, 'budget', cur.id, 'edited', ctx.me.id, note)
    })
    res.json({ ok: true })
  }))

  router.delete(`/finance-mgmt/budget/budgets/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    await ctx.tx(async c => {
      const { rows: [n] } = await c.query(`SELECT COUNT(*)::int AS n FROM fm_receipts WHERE org_id = $1 AND budget_id = $2`, [ctx.orgId, req.params.id])
      if (n.n) throw bad('Delete this budget’s donor receipts first.')
      const { rowCount } = await c.query(`DELETE FROM fm_budgets WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!rowCount) throw notFound('Budget not found.')
      await logEvent(c, ctx.orgId, 'budget', req.params.id, 'deleted', ctx.me.id)
    })
    res.json({ ok: true })
  }))

  router.get(`/finance-mgmt/budget/budgets/:id${ID}`, h(async (req, res, ctx) => {
    requireViewer(ctx)
    const out = await ctx.tx(async c => {
      const [grant] = await grantRows(c, ctx.orgId, req.params.id)
      if (!grant) throw notFound('Budget not found.')
      const { rows: receipts } = await c.query(
        `SELECT r.id, r.budget_id, r.bank_account_id, r.received_on::text AS received_on, r.amount::float8 AS amount, r.tranche, r.reference, r.note,
                a.name AS account_name, u.name AS created_by_name, r.created_at
           FROM fm_receipts r JOIN fm_bank_accounts a ON a.id = r.bank_account_id LEFT JOIN users u ON u.id = r.created_by
          WHERE r.org_id = $1 AND r.budget_id = $2 ORDER BY r.received_on DESC, r.created_at DESC`, [ctx.orgId, grant.id])
      const { rows: expenses } = await c.query(
        `SELECT e.id, e.project_key, e.project_name, e.bank_account_id, e.paid_on::text AS paid_on, e.category, e.payee, e.description, e.amount::float8 AS amount, e.voucher_ref,
                a.name AS account_name, e.upload_batch
           FROM fm_expenses e LEFT JOIN fm_bank_accounts a ON a.id = e.bank_account_id
          WHERE e.org_id = $1 AND e.project_key = $2 AND e.paid_on BETWEEN $3 AND $4
          ORDER BY e.paid_on DESC, e.created_at DESC LIMIT 1000`, [ctx.orgId, grant.project_key, grant.period_from, grant.period_to])
      const { rows: advances } = await c.query(
        `${ADVANCE_SELECT} WHERE a.org_id = $1 AND a.project_key = $2 AND a.status IN ('disbursed', 'settled')
           AND a.disbursed_on BETWEEN $3 AND $4 ORDER BY a.disbursed_on DESC`, [ctx.orgId, grant.project_key, grant.period_from, grant.period_to])
      const { rows: byCategory } = await c.query(
        `SELECT category, COUNT(*)::int AS n, SUM(amount)::float8 AS amount FROM fm_expenses
          WHERE org_id = $1 AND project_key = $2 AND paid_on BETWEEN $3 AND $4 GROUP BY category ORDER BY 3 DESC`,
        [ctx.orgId, grant.project_key, grant.period_from, grant.period_to])
      return { grant, receipts, expenses, advances: advances.map(withBalance), expenses_by_category: byCategory }
    })
    res.json(out)
  }))

  // ── Donor receipts ─────────────────────────────────────────────────────────
  router.get('/finance-mgmt/budget/receipts', h(async (req, res, ctx) => {
    requireViewer(ctx)
    const budget = req.query.budget && UUID.test(String(req.query.budget)) ? String(req.query.budget) : null
    const { rows } = await ctx.tx(c => c.query(
      `SELECT r.id, r.budget_id, r.bank_account_id, b.project_key, b.project_name, b.donor, r.received_on::text AS received_on, r.amount::float8 AS amount,
              r.tranche, r.reference, r.note, a.name AS account_name, r.created_at
         FROM fm_receipts r JOIN fm_budgets b ON b.id = r.budget_id JOIN fm_bank_accounts a ON a.id = r.bank_account_id
        WHERE r.org_id = $1 ${budget ? 'AND r.budget_id = $2' : ''}
        ORDER BY r.received_on DESC, r.created_at DESC LIMIT 1000`, budget ? [ctx.orgId, budget] : [ctx.orgId]))
    res.json({ receipts: rows })
  }))

  router.post('/finance-mgmt/budget/receipts', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    if (!UUID.test(String(b.budget_id || ''))) throw bad('Choose the grant this money was received for.')
    const on     = dateStr(b.received_on, 'Date received')
    const amount = money(b.amount)
    const id = await ctx.tx(async c => {
      const { rows: [g] } = await c.query(`SELECT id FROM fm_budgets WHERE org_id = $1 AND id = $2`, [ctx.orgId, b.budget_id])
      if (!g) throw bad('That grant was not found.')
      const account = await acct(c, ctx, b.bank_account_id, { required: true, label: 'Received into account' })
      const { rows: [r] } = await c.query(
        `INSERT INTO fm_receipts (org_id, budget_id, bank_account_id, received_on, amount, tranche, reference, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [ctx.orgId, g.id, account, on, amount, text(b.tranche, 'Tranche', { max: 100 }),
         text(b.reference, 'Reference', { max: 200 }), text(b.note, 'Note', { max: 1000 }), ctx.me.id])
      await logEvent(c, ctx.orgId, 'receipt', r.id, 'created', ctx.me.id, `${inr(amount)} received on ${on}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  router.delete(`/finance-mgmt/budget/receipts/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    await ctx.tx(async c => {
      const { rows: [r] } = await c.query(`DELETE FROM fm_receipts WHERE org_id = $1 AND id = $2 RETURNING amount::text, received_on::text`, [ctx.orgId, req.params.id])
      if (!r) throw notFound('Receipt not found.')
      await logEvent(c, ctx.orgId, 'receipt', req.params.id, 'deleted', ctx.me.id, `${inr(r.amount)} received on ${r.received_on}`)
    })
    res.json({ ok: true })
  }))

  // ── Other expenses ─────────────────────────────────────────────────────────
  router.get('/finance-mgmt/budget/expenses', h(async (req, res, ctx) => {
    requireViewer(ctx)
    const where = ['e.org_id = $1'], vals = [ctx.orgId]
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)) }
    if (req.query.project) add('e.project_key = ?', String(req.query.project))
    if (req.query.from) add('e.paid_on >= ?', dateStr(req.query.from, 'From'))
    if (req.query.to) add('e.paid_on <= ?', dateStr(req.query.to, 'To'))
    if (req.query.untagged === '1') where.push('e.bank_account_id IS NULL')
    const { rows } = await ctx.tx(c => c.query(
      `SELECT e.id, e.project_key, e.project_name, e.paid_on::text AS paid_on, e.category, e.payee, e.description,
              e.amount::float8 AS amount, e.voucher_ref, e.bank_account_id, a.name AS account_name, e.upload_batch, e.created_at
         FROM fm_expenses e LEFT JOIN fm_bank_accounts a ON a.id = e.bank_account_id
        WHERE ${where.join(' AND ')} ORDER BY e.paid_on DESC, e.created_at DESC LIMIT 2000`, vals))
    res.json({ expenses: rows })
  }))

  function expenseInput(r, label = '') {
    return {
      project_key:     text(r.project_key, `${label}Project`, { required: true, max: 200 }),
      project_name:    text(r.project_name, `${label}Project name`, { max: 300 }),
      paid_on:         dateStr(r.paid_on, `${label}Date`),
      category:        text(r.category, `${label}Category`, { required: true, max: 100 }),
      payee:           text(r.payee, `${label}Payee`, { max: 300 }),
      description:     text(r.description, `${label}Description`, { max: 1000 }),
      amount:          money(r.amount, `${label}Amount`),
      voucher_ref:     text(r.voucher_ref, `${label}Voucher no.`, { max: 100 }),
      bank_account_id: r.bank_account_id || null,
    }
  }
  const INSERT_EXPENSE = `INSERT INTO fm_expenses (org_id, project_key, project_name, bank_account_id, paid_on, category, payee,
      description, amount, voucher_ref, upload_batch, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`
  const expenseVals = (ctx, v, account, batch) =>
    [ctx.orgId, v.project_key, v.project_name, account, v.paid_on, v.category, v.payee, v.description, v.amount, v.voucher_ref, batch, ctx.me.id]

  router.post('/finance-mgmt/budget/expenses', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const v = expenseInput(req.body || {})
    const id = await ctx.tx(async c => {
      const account = await acct(c, ctx, v.bank_account_id, { label: 'Paid from account' })
      const { rows: [r] } = await c.query(INSERT_EXPENSE, expenseVals(ctx, v, account, null))
      await logEvent(c, ctx.orgId, 'expense', r.id, 'created', ctx.me.id, `${inr(v.amount)} ${v.category} paid on ${v.paid_on}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  // Bulk upload: the browser parses the Excel/CSV and maps project / account
  // names to ids. dry_run validates every row and flags likely duplicates
  // (same project, date, amount and voucher no.) without writing; the real
  // run is all-or-nothing in one transaction.
  router.post('/finance-mgmt/budget/expenses/bulk', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
    if (!rows?.length) throw bad('No rows to upload.')
    if (rows.length > MAX_BULK_ROWS) throw bad(`Too many rows (max ${MAX_BULK_ROWS} per upload) — split the file.`)
    const dryRun = req.body.dry_run === true
    const errors = []
    const parsed = rows.map((r, i) => {
      try { return expenseInput(r || {}) } catch (e) { errors.push({ row: i + 1, error: e.message }); return null }
    })
    const out = await ctx.tx(async c => {
      const { rows: accts } = await c.query(`SELECT id FROM fm_bank_accounts WHERE org_id = $1 AND active`, [ctx.orgId])
      const okAcct = new Set(accts.map(a => a.id))
      parsed.forEach((v, i) => {
        if (v?.bank_account_id && !okAcct.has(v.bank_account_id)) { errors.push({ row: i + 1, error: 'Unknown or inactive bank account.' }); parsed[i] = null }
      })
      const valid = parsed.filter(Boolean)
      // Likely duplicates of rows already stored
      let duplicates = []
      if (valid.length) {
        const { rows: dup } = await c.query(
          `SELECT DISTINCT x.idx::int AS idx FROM unnest($2::text[], $3::date[], $4::numeric[], $5::text[]) WITH ORDINALITY AS x(p, d, a, v, idx)
             JOIN fm_expenses e ON e.org_id = $1 AND e.project_key = x.p AND e.paid_on = x.d AND e.amount = x.a
                               AND COALESCE(e.voucher_ref, '') = COALESCE(x.v, '')`,
          [ctx.orgId, valid.map(v => v.project_key), valid.map(v => v.paid_on), valid.map(v => v.amount), valid.map(v => v.voucher_ref || '')])
        const validIdx = parsed.map((v, i) => (v ? i + 1 : null)).filter(Boolean)
        duplicates = dup.map(d => validIdx[d.idx - 1])
      }
      if (dryRun || errors.length) {
        return { inserted: 0, valid: valid.length, total: round2(valid.reduce((t, v) => t + v.amount, 0)), duplicates }
      }
      const batch = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id
      for (const v of valid) await c.query(INSERT_EXPENSE, expenseVals(ctx, v, v.bank_account_id, batch))
      await logEvent(c, ctx.orgId, 'expense', batch, 'bulk_uploaded', ctx.me.id, `${valid.length} rows`)
      return { inserted: valid.length, batch, total: round2(valid.reduce((t, v) => t + v.amount, 0)), duplicates }
    })
    errors.sort((a, b) => a.row - b.row)
    if (!dryRun && errors.length) return res.status(400).json({ error: `${errors.length} row(s) have problems — nothing was saved.`, errors, ...out })
    res.status(dryRun ? 200 : 201).json({ ...out, errors })
  }))

  router.delete(`/finance-mgmt/budget/expenses/batch/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const n = await ctx.tx(async c => {
      const { rowCount } = await c.query(`DELETE FROM fm_expenses WHERE org_id = $1 AND upload_batch = $2`, [ctx.orgId, req.params.id])
      if (!rowCount) throw notFound('Upload not found.')
      await logEvent(c, ctx.orgId, 'expense', req.params.id, 'bulk_deleted', ctx.me.id, `${rowCount} rows`)
      return rowCount
    })
    res.json({ ok: true, deleted: n })
  }))

  router.delete(`/finance-mgmt/budget/expenses/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    await ctx.tx(async c => {
      const { rows: [r] } = await c.query(`DELETE FROM fm_expenses WHERE org_id = $1 AND id = $2 RETURNING amount::text, category, paid_on::text`, [ctx.orgId, req.params.id])
      if (!r) throw notFound('Expense not found.')
      await logEvent(c, ctx.orgId, 'expense', req.params.id, 'deleted', ctx.me.id, `${inr(r.amount)} ${r.category} paid on ${r.paid_on}`)
    })
    res.json({ ok: true })
  }))

  // ── Bank accounts + statements ─────────────────────────────────────────────
  router.get('/finance-mgmt/budget/accounts', h(async (_req, res, ctx) => {
    requireViewer(ctx)
    const accounts = await ctx.tx(c => accountRows(c, ctx.orgId))
    res.json({ accounts })
  }))

  function accountInput(b) {
    if (!ACCOUNT_KINDS.includes(b.kind)) throw bad('Choose the account type.')
    const last4 = text(b.account_last4, 'Last 4 digits', { max: 4 })
    if (last4 && !/^\d{4}$/.test(last4)) throw bad('Enter exactly the last 4 digits of the account number.')
    return {
      name: text(b.name, 'Account name', { required: true, max: 120 }),
      kind: b.kind,
      bank_name: text(b.bank_name, 'Bank', { max: 120 }),
      last4,
      opening_balance: signedMoney(b.opening_balance ?? 0, 'Opening balance'),
      opening_date: dateStr(b.opening_date, 'Opening balance date'),
    }
  }

  router.post('/finance-mgmt/budget/accounts', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const v = accountInput(req.body || {})
    const id = await ctx.tx(async c => {
      const { rows: [dup] } = await c.query(`SELECT 1 FROM fm_bank_accounts WHERE org_id = $1 AND lower(name) = lower($2)`, [ctx.orgId, v.name])
      if (dup) throw bad('An account with this name already exists.')
      const { rows: [r] } = await c.query(
        `INSERT INTO fm_bank_accounts (org_id, name, kind, bank_name, account_last4, opening_balance, opening_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.orgId, v.name, v.kind, v.bank_name, v.last4, v.opening_balance, v.opening_date, ctx.me.id])
      await logEvent(c, ctx.orgId, 'bank_account', r.id, 'created', ctx.me.id, `${v.name}, opening balance ${inr(v.opening_balance)} on ${v.opening_date}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  router.patch(`/finance-mgmt/budget/accounts/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT id, name, kind, bank_name, account_last4 AS last4, opening_balance::float8 AS opening_balance, opening_date::text AS opening_date
           FROM fm_bank_accounts WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Account not found.')
      if (Object.keys(b).length === 1 && typeof b.active === 'boolean') {
        await c.query(`UPDATE fm_bank_accounts SET active = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, [ctx.orgId, cur.id, b.active])
        await logEvent(c, ctx.orgId, 'bank_account', cur.id, b.active ? 'reactivated' : 'deactivated', ctx.me.id)
        return
      }
      const v = accountInput(b)
      const { rows: [dup] } = await c.query(`SELECT 1 FROM fm_bank_accounts WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3`, [ctx.orgId, v.name, cur.id])
      if (dup) throw bad('An account with this name already exists.')
      await c.query(
        `UPDATE fm_bank_accounts SET name = $3, kind = $4, bank_name = $5, account_last4 = $6, opening_balance = $7, opening_date = $8,
                updated_at = now() WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, cur.id, v.name, v.kind, v.bank_name, v.last4, v.opening_balance, v.opening_date])
      const { note } = diffNote(cur, v, [['name', 'Name'], ['kind', 'Type'], ['bank_name', 'Bank'], ['last4', 'Last 4 digits'],
        ['opening_balance', 'Opening balance', 'money'], ['opening_date', 'Opening date']])
      await logEvent(c, ctx.orgId, 'bank_account', cur.id, 'edited', ctx.me.id, note || 'No field changes')
    })
    res.json({ ok: true })
  }))

  router.post('/finance-mgmt/budget/statements', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const asOf = dateStr(b.as_of, 'Statement date')
    const balance = signedMoney(b.balance, 'Statement balance')
    const id = await ctx.tx(async c => {
      const account = await acct(c, ctx, b.bank_account_id, { required: true })
      const { rows: [prev] } = await c.query(
        `SELECT balance::float8 AS balance FROM fm_bank_statements WHERE org_id = $1 AND bank_account_id = $2 AND as_of = $3 FOR UPDATE`,
        [ctx.orgId, account, asOf])
      const { rows: [r] } = await c.query(
        `INSERT INTO fm_bank_statements (org_id, bank_account_id, as_of, balance, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bank_account_id, as_of) DO UPDATE SET balance = EXCLUDED.balance, note = EXCLUDED.note,
           created_by = EXCLUDED.created_by, created_at = now()
         RETURNING id`, [ctx.orgId, account, asOf, balance, text(b.note, 'Note', { max: 500 }), ctx.me.id])
      await logEvent(c, ctx.orgId, 'statement', r.id, prev ? 'edited' : 'recorded', ctx.me.id,
        prev ? `Balance as on ${asOf}: ${inr(prev.balance)} → ${inr(balance)}` : `${inr(balance)} as on ${asOf}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  router.delete(`/finance-mgmt/budget/statements/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    await ctx.tx(async c => {
      const { rowCount } = await c.query(`DELETE FROM fm_bank_statements WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!rowCount) throw notFound('Statement balance not found.')
      await logEvent(c, ctx.orgId, 'statement', req.params.id, 'deleted', ctx.me.id)
    })
    res.json({ ok: true })
  }))

  // ── Transfers between own accounts ─────────────────────────────────────────
  router.get('/finance-mgmt/budget/transfers', h(async (_req, res, ctx) => {
    requireViewer(ctx)
    const { rows } = await ctx.tx(c => c.query(
      `SELECT t.id, t.from_account_id, t.to_account_id, t.transfer_on::text AS transfer_on, t.amount::float8 AS amount, t.reference, t.note,
              f.name AS from_name, x.name AS to_name, t.created_at
         FROM fm_transfers t JOIN fm_bank_accounts f ON f.id = t.from_account_id JOIN fm_bank_accounts x ON x.id = t.to_account_id
        WHERE t.org_id = $1 ORDER BY t.transfer_on DESC, t.created_at DESC LIMIT 500`, [ctx.orgId]))
    res.json({ transfers: rows })
  }))

  router.post('/finance-mgmt/budget/transfers', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const on = dateStr(b.transfer_on, 'Transfer date')
    const amount = money(b.amount)
    const id = await ctx.tx(async c => {
      const from = await acct(c, ctx, b.from_account_id, { required: true, label: 'From account' })
      const to   = await acct(c, ctx, b.to_account_id, { required: true, label: 'To account' })
      if (from === to) throw bad('From and to accounts must be different.')
      const { rows: [r] } = await c.query(
        `INSERT INTO fm_transfers (org_id, from_account_id, to_account_id, transfer_on, amount, reference, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.orgId, from, to, on, amount, text(b.reference, 'Reference', { max: 200 }), text(b.note, 'Note', { max: 500 }), ctx.me.id])
      await logEvent(c, ctx.orgId, 'transfer', r.id, 'created', ctx.me.id, `${inr(amount)} on ${on}`)
      return r.id
    })
    res.status(201).json({ id })
  }))

  router.delete(`/finance-mgmt/budget/transfers/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    await ctx.tx(async c => {
      const { rowCount } = await c.query(`DELETE FROM fm_transfers WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!rowCount) throw notFound('Transfer not found.')
      await logEvent(c, ctx.orgId, 'transfer', req.params.id, 'deleted', ctx.me.id)
    })
    res.json({ ok: true })
  }))

  // ── Edits (Finance + admins) — every change logged "old → new" ────────────
  const accountName = async (c, id) => id ? (await c.query('SELECT name FROM fm_bank_accounts WHERE id = $1', [id])).rows[0]?.name ?? null : null
  const GRANT_LABEL = "COALESCE(g.project_name, g.project_key) || ' ' || g.period_from || ' to ' || g.period_to"

  router.patch(`/finance-mgmt/budget/receipts/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT r.id, r.budget_id, r.bank_account_id, r.received_on::text AS received_on, r.amount::float8 AS amount,
                r.tranche, r.reference, r.note, a.name AS account, ${GRANT_LABEL} AS grant_label
           FROM fm_receipts r JOIN fm_bank_accounts a ON a.id = r.bank_account_id JOIN fm_budgets g ON g.id = r.budget_id
          WHERE r.org_id = $1 AND r.id = $2`, [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Receipt not found.')
      const next = { ...cur }
      if ('budget_id' in b) {
        if (!UUID.test(String(b.budget_id || ''))) throw bad('Choose the grant.')
        const { rows: [g] } = await c.query(`SELECT g.id, ${GRANT_LABEL} AS label FROM fm_budgets g WHERE g.org_id = $1 AND g.id = $2`, [ctx.orgId, b.budget_id])
        if (!g) throw bad('That grant was not found.')
        next.budget_id = g.id; next.grant_label = g.label
      }
      if ('bank_account_id' in b) {
        next.bank_account_id = await acct(c, ctx, b.bank_account_id, { required: true, label: 'Received into account' })
        next.account = await accountName(c, next.bank_account_id)
      }
      if ('received_on' in b) next.received_on = dateStr(b.received_on, 'Date received')
      if ('amount' in b) next.amount = money(b.amount)
      for (const [k, l, max] of [['tranche', 'Tranche', 100], ['reference', 'Reference', 200], ['note', 'Note', 1000]]) {
        if (k in b) next[k] = text(b[k], l, { max })
      }
      const { note } = diffNote(cur, next, [['grant_label', 'Grant'], ['received_on', 'Date'], ['amount', 'Amount', 'money'],
        ['account', 'Account'], ['tranche', 'Tranche'], ['reference', 'Reference'], ['note', 'Note']])
      if (!note) throw bad('Nothing was changed.')
      await c.query(
        `UPDATE fm_receipts SET budget_id = $3, bank_account_id = $4, received_on = $5, amount = $6, tranche = $7, reference = $8, note = $9
          WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, cur.id, next.budget_id, next.bank_account_id, next.received_on, next.amount, next.tranche, next.reference, next.note])
      await logEvent(c, ctx.orgId, 'receipt', cur.id, 'edited', ctx.me.id, note)
    })
    res.json({ ok: true })
  }))

  router.patch(`/finance-mgmt/budget/expenses/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT e.id, e.project_key, e.project_name, e.bank_account_id, e.paid_on::text AS paid_on, e.category, e.payee, e.description,
                e.amount::float8 AS amount, e.voucher_ref, a.name AS account
           FROM fm_expenses e LEFT JOIN fm_bank_accounts a ON a.id = e.bank_account_id WHERE e.org_id = $1 AND e.id = $2`,
        [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Expense not found.')
      const next = { ...cur }
      if ('project_key' in b) {
        next.project_key = text(b.project_key, 'Project', { required: true, max: 200 })
        next.project_name = text(b.project_name, 'Project name', { max: 300 })
      }
      if ('paid_on' in b) next.paid_on = dateStr(b.paid_on, 'Date paid')
      if ('category' in b) next.category = text(b.category, 'Category', { required: true, max: 100 })
      for (const [k, l, max] of [['payee', 'Payee', 300], ['description', 'Description', 1000], ['voucher_ref', 'Voucher no.', 100]]) {
        if (k in b) next[k] = text(b[k], l, { max })
      }
      if ('amount' in b) next.amount = money(b.amount)
      if ('bank_account_id' in b) {
        next.bank_account_id = await acct(c, ctx, b.bank_account_id, { label: 'Paid from account' })
        next.account = await accountName(c, next.bank_account_id)
      }
      const view = x => ({ ...x, project: x.project_name || x.project_key })
      const { note } = diffNote(view(cur), view(next), [['project', 'Project'], ['paid_on', 'Date'], ['category', 'Category'],
        ['payee', 'Payee'], ['description', 'Description'], ['amount', 'Amount', 'money'], ['voucher_ref', 'Voucher'], ['account', 'Account']])
      if (!note) throw bad('Nothing was changed.')
      await c.query(
        `UPDATE fm_expenses SET project_key = $3, project_name = $4, bank_account_id = $5, paid_on = $6, category = $7, payee = $8,
                description = $9, amount = $10, voucher_ref = $11 WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, cur.id, next.project_key, next.project_name, next.bank_account_id, next.paid_on, next.category, next.payee,
         next.description, next.amount, next.voucher_ref])
      await logEvent(c, ctx.orgId, 'expense', cur.id, 'edited', ctx.me.id, note)
    })
    res.json({ ok: true })
  }))

  router.patch(`/finance-mgmt/budget/transfers/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT t.id, t.from_account_id, t.to_account_id, t.transfer_on::text AS transfer_on, t.amount::float8 AS amount, t.reference, t.note,
                f.name AS from_name, x.name AS to_name
           FROM fm_transfers t JOIN fm_bank_accounts f ON f.id = t.from_account_id JOIN fm_bank_accounts x ON x.id = t.to_account_id
          WHERE t.org_id = $1 AND t.id = $2`, [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Transfer not found.')
      const next = { ...cur }
      if ('from_account_id' in b) {
        next.from_account_id = await acct(c, ctx, b.from_account_id, { required: true, label: 'From account' })
        next.from_name = await accountName(c, next.from_account_id)
      }
      if ('to_account_id' in b) {
        next.to_account_id = await acct(c, ctx, b.to_account_id, { required: true, label: 'To account' })
        next.to_name = await accountName(c, next.to_account_id)
      }
      if (next.from_account_id === next.to_account_id) throw bad('From and to accounts must be different.')
      if ('transfer_on' in b) next.transfer_on = dateStr(b.transfer_on, 'Transfer date')
      if ('amount' in b) next.amount = money(b.amount)
      if ('reference' in b) next.reference = text(b.reference, 'Reference', { max: 200 })
      if ('note' in b) next.note = text(b.note, 'Note', { max: 500 })
      const { note } = diffNote(cur, next, [['from_name', 'From'], ['to_name', 'To'], ['transfer_on', 'Date'], ['amount', 'Amount', 'money'],
        ['reference', 'Reference'], ['note', 'Note']])
      if (!note) throw bad('Nothing was changed.')
      await c.query(
        `UPDATE fm_transfers SET from_account_id = $3, to_account_id = $4, transfer_on = $5, amount = $6, reference = $7, note = $8
          WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, cur.id, next.from_account_id, next.to_account_id, next.transfer_on, next.amount, next.reference, next.note])
      await logEvent(c, ctx.orgId, 'transfer', cur.id, 'edited', ctx.me.id, note)
    })
    res.json({ ok: true })
  }))

  router.patch(`/finance-mgmt/budget/statements/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    await ctx.tx(async c => {
      const { rows: [cur] } = await c.query(
        `SELECT id, as_of::text AS as_of, balance::float8 AS balance, note FROM fm_bank_statements WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, req.params.id])
      if (!cur) throw notFound('Statement balance not found.')
      const next = { ...cur }
      if ('as_of' in b) next.as_of = dateStr(b.as_of, 'Statement date')
      if ('balance' in b) next.balance = signedMoney(b.balance, 'Statement balance')
      if ('note' in b) next.note = text(b.note, 'Note', { max: 500 })
      const { note } = diffNote(cur, next, [['as_of', 'Date'], ['balance', 'Balance', 'money'], ['note', 'Note']])
      if (!note) throw bad('Nothing was changed.')
      // Savepoint so a duplicate date can be reported cleanly inside this transaction.
      await c.query('SAVEPOINT stmt_edit')
      try {
        await c.query(`UPDATE fm_bank_statements SET as_of = $3, balance = $4, note = $5 WHERE org_id = $1 AND id = $2`,
          [ctx.orgId, cur.id, next.as_of, next.balance, next.note])
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT stmt_edit')
        if (e.code === '23505') throw bad('This account already has a statement balance for that date.')
        throw e
      }
      await logEvent(c, ctx.orgId, 'statement', cur.id, 'edited', ctx.me.id, note)
    })
    res.json({ ok: true })
  }))

}
