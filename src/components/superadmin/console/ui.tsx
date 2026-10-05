// Super admin console primitives; colours come from the .sa-console tokens in src/index.css (light + dark).

import {
  useState, useCallback, useRef, useId,
  type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { Loader2, X, Copy, Check } from 'lucide-react'
import { useEscapeKey } from '../../../hooks/useEscapeKey'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ── Button ────────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
const BTN: Record<ButtonVariant, string> = {
  primary:   'bg-sa-primary text-sa-on-primary hover:bg-sa-primary-hover border border-transparent',
  secondary: 'bg-sa-surface text-sa-text border border-sa-border hover:bg-sa-subtle',
  ghost:     'bg-transparent text-sa-muted hover:text-sa-text hover:bg-sa-subtle border border-transparent',
  danger:    'bg-sa-danger-soft text-sa-danger border border-transparent hover:border-sa-danger',
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors whitespace-nowrap',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sa-primary',
        'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'text-xs px-2.5 py-1.5' : 'text-sm px-3.5 py-2',
        BTN[variant], className,
      )}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button size="sm" icon={done ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1800) }) }}>
      {done ? 'Copied' : label}
    </Button>
  )
}

// ── Form controls ─────────────────────────────────────────────────────────────
const CONTROL = 'w-full rounded-lg border border-sa-border bg-sa-surface text-sa-text text-sm px-3 py-2 placeholder:text-sa-muted/70 focus:outline-none focus:ring-2 focus:ring-sa-primary/30 focus:border-sa-primary disabled:opacity-60'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, className)} />
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx(CONTROL, 'pr-8', className)}>{children}</select>
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(CONTROL, 'resize-y', className)} />
}

/** Label + control + hint. Pass a render function to get the generated id for the control. */
export function Field({ label, hint, error, children, className }: {
  label: string; hint?: ReactNode; error?: string; className?: string
  children: ReactNode | ((id: string) => ReactNode)
}) {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-xs font-semibold text-sa-muted">{label}</label>
      {typeof children === 'function' ? children(id) : children}
      {error ? <p className="text-xs text-sa-danger">{error}</p> : hint ? <p className="text-xs text-sa-muted">{hint}</p> : null}
    </div>
  )
}

export function Switch({ checked, onChange, label, description, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean
}) {
  return (
    <label className={cx('flex items-start justify-between gap-4 py-2.5', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-sa-text">{label}</span>
        {description && <span className="block text-xs text-sa-muted mt-0.5">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative shrink-0 w-10 h-6 rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed', checked ? 'bg-sa-primary' : 'bg-sa-border')}>
        <span className={cx('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
    </label>
  )
}

// ── Layout ────────────────────────────────────────────────────────────────────
export function Card({ title, description, actions, children, className, padded = true }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean
}) {
  return (
    <section className={cx('rounded-xl border border-sa-border bg-sa-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-sa-border">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-sa-text">{title}</h3>}
            {description && <p className="text-xs text-sa-muted mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div className="min-w-0">
        {back}
        <h1 className="text-xl sm:text-2xl font-semibold text-sa-text tracking-tight">{title}</h1>
        {subtitle && <div className="text-sm text-sa-muted mt-1">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-12 px-6">
      {icon && <div className="text-sa-muted mb-1">{icon}</div>}
      <div className="text-sm font-semibold text-sa-text">{title}</div>
      {children && <div className="text-sm text-sa-muted max-w-md">{children}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-sa-subtle', className)} />
}

// ── Badges ────────────────────────────────────────────────────────────────────
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
const TONE: Record<Tone, string> = {
  neutral: 'bg-sa-subtle text-sa-muted border-sa-border',
  primary: 'bg-sa-primary-soft text-sa-primary border-transparent',
  success: 'bg-sa-success-soft text-sa-success border-transparent',
  warning: 'bg-sa-warning-soft text-sa-warning border-transparent',
  danger:  'bg-sa-danger-soft text-sa-danger border-transparent',
}
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', TONE[tone], className)}>{children}</span>
}

export const STATUS_TONE: Record<string, Tone> = {
  active: 'success', trialing: 'primary', expired: 'danger', suspended: 'danger', inactive: 'neutral',
}
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status || 'inactive'
  return <Badge tone={STATUS_TONE[s] ?? 'neutral'}>{s.charAt(0).toUpperCase() + s.slice(1)}</Badge>
}

export type AccessState = 'ok' | 'grace' | 'read_only'
export function AccessBadge({ state }: { state?: AccessState | null }) {
  if (!state || state === 'ok') return null
  return state === 'grace' ? <Badge tone="warning">Grace period</Badge> : <Badge tone="danger">Read-only</Badge>
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon?: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-sa-border -mx-1 px-1 mb-6">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx(
            'inline-flex items-center gap-1.5 px-3 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors cursor-pointer',
            value === t.id ? 'border-sa-primary text-sa-primary font-semibold' : 'border-transparent text-sa-muted hover:text-sa-text',
          )}>
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  )
}

// ── Dialog + confirm ──────────────────────────────────────────────────────────
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg'
}) {
  useEscapeKey(onClose, open)
  if (!open) return null
  const w = size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        className={cx('w-full bg-sa-surface text-sa-text border border-sa-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]', w)}>
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <div className="text-sm text-sa-muted mt-1">{description}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-md text-sa-muted hover:text-sa-text hover:bg-sa-subtle cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        {children && <div className="px-5 pb-4 overflow-y-auto">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2 px-5 py-4 border-t border-sa-border">{footer}</div>}
      </div>
    </div>
  )
}

type ConfirmOpts = {
  title: string
  body?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** Ask for a free-text reason (required when set). */
  reasonLabel?: string
  /** User must type this exact text to enable the confirm button. */
  typeToConfirm?: string
}

/** Promise-based confirm dialog: `const ok = await confirm({...})`; with reasonLabel it resolves to the reason string. */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null)
  const [text, setText] = useState('')
  const resolver = useRef<(v: string | boolean | null) => void>(() => {})

  const confirm = useCallback((o: ConfirmOpts) => new Promise<string | boolean | null>(resolve => {
    resolver.current = resolve; setText(''); setOpts(o)
  }), [])

  const close = (v: string | boolean | null) => { resolver.current(v); setOpts(null) }
  const canConfirm = !opts ? false
    : opts.typeToConfirm ? text.trim() === opts.typeToConfirm
    : opts.reasonLabel ? text.trim().length > 0 : true

  const dialog = (
    <Dialog open={!!opts} onClose={() => close(opts?.reasonLabel ? null : false)} title={opts?.title ?? ''} description={opts?.body} size="sm"
      footer={<>
        <Button onClick={() => close(opts?.reasonLabel ? null : false)}>Cancel</Button>
        <Button variant={opts?.danger ? 'danger' : 'primary'} disabled={!canConfirm}
          onClick={() => close(opts?.reasonLabel ? text.trim() : true)}>
          {opts?.confirmLabel ?? 'Confirm'}
        </Button>
      </>}>
      {opts?.reasonLabel && (
        <Field label={opts.reasonLabel}>{id => <Textarea id={id} rows={3} value={text} onChange={e => setText(e.target.value)} autoFocus />}</Field>
      )}
      {opts?.typeToConfirm && (
        <Field label={`Type "${opts.typeToConfirm}" to confirm`}>{id => <Input id={id} value={text} onChange={e => setText(e.target.value)} autoFocus />}</Field>
      )}
    </Dialog>
  )
  return { confirm, dialog }
}

// ── Formatting ────────────────────────────────────────────────────────────────
export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
export function daysUntil(iso?: string | null) {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
}
