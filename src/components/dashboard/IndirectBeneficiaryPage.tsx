// Indirect Beneficiary: org-wide, read-only list of people auto-created by MIS uploads
// whose row had no Beneficiary UID (see db/migrations/047_indirect_beneficiaries.sql).
// Only the MIS upload handlers write here, so there's no registration link.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { FF } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { SectionCard } from '../ui/SectionCard'

interface Row {
  id: string
  uid: string
  name: string | null
  contact_no: string | null
  place: string | null
  source: string | null
  created_at: string
}
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: { total: number }
}

const EMPTY: Data = { rows: [], totalRows: 0, page: 0, pageSize: 50, kpis: { total: 0 } }

export function IndirectBeneficiaryPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Data>(EMPTY)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  // Debounced + request counter so out-of-order responses can't overwrite newer results.
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('search', debouncedSearch)
      params.set('page', String(page))
      const r = await apiFetch(`/api/indirect-beneficiaries?${params}`)
      const d = await r.json()
      if (id !== requestId.current) return
      setData({ ...EMPTY, ...d })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [debouncedSearch, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [debouncedSearch])

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div className="rounded-xl p-3 text-xs" style={{ background: FF.bg, border: `1px solid ${FF.border}`, color: FF.textMuted }}>
        People who appear in an MIS upload (e.g. Training) with no Beneficiary UID given — saved here
        automatically instead of being rejected. The mobile number itself is the identity — the same
        number always resolves to the same record, so re-uploading never creates a duplicate.
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search UID, Name or Contact No.…"
        className="rounded-lg px-3 py-2 text-sm outline-none"
        style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, minWidth: 260, maxWidth: 400 }}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No indirect beneficiaries yet — these appear automatically once an MIS upload includes a row with no Beneficiary UID.
        </div>
      ) : (
        <>
          <KpiTile label="Total Indirect Beneficiaries" value={data.kpis.total} />

          <SectionCard noPadding>
            {/* md+: grid table; below md the rows render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 800 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '110px 1.2fr 130px 1fr 110px 130px',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>UID</div><div>Name</div><div>Contact No.</div><div>Place</div><div>Source</div><div>Created</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px 1.2fr 130px 1fr 110px 130px',
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.name || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.place || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12, textTransform: 'capitalize' }}>{r.source || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {data.rows.map(r => (
                <div key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.name || '—'}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>
                      {new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Contact: {r.contact_no || '—'}</div>
                    <div>Place: {r.place || '—'}</div>
                    <div style={{ textTransform: 'capitalize' }}>Source: {r.source || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Previous
                </button>
                <span className="text-xs" style={{ color: FF.textFaint }}>
                  Page {page + 1} of {pageCount} · {data.totalRows} indirect beneficiaries
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Next
                </button>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
