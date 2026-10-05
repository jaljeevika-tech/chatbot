// Page-level Finance Management state: profile/badge counts, a version counter that
// reloads lists after every change, and openers for the page's detail modals.

import { createContext, useContext } from 'react'
import type { FmMe } from './fmApi'

export interface FmCtx {
  me: FmMe
  version: number
  /** Call after any successful change: reloads badge counts + every list. */
  changed: () => void
  openAdvance: (id: string) => void
  openSettlement: (id: string) => void
  openLedger: (id: string) => void
  newAdvance: () => void
  newSettlement: (advanceId?: string) => void
}

export const FmContext = createContext<FmCtx | null>(null)

export function useFm(): FmCtx {
  const ctx = useContext(FmContext)
  if (!ctx) throw new Error('useFm must be used inside FinanceManagementPage')
  return ctx
}
