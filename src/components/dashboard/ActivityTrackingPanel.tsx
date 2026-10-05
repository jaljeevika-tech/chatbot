// Simple per-activity tracking fields (Status, Priority, Due Date, Evidence, Challenges,
// Next Action) inside ActionPlanTab's activity panel; read-only for non-editors.

import { useEffect, useState } from 'react'
import { Loader2, Check, ExternalLink } from 'lucide-react'
import {
  C, ACTIVITY_STATUSES, ACTIVITY_PRIORITIES, alertFor,
  type Activity, type ActivityTrackingFields, type ActivityStatus, type ActivityPriority,
} from './actionPlanShared'

const STATUS_COLOR: Record<ActivityStatus, { bg: string; fg: string }> = {
  'Not Started': { bg: '#F1F1F1', fg: '#6B7280' },
  'In Progress': { bg: '#EAF1FB', fg: '#2563EB' },
  'Completed':   { bg: '#E4EFE7', fg: C.green },
  'On Hold':     { bg: '#F5EBD3', fg: C.amber },
  'Cancelled':   { bg: '#F5E1DD', fg: C.red },
}

const EVIDENCE_URL_RE = /^https?:\/\//i

interface Props {
  activity: Activity
  canEdit:  boolean
  onSave:   (sn: number, patch: ActivityTrackingFields) => Promise<void>
}

export function ActivityTrackingPanel({ activity, canEdit, onSave }: Props) {
  const [draft, setDraft]     = useState<ActivityTrackingFields>({})
  const [touched, setTouched] = useState<Set<keyof ActivityTrackingFields>>(new Set())
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  // Re-baseline only when a different activity is shown (keyed on `sn`), so an unrelated
  // prop change can't discard or resend an in-flight edit.
  useEffect(() => {
    setDraft({
      status: activity.status, priority: activity.priority, due_date: activity.due_date,
      evidence_link: activity.evidence_link, challenges: activity.challenges, next_action: activity.next_action,
    })
    setTouched(new Set())
    setError('')
  }, [activity.sn]) // eslint-disable-line

  function set<K extends keyof ActivityTrackingFields>(key: K, value: ActivityTrackingFields[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
    setTouched(prev => new Set(prev).add(key))
  }

  const alert_ = alertFor(activity)
  const hasAnyTracking = !!(activity.status || activity.priority || activity.due_date || activity.evidence_link || activity.challenges || activity.next_action)

  async function handleSaveClick() {
    if (touched.size === 0) return
    if (draft.evidence_link && !EVIDENCE_URL_RE.test(draft.evidence_link)) {
      setError('Evidence link must start with http:// or https://')
      return
    }
    setError('')
    setSaving(true)
    try {
      // Only touched fields: one Save covers six fields and someone else may have this panel
      // open too (see handleActivityUpdate in ActionPlanTab.tsx).
      const patch: ActivityTrackingFields = {}
      for (const key of touched) (patch as any)[key] = (draft as any)[key] ?? null
      await onSave(activity.sn, patch)
      setTouched(new Set())
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2500)
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!canEdit) {
    if (!hasAnyTracking) return null
    return (
      <div className="mt-3 pt-3 border-t" style={{ borderColor: C.border }}>
        <div className="font-semibold text-gray-600 text-xs mb-2">Tracking</div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {activity.status && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: STATUS_COLOR[activity.status].bg, color: STATUS_COLOR[activity.status].fg }}>
              {activity.status}
            </span>
          )}
          {activity.priority === 'High' && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: '#F5E1DD', color: C.red }}>High priority</span>
          )}
          {activity.due_date && (
            <span className="text-[10px] text-gray-500">Due {new Date(activity.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          )}
          {alert_ && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: alert_ === 'Overdue' ? '#F5E1DD' : '#F5EBD3', color: alert_ === 'Overdue' ? C.red : C.amber }}>
              {alert_}
            </span>
          )}
          {activity.evidence_link && (
            <a href={activity.evidence_link} target="_blank" rel="noopener noreferrer" className="text-[10px] font-semibold flex items-center gap-1" style={{ color: C.purple }}>
              <ExternalLink className="w-2.5 h-2.5" /> View evidence
            </a>
          )}
        </div>
        {activity.challenges && (
          <div className="text-[11px] text-gray-500 mb-1"><strong className="text-gray-700">Challenges:</strong> {activity.challenges}</div>
        )}
        {activity.next_action && (
          <div className="text-[11px] text-gray-500"><strong className="text-gray-700">Next action:</strong> {activity.next_action}</div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: C.border }}>
      <div className="font-semibold text-gray-600 text-xs mb-2 flex items-center gap-2">
        Tracking
        {savedFlash && <span className="text-[10px] font-normal flex items-center gap-1" style={{ color: C.green }}><Check className="w-3 h-3" /> Saved</span>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
        <label className="text-[10px] text-gray-500">
          Status
          <select
            value={draft.status || ''}
            onChange={e => set('status', (e.target.value || undefined) as ActivityStatus | undefined)}
            className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
          >
            <option value="">— Not set —</option>
            {ACTIVITY_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-[10px] text-gray-500">
          Priority
          <select
            value={draft.priority || ''}
            onChange={e => set('priority', (e.target.value || undefined) as ActivityPriority | undefined)}
            className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
          >
            <option value="">— Not set —</option>
            {ACTIVITY_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-[10px] text-gray-500">
          Due date
          <input
            type="date"
            value={draft.due_date || ''}
            onChange={e => set('due_date', e.target.value || null)}
            className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
          />
        </label>
      </div>

      <label className="text-[10px] text-gray-500 block mb-2">
        Evidence link
        <div className="flex items-center gap-2 mt-0.5">
          <input
            type="text"
            placeholder="https://drive.google.com/…"
            value={draft.evidence_link || ''}
            onChange={e => set('evidence_link', e.target.value || null)}
            className="flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
          />
          {draft.evidence_link && EVIDENCE_URL_RE.test(draft.evidence_link) && (
            <a href={draft.evidence_link} target="_blank" rel="noopener noreferrer" title="Open link" className="shrink-0">
              <ExternalLink className="w-3.5 h-3.5" style={{ color: C.purple }} />
            </a>
          )}
        </div>
      </label>

      <label className="text-[10px] text-gray-500 block mb-2">
        Challenges / remarks
        <textarea
          rows={2}
          placeholder="e.g. Rains delayed start by 2 weeks"
          value={draft.challenges || ''}
          onChange={e => set('challenges', e.target.value || null)}
          className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300 resize-none"
        />
      </label>

      <label className="text-[10px] text-gray-500 block">
        Next action
        <textarea
          rows={2}
          placeholder="e.g. Reschedule training for next week"
          value={draft.next_action || ''}
          onChange={e => set('next_action', e.target.value || null)}
          className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-300 resize-none"
        />
      </label>

      {error && <p className="text-[10px] mt-2" style={{ color: C.red }}>{error}</p>}

      <div className="flex justify-end mt-2">
        <button
          onClick={handleSaveClick}
          disabled={touched.size === 0 || saving}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: C.purple }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save tracking info
        </button>
      </div>
    </div>
  )
}
