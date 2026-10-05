// Shared spinner with size + tone.

import { Loader2 } from 'lucide-react'

interface Props {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  tone?: 'muted' | 'brand' | 'inherit' | 'white'
  className?: string
}

const SIZE_CLASS: Record<NonNullable<Props['size']>, string> = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
  xl: 'w-8 h-8',
}

const TONE_CLASS: Record<NonNullable<Props['tone']>, string> = {
  muted:   'text-gray-400',
  brand:   'text-purple-700',
  inherit: '',           // inherits ambient text colour
  white:   'text-white',
}

export function LoadingSpinner({ size = 'md', tone = 'muted', className = '' }: Props) {
  const sizeC = SIZE_CLASS[size]
  const toneC = TONE_CLASS[tone]
  return <Loader2 className={`${sizeC} ${toneC} animate-spin ${className}`.trim()} aria-label="Loading" />
}
