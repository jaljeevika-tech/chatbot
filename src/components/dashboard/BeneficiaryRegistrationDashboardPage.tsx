// Beneficiary and Resource Registration > Dashboard sub-tab. Org-wide (no project
// selection); everything comes from GET /api/beneficiary-registration-dashboard
// (routes/beneficiary-dashboard.routes.js).

import { useEffect, useRef, useState } from 'react'
import { Loader2, MapPinned } from 'lucide-react'
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useAuthContext } from '../../context/AuthContext'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { resolveDistrictCoords, resolveBlockCoords } from '../../data/locationCoords'

interface StateRow {
  state: string
  individualBeneficiaries: number
  microEntrepreneurs: number
  collectives: number
  resources: number
}
interface ResourceLocation {
  id: string
  resource_type: string
  beneficiary_type: string
  latitude: number
  longitude: number
}
interface LocationRow {
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  total: number
  // split of `total` by beneficiary type (absent from an older server → treated as 0)
  individual?: number
  entrepreneur?: number
  collective?: number
}
interface LocationGeocode {
  state: string | null
  district: string | null
  block: string | null
  village: string | null
  latitude: number
  longitude: number
}
// One row per production system (db/migrations/067–069). Totals are Quintal for
// Aquaculture/Agriculture/Horticulture, headcount for Livestock.
interface ProductionSummary {
  byType: { type: string; count: number; quintal: number; livestock: number }[]
  totalQuintal: number
  totalLivestock: number
  withProduction: number
}
type LabelCount = { label: string; total: number }
type TypeCount = { type: string; total: number }
interface Summary {
  coverage: { states: number; districts: number; blocks: number; panchayats: number; villages: number }
  individualBeneficiaries: {
    total: number; male: number; female: number; other: number
    byCategory: LabelCount[]; collectiveMembers: number; avgIncome: number; production: ProductionSummary
  }
  microEntrepreneurs: {
    total: number; male: number; female: number; other: number
    byCategory: LabelCount[]; totalEmployees: number; totalRevenue: number; avgRevenue: number; production: ProductionSummary
  }
  collectives: {
    total: number; byType: TypeCount[]
    totalMale: number; totalFemale: number; totalRevenue: number; totalCreditAccess: number; production: ProductionSummary
  }
  production: ProductionSummary
  resources: {
    total: number
    byType: (TypeCount & { areaAcre?: number })[]
    byWaterBodyType: TypeCount[]
    byAccess: TypeCount[]
    byWetlandStructure: TypeCount[]
    totalAreaAcre: number
    totalRaftCount: number
    utilityBreakdown: { utility: string; resourceCount: number; totalKg: number }[]
  }
  byState: StateRow[]
  byLocation: LocationRow[]
  locationGeocodes: LocationGeocode[]
  // Static coordinates from lib/placeCoords.js, keyed like locationKey() ('' for missing levels).
  placeCoords: Record<string, [number, number]>
  villageGps: VillageGps[]
  resourceLocations: ResourceLocation[]
  filterOptions: { states: string[]; districts: string[]; blocks: string[]; villages: string[] }
}

const EMPTY_PRODUCTION: ProductionSummary = { byType: [], totalQuintal: 0, totalLivestock: 0, withProduction: 0 }
const EMPTY: Summary = {
  coverage: { states: 0, districts: 0, blocks: 0, panchayats: 0, villages: 0 },
  individualBeneficiaries: { total: 0, male: 0, female: 0, other: 0, byCategory: [], collectiveMembers: 0, avgIncome: 0, production: EMPTY_PRODUCTION },
  microEntrepreneurs: { total: 0, male: 0, female: 0, other: 0, byCategory: [], totalEmployees: 0, totalRevenue: 0, avgRevenue: 0, production: EMPTY_PRODUCTION },
  collectives: { total: 0, byType: [], totalMale: 0, totalFemale: 0, totalRevenue: 0, totalCreditAccess: 0, production: EMPTY_PRODUCTION },
  production: EMPTY_PRODUCTION,
  resources: { total: 0, byType: [], byWaterBodyType: [], byAccess: [], byWetlandStructure: [], totalAreaAcre: 0, totalRaftCount: 0, utilityBreakdown: [] },
  byState: [],
  byLocation: [],
  locationGeocodes: [],
  placeCoords: {},
  filterOptions: { states: [], districts: [], blocks: [], villages: [] },
  villageGps: [],
  resourceLocations: [],
}

// Shared by the graph and the map so a category is the same colour in both.
const SERIES = [
  { key: 'individualBeneficiaries' as const, label: 'Individual Beneficiary', color: '#3b82f6' },
  { key: 'microEntrepreneurs'      as const, label: 'Micro-Entrepreneur',     color: '#8b5cf6' },
  { key: 'collectives'             as const, label: 'Collective',            color: '#10b981' },
  { key: 'resources'               as const, label: 'Resource',              color: '#f59e0b' },
]
const BENEFICIARY_TYPE_COLORS: Record<string, string> = {
  'Individual Beneficiary': '#3b82f6',
  'Micro-Entrepreneur':     '#8b5cf6',
  'Collective':             '#10b981',
}

// Approximate geographic centres of India's states/UTs, used to place one bubble
// per State on the location map.
const STATE_COORDS: Record<string, [number, number]> = {
  'andhra pradesh': [15.9129, 79.7400],
  'arunachal pradesh': [28.2180, 94.7278],
  'assam': [26.2006, 92.9376],
  'bihar': [25.0961, 85.3131],
  'chhattisgarh': [21.2787, 81.8661],
  'goa': [15.2993, 74.1240],
  'gujarat': [22.2587, 71.1924],
  'haryana': [29.0588, 76.0856],
  'himachal pradesh': [31.1048, 77.1734],
  'jharkhand': [23.6102, 85.2799],
  'karnataka': [15.3173, 75.7139],
  'kerala': [10.8505, 76.2711],
  'madhya pradesh': [22.9734, 78.6569],
  'maharashtra': [19.7515, 75.7139],
  'manipur': [24.6637, 93.9063],
  'meghalaya': [25.4670, 91.3662],
  'mizoram': [23.1645, 92.9376],
  'nagaland': [26.1584, 94.5624],
  'odisha': [20.9517, 85.0985],
  'punjab': [31.1471, 75.3412],
  'rajasthan': [27.0238, 74.2179],
  'sikkim': [27.5330, 88.5122],
  'tamil nadu': [11.1271, 78.6569],
  'telangana': [18.1124, 79.0193],
  'tripura': [23.9408, 91.9882],
  'uttar pradesh': [26.8467, 80.9462],
  'uttarakhand': [30.0668, 79.0193],
  'west bengal': [22.9868, 87.8550],
  'andaman and nicobar islands': [11.7401, 92.6586],
  'chandigarh': [30.7333, 76.7794],
  'dadra and nagar haveli and daman and diu': [20.1809, 73.0169],
  'delhi': [28.7041, 77.1025],
  'jammu and kashmir': [33.7782, 76.5762],
  'ladakh': [34.1526, 77.5770],
  'lakshadweep': [10.5667, 72.6417],
  'puducherry': [11.9416, 79.8083],
}

