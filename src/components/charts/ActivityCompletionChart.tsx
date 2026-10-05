// Vertical bars for the 6 activity buckets (plain div/CSS).

interface ActivityRow {
  name: string
  completion_pct: number
}

interface Props {
  activities: ActivityRow[]
  height?: number
}

function colorFor(pct: number) {
  if (pct >= 85) return '#3F7D5C'
  if (pct >= 70) return '#B8862E'
  return '#B0473C'
}

export function ActivityCompletionChart({ activities, height = 200 }: Props) {
  if (!activities.length) return <div className="text-xs text-gray-400 text-center py-8">No activity data</div>
  return (
    <div className="w-full">
      <div className="flex items-end gap-2 px-2" style={{ height }}>
        {activities.map(a => {
          const pct = Math.max(0, Math.min(100, a.completion_pct))
          const barHeight = Math.max(8, (pct / 100) * (height - 40))
          return (
            <div key={a.name} className="flex-1 flex flex-col items-center gap-1">
              <div className="text-[10px] font-bold tabular-nums" style={{ color: colorFor(pct) }}>
                {pct}%
              </div>
              <div className="w-full flex justify-center" style={{ height: barHeight }}>
                <div
                  className="w-full rounded-t"
                  style={{ background: colorFor(pct), transition: 'height 300ms' }}
                />
              </div>
              <div className="text-[10px] text-gray-600 text-center mt-1 leading-tight max-w-[80px] line-clamp-2">
                {a.name}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
