// Status pill from raw bg/fg hex plus a 'chip' (6px) or 'pill' (20px) shape, for the
// FF status colours; BadgePill only maps a fixed tone enum to Tailwind classes.

interface Props {
  bg: string
  fg: string
  label: string
  shape?: 'chip' | 'pill'
  size?: 'xs' | 'sm'
}

const SIZE: Record<'xs' | 'sm', { fontSize: number; padding: string }> = {
  xs: { fontSize: 10.5, padding: '3px 8px' },
  sm: { fontSize: 11,   padding: '4px 10px' },
}

export function StatusBadge({ bg, fg, label, shape = 'chip', size = 'xs' }: Props) {
  const s = SIZE[size]
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: s.fontSize,
        fontWeight: 600,
        padding: s.padding,
        borderRadius: shape === 'pill' ? 20 : 6,
        background: bg,
        color: fg,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}
