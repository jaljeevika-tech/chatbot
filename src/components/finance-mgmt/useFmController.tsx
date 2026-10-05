// Finance Management state shared by FinanceManagementPage and the FieldFlow Org app:
// profile + badge counts (/me, refreshed each minute), list version counter and modals.
// Online-only: a failed /me with no connection sets `offline` and reloads on reconnect.

import { useCallback, useEffect, useState } from 'react'
import type { FmCtx } from './fmContext'
import { fmGet, type FmMe, type FmNotification } from './fmApi'
import { LedgerFormModal, LedgerDetailModal } from './LedgerRequestsPanel'
import { AdvanceFormModal, SettlementFormModal } from './FmForms'
import { AdvanceDetailModal, SettlementDetailModal } from './FmDetails'

export function useFmController(enabled = true) {
  const [me, setMe] = useState<FmMe | null>(null)
  const [meError, setMeError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [version, setVersion] = useState(0)
  const [advanceId, setAdvanceId] = useState<string | null>(null)
  const [settlementId, setSettlementId] = useState<string | null>(null)
  const [ledgerId, setLedgerId] = useState<string | null>(null)
  const [advanceForm, setAdvanceForm] = useState(false)
  const [settlementForm, setSettlementForm] = useState<{ open: boolean; advanceId?: string }>({ open: false })
  const [ledgerForm, setLedgerForm] = useState(false)

  const loadMe = useCallback(() => {
    if (!enabled) return
    fmGet<FmMe>('/me')
      .then(d => { setMe(d); setMeError(null); setOffline(false) })
      .catch(e => {
        // A TypeError is fetch's "no connection".
        if (e instanceof TypeError || !navigator.onLine) setOffline(true)
        else setMeError((e as Error).message)
      })
  }, [enabled])

  useEffect(() => { loadMe() }, [loadMe, version])

  // Keep badge counts fresh while visible, and recover when the connection returns.
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadMe() }, 60_000)
    window.addEventListener('online', loadMe)
    return () => { clearInterval(t); window.removeEventListener('online', loadMe) }
  }, [enabled, loadMe])

  const closeDetails = () => { setAdvanceId(null); setSettlementId(null); setLedgerId(null) }
  const ctx: FmCtx | null = me && {
    me, version,
    changed: () => setVersion(v => v + 1),
    openAdvance:    id => { closeDetails(); setAdvanceId(id) },
    openSettlement: id => { closeDetails(); setSettlementId(id) },
    openLedger:     id => { closeDetails(); setLedgerId(id) },
    newAdvance:     () => { closeDetails(); setAdvanceForm(true) },
    newSettlement:  advId => { closeDetails(); setSettlementForm({ open: true, advanceId: advId }) },
  }

  const newLedger = () => { closeDetails(); setLedgerForm(true) }

  /** Opens the record a notification points at (the host switches its own tab). */
  function openNotification(n: FmNotification) {
    if (!ctx || !n.entity_id) return
    if (n.entity_type === 'advance') ctx.openAdvance(n.entity_id)
    if (n.entity_type === 'settlement') ctx.openSettlement(n.entity_id)
    if (n.entity_type === 'ledger') ctx.openLedger(n.entity_id)
  }

  const modals = ctx && (
    <>
      <AdvanceFormModal open={advanceForm} onClose={() => setAdvanceForm(false)} />
      <SettlementFormModal open={settlementForm.open} advanceId={settlementForm.advanceId} onClose={() => setSettlementForm({ open: false })} />
      <LedgerFormModal open={ledgerForm} onClose={() => setLedgerForm(false)} />
      <AdvanceDetailModal id={advanceId} onClose={() => setAdvanceId(null)} />
      <SettlementDetailModal id={settlementId} onClose={() => setSettlementId(null)} />
      <LedgerDetailModal id={ledgerId} onClose={() => setLedgerId(null)} />
    </>
  )

  return { me, meError, offline, ctx, modals, reload: loadMe, newLedger, openNotification }
}

/** Everything waiting on this person across advances, settlements and ledger requests. */
export function fmActionCount(me: FmMe | null): number {
  if (!me) return 0
  const c = me.counts
  return c.adv_manager + c.adv_finance + c.adv_disburse + c.stl_manager + c.stl_finance + c.ledger_finance
}
