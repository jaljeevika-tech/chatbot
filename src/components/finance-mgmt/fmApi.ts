// Types + fetch helpers for Finance Management (services/finance/src/router.js at /api/finance-mgmt/*).

import { apiFetch } from '../../utils/apiFetch'
import { localIsoDate } from '../../utils/format'

export type AdvanceStatus = 'pending_manager' | 'pending_finance' | 'approved' | 'disbursed' | 'settled' | 'rejected' | 'cancelled'
export type SettlementStatus = 'pending_manager' | 'pending_finance' | 'approved' | 'rejected' | 'cancelled'
export type LedgerStatus = 'pending' | 'fulfilled' | 'rejected' | 'cancelled'
export type PaymentMode = 'bank_transfer' | 'upi' | 'cheque' | 'cash'

export interface FmMe {
  me: { id: string; name: string; email: string | null; role: string; is_finance: boolean; is_admin: boolean; manager: { id: string; name: string } | null }
  counts: {
    adv_manager: number; adv_finance: number; adv_disburse: number
    stl_manager: number; stl_finance: number; ledger_finance: number
    my_open_advances: number; unread: number
  }
  approvers: { id: string; name: string; role: string }[]
  finance_team_size: number
  expense_categories: string[]
  /** Active bank accounts — Finance team + admins, once migration 081 is applied. */
  bank_accounts?: { id: string; name: string; kind: BankAccountKind }[]
}

export interface Advance {
  id: string; ref_no: string
  requester_id: string; requester_name: string
  manager_id: string | null; manager_name: string | null
  project_key: string; project_name: string | null
  budget_section: string | null; budget_head: string | null
  purpose: string
  amount_requested: number; amount_approved: number | null
  needed_by: string | null; activity_from: string | null; activity_to: string | null
  status: AdvanceStatus
  manager_note: string | null; manager_action_at: string | null
  finance_note: string | null; finance_action_at: string | null
  disbursed_amount: number | null; disbursed_on: string | null
  payment_mode: PaymentMode | null; payment_ref: string | null
  closed_at: string | null; created_at: string; updated_at: string
  bank_account_id?: string | null
  spent: number; pending_claims: number; pending_settlements: number
  refunds: number; reimbursements: number; balance: number
}

export interface Settlement {
  id: string; ref_no: string
  advance_id: string; advance_ref: string; advance_purpose: string
  project_key: string; project_name: string | null; budget_head: string | null
  submitted_by: string; submitted_by_name: string
  manager_id: string | null; manager_name: string | null
  note: string | null
  amount_claimed: number; amount_approved: number | null
  status: SettlementStatus
  manager_note: string | null; manager_action_at: string | null
  finance_note: string | null; finance_action_at: string | null
  created_at: string; updated_at: string
}

export interface SettlementLine {
  id: string; expense_date: string; category: string; description: string | null
  amount: number; amount_approved: number | null
  bill_file_id: string; bill_file_name: string; bill_mime_type: string
}

export interface Adjustment {
  id: string; kind: 'refund' | 'reimbursement'; amount: number; txn_date: string
  payment_mode: PaymentMode | null; payment_ref: string | null; note: string | null
  created_at: string; recorded_by_name: string; bank_account_id?: string | null
}

export interface FmEvent { action: string; note: string | null; created_at: string; actor_name: string | null }

export interface LedgerRequest {
  id: string; ref_no: string; requester_id: string; requester_name: string
  ledger_type: 'staff' | 'vendor' | 'other'; party_name: string | null
  from_date: string; to_date: string; purpose: string | null; status: LedgerStatus
  statement_file_id: string | null; statement_file_name: string | null
  finance_note: string | null; finance_action_at: string | null; finance_action_by_name: string | null
  created_at: string
}

export interface StaffStatement {
  ref_no: string; employee: string; from_date: string; to_date: string; status: LedgerStatus
  opening_balance: number; closing_balance: number
  rows: { date: string; ref: string; particulars: string; debit: number; credit: number; balance: number }[]
  totals: { debit: number; credit: number }
}

