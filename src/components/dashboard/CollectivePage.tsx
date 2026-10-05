// Collective roster (org-wide, read-only), written by the public services/collective/
// registration form; admins can mint/rotate its link. Sibling of IndividualBeneficiaryPage.tsx.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Link2, RefreshCw, Copy, Check } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import type { ProductionSystemEntry } from '../../types/beneficiaryProfile'

interface Row {
  id: string
  uid: string
  collective_name: string
  collective_type: string | null
  lead_person_name: string | null
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  male_count: number | null
  female_count: number | null
  focus_area: string | null
  current_revenue_inr: number | null
  production_type: string | null // legacy single-select — null for collectives registered after 068
  current_production_ton: number | null // legacy — see production_type
  production_systems: ProductionSystemEntry[]
  per_capita_income_inr: number | null
  credit_access_inr: number | null
  created_at: string
}

// production_systems as one compact string (Livestock is a headcount, others in Quintal),
// falling back to the legacy production_type pair for pre-068 registrations.
function formatProductionSystems(row: Row): string {
  if (row.production_systems?.length) {
    return row.production_systems
      .map(p => `${p.type}: ${p.type === 'Livestock' ? (p.livestock_count ?? '—') : (p.production_quintal != null ? `${p.production_quintal} qtl` : '—')}`)
      .join(', ')
  }
  if (row.production_type) {
    return `${row.production_type}${row.current_production_ton != null ? ` (${row.current_production_ton} ton)` : ''}`
  }
  return '—'
}
interface TypeCount { label: string; total: number }
interface Kpis {
  total: number
  totalMale: number
  totalFemale: number
  avgRevenue: number
  totalRevenue: number
  totalProduction: number
  avgPerCapitaIncome: number
  totalCreditAccess: number
}
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  byType: TypeCount[]
  states: string[]
  districts: string[]
  blocks: string[]
  collectiveTypes: string[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, totalMale: 0, totalFemale: 0, avgRevenue: 0, totalRevenue: 0, totalProduction: 0, avgPerCapitaIncome: 0, totalCreditAccess: 0 },
  byType: [], states: [], districts: [], blocks: [], collectiveTypes: [],
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

