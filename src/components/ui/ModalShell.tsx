// Shared modal wrapper (backdrop, escape, mobile sheet, scroll lock).

import { useEffect, type ReactNode } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'

type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

interface Props {
  open: boolean
  onClose: () => void
  size?: Size
  className?: string
  // Suppress click-outside close, e.g. while a nested editor is active.
  disableBackdropClose?: boolean
  // Bottom sheet on small screens by default.
  mobilePresentation?: 'sheet' | 'center'
  children: ReactNode
}

const SIZE_CLASS: Record<Size, string> = {
  sm:  'sm:max-w-md',
  md:  'sm:max-w-lg',
  lg:  'sm:max-w-2xl',
  xl:  'sm:max-w-4xl',
  '2xl':'sm:max-w-5xl',
}

export function ModalShell({
  open, onClose, size = 'lg', className = '',
  disableBackdropClose, mobilePresentation = 'sheet',
  children,
}: Props) {
  useEscapeKey(open ? onClose : (() => {}))

  // Lock body scroll while open; restored on close so stacked modals don't leave it locked.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const align = mobilePresentation === 'center'
    ? 'items-center'
    : 'items-end sm:items-center'

  return (
    <div
      className={`fixed inset-0 z-50 bg-black/50 flex ${align} justify-center`}
      onClick={disableBackdropClose ? undefined : onClose}
      role="presentation"
    >
      <div
        className={`bg-white w-full ${SIZE_CLASS[size]} sm:rounded-2xl rounded-t-2xl flex flex-col ${className}`.trim()}
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  )
}
