// Pure-SVG radar chart for the 8 KPI dimensions, each axis 0–5.

interface KpiPoint {
  area: string
  score: number   // 0–5
}

interface Props {
  kpis: KpiPoint[]
  size?: number
}

export function KpiRadarChart({ kpis, size = 280 }: Props) {
  const n = kpis.length
  if (!n) return <div className="text-xs text-gray-400 text-center py-8">No KPI data</div>
  const cx = size / 2
  const cy = size / 2
  const radius = (size / 2) - 50  // margin for labels
  const max = 5
  const angleFor = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2

  // Background grid: concentric polygons at 0.25, 0.5, 0.75, 1.0
  function polygon(scale: number) {
    return kpis.map((_, i) => {
      const a = angleFor(i)
      const r = radius * scale
      return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
    }).join(' ')
  }

  const dataPoints = kpis.map((k, i) => {
    const a = angleFor(i)
    const r = radius * (Math.max(0, Math.min(max, k.score)) / max)
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z'

  const labels = kpis.map((k, i) => {
    const a = angleFor(i)
    const r = radius + 18
    const x = cx + r * Math.cos(a)
    const y = cy + r * Math.sin(a)
    const anchor: 'middle' | 'start' | 'end' =
      Math.abs(Math.cos(a)) < 0.2 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
    return { x, y, anchor, label: k.area, score: k.score }
  })

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="block mx-auto w-full h-auto" style={{ maxWidth: size }}>
      {[0.25, 0.5, 0.75, 1].map((s, i) => (
        <polygon key={i} points={polygon(s)} fill="none" stroke="#D9E6E8" strokeWidth="1" />
      ))}
      {kpis.map((_, i) => {
        const a = angleFor(i)
        return (
          <line
            key={i}
            x1={cx} y1={cy}
            x2={cx + radius * Math.cos(a)}
            y2={cy + radius * Math.sin(a)}
            stroke="#D9E6E8"
            strokeWidth="1"
          />
        )
      })}
      <path d={dataPath} fill="#341272" fillOpacity="0.18" stroke="#341272" strokeWidth="1.5" />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="#341272" />
      ))}
      {labels.map((l, i) => (
        <g key={i}>
          <text
            x={l.x} y={l.y}
            textAnchor={l.anchor}
            dominantBaseline="middle"
            className="text-[10px] fill-gray-700"
          >
            {l.label}
          </text>
          <text
            x={l.x} y={l.y + 11}
            textAnchor={l.anchor}
            dominantBaseline="middle"
            className="text-[9px] font-semibold"
            fill="#341272"
          >
            {l.score.toFixed(1)}
          </text>
        </g>
      ))}
    </svg>
  )
}
