import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id:      string
  message: string
  type:    ToastType
}

interface ToastContextValue {
  toasts:  Toast[]
  toast:   (message: string, type?: ToastType) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    const id = `toast-${++counter}`
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be inside ToastProvider')
  return ctx
}
