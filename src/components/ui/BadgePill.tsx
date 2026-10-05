// Status chip with a fixed tone set.

import type { ReactNode } from 'react'

type Tone = 'green' | 'amber' | 'red' | 'purple' | 'blue' | 'neutral'
type Size = 'xs' | 'sm'

interface Props {
  tone?: Tone
  size?: Size
  icon?: ReactNode
  className?: string
  title?: string
  children: ReactNode
}

const TONE_CLASS: Record<Tone, string> = {
  green:   'bg-green-50 text-green-700',
  amber:   'bg-amber-50 text-amber-700',
  red:     'bg-red-50 text-red-700',
  purple:  'bg-purple-50 text-purple-700',
  blue:    'bg-blue-50 text-blue-700',
  neutral: 'bg-gray-100 text-gray-700',
}

const SIZE_CLASS: Record<Size, string> = {
  xs: 'text-[10px] px-1.5 py-0.5',
  sm: 'text-xs px-2 py-0.5',
}

export function BadgePill({ tone = 'neutral', size = 'xs', icon, children, className = '', title }: Props) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full font-medium ${TONE_CLASS[tone]} ${SIZE_CLASS[size]} ${className}`.trim()}
    >
      {icon}
      {children}
    </span>
  )
}
