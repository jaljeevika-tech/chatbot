// IndexedDB for HR offline mode: `kv` holds the last bootstrap payload and sync problems
// per user (`<kind>:<orgId>:<uid>`, so shared laptops don't leak data); `outbox` holds
// unconfirmed actions. Not best-effort: write failures throw so the caller can tell the user.

import type { OutboxItem } from '../../types/hr'

const DB_NAME = 'ff_hr'
const KV = 'kv'
const OUTBOX = 'outbox'

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(KV)
        req.result.createObjectStore(OUTBOX, { keyPath: 'clientId' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { dbPromise = null; reject(req.error) }
    })
  }
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

export function kvGet<T>(key: string): Promise<T | null> {
  return run<T | undefined>(KV, 'readonly', s => s.get(key)).then(v => v ?? null).catch(() => null)
}

export function kvSet(key: string, value: unknown): Promise<void> {
  return run(KV, 'readwrite', s => { s.put(value, key) })
}

/** Logout: drop every cached HR payload. The outbox is kept — it is the
 *  user's own unsynced work and goes up the next time they sign in. */
export function kvClearAll(): Promise<void> {
  return run<void>(KV, 'readwrite', s => { s.clear() }).catch(() => {})
}

export async function outboxList(userKey: string): Promise<OutboxItem[]> {
  const all = await run<OutboxItem[]>(OUTBOX, 'readonly', s => s.getAll())
  return all.filter(i => i.userKey === userKey).sort((a, b) => a.seq - b.seq)
}

export function outboxPut(item: OutboxItem): Promise<void> {
  return run(OUTBOX, 'readwrite', s => { s.put(item) })
}

export function outboxDelete(clientIds: string[]): Promise<void> {
  return run(OUTBOX, 'readwrite', s => { for (const id of clientIds) s.delete(id) })
}
