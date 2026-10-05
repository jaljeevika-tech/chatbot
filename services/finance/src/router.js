// services/finance/src/router.js — Finance Management REST surface (/finance-mgmt/*).
// Mounted by both the Cloud Run service (identity from forwarded x-org-id/x-user-* headers)
// and the monolith as an in-process fallback; both set req.fm = { orgId, uid, role }.
//
// Advances & settlements: requester → manager → Finance. Ledger requests: requester → Finance.
// Nobody decides their own request. Never writes to the Financial Tracker.
//
// GET   /finance-mgmt/me                              profile, badge counts, approvers, settings
// PATCH /finance-mgmt/me                              { email }
// GET   /finance-mgmt/notifications                   latest 50
// POST  /finance-mgmt/notifications/read              { ids? } (omit = mark all)
// GET   /finance-mgmt/budget-lines?project=           line items from the project's Financial Tracker
// GET   /finance-mgmt/advances?scope=mine|approvals|team|all
// POST  /finance-mgmt/advances
// GET   /finance-mgmt/advances/:id
// POST  /finance-mgmt/advances/:id/manager-decision   { decision, note }
// POST  /finance-mgmt/advances/:id/finance-decision   { decision, note, amount_approved }
// POST  /finance-mgmt/advances/:id/disburse           { amount, disbursed_on, payment_mode, payment_ref }
// POST  /finance-mgmt/advances/:id/cancel
// POST  /finance-mgmt/advances/:id/adjustments        { kind, amount, txn_date, payment_mode, payment_ref, note }
// POST  /finance-mgmt/advances/:id/reassign           { manager_id }  (admin)
// GET   /finance-mgmt/settlements?scope=mine|approvals|team|all
// POST  /finance-mgmt/settlements                     { advance_id, note, lines[] }
// GET   /finance-mgmt/settlements/:id
// POST  /finance-mgmt/settlements/:id/manager-decision
// POST  /finance-mgmt/settlements/:id/finance-decision { decision, note, lines: [{ id, amount_approved }] }
// POST  /finance-mgmt/settlements/:id/cancel
// POST  /finance-mgmt/settlements/:id/reassign        { manager_id }  (admin)
// POST  /finance-mgmt/files                           { purpose, file_name, data }
// GET   /finance-mgmt/files/:id
// GET   /finance-mgmt/ledger-requests?scope=mine|queue
// POST  /finance-mgmt/ledger-requests
// GET   /finance-mgmt/ledger-requests/:id
// POST  /finance-mgmt/ledger-requests/:id/fulfil      { note, statement_file_id }
// POST  /finance-mgmt/ledger-requests/:id/reject      { note }
// POST  /finance-mgmt/ledger-requests/:id/cancel
// GET   /finance-mgmt/ledger-requests/:id/statement   generated staff ledger
// GET   /finance-mgmt/reports/budget-lines?project=   advances vs spend per budget line (Finance/admin)
// GET   /finance-mgmt/people                          (admin)
// PATCH /finance-mgmt/people/:id                      { is_finance, email } (admin)
// GET   /finance-mgmt/settings                        (admin)
// PUT   /finance-mgmt/settings                        (admin)
// …plus /finance-mgmt/budget/* (Budget Management) — see budget.js —
// and PATCH edits of advances / adjustments / settlements / ledger requests — see edits.js.
// Finance team + admins manage (create / edit / delete) data; approving,
// paying, reviewing bills and answering ledger requests stay Finance-only.

import { Router } from 'express'
import { withOrgTx, nextRefNo, logEvent } from './db.js'
import { DEFAULT_SETTINGS, loadSettings, queueNotifications, dispatchExternal } from './notify.js'
import { mountBudgetRoutes, resolveAccount, budgetSchemaReady } from './budget.js'
import { mountEditRoutes } from './edits.js'

const ID = '([0-9a-fA-F-]{36})'
const PAYMENT_MODES = ['bank_transfer', 'upi', 'cheque', 'cash']
const MODE_LABEL = { bank_transfer: 'bank transfer', upi: 'UPI', cheque: 'cheque', cash: 'cash' }
const MAX_FILE_BYTES = 10 * 1024 * 1024

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad       = msg => new HttpError(400, msg)
const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, msg)
const notFound  = (msg = 'Not found.') => new HttpError(404, msg)

