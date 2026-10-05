// Thin rounded track + fill bar; `pct` is 0-100.

import { FF } from '../../theme/colors'

interface Props {
  pct: number
  color?: string
  trackColor?: string
  height?: 4 | 6 | 8 | 10
}

export function ProgressBar({ pct, color = FF.tealDark, trackColor = FF.borderSoft, height = 6 }: Props) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ height, background: trackColor, borderRadius: height / 2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${clamped}%`, background: color, borderRadius: height / 2 }} />
    </div>
  )
}
