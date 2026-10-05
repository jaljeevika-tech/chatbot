// Individual Beneficiary roster (org-wide, read-only), written by the public
// services/individual-beneficiary/ registration form; admins can mint/rotate its link.

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
  name: string
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  gender: string | null
  category: string | null
  occupation: string | null
  current_income_inr: number | null
  production_type: string | null // legacy single-select — null for beneficiaries registered after 067
  current_production_ton: number | null // legacy — see production_type
  production_systems: ProductionSystemEntry[]
  member_of_collective: boolean | null
  created_at: string
}
interface Kpis {
  total: number; aquaculture: number; agriculture: number; livestock: number; horticulture: number
  collectiveMembers: number; avgIncome: number; totalProduction: number
}
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  states: string[]
  districts: string[]
  blocks: string[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, aquaculture: 0, agriculture: 0, livestock: 0, horticulture: 0, collectiveMembers: 0, avgIncome: 0, totalProduction: 0 },
  states: [], districts: [], blocks: [],
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

// production_systems as one compact string (Livestock is a headcount, others in Quintal),
// falling back to the legacy production_type pair for pre-067 registrations.
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

export function IndividualBeneficiaryPage() {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Data>(EMPTY)
  const [state, setState] = useState('')
  const [district, setDistrict] = useState('')
  const [block, setBlock] = useState('')
  const [productionSystem, setProductionSystem] = useState('')
  const [category, setCategory] = useState('')
  const [memberOfCollective, setMemberOfCollective] = useState('')
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
      if (productionSystem) params.set('production_system', productionSystem)
      if (category) params.set('category', category)
      if (memberOfCollective) params.set('member_of_collective', memberOfCollective)
      if (debouncedSearch) params.set('search', debouncedSearch)
      params.set('page', String(page))
      const r = await apiFetch(`/api/individual-beneficiaries?${params}`)
      const d = await r.json()
      if (id !== requestId.current) return
      setData({ ...EMPTY, ...d })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [state, district, block, productionSystem, category, memberOfCollective, debouncedSearch, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [state, district, block, productionSystem, category, memberOfCollective, debouncedSearch])

  const fetchLink = async () => {
    setLinkLoading(true)
    setLinkError(null)
    try {
      const r = await apiFetch('/api/individual-beneficiaries/registration-link')
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
      const r = await apiFetch('/api/individual-beneficiaries/registration-link/rotate', { method: 'POST' })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      {isAdmin && (
        <SectionCard title="Field Registration Link" titleRight={<Link2 className="w-4 h-4" style={{ color: FF.textFaint }} />}>
          <p style={{ fontSize: 13, color: FF.textMuted, marginBottom: 12 }}>
            Share this link with field staff so they can register beneficiaries directly from the village —
            no FieldFlow login needed. Each new registration gets its own IB-#### UID automatically.
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
        <select value={productionSystem} onChange={e => setProductionSystem(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Production Systems</option>
          <option value="Aquaculture">Aquaculture</option>
          <option value="Agriculture">Agriculture</option>
          <option value="Livestock">Livestock</option>
          <option value="Horticulture">Horticulture</option>
        </select>
        <select value={memberOfCollective} onChange={e => setMemberOfCollective(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">Member of Collective: All</option>
          <option value="yes">Member of Collective: Yes</option>
          <option value="no">Member of Collective: No</option>
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Categories</option>
          <option value="General">General</option>
          <option value="OBC">OBC</option>
          <option value="EBC">EBC</option>
          <option value="SC">SC</option>
          <option value="ST">ST</option>
          <option value="EWS">EWS</option>
          <option value="Minority">Minority</option>
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search UID, name, mobile or village…"
          className="col-span-2 w-full sm:w-auto sm:min-w-[200px] rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No individual beneficiaries registered yet.{isAdmin ? ' Use "Get Registration Link" above to start collecting field registrations.' : ''}
        </div>
      ) : (
        <>
          <KpiGrid cols={8}>
            <KpiTile label="Total Beneficiaries" value={data.kpis.total} />
            <KpiTile label="Aquaculture" value={data.kpis.aquaculture} note={data.kpis.total > 0 ? `${Math.round((data.kpis.aquaculture / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Agriculture" value={data.kpis.agriculture} note={data.kpis.total > 0 ? `${Math.round((data.kpis.agriculture / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Livestock" value={data.kpis.livestock} note={data.kpis.total > 0 ? `${Math.round((data.kpis.livestock / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Horticulture" value={data.kpis.horticulture} note={data.kpis.total > 0 ? `${Math.round((data.kpis.horticulture / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Collective Members" value={data.kpis.collectiveMembers} note={data.kpis.total > 0 ? `${Math.round((data.kpis.collectiveMembers / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Avg. Income" value={inr(data.kpis.avgIncome)} note="per beneficiary, where known" />
            <KpiTile label="Total Production" value={`${data.kpis.totalProduction.toLocaleString('en-IN')} qtl`} note="Aquaculture + Agriculture + Horticulture" />
          </KpiGrid>

          <SectionCard noPadding>
            {/* md+: grid table; below md the 14 columns render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 1500 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 1.2fr 110px 100px 110px 100px 110px 110px 80px 90px 110px 100px 220px 80px',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>UID</div><div>Name</div><div>Contact</div><div>State</div><div>District</div>
                  <div>Block</div><div>Panchayat</div><div>Village</div><div>Gender</div><div>Category</div>
                  <div>Occupation</div><div>Income</div><div>Production System</div><div>Collective</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '90px 1.2fr 110px 100px 110px 100px 110px 110px 80px 90px 110px 100px 220px 80px',
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.name}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.state || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.district || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.block || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.panchayat || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.village || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.gender || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.category || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.occupation || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.current_income_inr != null ? inr(r.current_income_inr) : '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{formatProductionSystems(r)}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.member_of_collective == null ? '—' : r.member_of_collective ? 'Yes' : 'No'}</div>
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
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.name}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 12.5 }}>
                    {[r.village, r.panchayat, r.block, r.district, r.state].filter(Boolean).join(', ') || '—'}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Gender: {r.gender || '—'}</div>
                    <div>Category: {r.category || '—'}</div>
                    <div>Occupation: {r.occupation || '—'}</div>
                    <div className="col-span-2">Production System: {formatProductionSystems(r)}</div>
                    <div>Income: {r.current_income_inr != null ? inr(r.current_income_inr) : '—'}</div>
                    <div>Collective: {r.member_of_collective == null ? '—' : r.member_of_collective ? 'Yes' : 'No'}</div>
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
                  Page {page + 1} of {pageCount} · {data.totalRows} beneficiaries
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
