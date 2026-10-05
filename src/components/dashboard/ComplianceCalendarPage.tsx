// Compliance Calendar cards from GET /api/compliance-items?project=<key> (includes org-level
// items with a null project_key).

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF, ffStatusColors, type FFStatus } from '../../theme/colors'
import { StatusBadge } from '../ui/StatusBadge'

interface ComplianceItem { id: string; item: string; status: 'overdue' | 'upcoming' | 'valid'; dueLabel: string }

const STATUS_MAP: Record<ComplianceItem['status'], FFStatus> = { overdue: 'red', upcoming: 'amber', valid: 'green' }

interface Props {
  projectKey?: string
}

export function ComplianceCalendarPage({ projectKey }: Props) {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ComplianceItem[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = projectKey ? `?project=${encodeURIComponent(projectKey)}` : ''
    apiFetch(`/api/compliance-items${q}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setItems(d.items || []) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectKey])

  if (loading) {
    return <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      {items.length === 0 ? (
        <div style={{ padding: 24, fontSize: 13, color: FF.textFaint, textAlign: 'center', background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12 }}>
          No compliance items yet.
        </div>
      ) : items.map(c => {
        const colors = ffStatusColors(STATUS_MAP[c.status])
        return (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 flex-wrap px-4 py-3.5 sm:px-[22px] sm:py-4"
            style={{
              background: '#FFFFFF', border: `1px solid ${FF.border}`, borderLeft: `4px solid ${colors.fg}`,
              borderRadius: 10,
            }}
          >
            <div className="min-w-0">
              <div style={{ fontSize: 14.5, fontWeight: 500, color: FF.tealDark }}>{c.item}</div>
              <div style={{ fontSize: 12, color: FF.textMuted, marginTop: 3 }}>{c.dueLabel}</div>
            </div>
            <StatusBadge bg={colors.bg} fg={colors.fg} label={c.status[0].toUpperCase() + c.status.slice(1)} shape="pill" size="sm" />
          </div>
        )
      })}
    </div>
  )
}
