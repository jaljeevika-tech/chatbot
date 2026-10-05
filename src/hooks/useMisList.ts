import { useEffect, useState, type SetStateAction } from 'react'
import { apiFetch } from '../utils/apiFetch'
import { useDebouncedValue } from './useDebouncedValue'

// Shared paged/searchable list loader for the MIS pages (Training, Income, …).
// Search is debounced, out-of-order responses are dropped, and the page resets
// to 0 in the same render a filter/search changes (no second fetch).
export function useMisList<T>(url: string, filters: Record<string, string>, empty: T) {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search)
  const key = JSON.stringify([url, filters, debouncedSearch])
  const [pageState, setPageState] = useState({ key, page: 0 })
  const page = pageState.key === key ? pageState.page : 0
  const setPage = (p: SetStateAction<number>) =>
    setPageState(prev => {
      const cur = prev.key === key ? prev.page : 0
      return { key, page: typeof p === 'function' ? p(cur) : p }
    })

  const [data, setData] = useState<T>(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams(filters)
    if (debouncedSearch) params.set('search', debouncedSearch)
    params.set('page', String(page))
    apiFetch(`${url}?${params}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `Couldn't load records (error ${r.status})`)
        return d
      })
      .then(d => { if (!cancelled) { setData({ ...empty, ...d }); setError(null) } })
      .catch((e: any) => { if (!cancelled) { setData(empty); setError(e.message || "Couldn't load records") } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers url/filters/search
  }, [key, page, reloadToken])

  return { data, loading, error, search, setSearch, page, setPage, reload: () => setReloadToken(t => t + 1) }
}
