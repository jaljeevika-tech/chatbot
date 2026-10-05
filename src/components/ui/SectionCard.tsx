// White bordered card wrapper with an optional serif title.

import type { ReactNode } from 'react'
import { FF } from '../../theme/colors'

interface Props {
  title?: string
  titleRight?: ReactNode
  padding?: 20 | 22 | 24
  noPadding?: boolean
  children: ReactNode
}

export function SectionCard({ title, titleRight, padding = 24, noPadding, children }: Props) {
  return (
    <div style={{ background: '#FFFFFF', border: `1px solid ${FF.border}`, borderRadius: 12, overflow: 'hidden' }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${padding}px ${padding}px ${noPadding ? padding : 12}px` }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 17, fontWeight: 600, color: FF.tealDark }}>{title}</div>
          {titleRight}
        </div>
      )}
      <div style={noPadding ? undefined : { padding: title ? `0 ${padding}px ${padding}px` : padding }}>
        {children}
      </div>
    </div>
  )
}