export interface FmNotification {
  id: string; title: string; body: string | null
  entity_type: 'advance' | 'settlement' | 'ledger' | null; entity_id: string | null
  read_at: string | null; created_at: string
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/finance-mgmt${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}
export const fmGet   = <T,>(path: string) => call<T>('GET', path)
export const fmPost  = <T,>(path: string, body: unknown = {}) => call<T>('POST', path, body)
export const fmPatch = <T,>(path: string, body: unknown) => call<T>('PATCH', path, body)
export const fmPut   = <T,>(path: string, body: unknown) => call<T>('PUT', path, body)
export const fmDelete = <T,>(path: string) => call<T>('DELETE', path)

// ── Budget Management ────────────────────────────────────────────────────────
export type BankAccountKind = 'fcra_main' | 'fcra_utilisation' | 'local' | 'cash' | 'other'
export const ACCOUNT_KIND_LABEL: Record<BankAccountKind, string> = {
  fcra_main: 'FCRA main', fcra_utilisation: 'FCRA utilisation', local: 'Local', cash: 'Cash in hand', other: 'Other',
}

/** One project's grant period with its money funnel (services/finance/src/budget.js). */
export interface Grant {
  id: string; project_key: string; project_name: string | null; donor: string | null; grant_ref: string | null
  period_from: string; period_to: string; approved: number; notes: string | null
  received: number; staff_paid: number; reimbursed: number; refunded: number; other_expenses: number
  bills_submitted: number; bills_approved: number; held_by_staff: number; owed_to_staff: number; open_advances: number
  paid_out: number; utilised: number; funds_in_hand: number; pending_from_donor: number; budget_left: number; utilisation_pct: number
}

export interface BankAccount {
  id: string; name: string; kind: BankAccountKind; bank_name: string | null; account_last4: string | null; active: boolean
  opening_balance: number; opening_date: string; computed_balance: number
  statement_id: string | null; statement_as_of: string | null; statement_balance: number | null; statement_note?: string | null
  computed_at_statement: number | null; difference: number | null; before_opening: number
}

export interface BudgetOverview {
  totals: Record<'approved' | 'received' | 'staff_paid' | 'reimbursed' | 'refunded' | 'other_expenses' | 'paid_out' | 'bills_submitted'
    | 'bills_approved' | 'utilised' | 'funds_in_hand' | 'pending_from_donor' | 'budget_left' | 'held_by_staff' | 'owed_to_staff'
    | 'bank_computed' | 'bank_accounts' | 'bank_reconciled', number> & { bank_difference: number | null }
  grants: Grant[]
  accounts: BankAccount[]
  gaps: { adv_outside_n: number; adv_outside_amt: number; exp_outside_n: number; exp_outside_amt: number
    exp_untagged_n: number; exp_untagged_amt: number; adv_untagged_n: number; adv_untagged_amt: number; adj_untagged_n: number }
}

export interface Receipt {
  id: string; budget_id?: string; bank_account_id?: string; project_key?: string; project_name?: string | null; donor?: string | null
  received_on: string; amount: number; tranche: string | null; reference: string | null; note: string | null
  account_name: string; created_at: string
}

export interface Expense {
  id: string; project_key?: string; project_name?: string | null; paid_on: string; category: string; payee: string | null
  description: string | null; amount: number; voucher_ref: string | null; bank_account_id?: string | null
  account_name: string | null; upload_batch: string | null; created_at?: string
}

export interface Transfer {
  id: string; from_account_id?: string; to_account_id?: string; transfer_on: string; amount: number; reference: string | null; note: string | null
  from_name: string; to_name: string; created_at: string
}

// ── Files ────────────────────────────────────────────────────────────────────
const MAX_UPLOAD = 10 * 1024 * 1024

/** Downscale phone photos (bills) to ≤1600px JPEG — a 4 MB camera shot becomes ~300 KB. */
async function shrinkImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 600 * 1024) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(b)
  })
}

export interface UploadedFile { id: string; file_name: string; mime_type: string; size_bytes: number }

export async function uploadFmFile(file: File, purpose: 'bill' | 'statement'): Promise<UploadedFile> {
  const blob = purpose === 'bill' ? await shrinkImage(file) : file
  if (blob.size > MAX_UPLOAD) throw new Error('File is larger than 10 MB.')
  const name = blob === file ? file.name : file.name.replace(/\.\w+$/, '') + '.jpg'
  const { file: f } = await fmPost<{ file: UploadedFile }>('/files', { purpose, file_name: name, data: await blobToDataUrl(blob) })
  return f
}

/** Fetch a stored file and open it in a new tab (or download for spreadsheets). */
export async function openFmFile(id: string) {
  // Open the tab synchronously so pop-up blockers allow it, then fill it.
  const win = window.open('', '_blank')
  try {
    const f = await fmGet<{ file_name: string; mime_type: string; data_base64: string }>(`/files/${id}`)
    const bytes = Uint8Array.from(atob(f.data_base64), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mime_type }))
    const viewable = /^(image\/|application\/pdf)/.test(f.mime_type)
    if (viewable && win) {
      win.location.href = url
    } else {
      win?.close()
      const a = document.createElement('a')
      a.href = url; a.download = f.file_name; a.click()
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (e) {
    win?.close()
    throw e
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────
export const inr = (n: number | null | undefined) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

export function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtDateTime(s: string | null | undefined) {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export const todayIso = () => localIsoDate()

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash',
}

export const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted', manager_approved: 'Approved by manager', manager_rejected: 'Declined by manager',
  finance_approved: 'Approved by Finance', finance_rejected: 'Rejected by Finance', disbursed: 'Payment made',
  cancelled: 'Cancelled', reassigned: 'Approver reassigned', settled: 'Closed — fully settled',
  settlement_submitted: 'Settlement submitted', settlement_approved: 'Settlement approved',
  settlement_rejected: 'Settlement rejected', settlement_withdrawn: 'Settlement withdrawn',
  refund_recorded: 'Refund received', reimbursement_recorded: 'Reimbursement paid',
  fulfilled: 'Statement provided', rejected: 'Rejected',
  edited: 'Edited', reopened: 'Reopened after an edit', settlement_edited: 'Settlement edited',
  refund_edited: 'Refund edited', reimbursement_edited: 'Reimbursement edited',
  refund_deleted: 'Refund removed', reimbursement_deleted: 'Reimbursement removed',
  created: 'Created', deleted: 'Deleted', recorded: 'Recorded', bulk_uploaded: 'Uploaded from Excel', bulk_deleted: 'Upload undone',
  deactivated: 'Deactivated', reactivated: 'Reactivated', updated: 'Updated',
}

/** Finance team and admins manage (add / edit / delete) Finance data. */
export const canEditFinance = (me: FmMe) => me.me.is_finance || me.me.is_admin
