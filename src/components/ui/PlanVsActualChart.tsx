// Cumulative plan-vs-actual bar chart (Org Dashboard growth, Project Dashboard progress).

import { FF } from '../../theme/colors'

export interface ChartMonth { month: string; planPct: number; actualPct: number }

interface Props {
  data: ChartMonth[]
  height?: number
}

export function PlanVsActualChart({ data, height = 150 }: Props) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, height: height + 20, paddingTop: 10 }}>
        {data.map(m => (
          <div key={m.month} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height }}>
              <div style={{ width: 12, height: Math.max(2, (m.planPct / 100) * height), background: FF.borderSoft, borderRadius: '3px 3px 0 0' }} />
              <div style={{ width: 12, height: Math.max(2, (m.actualPct / 100) * height), background: FF.tealDark, borderRadius: '3px 3px 0 0' }} />
            </div>
            <div style={{ fontSize: 11, color: FF.textMuted }}>{m.month}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 14, fontSize: 11.5, color: FF.textMuted }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: FF.borderSoft }} />Plan</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: FF.tealDark }} />Actual</div>
      </div>
    </div>
  )
}