// Alternate spellings seen in real data entry, mapped to STATE_COORDS keys.
const STATE_ALIASES: Record<string, string> = {
  'orissa': 'odisha',
  'pondicherry': 'puducherry',
  'uttaranchal': 'uttarakhand',
  'nct of delhi': 'delhi',
  'new delhi': 'delhi',
  'jammu & kashmir': 'jammu and kashmir',
  'j&k': 'jammu and kashmir',
  'andaman & nicobar islands': 'andaman and nicobar islands',
  'dadra & nagar haveli and daman & diu': 'dadra and nagar haveli and daman and diu',
}

function resolveStateCoords(state: string): [number, number] | null {
  const key = state.trim().toLowerCase()
  return STATE_COORDS[key] || STATE_COORDS[STATE_ALIASES[key]] || null
}

const INDIA_CENTER: [number, number] = [22.9734, 78.6569]

// Last-resort placement for places with no known position: unplaced siblings go
// on a sunflower spiral around the parent, in alphabetical order, so the layout
// is stable and nothing overlaps. These are flagged "approximate" on the map.
function ringPositions(anchor: [number, number], labels: string[], radiusDeg: number): Map<string, [number, number]> {
  const sorted = [...labels].sort((a, b) => a.localeCompare(b))
  const out = new Map<string, [number, number]>()
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  sorted.forEach((label, i) => {
    const r = radiusDeg * Math.sqrt((i + 1) / (sorted.length + 1)) // (i+1) keeps the first one off dead-centre
    const a = i * GOLDEN_ANGLE
    out.set(label, [anchor[0] + Math.sin(a) * r, anchor[1] + Math.cos(a) * r])
  })
  return out
}
const DISTRICT_RING_DEG = 0.9
const BLOCK_RING_DEG    = 0.3
const VILLAGE_RING_DEG  = 0.08

// Centre + zoom that fits every point in the ~700×380px map (Web Mercator:
// a tile of 256px spans 360/2^z degrees of longitude). Falls back to the
// level's default zoom for a single point, and never zooms in past 13.
function fitView(points: { lat: number; lng: number }[], fallback: [number, number], defaultZoom: number): { center: [number, number]; zoom: number } {
  if (points.length === 0) return { center: fallback, zoom: defaultZoom }
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng)
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)]
  const center: [number, number] = [(minLat + maxLat) / 2, (minLng + maxLng) / 2]
  if (points.length === 1) return { center, zoom: defaultZoom }
  const PAD = 1.4 // breathing room so edge bubbles aren't clipped
  const zoomFor = (spanDeg: number, px: number) => (spanDeg <= 0 ? 13 : Math.log2((px * 360) / (256 * spanDeg * PAD)))
  const zoom = Math.floor(Math.min(zoomFor(maxLng - minLng, 640), zoomFor(maxLat - minLat, 340), 13))
  return { center, zoom: Math.max(4, zoom) }
}

interface VillageGps { state: string | null; district: string | null; block: string | null; village: string; latitude: number; longitude: number; resources: number }

// Must match lib/geocodeLocation.js's locationKey exactly (trim/lowercase,
// Panchayat excluded) or cached geocodes won't line up with byLocation rows.
function locationKey(state: string | null, district: string | null, block: string | null, village: string | null): string {
  return [state, district, block, village].map(v => (v || '').trim().toLowerCase()).join('|')
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      {items.map(it => (
        <div key={it.label} className="flex items-center gap-1.5 text-xs" style={{ color: FF.textMuted }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: it.color, display: 'inline-block', flexShrink: 0 }} />
          {it.label}
        </div>
      ))}
    </div>
  )
}

