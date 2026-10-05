// Label / big serif number / small note card used across the dashboard.

import { FF } from '../../theme/colors'

interface Props {
  label: string
  value: string | number
  note?: string
  noteColor?: string
  valueSize?: 26 | 28 | 30
}

// Mobile is always a compact 20px so 2-up tiles on a phone never overflow; `valueSize` sets sm+.
const SM_SIZE_CLASS: Record<number, string> = { 26: 'sm:text-2xl', 28: 'sm:text-[28px]', 30: 'sm:text-3xl' }

export function KpiTile({ label, value, note, noteColor = FF.textFaint, valueSize = 26 }: Props) {
  return (
    <div className="p-3 sm:p-5" style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12 }}>
      <div className="text-[10px] sm:text-[11.5px]" style={{ letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textMuted }}>{label}</div>
      <div
        className={`mt-1.5 sm:mt-2 text-xl ${SM_SIZE_CLASS[valueSize]} truncate`}
        style={{ fontFamily: "'Newsreader',serif", fontWeight: 600, color: FF.tealDark }}
      >
        {value}
      </div>
      {note && <div className="text-[11px] sm:text-xs mt-1 sm:mt-1.5" style={{ color: noteColor, fontWeight: 500 }}>{note}</div>}
    </div>
  )
}
