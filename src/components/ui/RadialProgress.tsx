// Single-value progress ring with the % in the centre (Portfolio Overview target achievement).

interface Props {
  pct: number
  color: string
  trackColor: string
  size?: number
  strokeWidth?: number
  label?: string
  labelColor?: string
}

export function RadialProgress({ pct, color, trackColor, size = 72, strokeWidth = 7, label, labelColor }: Props) {
  const clamped = Math.max(0, Math.min(100, pct))
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2
  const circ = 2 * Math.PI * r
  const len = (clamped / 100) * circ
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
          {clamped > 0 && (
            <circle
              cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeWidth}
              strokeDasharray={`${len} ${circ - len}`} strokeLinecap="round"
            />
          )}
        </g>
        <text x={cx} y={cy + 4} textAnchor="middle" style={{ fontFamily: "'Newsreader',serif", fontSize: size * 0.24, fontWeight: 700, fill: labelColor ?? color }}>
          {Math.round(clamped)}%
        </text>
      </svg>
      {label && <span style={{ fontSize: 10.5, fontWeight: 600, color: labelColor, textAlign: 'center' }}>{label}</span>}
    </div>
  )
}
