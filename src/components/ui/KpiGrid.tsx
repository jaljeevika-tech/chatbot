// Responsive grid for <KpiTile>s: 2-up on phones, 3-up on small tablets, `cols` from md
// up (capped at 6; beyond that tiles wrap rather than shrink).
import type { ReactNode } from 'react'

const MD_COLS: Record<number, string> = {
  1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3',
  4: 'md:grid-cols-4', 5: 'md:grid-cols-5', 6: 'md:grid-cols-6',
}

export function KpiGrid({ cols, children }: { cols: number; children: ReactNode }) {
  const mdClass = MD_COLS[Math.min(Math.max(cols, 1), 6)]
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 ${mdClass} gap-3 sm:gap-4`}>
      {children}
    </div>
  )
}
