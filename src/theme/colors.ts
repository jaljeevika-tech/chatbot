// Single source of truth for FieldFlow colour tokens.

export const COLORS = {
  // ── Brand ────────────────────────────────────────────────────────────────
  purple:        '#341272',   // primary brand
  purpleDark:    '#1D0752',
  purpleLight:   '#7C3AED',

  // ── Semantic ─────────────────────────────────────────────────────────────
  green:         '#16a34a',   // success / positive
  greenSoft:     '#15803D',   // dark green for emphasis on dark backgrounds
  amber:         '#D97706',   // warning
  amberSoft:     '#B45309',   // amber on dark backgrounds (deeper)
  red:           '#DC2626',   // danger
  redSoft:       '#7f1d1d',
  blue:          '#2563EB',
  blueSoft:      '#1D4ED8',

  // ── Neutrals ─────────────────────────────────────────────────────────────
  surface:       '#EDE8F9',   // brand-tinted surface
  faint:         'rgba(237,232,249,0.7)',
  muted:         '#9CA3AF',
  border:        '#E5E7EB',
  text:          '#111827',
  textMuted:     '#6B7280',
  bg:            '#F9FAFB',
  white:         '#FFFFFF',
} as const

export type ColorToken = keyof typeof COLORS

// ── Project palette ──────────────────────────────────────────────────────────
// Project-coloured chips, badges and accent bars across the dashboard.

export interface ProjectStyle {
  dot:   string  // foreground accent (used for solid dots, vertical bars)
  badge: string  // light background for chip/badge
  bar:   string  // bar charts / left accent strips
  bg:   string   // soft surface for hover/card backgrounds
}

export const PROJECT_PALETTE: Record<string, ProjectStyle> = {
  'Dasara':                { dot: '#f97316', badge: '#fff7ed', bar: '#f97316', bg: '#FFEDD5' },
  'Kosi Sahajivan':        { dot: '#3b82f6', badge: '#eff6ff', bar: '#3b82f6', bg: '#DBEAFE' },
  'UNDP ECRIC Project':    { dot: '#8b5cf6', badge: '#f5f3ff', bar: '#8b5cf6', bg: '#EDE9FE' },
  'Jal Nidhi – Herbalife': { dot: '#14b8a6', badge: '#f0fdfa', bar: '#14b8a6', bg: '#CCFBF1' },
  'Internal Program':      { dot: '#6366f1', badge: '#eef2ff', bar: '#6366f1', bg: '#E0E7FF' },
  'TATWA':                 { dot: '#0ea5e9', badge: '#f0f9ff', bar: '#0ea5e9', bg: '#BAE6FD' },
  'Arogya Anna Herbelife': { dot: '#10b981', badge: '#f0fdf4', bar: '#10b981', bg: '#D1FAE5' },
  'FPO Madhepura – NABARD':{ dot: '#f59e0b', badge: '#fffbeb', bar: '#f59e0b', bg: '#FEF3C7' },
  'Water Hyacinth – NABARD':{ dot: '#84cc16', badge: '#f7fee7', bar: '#84cc16', bg: '#ECFCCB' },
  'Jal Smaridhi-APF':      { dot: '#a855f7', badge: '#faf5ff', bar: '#a855f7', bg: '#F3E8FF' },
  'Shabri Mahamandal':     { dot: '#dc2626', badge: '#fef2f2', bar: '#dc2626', bg: '#FEE2E2' },
}

// Round-robin fallback (projectDot) for projects not in PROJECT_PALETTE.
export const FALLBACK_DOTS = ['#16a34a', '#dc2626', '#d97706', '#db2777', '#0891b2', '#65a30d']

const _fallbackMap: Record<string, string> = {}
let _fallbackIdx = 0

/** Stable colour for a project name — known palette first, then round-robin fallback. */
export function projectDot(project: string): string {
  const known = PROJECT_PALETTE[project]
  if (known) return known.dot
  if (!_fallbackMap[project]) {
    _fallbackMap[project] = FALLBACK_DOTS[_fallbackIdx++ % FALLBACK_DOTS.length]
  }
  return _fallbackMap[project]
}

/** Light-bg chip colour for a project name. */
export function projectBadge(project: string): string {
  return PROJECT_PALETTE[project]?.badge ?? '#f9fafb'
}

// ── FieldFlow visual system (teal/purple) ──────────────────────────────────
// Palette from the Field Flow design handoff; restyled components use FF, older ones COLORS.
export const FF = {
  tealDark:    '#0E3A46',
  tealText:    '#16414C',
  purple:      '#341272',
  purpleHover: '#2C0F61',
  bg:          '#F2F7F8',
  bgWarm:      '#FBF9F4',
  border:      '#D9E6E8',
  borderSoft:  '#DCEAEC',
  borderFaint: '#E4F0F1',
  textMuted:   '#5C7378',
  textFaint:   '#86A0A5',
  sidebarText:       '#E7F2F3',
  sidebarTextDim:    '#9DBFC6',
  sidebarTextDimmer: '#7CA0A8',
  green: '#3F7D5C', greenBg: '#E4EFE7',
  amber: '#B8862E', amberBg: '#F5EBD3',
  red:   '#B0473C', redBg:  '#F5E1DD',
} as const

export type FFStatus = 'green' | 'amber' | 'red'

/** Mirrors the design mockup's `statusColors()` helper — bg/fg pair for a status key. */
export function ffStatusColors(status: FFStatus): { bg: string; fg: string } {
  if (status === 'green') return { bg: FF.greenBg, fg: FF.green }
  if (status === 'amber') return { bg: FF.amberBg, fg: FF.amber }
  return { bg: FF.redBg, fg: FF.red }
}

/** Buckets a 0-100 percentage into green/amber/red using caller-supplied thresholds. */
export function statusForPct(pct: number, thresholds: { good: number; warn: number } = { good: 100, warn: 60 }): FFStatus {
  if (pct >= thresholds.good) return 'green'
  if (pct >= thresholds.warn) return 'amber'
  return 'red'
}
