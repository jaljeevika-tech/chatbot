// Result banner for the MIS bulk uploads: lists every skipped row (`errors`, usually an
// unmatched UID), expandable. `duplicates`/`warnings` come only from the beneficiary-linked
// categories (lib/misUpsertHelpers.js) and are shown separately, since a duplicate isn't an error.
import { useState } from 'react'
import { CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronUp, X } from 'lucide-react'
import { FF, ffStatusColors } from '../../theme/colors'

export interface UploadRowError {
  row: number
  uid?: string
  error: string
}

export interface UploadRowWarning {
  row: number
  uid?: string
  warning: string
}

interface UploadResultBannerProps {
  saved: number
  /** Singular noun for the record type, e.g. "scheme access record" */
  noun: string
  errors: UploadRowError[]
  /** Rows recognized as an exact duplicate of an existing record (skipped, not an error) */
  duplicates?: number
  warnings?: UploadRowWarning[]
  onDismiss: () => void
}

export function UploadResultBanner({ saved, noun, errors, duplicates = 0, warnings = [], onDismiss }: UploadResultBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const [warningsExpanded, setWarningsExpanded] = useState(false)
  const hasErrors = errors.length > 0
  const hasDuplicates = duplicates > 0
  const colors = ffStatusColors(hasErrors ? 'amber' : 'green')
  const dupColors = ffStatusColors('amber')

  return (
    <div className="rounded-xl px-3 py-2 text-sm" style={{ background: colors.bg, color: colors.fg }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {hasErrors ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>
            Saved {saved} {noun}{saved === 1 ? '' : 's'}
            {hasErrors && ` — ${errors.length} row${errors.length === 1 ? '' : 's'} skipped`}
          </span>
          {hasErrors && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="flex items-center gap-1 text-xs font-semibold underline underline-offset-2"
            >
              {expanded ? 'Hide details' : `Show all ${errors.length}`}
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {hasErrors && expanded && (
        <div
          className="mt-2 max-h-56 overflow-y-auto rounded-lg"
          style={{ background: '#FFFFFF', border: `1px solid ${FF.border}` }}
        >
          {errors.map((e, i) => (
            <div
              key={i}
              className="flex items-start gap-3 px-3 py-1.5 text-xs"
              style={{ borderBottom: i < errors.length - 1 ? `1px solid ${FF.borderFaint}` : 'none' }}
            >
              <span style={{ color: FF.textFaint, minWidth: 46, flexShrink: 0 }}>Row {e.row}</span>
              {e.uid && (
                <span style={{ color: FF.tealDark, fontFamily: 'monospace', minWidth: 90, flexShrink: 0 }}>
                  {e.uid || '—'}
                </span>
              )}
              <span style={{ color: FF.textMuted }}>{e.error}</span>
            </div>
          ))}
        </div>
      )}

      {hasDuplicates && (
        <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Info className="w-4 h-4 shrink-0" style={{ color: dupColors.fg }} />
            <span style={{ color: dupColors.fg }}>
              {duplicates} row{duplicates === 1 ? '' : 's'} skipped as exact duplicate{duplicates === 1 ? '' : 's'} — every field matched an existing record
            </span>
            {warnings.length > 0 && (
              <button
                onClick={() => setWarningsExpanded(w => !w)}
                className="flex items-center gap-1 text-xs font-semibold underline underline-offset-2"
                style={{ color: dupColors.fg }}
              >
                {warningsExpanded ? 'Hide details' : `Show all ${warnings.length}`}
                {warningsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
          {warningsExpanded && (
            <div
              className="mt-2 max-h-56 overflow-y-auto rounded-lg"
              style={{ background: '#FFFFFF', border: `1px solid ${FF.border}` }}
            >
              {warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 px-3 py-1.5 text-xs"
                  style={{ borderBottom: i < warnings.length - 1 ? `1px solid ${FF.borderFaint}` : 'none' }}
                >
                  <span style={{ color: FF.textFaint, minWidth: 46, flexShrink: 0 }}>Row {w.row}</span>
                  {w.uid && (
                    <span style={{ color: FF.tealDark, fontFamily: 'monospace', minWidth: 90, flexShrink: 0 }}>
                      {w.uid || '—'}
                    </span>
                  )}
                  <span style={{ color: FF.textMuted }}>{w.warning}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
