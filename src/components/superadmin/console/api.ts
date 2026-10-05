// Thin JSON wrapper for /api/superadmin/* calls. apiFetch already attaches
// (and refreshes) the Firebase token; this parses JSON and throws the
// server's `error` message so callers can toast it.

import { apiFetch } from '../../../utils/apiFetch'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message); this.status = status; this.code = code
  }
}

export async function saApi<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await apiFetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const d = data as { error?: string; code?: string }
    throw new ApiError(d.error || `Request failed (${r.status})`, r.status, d.code)
  }
  return data as T
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')
