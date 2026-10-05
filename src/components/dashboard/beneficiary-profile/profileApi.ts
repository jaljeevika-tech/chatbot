import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../utils/apiFetch'
import { authedDownload } from '../../../utils/authedDownload'
import type { BeneficiaryProfileResponse } from '../../../types/beneficiaryProfile'

// Shared by the roster overlay and BeneficiaryPublicProfilePage (the QR landing page).
export function useBeneficiaryProfile(uid: string) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<BeneficiaryProfileResponse | null>(null)

  // cancelledRef stops a fetch for a previous uid from clobbering the current one.
  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}`)
      const d = await r.json()
      if (cancelledRef?.current) return
      if (!r.ok) { setError(d.error || 'Could not load beneficiary profile'); return }
      setData(d)
    } catch (e: any) {
      if (!cancelledRef?.current) setError(e.message || 'Network error')
    } finally {
      if (!cancelledRef?.current) setLoading(false)
    }
  }, [uid])

  useEffect(() => {
    const cancelledRef = { current: false }
    load(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [load])

  // refetch is uncancellable; it only runs after a modal save.
  return { loading, error, data, refetch: useCallback(() => load(), [load]) }
}

// authedDownload because a plain <a href> can't carry the Bearer token.
export async function downloadBeneficiaryProfilePdf(uid: string): Promise<void> {
  await authedDownload(`/api/beneficiary-profile/${encodeURIComponent(uid)}/export.pdf`, `${uid}_profile.pdf`)
}

// Admin-only server-side. The server ignores unknown or protected columns, so
// sending the whole draft (not just changed keys) is fine.
export async function updateBeneficiaryProfile(uid: string, updates: Record<string, unknown>): Promise<BeneficiaryProfileResponse> {
  const r = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: updates }),
  })
  // A proxy/App Engine error page is HTML, so r.json() can throw before the !r.ok check.
  let d: any
  try {
    d = await r.json()
  } catch {
    throw new Error(r.ok ? 'Server returned an invalid response' : `Could not save changes (HTTP ${r.status})`)
  }
  if (!r.ok) throw new Error(d.error || 'Could not save changes')
  return d
}

/**
 * `data.profile`'s display name, whichever registry it came from. `name` is
 * checked first: an individual who belongs to a collective also has
 * `collective_name` (their group's name), which must not win.
 */
export function beneficiaryDisplayName(data: BeneficiaryProfileResponse | null, fallbackUid: string): string {
  return data ? (data.profile as any).name ?? (data.profile as any).collective_name ?? data.uid : fallbackUid
}
