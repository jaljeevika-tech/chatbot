// Pure-SVG horizontal bars for the 4 weighted categories.

interface Category {
  label: string
  score: number       // 0–100
  weight: number      // 0..1
  color?: string
}

interface Props {
  categories: Category[]
  height?: number
}

const DEFAULT_COLORS = ['#341272', '#7C3AED', '#16a34a', '#D97706']

export function CategoryScoreChart({ categories, height = 180 }: Props) {
  const max = 100
  const rowHeight = Math.max(28, Math.floor(height / Math.max(categories.length, 1)))
  return (
    <div className="w-full">
      <div className="space-y-2">
        {categories.map((c, i) => {
          const pct = Math.max(0, Math.min(100, c.score))
          const color = c.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
          return (
            <div key={c.label} className="flex items-center gap-2" style={{ height: rowHeight }}>
              <div className="w-32 text-xs text-gray-700 truncate">{c.label}</div>
              <div className="flex-1 relative h-5 rounded bg-gray-100 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded"
                  style={{ width: `${(pct / max) * 100}%`, background: color, transition: 'width 300ms' }}
                />
              </div>
              <div className="w-16 text-right text-sm font-semibold tabular-nums" style={{ color }}>
                {pct}
              </div>
              <div className="w-12 text-right text-[10px] text-gray-400 tabular-nums">
                {Math.round(c.weight * 100)}%
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
