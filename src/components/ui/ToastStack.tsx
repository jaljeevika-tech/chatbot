import { CheckCircle, XCircle, Info, X } from 'lucide-react'
import { useToast } from '../../context/ToastContext'

const ICONS = {
  success: <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />,
  error:   <XCircle    className="w-4 h-4 text-red-500   shrink-0" />,
  info:    <Info       className="w-4 h-4 text-blue-500  shrink-0" />,
}

const BG = {
  success: 'bg-white border-green-200',
  error:   'bg-white border-red-200',
  info:    'bg-white border-blue-200',
}

export function ToastStack() {
  const { toasts, dismiss } = useToast()
  if (!toasts.length) return null

  return (
    <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-xl text-sm font-semibold text-gray-800 pointer-events-auto max-w-xs animate-fade-in ${BG[t.type]}`}
          style={{ animation: 'slideUp 0.2s ease' }}
        >
          {ICONS[t.type]}
          <span className="flex-1">{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="text-gray-400 hover:text-gray-600 transition shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