// One stacked bar per State. A resource's state is that of the beneficiary it's mapped to.
function StateStackedBarChart({ data }: { data: StateRow[] }) {
  if (data.length === 0) return <div className="text-xs" style={{ color: FF.textFaint }}>No state data yet.</div>
  const totals = data.map(d => d.individualBeneficiaries + d.microEntrepreneurs + d.collectives + d.resources)
  const maxTotal = Math.max(...totals, 1)
  return (
    <div className="flex flex-col gap-4">
      <Legend items={SERIES.map(s => ({ label: s.label, color: s.color }))} />
      <div className="flex flex-col gap-3">
        {data.map((d, i) => {
          const total = totals[i]
          const widthPct = Math.max((total / maxTotal) * 100, total > 0 ? 3 : 0)
          return (
            <div key={d.state}>
              <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                <span>{d.state}</span>
                <span style={{ fontWeight: 600, color: FF.tealDark }}>{total}</span>
              </div>
              <div style={{ height: 10, background: FF.borderSoft, borderRadius: 999, overflow: 'hidden', width: `${widthPct}%`, display: 'flex' }}>
                {SERIES.map(s => {
                  const val = d[s.key]
                  if (!val) return null
                  return <div key={s.key} style={{ height: '100%', width: `${(val / total) * 100}%`, background: s.color }} title={`${s.label}: ${val}`} />
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Geo-tagged resources plotted in plain SVG within the data's own bounding box
// (no basemap), coloured by the beneficiary category that registered them.
function ResourceLocationMap({ locations }: { locations: ResourceLocation[] }) {
  if (locations.length === 0) {
    return (
      <div className="text-xs" style={{ color: FF.textFaint }}>
        No geo-tagged resources yet — resources appear here once registered with GPS coordinates.
      </div>
    )
  }
  const W = 640, H = 320, PAD = 24
  const lats = locations.map(l => l.latitude)
  const lngs = locations.map(l => l.longitude)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const latSpan = maxLat - minLat || 1
  const lngSpan = maxLng - minLng || 1
  const project = (lat: number, lng: number): [number, number] => [
    PAD + ((lng - minLng) / lngSpan) * (W - 2 * PAD),
    // SVG y grows downward, latitude grows upward — flip it.
    H - PAD - ((lat - minLat) / latSpan) * (H - 2 * PAD),
  ]
  return (
    <div className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: FF.bg, borderRadius: 12 }}>
        {locations.map(loc => {
          const [x, y] = project(loc.latitude, loc.longitude)
          const color = BENEFICIARY_TYPE_COLORS[loc.beneficiary_type] || FF.amber
          return (
            <circle key={loc.id} cx={x} cy={y} r={6} fill={color} fillOpacity={0.85} stroke="#FFFFFF" strokeWidth={1.5}>
              <title>{`${loc.resource_type} · ${loc.beneficiary_type}`}</title>
            </circle>
          )
        })}
      </svg>
      <Legend items={Object.entries(BENEFICIARY_TYPE_COLORS).map(([label, color]) => ({ label, color }))} />
    </div>
  )
}

interface MapPoint {
  key: string; label: string; total: number; lat: number; lng: number; isApproximate?: boolean
  color: string
  group?: string // e.g. "District: KHAGARIA" — which colour group the point belongs to
  byType: Record<BeneficiaryTypeKey, number>
}

type BeneficiaryTypeKey = 'individual' | 'entrepreneur' | 'collective'
type TypeFilterKey = 'total' | BeneficiaryTypeKey
// Colours match SERIES / BENEFICIARY_TYPE_COLORS so a type reads the same everywhere.
const TYPE_FILTERS: { key: TypeFilterKey; label: string; color: string }[] = [
  { key: 'total',        label: 'All beneficiaries',      color: FF.purple },
  { key: 'individual',   label: 'Individual Beneficiary', color: '#3b82f6' },
  { key: 'entrepreneur', label: 'Micro-Entrepreneur',     color: '#8b5cf6' },
  { key: 'collective',   label: 'Collective',             color: '#10b981' },
]

// Indexed by alphabetical position within the parent, so colours are stable and
// distinct until a state has more districts than the palette.
const PLACE_PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075', '#bfef45', '#dcbeff']
function colorIndex(names: string[]): Map<string, string> {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b))
  return new Map(sorted.map((n, i) => [n, PLACE_PALETTE[i % PLACE_PALETTE.length]]))
}

// Bubble map for every drill-down level. Keyed by center+zoom so a level change
// remounts the map instead of animating from the old view.
function LocationBubbleMap({ points, center, zoom, onSelect, emptyMessage, footerNote }: {
  points: MapPoint[]
  center: [number, number]
  zoom: number
  onSelect?: (label: string) => void
  emptyMessage: string
  footerNote?: string
}) {
  if (points.length === 0) {
    return <div className="text-xs" style={{ color: FF.textFaint }}>{emptyMessage}</div>
  }
  const approximateCount = points.filter(p => p.isApproximate).length

  const maxTotal = Math.max(...points.map(p => p.total), 1)
  // CircleMarker radius is in screen pixels, not metres, so it's zoom-independent.
  const radius = (total: number) => 6 + Math.sqrt(total / maxTotal) * 18

  return (
    <div className="flex flex-col gap-3">
      <div style={{ height: 380, borderRadius: 12, overflow: 'hidden' }}>
        <MapContainer key={`${center[0]},${center[1]},${zoom}`} center={center} zoom={zoom} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
          {/* Not tile.openstreetmap.org: OSM requires a Referer and helmet sends
              Referrer-Policy: no-referrer. Esri needs neither a Referer nor a key.
              Note the {z}/{y}/{x} order. */}
          <TileLayer
            attribution='Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Sources: Esri, HERE, Garmin, USGS, OpenStreetMap contributors, and the GIS User Community'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
            maxZoom={18}
          />
          {points.map(p => (
            <CircleMarker
              key={p.key}
              center={[p.lat, p.lng]}
              radius={radius(p.total)}
              pathOptions={
                p.isApproximate
                  ? { color: FF.textFaint, weight: 1.5, dashArray: '3,3', fillColor: p.color, fillOpacity: 0.35 }
                  : { color: '#FFFFFF', weight: 1.5, fillColor: p.color, fillOpacity: 0.75 }
              }
              eventHandlers={onSelect ? { click: () => onSelect(p.label) } : undefined}
            >
              <Tooltip direction="top" offset={[0, -radius(p.total)]}>
                <div style={{ fontWeight: 600 }}>
                  {p.label} — {p.total} beneficiar{p.total === 1 ? 'y' : 'ies'}
                </div>
                {p.group && <div style={{ color: FF.textMuted }}>{p.group}</div>}
                {TYPE_FILTERS.filter(t => t.key !== 'total').map(t => (
                  <div key={t.key} className="flex items-center gap-1.5">
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, display: 'inline-block' }} />
                    {t.label}: {p.byType[t.key as BeneficiaryTypeKey]}
                  </div>
                ))}
                {onSelect && <div style={{ color: FF.textFaint }}>Click to drill in</div>}
                {p.isApproximate && <div style={{ color: FF.textFaint }}>Approximate position — placed near its parent area</div>}
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="text-[11px]" style={{ color: FF.textFaint }}>
        {points.length} location{points.length === 1 ? '' : 's'} plotted, marker size = beneficiary count
        {onSelect ? ' · click a marker to drill in' : ''}
        {approximateCount > 0 ? ` · ${approximateCount} dashed/faded = approximate position (no known coordinates yet)` : ''}
        {footerNote ? ` · ${footerNote}` : ''}
      </div>
    </div>
  )
}

// Per-utility resource totals (utilities vary by production system, see
// db/migrations/045_resource_production_system.sql).
function UtilityTable({ data }: { data: { utility: string; resourceCount: number; totalKg: number }[] }) {
  if (data.length === 0) return <div className="text-xs" style={{ color: FF.textFaint }}>No resource utility recorded yet.</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 300 }}>
        <div className="text-[10px] sm:text-[11px]" style={{ display: 'grid', gridTemplateColumns: '1.4fr 90px 110px', gap: 8, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint, paddingBottom: 6 }}>
          <div>Utility</div><div>Resources</div><div>Total Kg</div>
        </div>
        {data.map(d => (
          <div key={d.utility} className="text-[12px] sm:text-[13px]" style={{ display: 'grid', gridTemplateColumns: '1.4fr 90px 110px', gap: 8, padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
            <div style={{ color: FF.tealDark }}>{d.utility}</div>
            <div style={{ color: FF.textMuted }}>{d.resourceCount}</div>
            <div style={{ color: FF.textMuted }}>{d.totalKg.toLocaleString('en-IN')} kg</div>
          </div>
        ))}
      </div>
    </div>
  )
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '')

// A registration with several production systems counts once under each.
function ProductionTable({ ib, me, cb, combined }: { ib: ProductionSummary; me: ProductionSummary; cb: ProductionSummary; combined: ProductionSummary }) {
  if (combined.withProduction === 0) {
    return <div className="text-xs" style={{ color: FF.textFaint }}>No production system recorded yet.</div>
  }
  const countOf = (p: ProductionSummary, type: string) => p.byType.find(t => t.type === type)?.count || 0
  const cols = '1.3fr 70px 70px 70px 70px 110px'
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 520 }}>
        <div className="text-[10px] sm:text-[11px]" style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint, paddingBottom: 6 }}>
          <div>Production System</div><div>Individual</div><div>Micro-Ent.</div><div>Collective</div><div>Total</div><div>Quantity</div>
        </div>
        {combined.byType.map(t => (
          <div key={t.type} className="text-[12px] sm:text-[13px]" style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
            <div style={{ color: FF.tealDark }}>{t.type}</div>
            <div style={{ color: FF.textMuted }}>{countOf(ib, t.type)}</div>
            <div style={{ color: FF.textMuted }}>{countOf(me, t.type)}</div>
            <div style={{ color: FF.textMuted }}>{countOf(cb, t.type)}</div>
            <div style={{ color: FF.tealDark, fontWeight: 600 }}>{t.count}</div>
            <div style={{ color: FF.textMuted }}>
              {t.type === 'Livestock'
                ? `${t.livestock.toLocaleString('en-IN')} head`
                : `${t.quintal.toLocaleString('en-IN', { maximumFractionDigits: 2 })} qtl`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CategoryTable({ ib, me }: { ib: LabelCount[]; me: LabelCount[] }) {
  const labels = [...new Set([...ib.map(c => c.label), ...me.map(c => c.label)])]
  const get = (list: LabelCount[], label: string) => list.find(c => c.label === label)?.total || 0
  if (labels.every(l => get(ib, l) + get(me, l) === 0)) {
    return <div className="text-xs" style={{ color: FF.textFaint }}>No category recorded yet.</div>
  }
  const cols = '1fr 90px 90px'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div className="text-[10px] sm:text-[11px]" style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint, paddingBottom: 6 }}>
        <div>Category</div><div>Individual</div><div>Micro-Ent.</div>
      </div>
      {labels.map(l => (
        <div key={l} className="text-[12px] sm:text-[13px]" style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '7px 0', borderTop: `1px solid ${FF.borderFaint}` }}>
          <div style={{ color: FF.tealDark }}>{l}</div>
          <div style={{ color: FF.textMuted }}>{get(ib, l)}</div>
          <div style={{ color: FF.textMuted }}>{get(me, l)}</div>
        </div>
      ))}
    </div>
  )
}

// Count-per-label bar chart; rows become clickable when onSelect is passed.
function CountBarChart({ data, emptyLabel, onSelect }: { data: { label: string; total: number }[]; emptyLabel: string; onSelect?: (label: string) => void }) {
  const maxVal = Math.max(...data.map(d => d.total), 1)
  return (
    <div className="flex flex-col gap-3">
      {data.map(d => (
        <div key={d.label} onClick={onSelect ? () => onSelect(d.label) : undefined} style={onSelect ? { cursor: 'pointer' } : undefined}>
          <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
            <span>{d.label}</span>
            <span style={{ fontWeight: 600, color: FF.tealDark }}>{d.total}</span>
          </div>
          <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
            <div style={{ height: 8, width: `${Math.max((d.total / maxVal) * 100, d.total > 0 ? 3 : 0)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
          </div>
        </div>
      ))}
      {data.length === 0 && <div className="text-xs" style={{ color: FF.textFaint }}>{emptyLabel}</div>}
    </div>
  )
}

// State → District → Block → Village drill-down over byLocation rows. Position
// lookup order: District/Block use src/data/locationCoords.ts then placeCoords;
// Village uses placeCoords then plausible resource GPS; any level may use a
// cached admin geocode; otherwise ringPositions around the parent.
function LocationDrilldown({ data, initial, geocodes, placeCoords, villageGps, isAdmin, geocoding, geocodeStatus, onGeocode }: {
  data: LocationRow[]
  // Open already drilled into the filter-bar location, if any.
  initial: { state: string; district: string; block: string }
  geocodes: LocationGeocode[]
  placeCoords: Record<string, [number, number]>
  villageGps: VillageGps[]
  isAdmin: boolean
  geocoding: boolean
  geocodeStatus: string | null
  onGeocode: (level: 'district' | 'block' | 'village', scope: { state?: string; district?: string; block?: string }) => void
}) {
  // Resolve the filter's value to the exact spelling used in `data` (the
  // server matches case-insensitively; the drill-down compares exactly).
  const match = (field: 'state' | 'district' | 'block', value: string) =>
    value ? (data.find(d => (d[field] || '').trim().toLowerCase() === value.trim().toLowerCase())?.[field] ?? null) : null
  const [selectedState, setSelectedState] = useState<string | null>(() => match('state', initial.state))
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(() => (initial.state ? match('district', initial.district) : null))
  const [selectedBlock, setSelectedBlock] = useState<string | null>(() => (initial.state && initial.district ? match('block', initial.block) : null))

  const geocodeMap = new Map(geocodes.map(g => [locationKey(g.state, g.district, g.block, g.village), [g.latitude, g.longitude] as [number, number]]))

  const filtered = data.filter(d =>
    (!selectedState || d.state === selectedState) &&
    (!selectedDistrict || d.district === selectedDistrict) &&
    (!selectedBlock || d.block === selectedBlock)
  )

  const [typeFilter, setTypeFilter] = useState<TypeFilterKey>('total')

  type Group = { label: string; total: number; byType: Record<BeneficiaryTypeKey, number> }
  const groupBy = (rows: LocationRow[], field: 'state' | 'district' | 'block' | 'village'): Group[] => {
    const groups = new Map<string, Group>()
    for (const d of rows) {
      const label = d[field] || 'Unknown'
      let g = groups.get(label)
      if (!g) groups.set(label, g = { label, total: 0, byType: { individual: 0, entrepreneur: 0, collective: 0 } })
      g.byType.individual   += d.individual || 0
      g.byType.entrepreneur += d.entrepreneur || 0
      g.byType.collective   += d.collective || 0
      g.total += typeFilter === 'total' ? d.total : (d[typeFilter] || 0)
    }
    return [...groups.values()].filter(g => g.total > 0).sort((a, b) => b.total - a.total)
  }

  // Index over ALL of the state's districts, not just filtered ones, so a
  // district keeps its colour across type filters and drill-downs.
  const stateColors = colorIndex(data.map(d => d.state || 'Unknown'))
  const districtColors = colorIndex(data.filter(d => d.state === selectedState).map(d => d.district || 'Unknown'))
  let legendItems: { label: string; color: string }[] = []

  const crumbStyle = (active: boolean) => ({
    fontWeight: active ? 700 : 500,
    color: active ? FF.purple : FF.textMuted,
    textDecoration: active ? 'none' : 'underline',
  })

  let mapPoints: MapPoint[] = []
  let mapCenter: [number, number] = INDIA_CENTER
  let mapZoom = 5
  let onMapSelect: ((label: string) => void) | undefined
  let emptyMessage = 'No location data yet.'
  let footerNote: string | undefined
  let geocodeLevel: 'district' | 'block' | 'village' | null = null
  let geocodeScope: { state?: string; district?: string; block?: string } = {}

  if (!selectedState) {
    const unresolved: string[] = []
    mapPoints = groupBy(data, 'state').flatMap(({ label, total, byType }) => {
      const coords = resolveStateCoords(label)
      if (!coords) { unresolved.push(label); return [] }
      return [{ key: label, label, total, byType, lat: coords[0], lng: coords[1], color: stateColors.get(label) || FF.purple }]
    })
    legendItems = mapPoints.map(p => ({ label: p.label, color: p.color }))
    onMapSelect = setSelectedState
    if (unresolved.length > 0) footerNote = `not plotted (unrecognized state name): ${unresolved.join(', ')}`
  } else {
    const stateCoords = resolveStateCoords(selectedState) || INDIA_CENTER
    const districtReal = (district: string) => {
      const key = locationKey(selectedState, district, null, null)
      return resolveDistrictCoords(selectedState, district) || placeCoords[key] || geocodeMap.get(key) || null
    }
    const place = (groups: Group[], real: (label: string) => [number, number] | null, anchor: [number, number], ringDeg: number, colorOf: (label: string) => string, group?: string): MapPoint[] => {
      const resolved = groups.map(g => ({ ...g, pos: g.label === 'Unknown' ? null : real(g.label) }))
      const ring = ringPositions(anchor, resolved.filter(g => !g.pos).map(g => g.label), ringDeg)
      return resolved.map(({ label, total, byType, pos }) => {
        const [lat, lng] = pos || ring.get(label)!
        return { key: label, label, total, byType, lat, lng, isApproximate: !pos, color: colorOf(label), group }
      })
    }
    const districtColor = (district: string) => districtColors.get(district) || FF.purple
    if (!selectedDistrict) {
      const districts = groupBy(filtered, 'district')
      mapPoints = place(districts, districtReal, stateCoords, DISTRICT_RING_DEG, districtColor)
      legendItems = mapPoints.map(p => ({ label: p.label, color: p.color }))
      const fit = fitView(mapPoints, stateCoords, 7)
      mapCenter = fit.center
      mapZoom = fit.zoom
      onMapSelect = setSelectedDistrict
      emptyMessage = 'No district data for this state.'
      geocodeLevel = 'district'
      geocodeScope = { state: selectedState }
    } else {
      const districtAnchor = districtReal(selectedDistrict) || ringPositions(stateCoords, [selectedDistrict], DISTRICT_RING_DEG).get(selectedDistrict)!
      const blockReal = (block: string) => {
        const key = locationKey(selectedState, selectedDistrict, block, null)
        return resolveBlockCoords(selectedState, selectedDistrict, block) || placeCoords[key] || geocodeMap.get(key) || null
      }
      if (!selectedBlock) {
        mapPoints = place(groupBy(filtered, 'block'), blockReal, districtAnchor, BLOCK_RING_DEG, () => districtColor(selectedDistrict), `District: ${selectedDistrict}`)
        legendItems = [{ label: `${selectedDistrict} (district)`, color: districtColor(selectedDistrict) }]
        const fit = fitView(mapPoints, districtAnchor, 9)
        mapCenter = fit.center
        mapZoom = fit.zoom
        onMapSelect = setSelectedBlock
        emptyMessage = 'No block data for this district.'
        geocodeLevel = 'block'
        geocodeScope = { state: selectedState, district: selectedDistrict }
      } else {
        const blockAnchor = blockReal(selectedBlock) || districtAnchor
        const gpsMap = new Map(villageGps.map(v => [locationKey(v.state, v.district, v.block, v.village), [v.latitude, v.longitude] as [number, number]]))
        // Trust resource GPS only within ~0.5° (≈55 km) of the block; mis-entered
        // or phone-default readings in real data land hundreds of km away.
        const plausible = (p: [number, number] | undefined) =>
          p && Math.abs(p[0] - blockAnchor[0]) <= 0.5 && Math.abs(p[1] - blockAnchor[1]) <= 0.5 ? p : null
        const villageReal = (village: string) => {
          const key = locationKey(selectedState, selectedDistrict, selectedBlock, village)
          return placeCoords[key] || plausible(gpsMap.get(key)) || geocodeMap.get(key) || null
        }
        mapPoints = place(groupBy(filtered, 'village'), villageReal, blockAnchor, VILLAGE_RING_DEG, () => districtColor(selectedDistrict), `District: ${selectedDistrict} · Block: ${selectedBlock}`)
        legendItems = [{ label: `${selectedDistrict} (district)`, color: districtColor(selectedDistrict) }]
        const fit = fitView(mapPoints, blockAnchor, 11)
        mapCenter = fit.center
        mapZoom = fit.zoom
        onMapSelect = undefined // villages are the leaf level — nothing further to drill into
        emptyMessage = 'No village data for this block.'
        geocodeLevel = 'village'
        geocodeScope = { state: selectedState, district: selectedDistrict, block: selectedBlock }
      }
    }
  }

  const hasApproximate = mapPoints.some(p => p.isApproximate)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <button onClick={() => { setSelectedState(null); setSelectedDistrict(null); setSelectedBlock(null) }} style={crumbStyle(!selectedState)}>
            All States
          </button>
          {selectedState && <>
            <span style={{ color: FF.textFaint }}>/</span>
            <button onClick={() => { setSelectedDistrict(null); setSelectedBlock(null) }} style={crumbStyle(!selectedDistrict)}>{selectedState}</button>
          </>}
          {selectedDistrict && <>
            <span style={{ color: FF.textFaint }}>/</span>
            <button onClick={() => setSelectedBlock(null)} style={crumbStyle(!selectedBlock)}>{selectedDistrict}</button>
          </>}
          {selectedBlock && <>
            <span style={{ color: FF.textFaint }}>/</span>
            <span style={crumbStyle(true)}>{selectedBlock}</span>
          </>}
        </div>
        {isAdmin && geocodeLevel && hasApproximate && (
          <button
            onClick={() => onGeocode(geocodeLevel!, geocodeScope)}
            disabled={geocoding}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
          >
            {geocoding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPinned className="w-3.5 h-3.5" />}
            Geocode this level
          </button>
        )}
      </div>

      {geocodeStatus && <div className="text-xs" style={{ color: FF.textFaint }}>{geocodeStatus}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase" style={{ color: FF.textFaint, letterSpacing: 0.4 }}>Beneficiary type</span>
        {TYPE_FILTERS.map(t => {
          const active = typeFilter === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              style={{ border: `1.5px solid ${active ? t.color : FF.border}`, background: active ? t.color : '#FFFFFF', color: active ? '#FFFFFF' : FF.tealDark }}
            >
              {t.key !== 'total' && <span style={{ width: 8, height: 8, borderRadius: 2, background: active ? '#FFFFFF' : t.color, display: 'inline-block' }} />}
              {t.label}
            </button>
          )
        })}
      </div>

      <LocationBubbleMap
        points={mapPoints}
        center={mapCenter}
        zoom={mapZoom}
        onSelect={onMapSelect}
        emptyMessage={typeFilter === 'total' ? emptyMessage : `No ${TYPE_FILTERS.find(t => t.key === typeFilter)!.label} records at this level.`}
        footerNote={footerNote}
      />
      {legendItems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase" style={{ color: FF.textFaint, letterSpacing: 0.4 }}>
            {selectedState ? 'Colour = district' : 'Colour = state'}
          </span>
          <Legend items={legendItems} />
        </div>
      )}
    </div>
  )
}

// Sent as query params (see the route's parseFilters). Empty string = "any".
interface DashboardFilters {
  state: string; district: string; block: string; village: string
  beneficiary_type: '' | BeneficiaryTypeKey
  gender: string; category: string; production_system: string
  from: string; to: string
}
const EMPTY_FILTERS: DashboardFilters = {
  state: '', district: '', block: '', village: '', beneficiary_type: '',
  gender: '', category: '', production_system: '', from: '', to: '',
}
function filtersToQuery(f: DashboardFilters): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v)
  const s = params.toString()
  return s ? `?${s}` : ''
}
const activeFilterCount = (f: DashboardFilters) => Object.values(f).filter(Boolean).length

const GENDER_OPTIONS = ['Male', 'Female', 'Other']
const CATEGORY_OPTIONS = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']
const PRODUCTION_OPTIONS = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']

function FilterSelect({ label, value, options, onChange, allLabel = 'All', disabled }: {
  label: string; value: string; options: { value: string; label: string }[] | string[]
  onChange: (v: string) => void; allLabel?: string; disabled?: boolean
}) {
  const opts = (options as (string | { value: string; label: string })[]).map(o => (typeof o === 'string' ? { value: o, label: o } : o))
  // Keep a stale selected value visible so the control never silently shows "All".
  if (value && !opts.some(o => o.value === value)) opts.unshift({ value, label: value })
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10.5px] uppercase" style={{ color: FF.textFaint, letterSpacing: 0.4 }}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="px-2.5 py-2 rounded-lg text-xs sm:text-[13px] disabled:opacity-50"
        style={{ border: `1px solid ${value ? FF.purple : FF.border}`, background: '#FFFFFF', color: FF.tealDark, minWidth: 0, width: '100%' }}
      >
        <option value="">{allLabel}</option>
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function DashboardFilterBar({ filters, options, refreshing, onChange }: {
  filters: DashboardFilters
  options: { states: string[]; districts: string[]; blocks: string[]; villages: string[] }
  refreshing: boolean
  onChange: (next: DashboardFilters) => void
}) {
  // Clear lower levels, or a District from the old State would match nothing.
  const setLocation = (level: 'state' | 'district' | 'block' | 'village', value: string) => {
    const next = { ...filters, [level]: value }
    if (level === 'state')    { next.district = ''; next.block = ''; next.village = '' }
    if (level === 'district') { next.block = ''; next.village = '' }
    if (level === 'block')    { next.village = '' }
    onChange(next)
  }
  const set = <K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => onChange({ ...filters, [key]: value })
  const count = activeFilterCount(filters)
  const dateInvalid = !!(filters.from && filters.to && filters.from > filters.to)

  return (
    <SectionCard
      title="Filters"
      titleRight={
        <div className="flex items-center gap-3">
          {refreshing && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: FF.textFaint }} />}
          {count > 0 && (
            <button onClick={() => onChange(EMPTY_FILTERS)} className="text-xs font-semibold underline" style={{ color: FF.purple }}>
              Clear all ({count})
            </button>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <FilterSelect label="State"    value={filters.state}    options={options.states}    onChange={v => setLocation('state', v)} allLabel="All states" />
        <FilterSelect label="District" value={filters.district} options={options.districts} onChange={v => setLocation('district', v)} allLabel="All districts" />
        <FilterSelect label="Block"    value={filters.block}    options={options.blocks}    onChange={v => setLocation('block', v)} allLabel="All blocks" />
        <FilterSelect label="Village"  value={filters.village}  options={options.villages}  onChange={v => setLocation('village', v)} allLabel="All villages" />
        <FilterSelect
          label="Beneficiary type"
          value={filters.beneficiary_type}
          options={[
            { value: 'individual', label: 'Individual Beneficiary' },
            { value: 'entrepreneur', label: 'Micro-Entrepreneur' },
            { value: 'collective', label: 'Collective' },
          ]}
          onChange={v => set('beneficiary_type', v as DashboardFilters['beneficiary_type'])}
          allLabel="All types"
        />
        <FilterSelect label="Gender"            value={filters.gender}            options={GENDER_OPTIONS}     onChange={v => set('gender', v)} allLabel="All genders" />
        <FilterSelect label="Social category"   value={filters.category}          options={CATEGORY_OPTIONS}   onChange={v => set('category', v)} allLabel="All categories" />
        <FilterSelect label="Production system" value={filters.production_system} options={PRODUCTION_OPTIONS} onChange={v => set('production_system', v)} allLabel="All systems" />
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[10.5px] uppercase" style={{ color: FF.textFaint, letterSpacing: 0.4 }}>Registered from</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={e => set('from', e.target.value)}
            className="px-2.5 py-1.5 rounded-lg text-xs sm:text-[13px]" style={{ border: `1px solid ${filters.from ? FF.purple : FF.border}`, color: FF.tealDark, width: '100%' }} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-[10.5px] uppercase" style={{ color: FF.textFaint, letterSpacing: 0.4 }}>Registered to</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={e => set('to', e.target.value)}
            className="px-2.5 py-1.5 rounded-lg text-xs sm:text-[13px]" style={{ border: `1px solid ${filters.to ? FF.purple : FF.border}`, color: FF.tealDark, width: '100%' }} />
        </label>
      </div>
      {(filters.gender || filters.category) && filters.beneficiary_type !== 'individual' && filters.beneficiary_type !== 'entrepreneur' && (
        <div className="text-[11px] mt-3" style={{ color: FF.textFaint }}>
          Collectives have no single gender or social category, so they're excluded while a Gender or Social category filter is set.
        </div>
      )}
      {dateInvalid && (
        <div className="text-[11px] mt-3" style={{ color: '#b91c1c' }}>"Registered from" is after "Registered to" — nothing can match.</div>
      )}
    </SectionCard>
  )
}

export function BeneficiaryRegistrationDashboardPage() {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Summary>(EMPTY)
  const [geocoding, setGeocoding] = useState(false)
  const [geocodeStatus, setGeocodeStatus] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_FILTERS)
  const [refreshing, setRefreshing] = useState(false)
  // Drop responses for filters the user has since changed.
  const requestSeq = useRef(0)

  const load = async (active: DashboardFilters = filters) => {
    const seq = ++requestSeq.current
    const r = await apiFetch(`/api/beneficiary-registration-dashboard${filtersToQuery(active)}`)
    const d = await r.json().catch(() => ({}))
    if (seq !== requestSeq.current) return
    if (!r.ok) {
      setLoadError(d.error || `Dashboard failed to load (HTTP ${r.status})`)
      return
    }
    setLoadError(null)
    // Merge one level deep so a missing field falls back to its EMPTY default.
    setData({
      ...EMPTY, ...d,
      individualBeneficiaries: { ...EMPTY.individualBeneficiaries, ...d.individualBeneficiaries },
      microEntrepreneurs:      { ...EMPTY.microEntrepreneurs, ...d.microEntrepreneurs },
      collectives:             { ...EMPTY.collectives, ...d.collectives },
      production:              { ...EMPTY.production, ...d.production },
      resources:               { ...EMPTY.resources, ...d.resources },
      filterOptions:           { ...EMPTY.filterOptions, ...d.filterOptions },
    })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load(EMPTY_FILTERS)
      .catch(e => { if (!cancelled) setLoadError(e?.message || 'Network error') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const applyFilters = (next: DashboardFilters) => {
    setFilters(next)
    setRefreshing(true)
    load(next)
      .catch(e => setLoadError(e?.message || 'Network error'))
      .finally(() => setRefreshing(false))
  }

  const runGeocode = async (level: 'district' | 'block' | 'village', scope: { state?: string; district?: string; block?: string }) => {
    setGeocoding(true)
    setGeocodeStatus(null)
    try {
      const r = await apiFetch('/api/beneficiary-registration-dashboard/geocode-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, ...scope }),
      })
      const d = await r.json()
      if (!r.ok) { setGeocodeStatus(d.error || 'Geocoding failed'); return }
      setGeocodeStatus(
        `Geocoded ${d.found} location${d.found === 1 ? '' : 's'}` +
        (d.notFound ? `, ${d.notFound} not found` : '') +
        (d.remaining ? ` — ${d.remaining} more remaining, click again to continue` : ' — all locations at this level resolved')
      )
      await load()
    } catch (e: any) {
      setGeocodeStatus(e.message || 'Network error')
    } finally {
      setGeocoding(false)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }

  const { coverage, individualBeneficiaries: ib, microEntrepreneurs: me, collectives: cb, production, resources: rs, byState, byLocation, locationGeocodes, placeCoords, villageGps, resourceLocations } = data
  const cbMembers = cb.totalMale + cb.totalFemale

  const filterBar = (
    <DashboardFilterBar filters={filters} options={data.filterOptions} refreshing={refreshing} onChange={applyFilters} />
  )

  if (loadError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {filterBar}
        <div className="text-sm p-4 rounded-xl" style={{ border: `1px solid ${FF.border}`, color: FF.tealDark, background: '#FFFFFF' }}>
          Couldn't load the dashboard: {loadError}
        </div>
      </div>
    )
  }

  const filtered = activeFilterCount(filters) > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {filterBar}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, opacity: refreshing ? 0.55 : 1, transition: 'opacity .15s' }}>
      <SectionCard title="Geographic Coverage" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>{filtered ? 'Matching the filters above' : 'Across all registered beneficiaries'}</span>}>
        <KpiGrid cols={5}>
          <KpiTile label="States" value={coverage.states} />
          <KpiTile label="Districts" value={coverage.districts} />
          <KpiTile label="Blocks" value={coverage.blocks} />
          <KpiTile label="Panchayats" value={coverage.panchayats} />
          <KpiTile label="Villages" value={coverage.villages} />
        </KpiGrid>
      </SectionCard>

      <KpiGrid cols={5}>
        <KpiTile label="Individual Beneficiaries" value={ib.total} />
        <KpiTile label="Micro-Entrepreneurs" value={me.total} />
        <KpiTile label="Collectives" value={cb.total} note={cbMembers > 0 ? `${cbMembers.toLocaleString('en-IN')} members` : ''} />
        <KpiTile label="Resources" value={rs.total} />
        <KpiTile label="Total Production" value={`${production.totalQuintal.toLocaleString('en-IN', { maximumFractionDigits: 1 })} qtl`} note={production.totalLivestock > 0 ? `+ ${production.totalLivestock.toLocaleString('en-IN')} livestock` : ''} />
      </KpiGrid>

      <SectionCard title="Individual Beneficiaries">
        <KpiGrid cols={6}>
          <KpiTile label="Male" value={ib.male} note={pct(ib.male, ib.total)} />
          <KpiTile label="Female" value={ib.female} note={pct(ib.female, ib.total)} />
          <KpiTile label="Other" value={ib.other} note={pct(ib.other, ib.total)} />
          <KpiTile label="Collective Members" value={ib.collectiveMembers} note={pct(ib.collectiveMembers, ib.total)} />
          <KpiTile label="Avg. Income" value={inr(ib.avgIncome)} />
          <KpiTile label="With Production" value={ib.production.withProduction} note={pct(ib.production.withProduction, ib.total)} />
        </KpiGrid>
      </SectionCard>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard title="Micro-Entrepreneurs">
          <KpiGrid cols={3}>
            <KpiTile label="Male" value={me.male} note={pct(me.male, me.total)} />
            <KpiTile label="Female" value={me.female} note={pct(me.female, me.total)} />
            <KpiTile label="Employees" value={me.totalEmployees} />
            <KpiTile label="Total Revenue" value={inr(me.totalRevenue)} />
            <KpiTile label="Avg. Revenue" value={inr(me.avgRevenue)} />
            <KpiTile label="With Production" value={me.production.withProduction} note={pct(me.production.withProduction, me.total)} />
          </KpiGrid>
        </SectionCard>
        <SectionCard title="Collectives">
          <KpiGrid cols={3}>
            <KpiTile label="Male Members" value={cb.totalMale} note={pct(cb.totalMale, cbMembers)} />
            <KpiTile label="Female Members" value={cb.totalFemale} note={pct(cb.totalFemale, cbMembers)} />
            <KpiTile label="With Production" value={cb.production.withProduction} note={pct(cb.production.withProduction, cb.total)} />
            <KpiTile label="Total Revenue" value={inr(cb.totalRevenue)} />
            <KpiTile label="Credit Access" value={inr(cb.totalCreditAccess)} />
          </KpiGrid>
        </SectionCard>
      </div>

      <SectionCard title="Beneficiaries by Production System" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Individual + Micro-Entrepreneur + Collective · one beneficiary can be in several systems</span>}>
        <KpiGrid cols={Math.max(production.byType.length, 1)}>
          {production.byType.map(t => (
            <KpiTile
              key={t.type}
              label={t.type}
              value={t.count}
              note={t.type === 'Livestock'
                ? `${t.livestock.toLocaleString('en-IN')} livestock`
                : `${t.quintal.toLocaleString('en-IN', { maximumFractionDigits: 1 })} qtl`}
            />
          ))}
        </KpiGrid>
      </SectionCard>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard title="Production System by Beneficiary Type" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>No. of beneficiaries per system</span>}>
          <ProductionTable ib={ib.production} me={me.production} cb={cb.production} combined={production} />
        </SectionCard>
        <SectionCard title="Social Category">
          <CategoryTable ib={ib.byCategory} me={me.byCategory} />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard title="Collectives by Type">
          <CountBarChart data={cb.byType.map(t => ({ label: t.type, total: t.total }))} emptyLabel="No collective data" />
        </SectionCard>
        <SectionCard title="Resources by Type">
          <CountBarChart data={rs.byType.map(t => ({ label: t.areaAcre ? `${t.type} · ${t.areaAcre.toFixed(2)} ac` : t.type, total: t.total }))} emptyLabel="No resource data" />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SectionCard title="Freshwater · Type of Resource">
          <CountBarChart data={rs.byWaterBodyType.map(t => ({ label: t.type, total: t.total }))} emptyLabel="No freshwater wetland data" />
        </SectionCard>
        <SectionCard title="Freshwater · Resource Access">
          <CountBarChart data={rs.byAccess.map(t => ({ label: t.type, total: t.total }))} emptyLabel="No resource access recorded" />
        </SectionCard>
        <SectionCard title="Coastal · Type of Resource">
          <CountBarChart data={rs.byWetlandStructure.map(t => ({ label: t.type, total: t.total }))} emptyLabel="No coastal wetland data" />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard title="Resource Area &amp; Rafts">
          <KpiGrid cols={2}>
            <KpiTile label="Total Area" value={`${rs.totalAreaAcre.toFixed(2)} ac`} />
            <KpiTile label="No. of Rafts" value={rs.totalRaftCount} />
          </KpiGrid>
        </SectionCard>
        <SectionCard title="Resource Utility">
          <UtilityTable data={rs.utilityBreakdown} />
        </SectionCard>
      </div>

      <SectionCard title="Registrations by State" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Beneficiaries &amp; resources, blended</span>}>
        <StateStackedBarChart data={byState} />
      </SectionCard>

      <SectionCard title="Beneficiaries by Location" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Click a state to drill into District &gt; Block &gt; Village</span>}>
        <LocationDrilldown
          key={filtersToQuery(filters)}
          data={byLocation}
          initial={{ state: filters.state, district: filters.district, block: filters.block }}
          geocodes={locationGeocodes}
          placeCoords={placeCoords}
          villageGps={villageGps}
          isAdmin={isAdmin}
          geocoding={geocoding}
          geocodeStatus={geocodeStatus}
          onGeocode={runGeocode}
        />
      </SectionCard>

      <SectionCard title="Resource Locations" titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>Coloured by registering beneficiary type</span>}>
        <ResourceLocationMap locations={resourceLocations} />
      </SectionCard>
      </div>
    </div>
  )
}
