// HR tab data: shows the copy saved on this device straight away, then
// replaces it with a fresh /api/hr/bootstrap when there's a connection, and
// saves that for next time. Writes go through the outbox (utils/hr/hrSync).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuthContext } from '../../context/AuthContext'
import { apiFetch } from '../../utils/apiFetch'
import { kvGet, kvSet } from '../../utils/hr/hrStore'
import { enqueue, getSyncState, onApplied, startSync, subscribeSync } from '../../utils/hr/hrSync'
import type { HrActionKind, HrActionPayloads, HrBootstrap } from '../../types/hr'

/** GET an online-only HR endpoint, throwing the server's message on failure. */
export async function hrGet<T>(url: string): Promise<T> {
  const res = await apiFetch(url)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error || `Request failed (HTTP ${res.status})`)
  return body as T
}

export async function hrSend<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const res = await apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const out = await res.json().catch(() => null)
  if (!res.ok) throw new Error(out?.error || `Request failed (HTTP ${res.status})`)
  return out as T
}

/** Run after every online start for users who can see HR: caches HR data on the device
 *  even if they never open the tab, and flushes the outbox. */
export async function warmHrOffline(userKey: string): Promise<void> {
  void startSync(userKey)
  try {
    const fresh = await hrGet<HrBootstrap>('/api/hr/bootstrap')
    await kvSet(`bootstrap:${userKey}`, { ...fresh, cachedAt: new Date().toISOString() })
  } catch { /* best-effort */ }
}

/** `enabled: false` (no HR access) loads nothing — lets a host that may or
 *  may not show HR call the hook unconditionally. */
export function useHrData(enabled = true) {
  const { user } = useAuthContext()
  const userKey = enabled && user ? `${user.orgId}:${user.uid}` : null
  const [data, setData] = useState<HrBootstrap | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const freshRef = useRef(false)
  const sync = useSyncExternalStore(subscribeSync, getSyncState)

  const refresh = useCallback(async () => {
    if (!userKey) return
    try {
      const fresh = await hrGet<HrBootstrap>('/api/hr/bootstrap')
      freshRef.current = true
      setData(fresh)
      setFromCache(false)
      setError(null)
      await kvSet(`bootstrap:${userKey}`, { ...fresh, cachedAt: new Date().toISOString() }).catch(() => {})
    } catch (e) {
      // A TypeError is fetch's "no connection" — the saved copy covers that.
      setError(e instanceof TypeError ? null : (e as Error).message)
    } finally {
      setSettled(true)
    }
  }, [userKey])

  useEffect(() => {
    if (!userKey) return
    let cancelled = false
    freshRef.current = false
    kvGet<HrBootstrap>(`bootstrap:${userKey}`).then(cached => {
      if (cancelled || !cached || freshRef.current) return
      setData(cached)
      setFromCache(true)
    })
    void startSync(userKey)
    void refresh()
    const offApplied = onApplied(() => { void refresh() })
    const onOnline = () => { void refresh() }
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      offApplied()
      window.removeEventListener('online', onOnline)
    }
  }, [userKey, refresh])

  const queue = useCallback(
    <K extends HrActionKind>(kind: K, payload: HrActionPayloads[K]) => enqueue(kind, payload), [])

  return { data, loading: !data && !settled, error, fromCache, refresh, sync, queue }
}

export type HrData = ReturnType<typeof useHrData>
