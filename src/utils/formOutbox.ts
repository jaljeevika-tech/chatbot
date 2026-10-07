// Offline queue for form submissions (IndexedDB 'ff_forms'). Same model as the HR outbox:
// every submit is queued and sent; ok/duplicate → removed; network or 5xx → retried;
// 4xx → kept as 'rejected' with the server's message so the answers are never lost.
// `kv` caches the published form list for offline filling.

import { apiFetch } from './apiFetch'
import type { Answers, FormSchema } from '../../lib/odkForm'

export interface PublishedForm { form_key: string; kind: 'custom' | 'entity'; title: string; version: number; schema: FormSchema }
/** What the server returned for a sent submission (built-in forms report the new record's UID). */
export interface SentResult { uid?: string; label?: string }
export interface QueuedSubmission {
  instanceId: string; userKey: string; formKey: string; formTitle: string; version: number
  data: Answers; createdAt: string; status: 'pending' | 'rejected'; error?: string
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('ff_forms', 1)
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('outbox', { keyPath: 'instanceId' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { dbPromise = null; reject(req.error) }
  })
  return dbPromise
}
function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve((req ? req.result : undefined) as T)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
  }))
}

export const cacheForms = (userKey: string, forms: PublishedForm[]) => run<void>('kv', 'readwrite', s => { s.put(forms, `forms:${userKey}`) }).catch(() => {})
export const cachedForms = (userKey: string) =>
  run<PublishedForm[] | undefined>('kv', 'readonly', s => s.get(`forms:${userKey}`)).then(v => v ?? null).catch(() => null)

export async function listQueued(userKey: string): Promise<QueuedSubmission[]> {
  const all = await run<QueuedSubmission[]>('outbox', 'readonly', s => s.getAll()).catch(() => [] as QueuedSubmission[])
  return all.filter(q => q.userKey === userKey).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
/** Throws if the device can't store it — the caller must tell the user, the answers aren't saved. */
export const enqueue = (item: QueuedSubmission) => run<void>('outbox', 'readwrite', s => { s.put(item) })
export const discard = (instanceId: string) => run<void>('outbox', 'readwrite', s => { s.delete(instanceId) })

let flushing: Promise<Record<string, SentResult>> | null = null
/** Sends every pending submission once; resolves with what was accepted, by instanceId.
 *  A call made during a pass waits for it, then runs its own (so a just-queued item is included). */
export function flush(userKey: string): Promise<Record<string, SentResult>> {
  if (flushing) return flushing.then(() => flush(userKey))
  flushing = (async () => {
    const sent: Record<string, SentResult> = {}
    for (const q of await listQueued(userKey)) {
      if (q.status !== 'pending') continue
      let res: Response
      try {
        res = await apiFetch(`/api/forms/${encodeURIComponent(q.formKey)}/submissions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance_id: q.instanceId, version: q.version, data: q.data }),
        })
      } catch { return sent } // offline: stop, try again later
      if (res.ok) { sent[q.instanceId] = await res.json().catch(() => ({})); await discard(q.instanceId); continue }
      if (res.status >= 500 || res.status === 401 || res.status === 429) return sent
      const body = await res.json().catch(() => ({})) as { error?: string; errors?: Record<string, string> }
      const detail = body.errors ? Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : ''
      await enqueue({ ...q, status: 'rejected', error: [body.error || `Rejected (${res.status})`, detail].filter(Boolean).join(' ') })
    }
    return sent
  })().finally(() => { flushing = null })
  return flushing
}