// ── Input helpers ─────────────────────────────────────────────────────────────
function money(v, field = 'Amount') {
  const n = Math.round(Number(v) * 100) / 100
  if (!Number.isFinite(n) || n <= 0) throw bad(`${field} must be a positive number.`)
  if (n > 1e10) throw bad(`${field} is too large.`)
  return n
}
function dateStr(v, field, required = true) {
  if (v == null || v === '') {
    if (required) throw bad(`${field} is required.`)
    return null
  }
  const s = String(v)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s).getTime())) throw bad(`${field} must be a valid date.`)
  return s
}
function text(v, field, { required = false, max = 2000 } = {}) {
  const s = String(v ?? '').trim()
  if (required && !s) throw bad(`${field} is required.`)
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`)
  return s || null
}
function paymentMode(v, required = true) {
  if (!v && !required) return null
  if (!PAYMENT_MODES.includes(v)) throw bad('Choose a payment mode.')
  return v
}
function decision(v) {
  if (v !== 'approve' && v !== 'reject') throw bad("decision must be 'approve' or 'reject'.")
  return v
}
const round2 = n => Math.round(n * 100) / 100
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
/** 'YYYY-MM-DD' → '3 Oct 2026' for notification text. */
const day = s => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// `active` is a live-only column on users (added outside migrations) — read it
// through to_jsonb so the query works whether or not it exists.
const ACTIVE = `(COALESCE((to_jsonb(u) ->> 'active')::boolean, true) AND COALESCE((to_jsonb(u) ->> 'exit_date')::date > CURRENT_DATE, true))`

// ── Shared SQL ────────────────────────────────────────────────────────────────
const ADVANCE_SELECT = `
  SELECT a.id, a.ref_no, a.requester_id, r.name AS requester_name, a.manager_id, m.name AS manager_name,
         a.project_key, a.project_name, a.budget_section, a.budget_head, a.purpose,
         a.amount_requested::float8 AS amount_requested, a.amount_approved::float8 AS amount_approved,
         a.needed_by::text AS needed_by, a.activity_from::text AS activity_from, a.activity_to::text AS activity_to,
         a.status, a.manager_note, a.manager_action_at, a.finance_note, a.finance_action_at,
         a.disbursed_amount::float8 AS disbursed_amount, a.disbursed_on::text AS disbursed_on,
         a.payment_mode, a.payment_ref, a.closed_at, a.created_at, a.updated_at,
         to_jsonb(a) ->> 'bank_account_id' AS bank_account_id,
         COALESCE(s.spent, 0)::float8          AS spent,
         COALESCE(s.pending, 0)::float8        AS pending_claims,
         COALESCE(s.pending_count, 0)::int     AS pending_settlements,
         COALESCE(j.refunds, 0)::float8        AS refunds,
         COALESCE(j.reimbursements, 0)::float8 AS reimbursements
  FROM fm_advances a
  JOIN users r ON r.id = a.requester_id
  LEFT JOIN users m ON m.id = a.manager_id
  LEFT JOIN LATERAL (
    SELECT SUM(amount_approved) FILTER (WHERE status = 'approved') AS spent,
           SUM(amount_claimed)  FILTER (WHERE status IN ('pending_manager', 'pending_finance')) AS pending,
           COUNT(*)             FILTER (WHERE status IN ('pending_manager', 'pending_finance')) AS pending_count
    FROM fm_settlements WHERE advance_id = a.id
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount) FILTER (WHERE kind = 'refund')        AS refunds,
           SUM(amount) FILTER (WHERE kind = 'reimbursement') AS reimbursements
    FROM fm_advance_adjustments WHERE advance_id = a.id
  ) j ON true`

/** + balance: >0 employee still holds unspent money, <0 the org owes the employee. */
function withBalance(a) {
  return { ...a, balance: round2((a.disbursed_amount || 0) - a.spent - a.refunds + a.reimbursements) }
}

const SETTLEMENT_SELECT = `
  SELECT s.id, s.ref_no, s.advance_id, a.ref_no AS advance_ref, a.purpose AS advance_purpose,
         a.project_key, a.project_name, a.budget_head,
         s.submitted_by, u.name AS submitted_by_name, s.manager_id, m.name AS manager_name,
         s.note, s.amount_claimed::float8 AS amount_claimed, s.amount_approved::float8 AS amount_approved,
         s.status, s.manager_note, s.manager_action_at, s.finance_note, s.finance_action_at,
         s.created_at, s.updated_at
  FROM fm_settlements s
  JOIN fm_advances a ON a.id = s.advance_id
  JOIN users u ON u.id = s.submitted_by
  LEFT JOIN users m ON m.id = s.manager_id`

const LEDGER_SELECT = `
  SELECT l.id, l.ref_no, l.requester_id, u.name AS requester_name, l.ledger_type, l.party_name,
         l.from_date::text AS from_date, l.to_date::text AS to_date, l.purpose, l.status,
         l.statement_file_id, f.file_name AS statement_file_name,
         l.finance_note, l.finance_action_at, fa.name AS finance_action_by_name, l.created_at
  FROM fm_ledger_requests l
  JOIN users u ON u.id = l.requester_id
  LEFT JOIN users fa ON fa.id = l.finance_action_by
  LEFT JOIN fm_files f ON f.id = l.statement_file_id`

async function financeTeamIds(c, orgId) {
  const { rows } = await c.query(
    `SELECT u.id FROM users u JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
     WHERE u.org_id = $1 AND p.is_finance = true AND ${ACTIVE}`, [orgId])
  return rows.map(r => r.id)
}

async function loadEvents(c, orgId, entityType, entityId) {
  const { rows } = await c.query(
    `SELECT e.action, e.note, e.created_at, u.name AS actor_name
     FROM fm_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.org_id = $1 AND e.entity_type = $2 AND e.entity_id = $3
     ORDER BY e.created_at`, [orgId, entityType, entityId])
  return rows
}

/** Validate a chosen approver: an active manager/admin in this org (or the user's own reporting manager), never the requester. */
async function resolveApprover(c, orgId, me, requestedId) {
  const id = requestedId || me.manager_id
  if (!id) throw bad('Choose the manager who should approve this.')
  if (id === me.id) throw bad('You cannot approve your own request — choose your reporting manager.')
  const { rows } = await c.query(
    `SELECT u.id FROM users u WHERE u.org_id = $1 AND u.id = $2 AND ${ACTIVE}
       AND (u.role IN ('admin', 'manager', 'superadmin') OR u.id = $3)`, [orgId, id, me.manager_id])
  if (!rows[0]) throw bad('The selected approver was not found in your organisation.')
  return id
}

/** Close a disbursed advance once it nets to zero with nothing left pending. */
async function maybeClose(c, orgId, advanceId, actorId) {
  const { rows } = await c.query(`${ADVANCE_SELECT} WHERE a.org_id = $1 AND a.id = $2`, [orgId, advanceId])
  const a = rows[0] && withBalance(rows[0])
  if (!a || a.status !== 'disbursed' || a.pending_settlements > 0) return null
  if (Math.abs(a.balance) >= 0.005 || (a.spent <= 0 && a.refunds <= 0)) return null
  await c.query(
    `UPDATE fm_advances SET status = 'settled', closed_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2`,
    [orgId, advanceId])
  await logEvent(c, orgId, 'advance', advanceId, 'settled', actorId, 'Balance squared — advance closed')
  return a
}

function balanceLine(balance) {
  if (balance > 0.005)  return `Unspent balance of ${inr(balance)} is to be refunded to Finance.`
  if (balance < -0.005) return `${inr(-balance)} is to be reimbursed to you by Finance.`
  return 'The advance is fully accounted for.'
}

// ── File type sniffing (never trust the client's mime type) ───────────────────
function sniffMime(buf) {
  const head = buf.subarray(0, 12)
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png'
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image/jpeg'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04)
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (head.readUInt32BE(0) === 0xD0CF11E0) return 'application/vnd.ms-excel'
  // Plain text (CSV) — no NUL bytes and no markup in the first 4 KB
  const sample = buf.subarray(0, 4096)
  if (!sample.includes(0) && !/<\s*(script|html|svg|!doctype)/i.test(sample.toString('utf8'))) return 'text/csv'
  return null
}
const BILL_MIMES      = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
const STATEMENT_MIMES = new Set([...BILL_MIMES, 'text/csv', 'application/vnd.ms-excel',
                                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])

// ═════════════════════════════════════════════════════════════════════════════
export function createFinanceRouter({ getPool }) {
  const router = Router()
  const pool = () => getPool()

  /** Async handler: resolves the caller, runs fn, maps HttpError → status. */
  const h = fn => async (req, res) => {
    try {
      const { orgId, uid, role, phone } = req.fm || {}
      if (!orgId || !uid) return res.status(401).json({ error: 'Authentication required' })
      const me = await withOrgTx(pool(), orgId, async c => {
        const ME = `SELECT u.id, u.name, u.role, COALESCE(p.is_finance, false) AS is_finance, u.manager_id, p.email, u.phone
                    FROM users u LEFT JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
                    WHERE u.org_id = $1 AND ${ACTIVE}`
        let { rows } = await c.query(`${ME} AND u.firebase_uid = $2 LIMIT 1`, [orgId, uid])
        // Fallback when the row's firebase_uid isn't linked yet or was overwritten
        // (same as services/hr and POST /auth/login): match on the phone from the
        // verified token, within the caller's own org only.
        const digits = String(phone || '').replace(/\D/g, '').slice(-10)
        if (!rows.length && digits.length === 10) {
          ({ rows } = await c.query(
            `${ME} AND right(regexp_replace(u.phone, '\\D', '', 'g'), 10) = $2 ORDER BY u.created_at LIMIT 1`, [orgId, digits]))
        }
        return rows[0] || null
      })
      if (!me) return res.status(403).json({ error: 'Your login is not linked to a user profile in this organisation yet. Please sign out and in again, or ask an admin.' })
      const ctx = {
        orgId, me,
        role,
        isAdmin:   role === 'admin' || role === 'superadmin',
        isFinance: me.is_finance === true,
        tx: fn2 => withOrgTx(pool(), orgId, fn2),
        notifyAfter: queued => dispatchExternal(pool(), orgId, queued, withOrgTx),
      }
      await fn(req, res, ctx)
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message })
      console.error('[finance-mgmt]', req.method, req.path, e)
      res.status(500).json({ error: 'Something went wrong. Please try again.' })
    }
  }

  const requireAdmin   = ctx => { if (!ctx.isAdmin)   throw forbidden('Admins only.') }
  const requireFinance = ctx => { if (!ctx.isFinance) throw forbidden('Only members of the Finance team can do this.') }
  // Data management (add / edit / delete records, settings) — Finance team and admins.
  const requireEditor  = ctx => { if (!ctx.isFinance && !ctx.isAdmin) throw forbidden('Only the Finance team and admins can do this.') }

  // ── Me / badge counts ─────────────────────────────────────────────────────
  router.get('/finance-mgmt/me', h(async (_req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const out = await ctx.tx(async c => {
      const settings = await loadSettings(c, orgId)
      const { rows: [counts] } = await c.query(
        `SELECT
           (SELECT COUNT(*) FROM fm_advances    WHERE org_id = $1 AND manager_id = $2 AND status = 'pending_manager')::int AS adv_manager,
           (SELECT COUNT(*) FROM fm_advances    WHERE org_id = $1 AND $3 AND requester_id <> $2 AND status = 'pending_finance')::int AS adv_finance,
           (SELECT COUNT(*) FROM fm_advances    WHERE org_id = $1 AND $3 AND requester_id <> $2 AND status = 'approved')::int AS adv_disburse,
           (SELECT COUNT(*) FROM fm_settlements WHERE org_id = $1 AND manager_id = $2 AND status = 'pending_manager')::int AS stl_manager,
           (SELECT COUNT(*) FROM fm_settlements WHERE org_id = $1 AND $3 AND submitted_by <> $2 AND status = 'pending_finance')::int AS stl_finance,
           (SELECT COUNT(*) FROM fm_ledger_requests WHERE org_id = $1 AND $3 AND requester_id <> $2 AND status = 'pending')::int AS ledger_finance,
           (SELECT COUNT(*) FROM fm_advances    WHERE org_id = $1 AND requester_id = $2 AND status = 'disbursed')::int AS my_open_advances,
           (SELECT COUNT(*) FROM fm_notifications WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL)::int AS unread`,
        [orgId, me.id, isFinance])
      const { rows: approvers } = await c.query(
        `SELECT u.id, u.name, u.role FROM users u
         WHERE u.org_id = $1 AND u.id <> $2 AND u.role IN ('admin', 'manager', 'superadmin') AND ${ACTIVE}
         ORDER BY u.name`, [orgId, me.id])
      const { rows: [mgr] } = me.manager_id
        ? await c.query(`SELECT id, name FROM users WHERE org_id = $1 AND id = $2`, [orgId, me.manager_id])
        : { rows: [] }
      const { rows: [ft] } = await c.query(
        `SELECT COUNT(*)::int AS n FROM users u JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
         WHERE u.org_id = $1 AND p.is_finance = true AND ${ACTIVE}`, [orgId])
      // Only once migration 081 is in (code may be deployed before it is).
      const { rows: accounts } = (isFinance || isAdmin) && await budgetSchemaReady(sql => c.query(sql))
        ? await c.query(`SELECT id, name, kind FROM fm_bank_accounts WHERE org_id = $1 AND active ORDER BY name`, [orgId])
        : { rows: [] }
      return { settings, counts, approvers, manager: mgr || null, financeTeamSize: ft.n, accounts }
    })
    res.json({
      me: { id: me.id, name: me.name, email: me.email, role: ctx.role, is_finance: isFinance, is_admin: isAdmin, manager: out.manager },
      counts: out.counts,
      approvers: out.approvers,
      finance_team_size: out.financeTeamSize,
      expense_categories: out.settings.expense_categories,
      bank_accounts: out.accounts,
    })
  }))

  router.patch('/finance-mgmt/me', h(async (req, res, ctx) => {
    const email = text(req.body?.email, 'Email', { max: 200 })
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.')
    await ctx.tx(c => c.query(
      `INSERT INTO fm_profiles (org_id, user_id, email) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
      [ctx.orgId, ctx.me.id, email]))
    res.json({ ok: true, email })
  }))

  // ── Notifications ──────────────────────────────────────────────────────────
  router.get('/finance-mgmt/notifications', h(async (_req, res, ctx) => {
    const { rows } = await ctx.tx(c => c.query(
      `SELECT id, title, body, entity_type, entity_id, read_at, created_at FROM fm_notifications
       WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`, [ctx.orgId, ctx.me.id]))
    res.json({ notifications: rows })
  }))

  router.post('/finance-mgmt/notifications/read', h(async (req, res, ctx) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => /^[0-9a-fA-F-]{36}$/.test(x)) : null
    await ctx.tx(c => ids
      ? c.query(`UPDATE fm_notifications SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND id = ANY($3::uuid[]) AND read_at IS NULL`, [ctx.orgId, ctx.me.id, ids])
      : c.query(`UPDATE fm_notifications SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`, [ctx.orgId, ctx.me.id]))
    res.json({ ok: true })
  }))

  // ── Budget lines (read-only view of the project's Financial Tracker) ──────
  router.get('/finance-mgmt/budget-lines', h(async (req, res, ctx) => {
    const project = text(req.query.project, 'project', { required: true, max: 200 })
    const { rows } = await ctx.tx(c => c.query(
      `SELECT section, budget_head, MAX(budget_line_item) AS budget_line_item
       FROM budget_utilisation_reports
       WHERE org_id = $1 AND project_key = $2 AND budget_head !~* '^\\s*(sub\\s*-?\\s*)?total'
       GROUP BY section, budget_head
       ORDER BY section, MIN(sr_no) NULLS LAST, budget_head`, [ctx.orgId, project]))
    res.json({ lines: rows })
  }))

  // ══ Advances ═══════════════════════════════════════════════════════════════
  router.get('/finance-mgmt/advances', h(async (req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const scope = req.query.scope || 'mine'
    let where, params
    if (scope === 'mine')           { where = `a.requester_id = $2`; params = [orgId, me.id] }
    else if (scope === 'approvals') {
      where = `((a.manager_id = $2 AND a.status = 'pending_manager')
               OR ($3 AND a.requester_id <> $2 AND a.status IN ('pending_finance', 'approved')))`
      params = [orgId, me.id, isFinance]
    }
    else if (scope === 'team')      { where = `a.manager_id = $2`; params = [orgId, me.id] }
    else if (scope === 'all') {
      if (!isFinance && !isAdmin) throw forbidden()
      where = `true`; params = [orgId]
    } else throw bad('Unknown scope.')
    const { rows } = await ctx.tx(c => c.query(
      `${ADVANCE_SELECT} WHERE a.org_id = $1 AND ${where} ORDER BY a.created_at DESC LIMIT 500`, params))
    res.json({ advances: rows.map(withBalance) })
  }))

  router.post('/finance-mgmt/advances', h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const b = req.body || {}
    const projectKey  = text(b.project_key, 'Project', { required: true, max: 200 })
    const projectName = text(b.project_name, 'Project name', { max: 300 })
    const purpose     = text(b.purpose, 'Purpose', { required: true, max: 2000 })
    const amount      = money(b.amount)
    const neededBy    = dateStr(b.needed_by, 'Needed by', false)
    const from        = dateStr(b.activity_from, 'Activity start', false)
    const to          = dateStr(b.activity_to, 'Activity end', false)
    if (from && to && to < from) throw bad('Activity end must be on or after the start date.')
    const section = text(b.budget_section, 'Budget section', { max: 300 })
    const head    = text(b.budget_head, 'Budget line', { max: 300 })

    const { advance, queued } = await ctx.tx(async c => {
      const managerId = await resolveApprover(c, orgId, me, b.manager_id)
      const refNo = await nextRefNo(c, orgId, 'ADV')
      const { rows: [row] } = await c.query(
        `INSERT INTO fm_advances (org_id, ref_no, requester_id, manager_id, project_key, project_name,
                                  budget_section, budget_head, purpose, amount_requested, needed_by, activity_from, activity_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [orgId, refNo, me.id, managerId, projectKey, projectName, head ? section : null, head, purpose, amount, neededBy, from, to])
      await logEvent(c, orgId, 'advance', row.id, 'submitted', me.id)
      const queued = await queueNotifications(c, orgId, [managerId], {
        title: `Advance ${refNo} needs your approval`,
        body:  `${me.name} requested ${inr(amount)} for ${projectName || projectKey}: ${purpose}`,
        entityType: 'advance', entityId: row.id,
      }, me.id)
      return { advance: { id: row.id, ref_no: refNo }, queued }
    })
    await ctx.notifyAfter(queued)
    res.status(201).json({ advance })
  }))

  // Each loader takes a row lock first so two concurrent actions (double-click,
  // two Finance members) can't both pass a status check and both write.
  // Lock the bills before the "not already used" check, so two settlements
  // submitted at once can't both claim the same bill.
  async function lockFiles(c, orgId, ids) {
    await c.query(`SELECT 1 FROM fm_files WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [orgId, ids])
  }
  async function loadAdvance(c, ctx, id) {
    await c.query(`SELECT 1 FROM fm_advances WHERE org_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id])
    const { rows } = await c.query(`${ADVANCE_SELECT} WHERE a.org_id = $1 AND a.id = $2`, [ctx.orgId, id])
    if (!rows[0]) throw notFound('Advance not found.')
    return withBalance(rows[0])
  }
  const canViewAdvance = (ctx, a) =>
    a.requester_id === ctx.me.id || a.manager_id === ctx.me.id || ctx.isFinance || ctx.isAdmin

  router.get(`/finance-mgmt/advances/:id${ID}`, h(async (req, res, ctx) => {
    const out = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (!canViewAdvance(ctx, a)) throw forbidden()
      const { rows: settlements } = await c.query(
        `${SETTLEMENT_SELECT} WHERE s.org_id = $1 AND s.advance_id = $2 ORDER BY s.created_at`, [ctx.orgId, a.id])
      const { rows: adjustments } = await c.query(
        `SELECT j.id, j.kind, j.amount::float8 AS amount, j.txn_date::text AS txn_date, j.payment_mode, j.payment_ref,
                j.note, j.created_at, u.name AS recorded_by_name, to_jsonb(j) ->> 'bank_account_id' AS bank_account_id
         FROM fm_advance_adjustments j JOIN users u ON u.id = j.recorded_by
         WHERE j.org_id = $1 AND j.advance_id = $2 ORDER BY j.txn_date, j.created_at`, [ctx.orgId, a.id])
      const events = await loadEvents(c, ctx.orgId, 'advance', a.id)
      return { advance: a, settlements, adjustments, events }
    })
    res.json(out)
  }))

  router.post(`/finance-mgmt/advances/:id${ID}/manager-decision`, h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const d = decision(req.body?.decision)
    const note = text(req.body?.note, 'Note', { required: d === 'reject', max: 1000 })
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (a.manager_id !== me.id) throw forbidden('Only the assigned approving manager can decide this advance.')
      if (a.requester_id === me.id) throw forbidden('You cannot approve your own advance.')
      if (a.status !== 'pending_manager') throw bad('This advance is no longer waiting for manager approval.')
      const next = d === 'approve' ? 'pending_finance' : 'rejected'
      await c.query(
        `UPDATE fm_advances SET status = $1, manager_action_by = $2, manager_action_at = now(), manager_note = $3, updated_at = now()
         WHERE org_id = $4 AND id = $5`, [next, me.id, note, orgId, a.id])
      await logEvent(c, orgId, 'advance', a.id, d === 'approve' ? 'manager_approved' : 'manager_rejected', me.id, note)
      if (d === 'reject') {
        return queueNotifications(c, orgId, [a.requester_id], {
          title: `Advance ${a.ref_no} was not approved`,
          body:  `${me.name} declined your ${inr(a.amount_requested)} advance. Reason: ${note}`,
          entityType: 'advance', entityId: a.id,
        }, me.id)
      }
      const finance = await financeTeamIds(c, orgId)
      return [
        ...await queueNotifications(c, orgId, finance.filter(id => id !== a.requester_id), {
          title: `Advance ${a.ref_no} is ready for Finance approval`,
          body:  `${a.requester_name} — ${inr(a.amount_requested)} for ${a.project_name || a.project_key}. Approved by ${me.name}.`,
          entityType: 'advance', entityId: a.id,
        }, me.id),
        ...await queueNotifications(c, orgId, [a.requester_id], {
          title: `Advance ${a.ref_no} approved by your manager`,
          body:  `${me.name} approved it. It is now with Finance.`,
          entityType: 'advance', entityId: a.id,
        }, me.id),
      ]
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/advances/:id${ID}/finance-decision`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const d = decision(req.body?.decision)
    const note = text(req.body?.note, 'Note', { required: d === 'reject', max: 1000 })
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (a.requester_id === me.id) throw forbidden('You cannot approve your own advance.')
      if (a.status !== 'pending_finance') throw bad('This advance is not waiting for Finance approval.')
      if (d === 'reject') {
        await c.query(
          `UPDATE fm_advances SET status = 'rejected', finance_action_by = $1, finance_action_at = now(), finance_note = $2, updated_at = now()
           WHERE org_id = $3 AND id = $4`, [me.id, note, orgId, a.id])
        await logEvent(c, orgId, 'advance', a.id, 'finance_rejected', me.id, note)
        return queueNotifications(c, orgId, [a.requester_id, a.manager_id], {
          title: `Advance ${a.ref_no} was rejected by Finance`,
          body:  `Reason: ${note}`, entityType: 'advance', entityId: a.id,
        }, me.id)
      }
      const approved = req.body?.amount_approved != null && req.body.amount_approved !== ''
        ? money(req.body.amount_approved, 'Approved amount') : a.amount_requested
      if (approved > a.amount_requested) throw bad('Approved amount cannot be more than the amount requested.')
      await c.query(
        `UPDATE fm_advances SET status = 'approved', amount_approved = $1, finance_action_by = $2, finance_action_at = now(),
                finance_note = $3, updated_at = now() WHERE org_id = $4 AND id = $5`, [approved, me.id, note, orgId, a.id])
      await logEvent(c, orgId, 'advance', a.id, 'finance_approved', me.id,
        approved < a.amount_requested ? `Approved ${inr(approved)} of ${inr(a.amount_requested)}${note ? ' — ' + note : ''}` : note)
      return queueNotifications(c, orgId, [a.requester_id], {
        title: `Advance ${a.ref_no} approved by Finance`,
        body:  `${inr(approved)} approved${approved < a.amount_requested ? ` (of ${inr(a.amount_requested)} requested)` : ''}. Payment will follow.`,
        entityType: 'advance', entityId: a.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/advances/:id${ID}/disburse`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const b = req.body || {}
    const on   = dateStr(b.disbursed_on, 'Payment date')
    const mode = paymentMode(b.payment_mode)
    const ref  = text(b.payment_ref, 'Payment reference', { required: mode !== 'cash', max: 200 })
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (a.requester_id === me.id) throw forbidden('You cannot disburse your own advance.')
      if (a.status !== 'approved') throw bad('Only an approved advance can be disbursed.')
      const amount = b.amount != null && b.amount !== '' ? money(b.amount) : a.amount_approved
      if (amount > a.amount_approved) throw bad(`Cannot pay more than the approved ${inr(a.amount_approved)}.`)
      const account = await resolveAccount(c, orgId, b.bank_account_id, { label: 'Paid from account' }).catch(e => { throw e.status ? bad(e.message) : e })
      // bank_account_id (migration 081) is only written when one was chosen,
      // so payments keep working on a database that predates 081.
      await c.query(
        `UPDATE fm_advances SET status = 'disbursed', disbursed_amount = $1, disbursed_on = $2, payment_mode = $3,
                payment_ref = $4, disbursed_by = $5${account ? ', bank_account_id = $8' : ''}, updated_at = now() WHERE org_id = $6 AND id = $7`,
        account ? [amount, on, mode, ref, me.id, orgId, a.id, account] : [amount, on, mode, ref, me.id, orgId, a.id])
      await logEvent(c, orgId, 'advance', a.id, 'disbursed', me.id, `${inr(amount)} via ${MODE_LABEL[mode]}${ref ? ' · ' + ref : ''}`)
      return queueNotifications(c, orgId, [a.requester_id], {
        title: `Advance ${a.ref_no} paid — ${inr(amount)}`,
        body:  `Paid on ${day(on)} by ${MODE_LABEL[mode]}${ref ? ` (ref ${ref})` : ''}. Submit your bills under Advance Settlement after the activity.`,
        entityType: 'advance', entityId: a.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/advances/:id${ID}/cancel`, h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (a.requester_id !== me.id) throw forbidden('Only the requester can cancel this advance.')
      if (!['pending_manager', 'pending_finance', 'approved'].includes(a.status)) throw bad('This advance can no longer be cancelled.')
      await c.query(`UPDATE fm_advances SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, a.id])
      await logEvent(c, orgId, 'advance', a.id, 'cancelled', me.id)
      const notify = a.status === 'pending_manager' ? [a.manager_id] : await financeTeamIds(c, orgId)
      return queueNotifications(c, orgId, notify, {
        title: `Advance ${a.ref_no} was cancelled`, body: `${me.name} withdrew the request.`,
        entityType: 'advance', entityId: a.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/advances/:id${ID}/adjustments`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const b = req.body || {}
    if (b.kind !== 'refund' && b.kind !== 'reimbursement') throw bad("kind must be 'refund' or 'reimbursement'.")
    const amount = money(b.amount)
    const on     = dateStr(b.txn_date, 'Date')
    const mode   = paymentMode(b.payment_mode)
    const ref    = text(b.payment_ref, 'Payment reference', { max: 200 })
    const note   = text(b.note, 'Note', { max: 1000 })
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      if (a.requester_id === me.id) throw forbidden('You cannot record adjustments on your own advance.')
      if (a.status !== 'disbursed') throw bad('Adjustments can only be recorded on a disbursed, open advance.')
      if (b.kind === 'refund' && amount > a.balance + 0.005)
        throw bad(a.balance > 0 ? `Refund cannot exceed the unspent balance of ${inr(a.balance)}.` : 'Nothing is due back from the employee.')
      if (b.kind === 'reimbursement' && amount > -a.balance + 0.005)
        throw bad(a.balance < 0 ? `Reimbursement cannot exceed ${inr(-a.balance)} owed.` : 'Nothing is owed to the employee.')
      const account = await resolveAccount(c, orgId, b.bank_account_id, { label: b.kind === 'refund' ? 'Received into account' : 'Paid from account' })
        .catch(e => { throw e.status ? bad(e.message) : e })
      await c.query(
        `INSERT INTO fm_advance_adjustments (org_id, advance_id, kind, amount, txn_date, payment_mode, payment_ref, note, recorded_by${account ? ', bank_account_id' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9${account ? ',$10' : ''})`,
        account ? [orgId, a.id, b.kind, amount, on, mode, ref, note, me.id, account] : [orgId, a.id, b.kind, amount, on, mode, ref, note, me.id])
      await logEvent(c, orgId, 'advance', a.id, b.kind === 'refund' ? 'refund_recorded' : 'reimbursement_recorded', me.id, `${inr(amount)}${note ? ' — ' + note : ''}`)
      const closed = await maybeClose(c, orgId, a.id, me.id)
      return queueNotifications(c, orgId, [a.requester_id], {
        title: b.kind === 'refund' ? `Refund of ${inr(amount)} received for ${a.ref_no}` : `${inr(amount)} reimbursed for ${a.ref_no}`,
        body:  closed ? 'Your advance is now fully settled and closed.' : `Recorded on ${day(on)}.`,
        entityType: 'advance', entityId: a.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  // Admin escape hatch when the assigned approver has left or is unavailable.
  async function reassign(req, res, ctx, table, entityType, label) {
    requireAdmin(ctx)
    const { orgId, me } = ctx
    const queued = await ctx.tx(async c => {
      const { rows: [row] } = await c.query(
        `SELECT id, ref_no, status, ${table === 'fm_advances' ? 'requester_id' : 'submitted_by'} AS owner_id
         FROM ${table} WHERE org_id = $1 AND id = $2`, [orgId, req.params.id])
      if (!row) throw notFound()
      if (row.status !== 'pending_manager') throw bad('Only requests waiting for manager approval can be reassigned.')
      const managerId = await resolveApprover(c, orgId, { id: row.owner_id, manager_id: null }, req.body?.manager_id)
      await c.query(`UPDATE ${table} SET manager_id = $1, updated_at = now() WHERE org_id = $2 AND id = $3`, [managerId, orgId, row.id])
      await logEvent(c, orgId, entityType, row.id, 'reassigned', me.id)
      return queueNotifications(c, orgId, [managerId], {
        title: `${label} ${row.ref_no} needs your approval`, body: `Reassigned to you by ${me.name}.`,
        entityType, entityId: row.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }
  router.post(`/finance-mgmt/advances/:id${ID}/reassign`,    h((req, res, ctx) => reassign(req, res, ctx, 'fm_advances', 'advance', 'Advance')))
  router.post(`/finance-mgmt/settlements/:id${ID}/reassign`, h((req, res, ctx) => reassign(req, res, ctx, 'fm_settlements', 'settlement', 'Settlement')))

  // ══ Settlements ════════════════════════════════════════════════════════════
  router.get('/finance-mgmt/settlements', h(async (req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const scope = req.query.scope || 'mine'
    let where, params
    if (scope === 'mine')           { where = `s.submitted_by = $2`; params = [orgId, me.id] }
    else if (scope === 'approvals') {
      where = `((s.manager_id = $2 AND s.status = 'pending_manager')
               OR ($3 AND s.submitted_by <> $2 AND s.status = 'pending_finance'))`
      params = [orgId, me.id, isFinance]
    }
    else if (scope === 'team')      { where = `s.manager_id = $2`; params = [orgId, me.id] }
    else if (scope === 'all') {
      if (!isFinance && !isAdmin) throw forbidden()
      where = `true`; params = [orgId]
    } else throw bad('Unknown scope.')
    const { rows } = await ctx.tx(c => c.query(
      `${SETTLEMENT_SELECT} WHERE s.org_id = $1 AND ${where} ORDER BY s.created_at DESC LIMIT 500`, params))
    res.json({ settlements: rows })
  }))

  router.post('/finance-mgmt/settlements', h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const b = req.body || {}
    if (!/^[0-9a-fA-F-]{36}$/.test(String(b.advance_id || ''))) throw bad('Choose the advance you are settling.')
    const note = text(b.note, 'Note', { max: 2000 })
    if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one expense line.')
    if (b.lines.length > 100) throw bad('Too many expense lines (max 100) — split into two settlements.')
    const lines = b.lines.map((l, i) => {
      const n = i + 1
      if (!/^[0-9a-fA-F-]{36}$/.test(String(l.bill_file_id || ''))) throw bad(`Line ${n}: attach the bill or receipt.`)
      return {
        expense_date: dateStr(l.expense_date, `Line ${n}: date`),
        category:     text(l.category, `Line ${n}: category`, { required: true, max: 100 }),
        description:  text(l.description, `Line ${n}: description`, { max: 500 }),
        amount:       money(l.amount, `Line ${n}: amount`),
        bill_file_id: l.bill_file_id,
      }
    })
    const fileIds = lines.map(l => l.bill_file_id)
    if (new Set(fileIds).size !== fileIds.length) throw bad('The same bill is attached to more than one line.')
    const total = round2(lines.reduce((s, l) => s + l.amount, 0))

    const { settlement, queued } = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, b.advance_id)
      if (a.requester_id !== me.id) throw forbidden('You can only settle your own advances.')
      if (a.status !== 'disbursed') throw bad('Only a paid (disbursed) advance that is still open can be settled.')
      await lockFiles(c, orgId, fileIds)
      const { rows: files } = await c.query(
        `SELECT f.id FROM fm_files f
         WHERE f.org_id = $1 AND f.id = ANY($2::uuid[]) AND f.uploaded_by = $3 AND f.purpose = 'bill'
           AND NOT EXISTS (SELECT 1 FROM fm_settlement_lines l WHERE l.bill_file_id = f.id)`,
        [orgId, fileIds, me.id])
      if (files.length !== fileIds.length) throw bad('One or more bills are missing or already used — please re-attach them.')
      const refNo = await nextRefNo(c, orgId, 'STL')
      const { rows: [s] } = await c.query(
        `INSERT INTO fm_settlements (org_id, ref_no, advance_id, submitted_by, manager_id, note, amount_claimed)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [orgId, refNo, a.id, me.id, a.manager_id, note, total])
      for (const [i, l] of lines.entries()) {
        await c.query(
          `INSERT INTO fm_settlement_lines (org_id, settlement_id, expense_date, category, description, amount, bill_file_id, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, s.id, l.expense_date, l.category, l.description, l.amount, l.bill_file_id, i])
      }
      await logEvent(c, orgId, 'settlement', s.id, 'submitted', me.id)
      await logEvent(c, orgId, 'advance', a.id, 'settlement_submitted', me.id, `${refNo} — ${inr(total)}`)
      const queued = await queueNotifications(c, orgId, [a.manager_id], {
        title: `Settlement ${refNo} needs your approval`,
        body:  `${me.name} submitted ${inr(total)} of bills against advance ${a.ref_no} (${a.purpose}).`,
        entityType: 'settlement', entityId: s.id,
      }, me.id)
      return { settlement: { id: s.id, ref_no: refNo }, queued }
    })
    await ctx.notifyAfter(queued)
    res.status(201).json({ settlement })
  }))

  async function loadSettlement(c, ctx, id) {
    await c.query(`SELECT 1 FROM fm_settlements WHERE org_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id])
    const { rows } = await c.query(`${SETTLEMENT_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [ctx.orgId, id])
    if (!rows[0]) throw notFound('Settlement not found.')
    return rows[0]
  }
  const canViewSettlement = (ctx, s) =>
    s.submitted_by === ctx.me.id || s.manager_id === ctx.me.id || ctx.isFinance || ctx.isAdmin

  router.get(`/finance-mgmt/settlements/:id${ID}`, h(async (req, res, ctx) => {
    const out = await ctx.tx(async c => {
      const s = await loadSettlement(c, ctx, req.params.id)
      if (!canViewSettlement(ctx, s)) throw forbidden()
      const { rows: lines } = await c.query(
        `SELECT l.id, l.expense_date::text AS expense_date, l.category, l.description, l.amount::float8 AS amount,
                l.amount_approved::float8 AS amount_approved, l.bill_file_id, f.file_name AS bill_file_name, f.mime_type AS bill_mime_type
         FROM fm_settlement_lines l JOIN fm_files f ON f.id = l.bill_file_id
         WHERE l.org_id = $1 AND l.settlement_id = $2 ORDER BY l.sort_order`, [ctx.orgId, s.id])
      const advance = await loadAdvance(c, ctx, s.advance_id)
      const events = await loadEvents(c, ctx.orgId, 'settlement', s.id)
      return { settlement: s, lines, advance, events }
    })
    res.json(out)
  }))

  router.post(`/finance-mgmt/settlements/:id${ID}/manager-decision`, h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const d = decision(req.body?.decision)
    const note = text(req.body?.note, 'Note', { required: d === 'reject', max: 1000 })
    const queued = await ctx.tx(async c => {
      const s = await loadSettlement(c, ctx, req.params.id)
      if (s.manager_id !== me.id) throw forbidden('Only the assigned approving manager can decide this settlement.')
      if (s.submitted_by === me.id) throw forbidden('You cannot approve your own settlement.')
      if (s.status !== 'pending_manager') throw bad('This settlement is no longer waiting for manager approval.')
      await c.query(
        `UPDATE fm_settlements SET status = $1, manager_action_by = $2, manager_action_at = now(), manager_note = $3, updated_at = now()
         WHERE org_id = $4 AND id = $5`, [d === 'approve' ? 'pending_finance' : 'rejected', me.id, note, orgId, s.id])
      await logEvent(c, orgId, 'settlement', s.id, d === 'approve' ? 'manager_approved' : 'manager_rejected', me.id, note)
      if (d === 'reject') {
        return queueNotifications(c, orgId, [s.submitted_by], {
          title: `Settlement ${s.ref_no} was sent back`,
          body:  `${me.name}: ${note}. Please correct and submit again.`,
          entityType: 'settlement', entityId: s.id,
        }, me.id)
      }
      const finance = await financeTeamIds(c, orgId)
      return queueNotifications(c, orgId, finance.filter(id => id !== s.submitted_by), {
        title: `Settlement ${s.ref_no} is ready for Finance review`,
        body:  `${s.submitted_by_name} — ${inr(s.amount_claimed)} against ${s.advance_ref}. Approved by ${me.name}.`,
        entityType: 'settlement', entityId: s.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/settlements/:id${ID}/finance-decision`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const d = decision(req.body?.decision)
    const note = text(req.body?.note, 'Note', { required: d === 'reject', max: 1000 })
    const queued = await ctx.tx(async c => {
      const s = await loadSettlement(c, ctx, req.params.id)
      if (s.submitted_by === me.id) throw forbidden('You cannot approve your own settlement.')
      if (s.status !== 'pending_finance') throw bad('This settlement is not waiting for Finance review.')
      if (d === 'reject') {
        await c.query(
          `UPDATE fm_settlements SET status = 'rejected', finance_action_by = $1, finance_action_at = now(), finance_note = $2, updated_at = now()
           WHERE org_id = $3 AND id = $4`, [me.id, note, orgId, s.id])
        await logEvent(c, orgId, 'settlement', s.id, 'finance_rejected', me.id, note)
        await logEvent(c, orgId, 'advance', s.advance_id, 'settlement_rejected', me.id, s.ref_no)
        return queueNotifications(c, orgId, [s.submitted_by], {
          title: `Settlement ${s.ref_no} was rejected by Finance`,
          body:  `Reason: ${note}. Please correct and submit again.`,
          entityType: 'settlement', entityId: s.id,
        }, me.id)
      }
      // Per-line approved amounts (default: the full claimed amount).
      const { rows: lines } = await c.query(
        `SELECT id, amount::float8 AS amount FROM fm_settlement_lines WHERE org_id = $1 AND settlement_id = $2`, [orgId, s.id])
      const overrides = new Map((Array.isArray(req.body?.lines) ? req.body.lines : []).map(l => [l.id, l.amount_approved]))
      let total = 0
      for (const l of lines) {
        let amt = l.amount
        if (overrides.has(l.id) && overrides.get(l.id) !== '' && overrides.get(l.id) != null) {
          amt = round2(Number(overrides.get(l.id)))
          if (!Number.isFinite(amt) || amt < 0 || amt > l.amount) throw bad('An approved line amount must be between 0 and the amount claimed.')
        }
        total += amt
        await c.query(`UPDATE fm_settlement_lines SET amount_approved = $1 WHERE org_id = $2 AND id = $3`, [amt, orgId, l.id])
      }
      total = round2(total)
      if (total <= 0) throw bad('Nothing approved — reject the settlement instead, with a reason.')
      if (total < s.amount_claimed && !note) throw bad('Add a note explaining the disallowed amount.')
      await c.query(
        `UPDATE fm_settlements SET status = 'approved', amount_approved = $1, finance_action_by = $2, finance_action_at = now(),
                finance_note = $3, updated_at = now() WHERE org_id = $4 AND id = $5`, [total, me.id, note, orgId, s.id])
      await logEvent(c, orgId, 'settlement', s.id, 'finance_approved', me.id,
        total < s.amount_claimed ? `Approved ${inr(total)} of ${inr(s.amount_claimed)} — ${note}` : note)
      await logEvent(c, orgId, 'advance', s.advance_id, 'settlement_approved', me.id, `${s.ref_no} — ${inr(total)}`)
      const closed = await maybeClose(c, orgId, s.advance_id, me.id)
      const a = await loadAdvance(c, ctx, s.advance_id)
      return queueNotifications(c, orgId, [s.submitted_by], {
        title: `Settlement ${s.ref_no} approved — ${inr(total)}`,
        body:  (total < s.amount_claimed ? `${inr(s.amount_claimed - total)} was disallowed: ${note}. ` : '')
             + (closed ? 'Your advance is now fully settled and closed.' : balanceLine(a.balance)),
        entityType: 'settlement', entityId: s.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/settlements/:id${ID}/cancel`, h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    await ctx.tx(async c => {
      const s = await loadSettlement(c, ctx, req.params.id)
      if (s.submitted_by !== me.id) throw forbidden('Only the person who submitted it can withdraw this settlement.')
      if (!['pending_manager', 'pending_finance'].includes(s.status)) throw bad('This settlement can no longer be withdrawn.')
      await c.query(`UPDATE fm_settlements SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, s.id])
      await logEvent(c, orgId, 'settlement', s.id, 'cancelled', me.id)
      await logEvent(c, orgId, 'advance', s.advance_id, 'settlement_withdrawn', me.id, s.ref_no)
    })
    res.json({ ok: true })
  }))

  // ══ Files ══════════════════════════════════════════════════════════════════
  router.post('/finance-mgmt/files', h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const b = req.body || {}
    if (b.purpose !== 'bill' && b.purpose !== 'statement') throw bad("purpose must be 'bill' or 'statement'.")
    if (b.purpose === 'statement') requireEditor(ctx)
    const name = text(b.file_name, 'File name', { required: true, max: 200 }).replace(/[\\/\r\n]/g, '_')
    const raw = String(b.data || '').replace(/^data:[^;,]*;base64,/, '')
    const buf = Buffer.from(raw, 'base64')
    if (!buf.length) throw bad('The file is empty.')
    if (buf.length > MAX_FILE_BYTES) throw bad('File is larger than 10 MB.')
    const mime = sniffMime(buf)
    const allowed = b.purpose === 'bill' ? BILL_MIMES : STATEMENT_MIMES
    if (!mime || !allowed.has(mime))
      throw bad(b.purpose === 'bill' ? 'Bills must be a photo (JPG/PNG/WebP) or a PDF.' : 'Statements must be PDF, Excel, CSV or an image.')
    const { rows: [f] } = await ctx.tx(c => c.query(
      `INSERT INTO fm_files (org_id, uploaded_by, purpose, file_name, mime_type, size_bytes, data_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, file_name, mime_type, size_bytes`,
      [orgId, me.id, b.purpose, name, mime, buf.length, buf.toString('base64')]))
    res.status(201).json({ file: f })
  }))

  router.get(`/finance-mgmt/files/:id${ID}`, h(async (req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const file = await ctx.tx(async c => {
      const { rows: [f] } = await c.query(
        `SELECT id, uploaded_by, purpose, file_name, mime_type, data_base64 FROM fm_files WHERE org_id = $1 AND id = $2`,
        [orgId, req.params.id])
      if (!f) throw notFound('File not found.')
      if (f.uploaded_by === me.id || isFinance || isAdmin) return f
      const { rows } = f.purpose === 'bill'
        ? await c.query(
            `SELECT 1 FROM fm_settlement_lines l JOIN fm_settlements s ON s.id = l.settlement_id
             WHERE l.org_id = $1 AND l.bill_file_id = $2 AND (s.submitted_by = $3 OR s.manager_id = $3) LIMIT 1`,
            [orgId, f.id, me.id])
        : await c.query(
            `SELECT 1 FROM fm_ledger_requests WHERE org_id = $1 AND statement_file_id = $2 AND requester_id = $3
               AND status = 'fulfilled' LIMIT 1`, [orgId, f.id, me.id])
      if (!rows[0]) throw forbidden()
      return f
    })
    res.json({ file_name: file.file_name, mime_type: file.mime_type, data_base64: file.data_base64 })
  }))

  // ══ Ledger requests ════════════════════════════════════════════════════════
  router.get('/finance-mgmt/ledger-requests', h(async (req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const scope = req.query.scope || 'mine'
    if (scope !== 'mine' && scope !== 'queue') throw bad('Unknown scope.')
    if (scope === 'queue' && !isFinance && !isAdmin) throw forbidden()
    const { rows } = await ctx.tx(c => c.query(
      `${LEDGER_SELECT} WHERE l.org_id = $1 ${scope === 'mine' ? 'AND l.requester_id = $2' : ''}
       ORDER BY (l.status = 'pending') DESC, l.created_at DESC LIMIT 500`,
      scope === 'mine' ? [orgId, me.id] : [orgId]))
    res.json({ requests: rows })
  }))

  router.post('/finance-mgmt/ledger-requests', h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    const b = req.body || {}
    if (!['staff', 'vendor', 'other'].includes(b.ledger_type)) throw bad('Choose which ledger you need.')
    const party = b.ledger_type === 'staff' ? null
      : text(b.party_name, b.ledger_type === 'vendor' ? 'Vendor / party name' : 'Ledger name', { required: true, max: 300 })
    const from = dateStr(b.from_date, 'From date')
    const to   = dateStr(b.to_date, 'To date')
    if (to < from) throw bad('To date must be on or after the from date.')
    const purpose = text(b.purpose, 'Purpose', { max: 1000 })
    const { request, queued } = await ctx.tx(async c => {
      const refNo = await nextRefNo(c, orgId, 'LDG')
      const { rows: [l] } = await c.query(
        `INSERT INTO fm_ledger_requests (org_id, ref_no, requester_id, ledger_type, party_name, from_date, to_date, purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [orgId, refNo, me.id, b.ledger_type, party, from, to, purpose])
      await logEvent(c, orgId, 'ledger', l.id, 'submitted', me.id)
      const what = b.ledger_type === 'staff' ? 'their staff advance ledger' : `the ${party} ledger`
      const queued = await queueNotifications(c, orgId, await financeTeamIds(c, orgId), {
        title: `Ledger request ${refNo} from ${me.name}`,
        body:  `Statement of ${what}, ${day(from)} to ${day(to)}.${purpose ? ' Purpose: ' + purpose : ''}`,
        entityType: 'ledger', entityId: l.id,
      }, me.id)
      return { request: { id: l.id, ref_no: refNo }, queued }
    })
    await ctx.notifyAfter(queued)
    res.status(201).json({ request })
  }))

  async function loadLedger(c, ctx, id) {
    await c.query(`SELECT 1 FROM fm_ledger_requests WHERE org_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id])
    const { rows } = await c.query(`${LEDGER_SELECT} WHERE l.org_id = $1 AND l.id = $2`, [ctx.orgId, id])
    if (!rows[0]) throw notFound('Ledger request not found.')
    return rows[0]
  }

  router.get(`/finance-mgmt/ledger-requests/:id${ID}`, h(async (req, res, ctx) => {
    const out = await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      if (l.requester_id !== ctx.me.id && !ctx.isFinance && !ctx.isAdmin) throw forbidden()
      return { request: l, events: await loadEvents(c, ctx.orgId, 'ledger', l.id) }
    })
    res.json(out)
  }))

  router.post(`/finance-mgmt/ledger-requests/:id${ID}/fulfil`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const note = text(req.body?.note, 'Note', { max: 1000 })
    const fileId = req.body?.statement_file_id || null
    const queued = await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      if (l.requester_id === me.id) throw forbidden('Another Finance team member must answer your own request.')
      if (l.status !== 'pending') throw bad('This request has already been answered.')
      if (l.ledger_type !== 'staff' || fileId) {
        if (!fileId || !/^[0-9a-fA-F-]{36}$/.test(fileId)) throw bad('Upload the ledger statement file first.')
        const { rows } = await c.query(
          `SELECT 1 FROM fm_files WHERE org_id = $1 AND id = $2 AND purpose = 'statement' AND uploaded_by = $3`, [orgId, fileId, me.id])
        if (!rows[0]) throw bad('Statement file not found — upload it again.')
      }
      await c.query(
        `UPDATE fm_ledger_requests SET status = 'fulfilled', statement_file_id = $1, finance_action_by = $2,
                finance_action_at = now(), finance_note = $3, updated_at = now() WHERE org_id = $4 AND id = $5`,
        [fileId, me.id, note, orgId, l.id])
      await logEvent(c, orgId, 'ledger', l.id, 'fulfilled', me.id, note)
      return queueNotifications(c, orgId, [l.requester_id], {
        title: `Your ledger statement ${l.ref_no} is ready`,
        body:  `${day(l.from_date)} to ${day(l.to_date)}. Open Finance Management → Ledger Request to view or download it.${note ? ' Note: ' + note : ''}`,
        entityType: 'ledger', entityId: l.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/ledger-requests/:id${ID}/reject`, h(async (req, res, ctx) => {
    requireFinance(ctx)
    const { orgId, me } = ctx
    const note = text(req.body?.note, 'Reason', { required: true, max: 1000 })
    const queued = await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      if (l.status !== 'pending') throw bad('This request has already been answered.')
      await c.query(
        `UPDATE fm_ledger_requests SET status = 'rejected', finance_action_by = $1, finance_action_at = now(),
                finance_note = $2, updated_at = now() WHERE org_id = $3 AND id = $4`, [me.id, note, orgId, l.id])
      await logEvent(c, orgId, 'ledger', l.id, 'rejected', me.id, note)
      return queueNotifications(c, orgId, [l.requester_id], {
        title: `Ledger request ${l.ref_no} could not be fulfilled`, body: `Reason: ${note}`,
        entityType: 'ledger', entityId: l.id,
      }, me.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.post(`/finance-mgmt/ledger-requests/:id${ID}/cancel`, h(async (req, res, ctx) => {
    const { orgId, me } = ctx
    await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      if (l.requester_id !== me.id) throw forbidden()
      if (l.status !== 'pending') throw bad('This request has already been answered.')
      await c.query(`UPDATE fm_ledger_requests SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, l.id])
      await logEvent(c, orgId, 'ledger', l.id, 'cancelled', me.id)
    })
    res.json({ ok: true })
  }))

  /**
   * Staff advance ledger. Debit = money the employee received; credit = money accounted
   * for. Positive balance = Dr (employee holds funds), negative = Cr (owed to employee).
   */
  router.get(`/finance-mgmt/ledger-requests/:id${ID}/statement`, h(async (req, res, ctx) => {
    const { orgId, me, isFinance, isAdmin } = ctx
    const out = await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      if (l.ledger_type !== 'staff') throw bad('This ledger is provided as a file — download it instead.')
      const own = l.requester_id === me.id
      if (!(isFinance || isAdmin || (own && l.status === 'fulfilled'))) throw forbidden('The statement is available once Finance approves the request.')
      // e.d::text — node-postgres turns DATE into a local-midnight JS Date,
      // which toISOString() shifts back a day east of UTC (e.g. IST).
      const { rows: entries } = await c.query(
        `SELECT e.d::text AS d, e.ref, e.particulars, e.debit, e.credit FROM (
           SELECT a.disbursed_on AS d, a.ref_no AS ref, 'Advance paid — ' || a.purpose AS particulars,
                  a.disbursed_amount::float8 AS debit, 0::float8 AS credit, a.created_at AS ts
           FROM fm_advances a WHERE a.org_id = $1 AND a.requester_id = $2 AND a.disbursed_on IS NOT NULL
           UNION ALL
           SELECT (s.finance_action_at AT TIME ZONE 'Asia/Kolkata')::date, s.ref_no, 'Bills settled against ' || a.ref_no,
                  0, s.amount_approved::float8, s.finance_action_at
           FROM fm_settlements s JOIN fm_advances a ON a.id = s.advance_id
           WHERE s.org_id = $1 AND a.requester_id = $2 AND s.status = 'approved'
           UNION ALL
           SELECT j.txn_date, a.ref_no,
                  CASE j.kind WHEN 'refund' THEN 'Refund of unspent advance' ELSE 'Reimbursement of excess spend' END,
                  CASE j.kind WHEN 'reimbursement' THEN j.amount::float8 ELSE 0 END,
                  CASE j.kind WHEN 'refund' THEN j.amount::float8 ELSE 0 END, j.created_at
           FROM fm_advance_adjustments j JOIN fm_advances a ON a.id = j.advance_id
           WHERE j.org_id = $1 AND a.requester_id = $2
         ) e WHERE e.d <= $3::date ORDER BY e.d, e.ts`,
        [orgId, l.requester_id, l.to_date])
      let opening = 0
      const rows = []
      let bal = 0
      for (const e of entries) {
        if (e.d < l.from_date) { opening = round2(opening + e.debit - e.credit); continue }
        if (!rows.length) bal = opening
        bal = round2(bal + e.debit - e.credit)
        rows.push({ date: e.d, ref: e.ref, particulars: e.particulars, debit: e.debit, credit: e.credit, balance: bal })
      }
      return {
        ref_no: l.ref_no, employee: l.requester_name, from_date: l.from_date, to_date: l.to_date, status: l.status,
        opening_balance: opening, closing_balance: rows.length ? bal : opening, rows,
        totals: { debit: round2(rows.reduce((s, r) => s + r.debit, 0)), credit: round2(rows.reduce((s, r) => s + r.credit, 0)) },
      }
    })
    res.json({ statement: out })
  }))

  // ══ Reports ════════════════════════════════════════════════════════════════
  router.get('/finance-mgmt/reports/budget-lines', h(async (req, res, ctx) => {
    if (!ctx.isFinance && !ctx.isAdmin) throw forbidden()
    const project = text(req.query.project, 'project', { max: 200 })
    const { rows } = await ctx.tx(c => c.query(
      `SELECT x.project_key, MAX(x.project_name) AS project_name, x.budget_section, x.budget_head,
              COUNT(*)::int AS advances,
              COALESCE(SUM(x.disbursed_amount), 0)::float8 AS disbursed,
              COALESCE(SUM(x.spent), 0)::float8 AS spent,
              COALESCE(SUM(x.refunds), 0)::float8 AS refunds,
              COALESCE(SUM(x.reimbursements), 0)::float8 AS reimbursements
       FROM (${ADVANCE_SELECT} WHERE a.org_id = $1 AND a.status IN ('disbursed', 'settled')
             ${project ? 'AND a.project_key = $2' : ''}) x
       GROUP BY x.project_key, x.budget_section, x.budget_head
       ORDER BY project_name, x.budget_section NULLS LAST, x.budget_head NULLS LAST`,
      project ? [ctx.orgId, project] : [ctx.orgId]))
    res.json({ rows: rows.map(r => ({ ...r, outstanding: round2(r.disbursed - r.spent - r.refunds + r.reimbursements) })) })
  }))

  // ══ Admin: people + settings ══════════════════════════════════════════════
  router.get('/finance-mgmt/people', h(async (_req, res, ctx) => {
    requireEditor(ctx)
    const { rows } = await ctx.tx(c => c.query(
      `SELECT u.id, u.name, u.role, to_jsonb(u) ->> 'designation' AS designation,
              p.email, COALESCE(p.is_finance, false) AS is_finance,
              m.name AS manager_name, ${ACTIVE} AS active
       FROM users u
       LEFT JOIN fm_profiles p ON p.org_id = u.org_id AND p.user_id = u.id
       LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.org_id = $1 ORDER BY ${ACTIVE} DESC, u.name`, [ctx.orgId]))
    res.json({ people: rows })
  }))

  router.patch(`/finance-mgmt/people/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    // Only admins decide who is in the Finance team (no self-granting).
    if (typeof b.is_finance === 'boolean') requireAdmin(ctx)
    const hasFlag  = typeof b.is_finance === 'boolean'
    const hasEmail = 'email' in b
    if (!hasFlag && !hasEmail) throw bad('Nothing to update.')
    const email = hasEmail ? text(b.email, 'Email', { max: 200 }) : null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.')
    await ctx.tx(async c => {
      const { rows } = await c.query(`SELECT 1 FROM users WHERE org_id = $1 AND id = $2`, [ctx.orgId, req.params.id])
      if (!rows[0]) throw notFound('User not found.')
      // $4/$5 = "was this field sent?" so an omitted field keeps its stored value.
      await c.query(
        `INSERT INTO fm_profiles (org_id, user_id, is_finance, email) VALUES ($1, $2, COALESCE($3, false), $6)
         ON CONFLICT (org_id, user_id) DO UPDATE SET
           is_finance = CASE WHEN $4 THEN EXCLUDED.is_finance ELSE fm_profiles.is_finance END,
           email      = CASE WHEN $5 THEN EXCLUDED.email      ELSE fm_profiles.email      END,
           updated_at = now()`,
        [ctx.orgId, req.params.id, hasFlag ? b.is_finance : null, hasFlag, hasEmail, email])
    })
    res.json({ ok: true })
  }))

  router.get('/finance-mgmt/settings', h(async (_req, res, ctx) => {
    requireEditor(ctx)
    const settings = await ctx.tx(c => loadSettings(c, ctx.orgId))
    const smtpConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS)
    res.json({ settings, smtp_configured: smtpConfigured })
  }))

  router.put('/finance-mgmt/settings', h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const cats = Array.isArray(b.expense_categories)
      ? [...new Set(b.expense_categories.map(x => String(x).trim()).filter(Boolean))].slice(0, 50)
      : DEFAULT_SETTINGS.expense_categories
    if (!cats.length) throw bad('Keep at least one expense category.')
    if (cats.some(x => x.length > 100)) throw bad('Category names must be under 100 characters.')
    const template = text(b.whatsapp_template, 'WhatsApp template name', { max: 512 }) || ''
    if (template && !/^[a-z0-9_]+$/.test(template)) throw bad('WhatsApp template names use lowercase letters, digits and underscores only.')
    const settings = {
      email_enabled:      b.email_enabled !== false,
      whatsapp_enabled:   b.whatsapp_enabled === true,
      whatsapp_template:  template,
      whatsapp_lang:      text(b.whatsapp_lang, 'Template language', { max: 20 }) || 'en',
      expense_categories: cats,
    }
    await ctx.tx(c => c.query(
      `INSERT INTO fm_settings (org_id, settings, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
      [ctx.orgId, JSON.stringify(settings)]))
    res.json({ settings })
  }))

  mountBudgetRoutes(router, { h, ID, bad, forbidden, notFound, money, dateStr, text, round2, requireEditor, ADVANCE_SELECT, withBalance, getPool })
  mountEditRoutes(router, {
    h, ID, bad, forbidden, money, dateStr, text, round2, inr, paymentMode, requireEditor,
    loadAdvance, loadSettlement, loadLedger, lockFiles, loadEvents, maybeClose, ADVANCE_SELECT, withBalance,
  })

  return router
}
