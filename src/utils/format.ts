// Date / number / currency formatters (en-IN).

type DateInput = string | number | Date

function _toDate(v: DateInput): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d : null
}

/** "18 Jun 2026" by default; `time` appends " · 3:45pm", `year: false` drops the year,
 * `long` uses the full month name. */
export function formatDate(
  v: DateInput,
  opts: { time?: boolean; year?: boolean; long?: boolean } = {},
): string {
  const d = _toDate(v)
  if (!d) return ''
  const year = opts.year !== false
  const datePart = d.toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: opts.long ? 'long' : 'short',
    ...(year ? { year: 'numeric' as const } : {}),
  })
  if (!opts.time) return datePart
  const timePart = d.toLocaleTimeString('en-IN', {
    hour:   'numeric',
    minute: '2-digit',
    hour12: true,
  }).toLowerCase().replace(/\s/g, '')
  return `${datePart} · ${timePart}`
}

/** en-IN thousands grouping; `compact` renders lakh / crore. */
export function formatNumber(
  n: number | string | null | undefined,
  opts: { compact?: boolean; decimals?: number } = {},
): string {
  const num = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(num)) return '—'
  if (opts.compact) {
    const abs = Math.abs(num)
    if (abs >= 1_00_00_000) return `${(num / 1_00_00_000).toFixed(opts.decimals ?? 1)} cr`
    if (abs >=    1_00_000) return `${(num /    1_00_000).toFixed(opts.decimals ?? 1)} lakh`
    if (abs >=      1_000) return `${(num /      1_000).toFixed(opts.decimals ?? 1)}K`
  }
  if (typeof opts.decimals === 'number') {
    return num.toLocaleString('en-IN', { minimumFractionDigits: opts.decimals, maximumFractionDigits: opts.decimals })
  }
  return num.toLocaleString('en-IN')
}

/** ₹1,234 — India-style currency with no decimals by default. */
export function formatINR(amount: number | string | null | undefined, decimals = 0): string {
  const num = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(num)) return '—'
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** "2 days ago", "3 hours ago", "just now". */
export function formatRelative(v: DateInput, now: Date = new Date()): string {
  const d = _toDate(v)
  if (!d) return ''
  const sec = Math.round((now.getTime() - d.getTime()) / 1000)
  if (sec < 0)      return formatDate(d)             // future — fall back to absolute
  if (sec < 45)     return 'just now'
  if (sec < 90)     return '1 minute ago'
  const min = Math.round(sec / 60)
  if (min < 45)     return `${min} minutes ago`
  if (min < 90)     return '1 hour ago'
  const hr  = Math.round(min / 60)
  if (hr  < 24)     return `${hr} hours ago`
  if (hr  < 36)     return 'yesterday'
  const day = Math.round(hr / 24)
  if (day < 7)      return `${day} days ago`
  if (day < 30)     return `${Math.round(day / 7)} weeks ago`
  if (day < 365)    return `${Math.round(day / 30)} months ago`
  return formatDate(d)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD in the user's local timezone (toISOString() is UTC and lands on the previous day before 05:30 IST). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * Excel date cell → YYYY-MM-DD. Read the workbook WITHOUT cellDates so date
 * cells arrive as raw serials: SheetJS's Date conversion lands a hair before
 * local midnight, which shifts every date back a day in IST. parse_date_code
 * is pure integer arithmetic, no timezone involved.
 */
export function excelCellToIsoDate(XLSX: any, v: any): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && XLSX.SSF?.parse_date_code) {
    const p = XLSX.SSF.parse_date_code(v)
    if (p) return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? null : localIsoDate(v)
  const s = String(v).trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : localIsoDate(d)
}
