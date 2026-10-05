// services/finance/src/audit.js — "old → new" change notes for the fm_events
// audit trail, so every edit to a finance record says exactly what changed.

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

const FORMATS = {
  money: v => (v == null || v === '' ? '—' : inr(v)),
  text:  v => (v == null || v === '' ? '—' : String(v)),
}

/**
 * Compare `before` and `after` on the listed fields.
 * spec: [key, label, 'money' | 'text' (default)][]
 * Returns { changes: string[], note: string } — note is "" when nothing changed.
 */
export function diffNote(before, after, spec) {
  const changes = []
  for (const [key, label, kind = 'text'] of spec) {
    if (!(key in after)) continue
    const fmt = FORMATS[kind]
    const a = before[key] ?? null, b = after[key] ?? null
    const same = kind === 'money'
      ? (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005)
      : String(a ?? '') === String(b ?? '')
    if (!same) changes.push(`${label}: ${fmt(a)} → ${fmt(b)}`)
  }
  const note = changes.join('; ')
  return { changes, note: note.length > 1900 ? note.slice(0, 1897) + '…' : note }
}
