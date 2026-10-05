// HR outbox: every attendance/leave write is queued and sent to POST /api/hr/sync, online
// or not. Per action: ok → removed; rejected → removed and shown as a sync problem;
// retryable → stays queued. Client UUIDs make resends idempotent.

import { apiFetch } from '../apiFetch'
import { kvGet, kvSet, outboxDelete, outboxList, outboxPut } from './hrStore'
import type { HrActionKind, HrActionPayloads, OutboxItem, SyncProblem } from '../../types/hr'

export interface SyncState {
  userKey: string | null
  pending: OutboxItem[]
  problems: SyncProblem[]
  syncing: boolean
  online: boolean
  lastSyncAt: string | null
  lastError: string | null
}

interface SyncResult { clientId: string; ok: boolean; error?: string; retryable?: boolean }

const BATCH = 50
const problemsKey = (userKey: string) => `problems:${userKey}`

let state: SyncState = {
  userKey: null, pending: [], problems: [], syncing: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine, lastSyncAt: null, lastError: null,
}
const listeners = new Set<() => void>()
const appliedListeners = new Set<() => void>()
let listening = false
let seqCounter = 0

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}

export const getSyncState = () => state

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Called after the server confirms at least one action — callers refetch. */
export function onApplied(fn: () => void): () => void {
  appliedListeners.add(fn)
  return () => { appliedListeners.delete(fn) }
}

export async function startSync(userKey: string): Promise<void> {
  if (state.userKey !== userKey) {
    set({ userKey, pending: [], problems: [], lastError: null })
    const [pending, problems] = await Promise.all([
      outboxList(userKey).catch(() => [] as OutboxItem[]),
      kvGet<SyncProblem[]>(problemsKey(userKey)),
    ])
    if (state.userKey !== userKey) return
    set({ pending, problems: problems ?? [] })
  }
  if (!listening) {
    listening = true
    window.addEventListener('online', () => { set({ online: true }); void flush() })
    window.addEventListener('offline', () => set({ online: false }))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void flush()
    })
    // navigator.onLine is true on Wi-Fi with no internet, so keep retrying.
    window.setInterval(() => { if (state.pending.length) void flush() }, 60_000)
  }
  void flush()
}

export async function enqueue<K extends HrActionKind>(kind: K, payload: HrActionPayloads[K]): Promise<OutboxItem<K>> {
  const userKey = state.userKey
  if (!userKey) throw new Error('HR sync has not started yet.')
  const item: OutboxItem<K> = {
    clientId:  crypto.randomUUID(),
    userKey,
    kind,
    payload,
    createdAt: new Date().toISOString(),
    offline:   !navigator.onLine,
    seq:       Date.now() * 1000 + (seqCounter++ % 1000),
    attempts:  0,
  }
  await outboxPut(item)   // throws if the device can't store it — caller tells the user
  set({ pending: [...state.pending, item] })
  void flush()
  return item
}

let flushing: Promise<void> | null = null
export function flush(): Promise<void> {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null })
  return flushing
}

async function doFlush(): Promise<void> {
  const userKey = state.userKey
  if (!userKey || !state.pending.length) return
  set({ syncing: true })
  let applied = false
  try {
    while (state.userKey === userKey && state.pending.length) {
      const batch = state.pending.slice(0, BATCH)
      let res: Response
      try {
        res = await apiFetch('/api/hr/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sentAt: new Date().toISOString(),
            actions: batch.map(({ clientId, kind, payload, createdAt, offline }) =>
              ({ clientId, kind, payload, createdAt, offline })),
          }),
        })
      } catch {
        set({ online: false })   // no connection — everything stays queued
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        set({ lastError: body?.error || `Sync failed (HTTP ${res.status}) — will retry.` })
        return
      }
      const { results } = await res.json() as { results: SyncResult[] }
      const done = new Set<string>()
      const retry = new Map<string, string>()
      const problems: SyncProblem[] = []
      for (const r of results) {
        const item = batch.find(i => i.clientId === r.clientId)
        if (!item) continue
        if (r.ok) {
          done.add(item.clientId)
        } else if (r.retryable) {
          retry.set(item.clientId, r.error || 'Will retry')
        } else {
          done.add(item.clientId)
          problems.push({
            clientId: item.clientId, kind: item.kind, payload: item.payload,
            createdAt: item.createdAt, error: r.error || 'Rejected by the server',
          })
        }
      }
      if (done.size) await outboxDelete([...done])
      if (state.userKey !== userKey) {
        // Signed-in user changed mid-flush: file this batch's problems under the
        // user who queued them and leave the new user's state untouched.
        if (problems.length) {
          const prev = await kvGet<SyncProblem[]>(problemsKey(userKey))
          await kvSet(problemsKey(userKey), [...(prev ?? []), ...problems]).catch(() => {})
        }
        return
      }
      if (results.some(r => r.ok)) applied = true
      const allProblems = problems.length ? [...state.problems, ...problems] : state.problems
      set({
        pending: state.pending
          .filter(i => !done.has(i.clientId))
          .map(i => retry.has(i.clientId) ? { ...i, attempts: i.attempts + 1, lastError: retry.get(i.clientId) } : i),
        problems: allProblems,
        online: true,
        lastSyncAt: new Date().toISOString(),
        lastError: retry.size ? 'Some changes could not be saved yet — retrying in a minute.' : null,
      })
      if (problems.length) await kvSet(problemsKey(userKey), allProblems).catch(() => {})
      if (retry.size || !done.size) return   // server trouble: wait for the next tick
    }
  } finally {
    set({ syncing: false })
    if (applied) appliedListeners.forEach(l => l())
  }
}

export async function dismissProblem(clientId: string): Promise<void> {
  const problems = state.problems.filter(p => p.clientId !== clientId)
  set({ problems })
  if (state.userKey) await kvSet(problemsKey(state.userKey), problems).catch(() => {})
}

/** Withdraw a queued action before it reaches the server (e.g. cancel an unsynced leave request). */
export async function discardPending(clientId: string): Promise<boolean> {
  if (state.syncing) return false
  await outboxDelete([clientId])
  set({ pending: state.pending.filter(i => i.clientId !== clientId) })
  return true
}
