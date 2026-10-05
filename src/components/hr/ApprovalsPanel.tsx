// "Approvals" — leave requests waiting on me: first level for my reports,
// second level if I'm HR, either level if I'm an admin (override). Works
// offline from the saved list; a decision made offline is queued, and if
// someone else decided first the server rejects it and the user is told.

import { useState } from 'react'
import { FF } from '../../theme/colors'
import { useToast } from '../../context/ToastContext'
import type { HrBootstrap, LeaveRequest, OutboxItem } from '../../types/hr'
import type { HrData } from './useHrData'
import { Btn, Card, Muted, PORTION_LABEL, SyncBadge, errorText, fmtDays, fmtRange, inputStyle } from './hrUi'

export function ApprovalsPanel({ hr, data }: { hr: HrData; data: HrBootstrap }) {
  const { sync, queue } = hr
  const decided = new Map(sync.pending
    .filter((p): p is OutboxItem<'leave_decision'> => p.kind === 'leave_decision')
    .map(p => [p.payload.requestId, p.payload.decision]))
  const waiting = data.approvals.filter(r => !decided.has(r.id))
  const queuedDecisions = data.approvals.filter(r => decided.has(r.id))

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Waiting for your decision${waiting.length ? ` · ${waiting.length}` : ''}`}>
        {waiting.length === 0 ? <Muted>Nothing waiting for you.</Muted> : (
          <div className="flex flex-col">
            {waiting.map(r => <Request key={r.id} r={r} me={data.me} queue={queue} />)}
          </div>
        )}
      </Card>
      {queuedDecisions.length > 0 && (
        <Card title="Decided on this device">
          {queuedDecisions.map(r => (
            <div key={r.id} className="flex justify-between gap-3 flex-wrap"
              style={{ padding: '8px 0', borderTop: `1px solid ${FF.borderFaint}`, fontSize: 13.5, color: FF.tealText }}>
              <span>{r.userName} · {r.leaveTypeName} · {fmtRange(r.startDate, r.endDate)}</span>
              <span className="flex items-center gap-2">
                {decided.get(r.id) === 'approve' ? 'Approved' : 'Rejected'} <SyncBadge />
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

function Request({ r, me, queue }: { r: LeaveRequest; me: HrBootstrap['me']; queue: HrData['queue'] }) {
  const { toast } = useToast()
  const [comment, setComment] = useState('')
  const stage = r.status === 'pending_manager'
    ? (r.managerId === me.id || !me.isAdmin ? 'Your approval as manager'
      : `Waiting for ${r.managerName ?? 'their manager'} — admin override`)
    : 'HR approval'

  async function decide(decision: 'approve' | 'reject') {
    try {
      await queue('leave_decision', { requestId: r.id, decision, ...(comment.trim() ? { comment: comment.trim() } : {}) })
      toast(decision === 'approve' ? `Approved ${r.userName}'s leave` : `Rejected ${r.userName}'s leave`, 'success')
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error')
    }
  }

  return (
    <div style={{ padding: '12px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: FF.tealDark }}>
        {r.userName} · {r.leaveTypeName} · {fmtDays(r.days)}
      </div>
      <div style={{ fontSize: 12.5, color: FF.textMuted, marginTop: 2 }}>
        {fmtRange(r.startDate, r.endDate)}{r.dayPortion !== 'full' && ` · ${PORTION_LABEL[r.dayPortion]}`} · {stage}
      </div>
      {r.reason && <div style={{ fontSize: 13, color: FF.tealText, marginTop: 4 }}>“{r.reason}”</div>}
      {r.managerComment && <div style={{ fontSize: 12, color: FF.textFaint, marginTop: 2 }}>Manager: {r.managerComment}</div>}
      <div className="flex gap-2 flex-wrap items-center" style={{ marginTop: 8 }}>
        <input value={comment} onChange={e => setComment(e.target.value)} maxLength={1000}
          placeholder="Comment (optional)" aria-label={`Comment on ${r.userName}'s request`}
          style={{ ...inputStyle, flex: '1 1 200px' }} />
        <Btn variant="primary" onClick={() => void decide('approve')}>Approve</Btn>
        <Btn variant="danger" onClick={() => void decide('reject')}>Reject</Btn>
      </div>
    </div>
  )
}