export function CollectivePage() {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Data>(EMPTY)
  const [state, setState] = useState('')
  const [district, setDistrict] = useState('')
  const [block, setBlock] = useState('')
  const [collectiveType, setCollectiveType] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const [link, setLink] = useState<string | null>(null)
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Debounced + request counter so out-of-order responses can't overwrite newer results.
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (state) params.set('state', state)
      if (district) params.set('district', district)
      if (block) params.set('block', block)
      if (collectiveType) params.set('collective_type', collectiveType)
      if (debouncedSearch) params.set('search', debouncedSearch)
      params.set('page', String(page))
      const r = await apiFetch(`/api/collectives?${params}`)
      const d = await r.json()
      if (id !== requestId.current) return
      setData({ ...EMPTY, ...d })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [state, district, block, collectiveType, debouncedSearch, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [state, district, block, collectiveType, debouncedSearch])

  const fetchLink = async () => {
    setLinkLoading(true)
    setLinkError(null)
    try {
      const r = await apiFetch('/api/collectives/registration-link')
      const d = await r.json()
      if (!r.ok) { setLinkError(d.error || 'Could not load link'); return }
      setLink(d.url)
    } catch (e: any) {
      setLinkError(e.message || 'Network error')
    } finally {
      setLinkLoading(false)
    }
  }

  const rotateLink = async () => {
    if (!confirm('Rotate the registration link? The old link will stop working immediately — anyone still using it will need the new one.')) return
    setLinkLoading(true)
    setLinkError(null)
    try {
      const r = await apiFetch('/api/collectives/registration-link/rotate', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setLinkError(d.error || 'Could not rotate link'); return }
      setLink(d.url)
    } catch (e: any) {
      setLinkError(e.message || 'Network error')
    } finally {
      setLinkLoading(false)
    }
  }

  const copyLink = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — user can still select the text */ }
  }

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))
  const totalMembers = data.kpis.totalMale + data.kpis.totalFemale

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      {isAdmin && (
        <SectionCard title="Field Registration Link" titleRight={<Link2 className="w-4 h-4" style={{ color: FF.textFaint }} />}>
          <p style={{ fontSize: 13, color: FF.textMuted, marginBottom: 12 }}>
            Share this link with field staff so they can register collectives directly from the village —
            no FieldFlow login needed. Each new registration gets its own CB-#### UID automatically.
          </p>
          {!link ? (
            <button
              onClick={fetchLink}
              disabled={linkLoading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {linkLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              Get Registration Link
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                readOnly
                value={link}
                onFocus={e => e.currentTarget.select()}
                className="rounded-lg px-3 py-2 text-sm outline-none flex-1"
                style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, minWidth: 260, fontFamily: 'monospace', fontSize: 12.5 }}
              />
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold"
                style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
              >
                {copied ? <Check className="w-4 h-4" style={{ color: FF.green }} /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              {isAdmin && (
                <button
                  onClick={rotateLink}
                  disabled={linkLoading}
                  title="Invalidate the old link and issue a new one"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                  style={{ border: `1px solid ${FF.red}`, color: FF.red }}
                >
                  {linkLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Rotate
                </button>
              )}
            </div>
          )}
          {linkError && <div className="text-xs mt-2" style={{ color: FF.red }}>{linkError}</div>}
        </SectionCard>
      )}

      <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 sm:gap-3 sm:flex-wrap">
        <select value={collectiveType} onChange={e => setCollectiveType(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Types</option>
          {data.collectiveTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {/* Options are scoped server-side to the picked ancestor, so changing an ancestor
            must clear its descendants or a stale District would zero out the results. */}
        <select value={state} onChange={e => { setState(e.target.value); setDistrict(''); setBlock('') }} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All States</option>
          {data.states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={district} onChange={e => { setDistrict(e.target.value); setBlock('') }} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Districts</option>
          {data.districts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={block} onChange={e => setBlock(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Blocks</option>
          {data.blocks.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search UID, name, lead person, mobile or village…"
          className="col-span-2 w-full sm:w-auto sm:min-w-[220px] rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No collectives registered yet.{isAdmin ? ' Use "Get Registration Link" above to start collecting field registrations.' : ''}
        </div>
      ) : (
        <>
          <KpiGrid cols={3}>
            <KpiTile label="Total Collectives" value={data.kpis.total} />
            <KpiTile label="Total Members" value={totalMembers} note={`${data.kpis.totalMale} Male · ${data.kpis.totalFemale} Female`} />
            <KpiTile label="Avg. Revenue" value={inr(data.kpis.avgRevenue)} note="per collective, where known" />
          </KpiGrid>
          <KpiGrid cols={3}>
            <KpiTile label="Total Production" value={`${data.kpis.totalProduction.toLocaleString('en-IN')} qtl`} note="Aquaculture + Agriculture + Horticulture" />
            <KpiTile label="Avg. Per Capita Income" value={inr(data.kpis.avgPerCapitaIncome)} note="per collective, where known" />
            <KpiTile label="Total Credit Access" value={inr(data.kpis.totalCreditAccess)} />
          </KpiGrid>

          {data.byType.length > 0 && (
            <SectionCard title="Collectives by Type">
              <div className="flex flex-col gap-3">
                {(() => {
                  const maxVal = Math.max(...data.byType.map(t => t.total), 1)
                  return data.byType.map(t => (
                    <div key={t.label}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{t.label}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>{t.total}</span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div style={{ height: 8, width: `${Math.max((t.total / maxVal) * 100, 3)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </SectionCard>
          )}

          <SectionCard noPadding>
            {/* md+: grid table; below md the 17 columns render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 2100 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 1.1fr 110px 1fr 100px 100px 110px 100px 110px 110px 80px 70px 70px 1fr 220px 90px 110px',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>UID</div><div>Name</div><div>Type</div><div>Lead Person</div><div>Contact</div>
                  <div>State</div><div>District</div><div>Block</div><div>Panchayat</div><div>Village</div>
                  <div>Male</div><div>Female</div><div>Focus Area</div><div>Revenue</div>
                  <div>Production System</div><div>Per Capita</div><div>Credit Access</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '90px 1.1fr 110px 1fr 100px 100px 110px 100px 110px 110px 80px 70px 70px 1fr 220px 90px 110px',
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.collective_name}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.collective_type || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.lead_person_name || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.state || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.district || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.block || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.panchayat || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.village || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.male_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.female_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.focus_area || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.current_revenue_inr != null ? inr(r.current_revenue_inr) : '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{formatProductionSystems(r)}</div>
                    <div style={{ color: FF.textMuted }}>{r.per_capita_income_inr != null ? inr(r.per_capita_income_inr) : '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.credit_access_inr != null ? inr(r.credit_access_inr) : '—'}</div>
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
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.collective_name}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 12.5 }}>
                    {[r.village, r.panchayat, r.block, r.district, r.state].filter(Boolean).join(', ') || '—'}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Type: {r.collective_type || '—'}</div>
                    <div>Lead: {r.lead_person_name || '—'}</div>
                    <div>Male: {r.male_count ?? '—'}</div>
                    <div>Female: {r.female_count ?? '—'}</div>
                    <div>Focus Area: {r.focus_area || '—'}</div>
                    <div>Revenue: {r.current_revenue_inr != null ? inr(r.current_revenue_inr) : '—'}</div>
                    <div className="col-span-2">Production System: {formatProductionSystems(r)}</div>
                    <div>Per Capita: {r.per_capita_income_inr != null ? inr(r.per_capita_income_inr) : '—'}</div>
                    <div>Credit Access: {r.credit_access_inr != null ? inr(r.credit_access_inr) : '—'}</div>
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
                  Page {page + 1} of {pageCount} · {data.totalRows} collectives
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
