// Resource roster (org-wide, read-only): physical resources mapped to a beneficiary UID,
// written by the public services/resource/ form; admins can mint/rotate its link. Fields
// vary by production-system branch (see services/resource/index.js), so none are assumed present.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Link2, RefreshCw, Copy, Check } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'

interface UtilityEntry { utility: string; production_kg: number | null }
interface Row {
  id: string
  uid: string
  resource_type: string
  beneficiary_uid: string
  beneficiary_type: string
  beneficiary_name: string | null
  latitude: number | null
  longitude: number | null
  area_acre: number | null
  water_body_type: string | null
  resource_access: string | null
  wetland_structure: string | null
  raft_count: number | null
  resource_utility: UtilityEntry[]
  created_at: string
}
interface Kpis {
  total: number; freshwaterWetland: number; coastalWetland: number
  agriculturalLand: number; brackishWater: number; totalArea: number; totalRaftCount: number
}
interface UtilityBreakdown { utility: string; resourceCount: number; totalKg: number }
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  utilityBreakdown: UtilityBreakdown[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, freshwaterWetland: 0, coastalWetland: 0, agriculturalLand: 0, brackishWater: 0, totalArea: 0, totalRaftCount: 0 },
  utilityBreakdown: [],
}

const BENEFICIARY_TYPES = ['Individual Beneficiary', 'Micro-Entrepreneur', 'Collective']
const PRODUCTION_SYSTEMS = ['Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water']

function utilitySummary(entries: UtilityEntry[]): string {
  if (!entries || entries.length === 0) return '—'
  return entries.map(e => `${e.utility}${e.production_kg != null ? `: ${e.production_kg} kg` : ''}`).join(', ')
}

export function ResourcePage() {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Data>(EMPTY)
  const [resourceType, setResourceType] = useState('')
  const [beneficiaryType, setBeneficiaryType] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const [link, setLink] = useState<string | null>(null)
  const [linkLoading, setLinkLoading] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (resourceType) params.set('resource_type', resourceType)
      if (beneficiaryType) params.set('beneficiary_type', beneficiaryType)
      if (search) params.set('search', search)
      params.set('page', String(page))
      const r = await apiFetch(`/api/resources?${params}`)
      const d = await r.json()
      setData({ ...EMPTY, ...d })
    } finally {
      setLoading(false)
    }
  }, [resourceType, beneficiaryType, search, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [resourceType, beneficiaryType, search])

  const fetchLink = async () => {
    setLinkLoading(true)
    setLinkError(null)
    try {
      const r = await apiFetch('/api/resources/registration-link')
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
      const r = await apiFetch('/api/resources/registration-link/rotate', { method: 'POST' })
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
            Share this link with field staff so they can map resources to an existing beneficiary directly
            from the village — no FieldFlow login needed. Each new registration gets its own UID automatically —
            FW-#### (Freshwater Wetland), CW-#### (Coastal Wetland), AG-#### (Agricultural Land) or BW-#### (Brackish Water).
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
        <select value={resourceType} onChange={e => setResourceType(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Production Systems</option>
          {PRODUCTION_SYSTEMS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={beneficiaryType} onChange={e => setBeneficiaryType(e.target.value)} className="w-full sm:w-auto rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Beneficiary Types</option>
          {BENEFICIARY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search Resource UID, Beneficiary UID or name…"
          className="col-span-2 w-full sm:w-auto sm:min-w-[240px] rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No resources registered yet.{isAdmin ? ' Use "Get Registration Link" above to start mapping resources to beneficiaries.' : ''}
        </div>
      ) : (
        <>
          <KpiGrid cols={5}>
            <KpiTile label="Total Resources" value={data.kpis.total} />
            <KpiTile label="Freshwater Wetland" value={data.kpis.freshwaterWetland} note={data.kpis.total > 0 ? `${Math.round((data.kpis.freshwaterWetland / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Coastal Wetland" value={data.kpis.coastalWetland} note={data.kpis.total > 0 ? `${Math.round((data.kpis.coastalWetland / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Agricultural Land" value={data.kpis.agriculturalLand} note={data.kpis.total > 0 ? `${Math.round((data.kpis.agriculturalLand / data.kpis.total) * 100)}% of total` : ''} />
            <KpiTile label="Brackish Water" value={data.kpis.brackishWater} note={data.kpis.total > 0 ? `${Math.round((data.kpis.brackishWater / data.kpis.total) * 100)}% of total` : ''} />
          </KpiGrid>
          <KpiGrid cols={2}>
            <KpiTile label="Total Area" value={`${data.kpis.totalArea.toLocaleString('en-IN')} acre`} note="Freshwater Wetland, Mangroves &amp; Agricultural Land" />
            <KpiTile label="Total Rafts" value={data.kpis.totalRaftCount} note="Coastal Wetland &gt; Raft" />
          </KpiGrid>

          {data.utilityBreakdown.length > 0 && (
            <SectionCard title="Resource Utility" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Total production (KG) across all branches</span>}>
              <div className="flex flex-col gap-3">
                {(() => {
                  const maxVal = Math.max(...data.utilityBreakdown.map(u => u.totalKg), 1)
                  return data.utilityBreakdown.map(u => (
                    <div key={u.utility}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{u.utility}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>{u.totalKg.toLocaleString('en-IN')} kg · {u.resourceCount} resource{u.resourceCount === 1 ? '' : 's'}</span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div style={{ height: 8, width: `${Math.max((u.totalKg / maxVal) * 100, 3)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </SectionCard>
          )}

          <SectionCard noPadding>
            {/* md+: grid table; below md the 13 columns render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 1700 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 130px 100px 1fr 150px 100px 100px 100px 80px 70px 110px 110px 1.6fr',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>Resource UID</div><div>Beneficiary UID</div><div>Type</div><div>Beneficiary Name</div>
                  <div>Production System</div><div>Water Body</div><div>Structure</div><div>Access</div>
                  <div>Rafts</div><div>Area (Acre)</div><div>Latitude</div><div>Longitude</div><div>Resource Utility</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '90px 130px 100px 1fr 150px 100px 100px 100px 80px 70px 110px 110px 1.6fr',
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12, fontFamily: 'monospace' }}>{r.beneficiary_uid}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.beneficiary_type}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.beneficiary_name || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.resource_type}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.water_body_type || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.wetland_structure || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.resource_access || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.raft_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.area_acre ?? '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.latitude ?? '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.longitude ?? '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{utilitySummary(r.resource_utility)}</div>
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
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.beneficiary_name || '—'}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12, fontFamily: 'monospace' }}>{r.beneficiary_uid}</div>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 12.5 }}>{r.resource_type}</div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Beneficiary Type: {r.beneficiary_type}</div>
                    <div>Water Body: {r.water_body_type || '—'}</div>
                    <div>Structure: {r.wetland_structure || '—'}</div>
                    <div>Access: {r.resource_access || '—'}</div>
                    <div>Rafts: {r.raft_count ?? '—'}</div>
                    <div>Area: {r.area_acre ?? '—'}</div>
                    <div>Latitude: {r.latitude ?? '—'}</div>
                    <div>Longitude: {r.longitude ?? '—'}</div>
                    <div className="col-span-2">Utility: {utilitySummary(r.resource_utility)}</div>
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
                  Page {page + 1} of {pageCount} · {data.totalRows} resources
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
