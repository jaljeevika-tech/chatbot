// Shared dashboard block for the MIS sub-tabs: a KPI strip plus one horizontal bar
// chart of the tab's breakdown. Data comes from the tab's own list response (KPIs and
// breakdowns are computed over the whole filtered set, not the current page).

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { FF } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'

export interface MisKpi {
  label: string
  value: string | number
}

export interface MisBreakdownItem {
  label: string
  value: number
  // Secondary figure shown in the tooltip (e.g. attendees or amount next to a count).
  sub?: string
}

interface Props {
  kpis: MisKpi[]
  breakdownTitle: string
  valueLabel: string
  breakdown: MisBreakdownItem[]
  // Set for money breakdowns (e.g. ₹ amounts); counts show as plain numbers.
  formatValue?: (n: number) => string
}

const ROW_HEIGHT = 34
const MIN_HEIGHT = 160

export function MisTabDashboard({ kpis, breakdownTitle, valueLabel, breakdown, formatValue = n => String(n) }: Props) {
  const chartHeight = Math.max(MIN_HEIGHT, breakdown.length * ROW_HEIGHT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <KpiGrid cols={kpis.length >= 6 ? 6 : 5}>
        {kpis.map(k => <KpiTile key={k.label} label={k.label} value={k.value} />)}
      </KpiGrid>

      {breakdown.length > 0 && (
        <SectionCard title={breakdownTitle}>
          <div style={{ width: '100%', height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdown} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 0 }} barCategoryGap="28%">
                <CartesianGrid horizontal={false} stroke={FF.borderSoft} />
                <XAxis type="number" allowDecimals={false} tickFormatter={formatValue} tick={{ fontSize: 11, fill: FF.textFaint }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={150}
                  interval={0}
                  tick={{ fontSize: 12, fill: FF.textMuted }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: FF.borderFaint }}
                  formatter={(value, _name, item) => {
                    const n = Number(value)
                    const sub = (item?.payload as MisBreakdownItem | undefined)?.sub
                    return [sub ? `${formatValue(n)} · ${sub}` : formatValue(n), valueLabel]
                  }}
                />
                <Bar dataKey="value" fill={FF.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
