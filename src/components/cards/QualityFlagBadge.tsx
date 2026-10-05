// Inline badge for items flagged by the data-correctness layer; `compact` renders a dot
// for dense tables, with confidence and reasons in the tooltip.

import { AlertTriangle, AlertCircle, Camera } from 'lucide-react'

export type QualityFlag = 'low_confidence' | 'needs_review' | 'photo_mismatch' | null | undefined

interface Props {
  flag: QualityFlag
  confidence?: number | null
  reasons?: string[]
  compact?: boolean
}

const FLAG_META: Record<NonNullable<QualityFlag>, {
  label: string
  bg: string
  fg: string
  icon: typeof AlertTriangle
}> = {
  low_confidence: { label: 'Low confidence', bg: 'bg-amber-50',  fg: 'text-amber-700',  icon: AlertCircle },
  needs_review:   { label: 'Needs review',   bg: 'bg-red-50',     fg: 'text-red-700',     icon: AlertTriangle },
  photo_mismatch: { label: 'Photo mismatch', bg: 'bg-purple-50',  fg: 'text-purple-700',  icon: Camera },
}

export function QualityFlagBadge({ flag, confidence, reasons, compact }: Props) {
  if (!flag) return null
  const meta = FLAG_META[flag]
  if (!meta) return null
  const Icon = meta.icon
  const tooltip = [
    meta.label,
    confidence != null ? `Confidence ${Math.round(confidence * 100)}%` : null,
    ...(reasons || []).slice(0, 3),
  ].filter(Boolean).join('\n')

  if (compact) {
    return (
      <span
        title={tooltip}
        className={`inline-block w-2 h-2 rounded-full ${meta.bg} border ${meta.fg.replace('text-', 'border-')}`}
        aria-label={meta.label}
      />
    )
  }

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.bg} ${meta.fg}`}
    >
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  )
}
