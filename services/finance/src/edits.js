// Post-hoc edits to finance records. Finance and admins may correct any field of
// an advance, its refunds/reimbursements, a settlement and its lines, or a ledger
// request; each edit is logged "old → new", the requester notified, and balances
// recomputed (reopening or closing the advance). Nobody edits their own request;
// approve/pay/review stay Finance-only (router.js).
//
// PATCH  /finance-mgmt/advances/:id
// PATCH  /finance-mgmt/advances/:id/adjustments/:adj      DELETE same
// PATCH  /finance-mgmt/settlements/:id                    { note, lines: [{ id?, remove?, … }] }
// PATCH  /finance-mgmt/ledger-requests/:id
// GET    /finance-mgmt/history/:type/:id                  audit trail of a Budget Management record

import { logEvent } from './db.js'
import { queueNotifications } from './notify.js'
import { diffNote } from './audit.js'
import { resolveAccount, budgetSchemaReady } from './budget.js'

const UUID = /^[0-9a-fA-F-]{36}$/
const HISTORY_TYPES = new Set(['budget', 'receipt', 'expense', 'transfer', 'bank_account', 'statement'])

export function mountEditRoutes(router, d) {
  const {
    h, ID, bad, forbidden, money, dateStr, text, round2, inr, paymentMode, requireEditor,
    loadAdvance, loadSettlement, loadLedger, lockFiles, loadEvents, maybeClose, ADVANCE_SELECT, withBalance,
  } = d

  const notOwn = (ownerId, ctx, what) => {
    if (ownerId === ctx.me.id) throw forbidden(`You can't edit ${what} you raised yourself — ask another Finance team member or an admin.`)
  }
  const acct = async (c, ctx, id, label) => {
    if (!(await budgetSchemaReady(sql => c.query(sql)))) throw bad('Bank accounts are not set up yet.')
    try { return await resolveAccount(c, ctx.orgId, id || null, { label }) } catch (e) { throw e.status ? bad(e.message) : e }
  }
  async function accountNames(c, orgId, ids) {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length || !(await budgetSchemaReady(sql => c.query(sql)))) return new Map()
    const { rows } = await c.query(`SELECT id, name FROM fm_bank_accounts WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, list])
    return new Map(rows.map(r => [r.id, r.name]))
  }

  /** Reopen / close an advance whose balance an edit has changed. */
  async function resettle(c, ctx, advanceId) {
    const { rows } = await c.query(`${ADVANCE_SELECT} WHERE a.org_id = $1 AND a.id = $2`, [ctx.orgId, advanceId])
    const a = rows[0] && withBalance(rows[0])
    if (!a) return
    if (a.status === 'settled' && (Math.abs(a.balance) >= 0.005 || a.pending_settlements > 0)) {
      await c.query(`UPDATE fm_advances SET status = 'disbursed', closed_at = NULL, updated_at = now() WHERE org_id = $1 AND id = $2`, [ctx.orgId, a.id])
      await logEvent(c, ctx.orgId, 'advance', a.id, 'reopened', ctx.me.id,
        `Balance ${a.balance > 0 ? `${inr(a.balance)} still to account for` : `${inr(-a.balance)} owed to employee`} after an edit — advance reopened`)
    } else if (a.status === 'disbursed') {
      await maybeClose(c, ctx.orgId, a.id, ctx.me.id)
    }
  }

  const notifyOwner = (c, ctx, ownerId, title, note, entityType, entityId) =>
    queueNotifications(c, ctx.orgId, [ownerId], { title, body: `${ctx.me.name} changed — ${note}`, entityType, entityId }, ctx.me.id)

  // ══ Advance ════════════════════════════════════════════════════════════════
  const ADV_SPEC = [
    ['project', 'Project'], ['budget_line', 'Budget line'], ['purpose', 'Purpose'],
    ['amount_requested', 'Amount requested', 'money'], ['amount_approved', 'Amount approved', 'money'],
    ['needed_by', 'Needed by'], ['activity_from', 'Activity from'], ['activity_to', 'Activity to'],
    ['disbursed_amount', 'Amount paid', 'money'], ['disbursed_on', 'Paid on'], ['payment_mode', 'Payment mode'],
    ['payment_ref', 'Payment reference'], ['account', 'Paid from account'], ['finance_note', 'Finance note'],
  ]
  const advView = (x, names) => ({
    project: x.project_name || x.project_key,
    budget_line: x.budget_head ? `${x.budget_section ? x.budget_section + ' › ' : ''}${x.budget_head}` : null,
    purpose: x.purpose, amount_requested: x.amount_requested, amount_approved: x.amount_approved,
    needed_by: x.needed_by, activity_from: x.activity_from, activity_to: x.activity_to,
    disbursed_amount: x.disbursed_amount, disbursed_on: x.disbursed_on, payment_mode: x.payment_mode,
    payment_ref: x.payment_ref, account: x.bank_account_id ? names.get(x.bank_account_id) || 'unknown account' : null,
    finance_note: x.finance_note,
  })

  router.patch(`/finance-mgmt/advances/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      notOwn(a.requester_id, ctx, 'an advance')
      const paid = a.status === 'disbursed' || a.status === 'settled'
      const approvedStage = paid || a.status === 'approved'
      const next = {}
      if ('project_key' in b) {
        next.project_key = text(b.project_key, 'Project', { required: true, max: 200 })
        next.project_name = text(b.project_name, 'Project name', { max: 300 })
      }
      if ('budget_head' in b || 'budget_section' in b) {
        const head = text(b.budget_head, 'Budget line', { max: 300 })
        next.budget_head = head
        next.budget_section = head ? text(b.budget_section, 'Budget section', { max: 300 }) : null
      }
      if ('purpose' in b) next.purpose = text(b.purpose, 'Purpose', { required: true, max: 2000 })
      if ('amount_requested' in b) next.amount_requested = money(b.amount_requested, 'Amount requested')
      for (const [k, l] of [['needed_by', 'Needed by'], ['activity_from', 'Activity start'], ['activity_to', 'Activity end']]) {
        if (k in b) next[k] = dateStr(b[k], l, false)
      }
      if ('finance_note' in b) next.finance_note = text(b.finance_note, 'Finance note', { max: 1000 })
      if ('amount_approved' in b) {
        if (!approvedStage) throw bad('The approved amount can only be set once Finance has approved the advance.')
        next.amount_approved = money(b.amount_approved, 'Amount approved')
      }
      if (['disbursed_amount', 'disbursed_on', 'payment_mode', 'payment_ref', 'bank_account_id'].some(k => k in b) && !paid) {
        throw bad('Payment details can only be edited after the advance has been paid.')
      }
      if ('disbursed_amount' in b) next.disbursed_amount = money(b.disbursed_amount, 'Amount paid')
      if ('disbursed_on' in b) next.disbursed_on = dateStr(b.disbursed_on, 'Payment date')
      if ('payment_mode' in b) next.payment_mode = paymentMode(b.payment_mode)
      if ('payment_ref' in b) next.payment_ref = text(b.payment_ref, 'Payment reference', { max: 200 })
      if ('bank_account_id' in b) next.bank_account_id = await acct(c, ctx, b.bank_account_id, 'Paid from account')

      const m = { ...a, ...next }
      if (m.activity_from && m.activity_to && m.activity_to < m.activity_from) throw bad('Activity end must be on or after the start date.')
      if (m.amount_approved != null && m.amount_approved > m.amount_requested + 0.005) throw bad('Approved amount cannot be more than the amount requested.')
      if (paid && m.disbursed_amount > (m.amount_approved ?? m.amount_requested) + 0.005) throw bad(`Amount paid cannot be more than the approved ${inr(m.amount_approved)}.`)
      if (paid && m.payment_mode !== 'cash' && !m.payment_ref) throw bad('Payment reference is required unless paid in cash.')

      const names = await accountNames(c, ctx.orgId, [a.bank_account_id, m.bank_account_id])
      const { note } = diffNote(advView(a, names), advView(m, names), ADV_SPEC)
      if (!note) throw bad('Nothing was changed.')
      const cols = Object.keys(next)
      await c.query(
        `UPDATE fm_advances SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, a.id, ...cols.map(k => next[k])])
      await logEvent(c, ctx.orgId, 'advance', a.id, 'edited', ctx.me.id, note)
      await resettle(c, ctx, a.id)
      return notifyOwner(c, ctx, a.requester_id, `Advance ${a.ref_no} was updated`, note, 'advance', a.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  // ══ Refund / reimbursement ═════════════════════════════════════════════════
  async function loadAdjustment(c, ctx, advanceId, adjId) {
    const { rows: [j] } = await c.query(
      `SELECT j.id, j.kind, j.amount::float8 AS amount, j.txn_date::text AS txn_date, j.payment_mode, j.payment_ref, j.note,
              to_jsonb(j) ->> 'bank_account_id' AS bank_account_id
         FROM fm_advance_adjustments j WHERE j.org_id = $1 AND j.advance_id = $2 AND j.id = $3`, [ctx.orgId, advanceId, adjId])
    if (!j) throw bad('That refund / reimbursement was not found.')
    return j
  }
  const ADJ_SPEC = [['amount', 'Amount', 'money'], ['txn_date', 'Date'], ['payment_mode', 'Mode'], ['payment_ref', 'Reference'], ['account', 'Account'], ['note', 'Note']]
  const adjView = (x, names) => ({ ...x, account: x.bank_account_id ? names.get(x.bank_account_id) || 'unknown account' : null })

  router.patch(`/finance-mgmt/advances/:id${ID}/adjustments/:adj${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      notOwn(a.requester_id, ctx, 'an advance')
      const j = await loadAdjustment(c, ctx, a.id, req.params.adj)
      const next = {}
      if ('amount' in b) next.amount = money(b.amount)
      if ('txn_date' in b) next.txn_date = dateStr(b.txn_date, 'Date')
      if ('payment_mode' in b) next.payment_mode = paymentMode(b.payment_mode)
      if ('payment_ref' in b) next.payment_ref = text(b.payment_ref, 'Reference', { max: 200 })
      if ('note' in b) next.note = text(b.note, 'Note', { max: 1000 })
      if ('bank_account_id' in b) next.bank_account_id = await acct(c, ctx, b.bank_account_id, 'Account')
      const m = { ...j, ...next }
      const names = await accountNames(c, ctx.orgId, [j.bank_account_id, m.bank_account_id])
      const { note } = diffNote(adjView(j, names), adjView(m, names), ADJ_SPEC)
      if (!note) throw bad('Nothing was changed.')
      const cols = Object.keys(next)
      await c.query(
        `UPDATE fm_advance_adjustments SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, j.id, ...cols.map(k => next[k])])
      await logEvent(c, ctx.orgId, 'advance', a.id, `${j.kind}_edited`, ctx.me.id, note)
      await resettle(c, ctx, a.id)
      return notifyOwner(c, ctx, a.requester_id, `${j.kind === 'refund' ? 'Refund' : 'Reimbursement'} on ${a.ref_no} was updated`, note, 'advance', a.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  router.delete(`/finance-mgmt/advances/:id${ID}/adjustments/:adj${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const queued = await ctx.tx(async c => {
      const a = await loadAdvance(c, ctx, req.params.id)
      notOwn(a.requester_id, ctx, 'an advance')
      const j = await loadAdjustment(c, ctx, a.id, req.params.adj)
      await c.query(`DELETE FROM fm_advance_adjustments WHERE org_id = $1 AND id = $2`, [ctx.orgId, j.id])
      const note = `${inr(j.amount)} on ${j.txn_date}${j.payment_ref ? ` (${j.payment_ref})` : ''}`
      await logEvent(c, ctx.orgId, 'advance', a.id, `${j.kind}_deleted`, ctx.me.id, note)
      await resettle(c, ctx, a.id)
      return notifyOwner(c, ctx, a.requester_id, `${j.kind === 'refund' ? 'Refund' : 'Reimbursement'} on ${a.ref_no} was removed`, note, 'advance', a.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  // ══ Settlement + bill lines ════════════════════════════════════════════════
  router.patch(`/finance-mgmt/settlements/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const queued = await ctx.tx(async c => {
      const s = await loadSettlement(c, ctx, req.params.id)
      notOwn(s.submitted_by, ctx, 'a settlement')
      if (s.status === 'cancelled') throw bad('A withdrawn settlement cannot be edited.')
      const approved = s.status === 'approved'
      const { rows: lines } = await c.query(
        `SELECT id, expense_date::text AS expense_date, category, description, amount::float8 AS amount,
                amount_approved::float8 AS amount_approved, bill_file_id, sort_order
           FROM fm_settlement_lines WHERE org_id = $1 AND settlement_id = $2 ORDER BY sort_order`, [ctx.orgId, s.id])
      const byId = new Map(lines.map(l => [l.id, l]))
      const changes = []
      const updates = [], inserts = [], removes = []
      const newFiles = []

      if (Array.isArray(b.lines)) {
        if (b.lines.length > 100) throw bad('Too many lines.')
        b.lines.forEach((l, i) => {
          const n = i + 1
          if (l?.id) {
            const cur = byId.get(l.id)
            if (!cur) throw bad(`Line ${n} does not belong to this settlement.`)
            if (l.remove) { removes.push(cur); return }
            const nx = {
              expense_date: 'expense_date' in l ? dateStr(l.expense_date, `Line ${n}: date`) : cur.expense_date,
              category: 'category' in l ? text(l.category, `Line ${n}: category`, { required: true, max: 100 }) : cur.category,
              description: 'description' in l ? text(l.description, `Line ${n}: description`, { max: 500 }) : cur.description,
              amount: 'amount' in l ? money(l.amount, `Line ${n}: amount`) : cur.amount,
              amount_approved: cur.amount_approved,
              bill_file_id: cur.bill_file_id,
            }
            if (approved) {
              nx.amount_approved = 'amount_approved' in l && l.amount_approved !== '' && l.amount_approved != null
                ? round2(Number(l.amount_approved)) : (cur.amount_approved ?? nx.amount)
              if (!Number.isFinite(nx.amount_approved) || nx.amount_approved < 0 || nx.amount_approved > nx.amount + 0.005) {
                throw bad(`Line ${n}: approved amount must be between 0 and the amount claimed.`)
              }
            }
            if (l.bill_file_id && l.bill_file_id !== cur.bill_file_id) {
              if (!UUID.test(String(l.bill_file_id))) throw bad(`Line ${n}: bill is not valid.`)
              nx.bill_file_id = l.bill_file_id; newFiles.push(l.bill_file_id)
            }
            const { note } = diffNote(
              { ...cur, bill: 'attached' }, { ...nx, bill: nx.bill_file_id === cur.bill_file_id ? 'attached' : 'replaced' },
              [['expense_date', 'date'], ['category', 'category'], ['description', 'description'], ['amount', 'amount', 'money'],
               ['amount_approved', 'approved', 'money'], ['bill', 'bill']])
            if (note) { changes.push(`Line ${n} (${cur.category}): ${note}`); updates.push({ id: cur.id, ...nx }) }
          } else {
            if (!UUID.test(String(l?.bill_file_id || ''))) throw bad(`Line ${n}: attach the bill or receipt.`)
            const nx = {
              expense_date: dateStr(l.expense_date, `Line ${n}: date`),
              category: text(l.category, `Line ${n}: category`, { required: true, max: 100 }),
              description: text(l.description, `Line ${n}: description`, { max: 500 }),
              amount: money(l.amount, `Line ${n}: amount`),
              amount_approved: null,
              bill_file_id: l.bill_file_id,
            }
            if (approved) {
              nx.amount_approved = l.amount_approved !== '' && l.amount_approved != null ? round2(Number(l.amount_approved)) : nx.amount
              if (!Number.isFinite(nx.amount_approved) || nx.amount_approved < 0 || nx.amount_approved > nx.amount + 0.005) {
                throw bad(`Line ${n}: approved amount must be between 0 and the amount claimed.`)
              }
            }
            newFiles.push(l.bill_file_id); inserts.push(nx)
            changes.push(`Added line: ${nx.expense_date} ${nx.category} ${inr(nx.amount)}`)
          }
        })
        for (const r of removes) changes.push(`Removed line: ${r.expense_date} ${r.category} ${inr(r.amount)}`)
        if (lines.length - removes.length + inserts.length < 1) throw bad('A settlement needs at least one expense line.')
      }

      if (newFiles.length) {
        if (new Set(newFiles).size !== newFiles.length) throw bad('The same bill is attached to more than one line.')
        await lockFiles(c, ctx.orgId, newFiles)
        const { rows: ok } = await c.query(
          `SELECT f.id FROM fm_files f WHERE f.org_id = $1 AND f.id = ANY($2::uuid[]) AND f.purpose = 'bill'
             AND NOT EXISTS (SELECT 1 FROM fm_settlement_lines l WHERE l.bill_file_id = f.id)`, [ctx.orgId, newFiles])
        if (ok.length !== newFiles.length) throw bad('One or more bills are missing or already used — please re-attach them.')
      }

      let newNote = s.note
      if ('note' in b) {
        newNote = text(b.note, 'Note', { max: 2000 })
        if ((newNote || '') !== (s.note || '')) changes.push(`Note: ${s.note || '—'} → ${newNote || '—'}`)
      }
      if (!changes.length) throw bad('Nothing was changed.')

      for (const r of removes) await c.query(`DELETE FROM fm_settlement_lines WHERE org_id = $1 AND id = $2`, [ctx.orgId, r.id])
      for (const u of updates) {
        await c.query(
          `UPDATE fm_settlement_lines SET expense_date = $3, category = $4, description = $5, amount = $6, amount_approved = $7, bill_file_id = $8
            WHERE org_id = $1 AND id = $2`,
          [ctx.orgId, u.id, u.expense_date, u.category, u.description, u.amount, u.amount_approved, u.bill_file_id])
      }
      let order = lines.reduce((mx, l) => Math.max(mx, l.sort_order), 0)
      for (const x of inserts) {
        await c.query(
          `INSERT INTO fm_settlement_lines (org_id, settlement_id, expense_date, category, description, amount, amount_approved, bill_file_id, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.orgId, s.id, x.expense_date, x.category, x.description, x.amount, x.amount_approved, x.bill_file_id, ++order])
      }
      const { rows: [t] } = await c.query(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS claimed, COALESCE(SUM(amount_approved), 0)::float8 AS approved
           FROM fm_settlement_lines WHERE org_id = $1 AND settlement_id = $2`, [ctx.orgId, s.id])
      if (approved && t.approved <= 0) throw bad('Nothing would remain approved — reject the settlement instead.')
      const newApproved = approved ? round2(t.approved) : s.amount_approved
      if (Math.abs(t.claimed - s.amount_claimed) >= 0.005) changes.push(`Total claimed: ${inr(s.amount_claimed)} → ${inr(t.claimed)}`)
      if (approved && Math.abs(newApproved - (s.amount_approved || 0)) >= 0.005) changes.push(`Total approved: ${inr(s.amount_approved)} → ${inr(newApproved)}`)
      await c.query(
        `UPDATE fm_settlements SET note = $3, amount_claimed = $4, amount_approved = $5, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, s.id, newNote, round2(t.claimed), newApproved])
      const note = changes.join('; ').slice(0, 1900)
      await logEvent(c, ctx.orgId, 'settlement', s.id, 'edited', ctx.me.id, note)
      await logEvent(c, ctx.orgId, 'advance', s.advance_id, 'settlement_edited', ctx.me.id, `${s.ref_no}: ${note}`.slice(0, 1900))
      await resettle(c, ctx, s.advance_id)
      return notifyOwner(c, ctx, s.submitted_by, `Settlement ${s.ref_no} was updated`, note, 'settlement', s.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  // ══ Ledger request ═════════════════════════════════════════════════════════
  router.patch(`/finance-mgmt/ledger-requests/:id${ID}`, h(async (req, res, ctx) => {
    requireEditor(ctx)
    const b = req.body || {}
    const queued = await ctx.tx(async c => {
      const l = await loadLedger(c, ctx, req.params.id)
      notOwn(l.requester_id, ctx, 'a ledger request')
      if (l.status === 'cancelled') throw bad('A cancelled request cannot be edited.')
      const m = { ...l }
      if ('ledger_type' in b) {
        if (!['staff', 'vendor', 'other'].includes(b.ledger_type)) throw bad('Choose which ledger.')
        m.ledger_type = b.ledger_type
      }
      if ('party_name' in b || 'ledger_type' in b) {
        m.party_name = m.ledger_type === 'staff' ? null
          : text('party_name' in b ? b.party_name : l.party_name, m.ledger_type === 'vendor' ? 'Vendor / party name' : 'Ledger name', { required: true, max: 300 })
      }
      if ('from_date' in b) m.from_date = dateStr(b.from_date, 'From date')
      if ('to_date' in b) m.to_date = dateStr(b.to_date, 'To date')
      if (m.to_date < m.from_date) throw bad('To date must be on or after the from date.')
      if ('purpose' in b) m.purpose = text(b.purpose, 'Purpose', { max: 1000 })
      if ('finance_note' in b) m.finance_note = text(b.finance_note, 'Finance note', { max: 1000 })
      if (m.ledger_type === 'staff') {
        m.statement_file_id = null; m.statement_file_name = null
      } else if (b.statement_file_id && b.statement_file_id !== l.statement_file_id) {
        if (l.status !== 'fulfilled') throw bad('A statement file can only be attached once the request has been answered.')
        if (!UUID.test(String(b.statement_file_id))) throw bad('Statement file is not valid.')
        const { rows: [f] } = await c.query(
          `SELECT file_name FROM fm_files WHERE org_id = $1 AND id = $2 AND purpose = 'statement'`, [ctx.orgId, b.statement_file_id])
        if (!f) throw bad('Statement file not found — upload it again.')
        m.statement_file_id = b.statement_file_id; m.statement_file_name = f.file_name
      }
      if (l.status === 'fulfilled' && m.ledger_type !== 'staff' && !m.statement_file_id) {
        throw bad('A vendor / other ledger that has been answered needs its statement file — upload it.')
      }
      const { note } = diffNote(l, m, [['ledger_type', 'Ledger type'], ['party_name', 'Ledger name'], ['from_date', 'From'],
        ['to_date', 'To'], ['purpose', 'Purpose'], ['finance_note', 'Finance note'], ['statement_file_name', 'Statement file']])
      if (!note) throw bad('Nothing was changed.')
      await c.query(
        `UPDATE fm_ledger_requests SET ledger_type = $3, party_name = $4, from_date = $5, to_date = $6, purpose = $7,
                finance_note = $8, statement_file_id = $9, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [ctx.orgId, l.id, m.ledger_type, m.party_name, m.from_date, m.to_date, m.purpose, m.finance_note, m.statement_file_id])
      await logEvent(c, ctx.orgId, 'ledger', l.id, 'edited', ctx.me.id, note)
      return notifyOwner(c, ctx, l.requester_id, `Ledger request ${l.ref_no} was updated`, note, 'ledger', l.id)
    })
    await ctx.notifyAfter(queued)
    res.json({ ok: true })
  }))

  // ══ Audit trail of a Budget Management record ═════════════════════════════
  router.get('/finance-mgmt/history/:type/:id', h(async (req, res, ctx) => {
    requireEditor(ctx)
    if (!HISTORY_TYPES.has(req.params.type) || !UUID.test(req.params.id)) throw bad('Unknown record.')
    const events = await ctx.tx(c => loadEvents(c, ctx.orgId, req.params.type, req.params.id))
    res.json({ events })
  }))
}
