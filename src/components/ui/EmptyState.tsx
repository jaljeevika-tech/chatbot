// Shared "no data" placeholder; pairs with src/i18n/errorCopy.ts::emptyState().

import type { ReactNode } from 'react'

interface Props {
  icon?: ReactNode               // typically a lucide icon at w-8 h-8 or an emoji
  title: string
  body?: string
  cta?: ReactNode                // typically a <button> with the next-action label
  compact?: boolean              // tighter vertical padding for inline use
  className?: string
}

export function EmptyState({ icon, title, body, cta, compact, className = '' }: Props) {
  const pad = compact ? 'py-8' : 'py-16'
  return (
    <div className={`text-center ${pad} px-4 ${className}`.trim()}>
      {icon && (
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gray-50 flex items-center justify-center text-gray-400">
          {icon}
        </div>
      )}
      <p className="font-semibold text-gray-700 text-sm">{title}</p>
      {body && <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto leading-relaxed">{body}</p>}
      {cta && <div className="mt-4 flex items-center justify-center">{cta}</div>}
    </div>
  )
}
