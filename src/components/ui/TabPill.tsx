// Active/inactive pill tab row.

import { FF } from '../../theme/colors'

interface Tab<T extends string> {
  key: T
  label: string
}

interface Props<T extends string> {
  tabs: Tab<T>[]
  active: T
  onChange: (key: T) => void
  size?: 'sm' | 'xs'
}

export function TabPill<T extends string>({ tabs, active, onChange, size = 'sm' }: Props<T>) {
  const padding = size === 'xs' ? '8px 14px' : '9px 16px'
  const fontSize = size === 'xs' ? 12.5 : 13

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {tabs.map(t => {
        const isActive = t.key === active
        return (
          <div
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding,
              borderRadius: 8,
              fontSize,
              fontWeight: 500,
              cursor: 'pointer',
              background: isActive ? FF.tealDark : '#FFFFFF',
              color: isActive ? FF.sidebarText : FF.tealText,
              border: `1px solid ${isActive ? FF.tealDark : FF.border}`,
            }}
          >
            {t.label}
          </div>
        )
      })}
    </div>
  )
}
