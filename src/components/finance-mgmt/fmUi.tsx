// Shared building blocks for the Finance Management tab (FF theme tokens).

import { useCallback, useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { X, Loader2, AlertCircle } from 'lucide-react'
import { FF } from '../../theme/colors'
import { ModalShell } from '../ui/ModalShell'
import { StatusBadge } from '../ui/StatusBadge'
import { EVENT_LABEL, fmGet, fmtDateTime, type FmEvent } from './fmApi'

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'success'
const BTN_STYLE: Record<BtnVariant, React.CSSProperties> = {
  primary:   { background: FF.purple, color: '#fff', border: `1px solid ${FF.purple}` },
  secondary: { background: '#fff', color: FF.tealDark, border: `1px solid ${FF.border}` },
  danger:    { background: '#fff', color: FF.red, border: `1px solid ${FF.red}` },
  success:   { background: FF.green, color: '#fff', border: `1px solid ${FF.green}` },
}

export function Btn({ variant = 'secondary', busy, small, children, className = '', style, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; busy?: boolean; small?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 font-semibold rounded-xl transition-opacity disabled:opacity-50 ${small ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} ${className}`}
      style={{ ...BTN_STYLE[variant], ...style }}
    >
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  )
}

export const inputCls = 'w-full rounded-lg px-3 py-2 text-sm outline-none bg-white disabled:bg-gray-50'
export const inputStyle: React.CSSProperties = { border: `1.5px solid ${FF.border}`, color: FF.tealDark }

export function Field({ label, required, hint, children, className = '' }:
  { label: string; required?: boolean; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-semibold mb-1" style={{ color: FF.tealDark }}>
        {label}{required && <span style={{ color: FF.red }}> *</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={{ color: FF.textFaint }}>{hint}</span>}
    </label>
  )
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="rounded-xl p-3 flex items-start gap-2 text-xs" style={{ background: FF.redBg, color: FF.red }} role="alert">
      <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
      <span>{message}</span>
    </div>
  )
}

type Tone = 'amber' | 'blue' | 'purple' | 'green' | 'red' | 'grey'
const TONE: Record<Tone, { bg: string; fg: string }> = {
  amber:  { bg: FF.amberBg, fg: FF.amber },
  blue:   { bg: '#E3EEF6', fg: '#2D6A93' },
  purple: { bg: '#ECE6F7', fg: FF.purple },
  green:  { bg: FF.greenBg, fg: FF.green },
  red:    { bg: FF.redBg, fg: FF.red },
  grey:   { bg: '#EEF2F3', fg: FF.textMuted },
}
const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_manager: { label: 'With manager',      tone: 'amber' },
  pending_finance: { label: 'With Finance',      tone: 'blue' },
  approved:        { label: 'Approved',          tone: 'purple' },
  disbursed:       { label: 'Paid · to settle',  tone: 'purple' },
  settled:         { label: 'Settled',           tone: 'green' },
  rejected:        { label: 'Rejected',          tone: 'red' },
  cancelled:       { label: 'Cancelled',         tone: 'grey' },
  pending:         { label: 'Pending',           tone: 'amber' },
  fulfilled:       { label: 'Ready',             tone: 'green' },
}
/** kind lets a settlement's 'approved' read as final (green) rather than mid-flow. */
export function StatusChip({ status, kind }: { status: string; kind?: 'advance' | 'settlement' | 'ledger' }) {
  const s = STATUS[status] || { label: status, tone: 'grey' as Tone }
  const tone = kind === 'settlement' && status === 'approved' ? 'green' : s.tone
  return <StatusBadge {...TONE[tone]} label={s.label} shape="pill" size="sm" />
}

export function FmModal({ open, onClose, title, subtitle, size = 'lg', footer, children, busy }: {
  open: boolean; onClose: () => void; title: string; subtitle?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'; footer?: ReactNode; children: ReactNode; busy?: boolean
}) {
  return (
    <ModalShell open={open} onClose={busy ? () => {} : onClose} size={size} disableBackdropClose={busy}>
      <div className="px-5 py-4 border-b flex items-start justify-between gap-3 shrink-0" style={{ borderColor: FF.border }}>
        <div className="min-w-0">
          <h3 className="font-bold text-[15px]" style={{ color: FF.tealDark }}>{title}</h3>
          {subtitle && <div className="text-xs mt-0.5" style={{ color: FF.textMuted }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} disabled={busy} aria-label="Close" className="disabled:opacity-50 shrink-0" style={{ color: FF.textFaint }}>
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="p-5 overflow-y-auto flex-1 space-y-4">{children}</div>
      {footer && (
        <div className="px-5 py-3 border-t flex flex-wrap justify-end gap-2 shrink-0" style={{ borderColor: FF.border }}>{footer}</div>
      )}
    </ModalShell>
  )
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide font-semibold" style={{ color: FF.textFaint }}>{k}</dt>
          <dd className="text-sm mt-0.5 break-words" style={{ color: FF.tealDark }}>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <h4 className="text-xs uppercase tracking-wider font-bold" style={{ color: FF.textMuted }}>{children}</h4>
      {right}
    </div>
  )
}

export function Timeline({ events }: { events: FmEvent[] }) {
  if (!events.length) return null
  return (
    <ol className="space-y-2.5">
      {events.map((e, i) => (
        <li key={i} className="flex gap-3 text-xs">
          <span className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: i === events.length - 1 ? FF.purple : FF.border }} />
          <div className="min-w-0">
            <div style={{ color: FF.tealDark }}>
              <span className="font-semibold">{EVENT_LABEL[e.action] || e.action}</span>
              {e.actor_name && <span style={{ color: FF.textMuted }}> · {e.actor_name}</span>}
              <span style={{ color: FF.textFaint }}> · {fmtDateTime(e.created_at)}</span>
            </div>
            {e.note && <div className="mt-0.5 break-words" style={{ color: FF.textMuted }}>{e.note}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void
}) {
  if (options.length === 1) {
    return <h3 className="text-sm font-bold" style={{ color: FF.tealDark }}>{options[0].label}</h3>
  }
  return (
    <div className="inline-flex flex-wrap gap-1 p-1 rounded-xl" style={{ background: '#E9F1F2' }} role="tablist">
      {options.map(o => {
        const active = o.key === value
        return (
          <button
            key={o.key} role="tab" aria-selected={active} onClick={() => onChange(o.key)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
            style={{ background: active ? '#fff' : 'transparent', color: active ? FF.tealDark : FF.textMuted, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}
          >
            {o.label}
            {!!o.count && <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] leading-[18px] text-white" style={{ background: FF.red }}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl ${className}`} style={{ border: `1px solid ${FF.border}` }}>{children}</div>
}

export const thCls = 'text-left text-[11px] uppercase tracking-wide font-semibold px-4 py-2.5 whitespace-nowrap'
export const tdCls = 'px-4 py-3 text-sm align-top'

export function useFmLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    run()
      .then(d => { if (!cancelled) { setData(d); setError(null) } })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [run, tick])
  return { data, error, loading, reload: () => setTick(t => t + 1) }
}

export function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-14" style={{ color: FF.textFaint }}>
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  )
}

/** Change history (old → new) of a Budget Management record, shown in its edit form. */
export function HistoryPanel({ type, id }: { type: 'budget' | 'receipt' | 'expense' | 'transfer' | 'bank_account' | 'statement'; id: string }) {
  const { data, error, loading } = useFmLoad(() => fmGet<{ events: FmEvent[] }>(`/history/${type}/${id}`), [type, id])
  return (
    <div className="space-y-2 pt-1">
      <SectionTitle>Change history</SectionTitle>
      {error ? <ErrorBox message={error} /> : loading ? <LoadingRow /> : data?.events.length
        ? <Timeline events={data.events} />
        : <div className="text-xs" style={{ color: FF.textFaint }}>No changes recorded yet.</div>}
    </div>
  )
}
