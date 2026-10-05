import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Search, QrCode, Printer, FileSpreadsheet } from 'lucide-react'
import { saveAs } from 'file-saver'
import { apiFetch } from '../../../utils/apiFetch'
import { FF } from '../../../theme/colors'
import { KpiTile } from '../../ui/KpiTile'
import { KpiGrid } from '../../ui/KpiGrid'
import { SectionCard } from '../../ui/SectionCard'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { EMPTY_ROSTER, PRODUCTION_TILES, humanizeKey, type CategoryConfig, type RosterData, type RosterRow } from './helpers'

export function CategoryRoster({ config, onSelectUid, onShowCard, onBulkPrint }: {
  config: CategoryConfig
  onSelectUid: (uid: string) => void
  onShowCard: (row: RosterRow) => void
  onBulkPrint: (rows: RosterRow[]) => void
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<RosterData>(EMPTY_ROSTER)
  const [state, setState] = useState('')
  const [district, setDistrict] = useState('')
  const [block, setBlock] = useState('')
  const [village, setVillage] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  // Selection survives paging and filtering, so it stores full rows (a row from
  // an earlier page is gone from data.rows). Cleared only explicitly or on tab switch.
  const [selected, setSelected] = useState<Map<string, RosterRow>>(new Map())
  const [exporting, setExporting] = useState(false)
  // requestId drops stale responses that land after a newer query's.
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams()
      if (state) params.set('state', state)
      if (district) params.set('district', district)
      if (block) params.set('block', block)
      if (village) params.set('village', village)
      if (debouncedSearch) params.set('search', debouncedSearch)
      params.set('page', String(page))
      const r = await apiFetch(`${config.endpoint}?${params}`)
      const d = await r.json()
      if (id !== requestId.current) return
      if (!r.ok) {
        setLoadError(d.error || `Could not load ${config.label.toLowerCase()} records`)
        setData(EMPTY_ROSTER)
        return
      }
      setData({ ...EMPTY_ROSTER, ...d })
    } catch (e: any) {
      if (id !== requestId.current) return
      setLoadError(e.message || 'Network error')
      setData(EMPTY_ROSTER)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [config.endpoint, state, district, block, village, debouncedSearch, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [state, district, block, village, debouncedSearch])
  useEffect(() => { setPage(0); setState(''); setDistrict(''); setBlock(''); setVillage(''); setSearch(''); setSelected(new Map()) }, [config.endpoint])

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))
  const allOnPageSelected = data.rows.length > 0 && data.rows.every(r => selected.has(r.uid))
  const toggleAll = () => setSelected(prev => {
    const next = new Map(prev)
    if (allOnPageSelected) data.rows.forEach(r => next.delete(r.uid))
    else data.rows.forEach(r => next.set(r.uid, r))
    return next
  })
  const toggleOne = (row: RosterRow) => setSelected(prev => {
    const next = new Map(prev)
    if (next.has(row.uid)) next.delete(row.uid); else next.set(row.uid, row)
    return next
  })
  const selectedRows = [...selected.values()]

  // Excel export of the CHECKED rows only (not the whole page/filtered set —
  // "selection" here means the checkboxes above, mirroring how the bulk
  // print button already treats a selection). Built client-side since the
  // roster rows are already in memory; humanizeKey (helpers.ts, shared
  // with the Complete Detail grid) turns raw column names into sheet
  // headers instead of exporting e.g. "current_income_inr" verbatim.
  const handleExportSelected = async () => {
    if (!selectedRows.length) return
    setExporting(true)
    try {
      const XLSX: any = await import('xlsx')
      const exportRows = selectedRows.map(r => {
        const out: Record<string, unknown> = {}
        Object.entries(r).forEach(([k, v]) => {
          if (k === 'id') return
          out[humanizeKey(k)] = v
        })
        return out
      })
      const ws = XLSX.utils.json_to_sheet(exportRows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, config.label.slice(0, 31))
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
      saveAs(new Blob([buf], { type: 'application/octet-stream' }), `${config.label.replace(/\s+/g, '_')}_selected.xlsx`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="flex items-center gap-3 flex-wrap">
        {/* State/District/Block/Village options are now scoped server-side
            to whichever ANCESTOR filters are already picked (see
            routes/individual-beneficiaries.routes.js's scopedDistinct) —
            so picking a new ancestor must also clear its now-stale
            descendants here, or a leftover District from a different State
            would keep being sent and silently zero out the results. */}
        <select value={state} onChange={e => { setState(e.target.value); setDistrict(''); setBlock(''); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All States</option>
          {data.states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={district} onChange={e => { setDistrict(e.target.value); setBlock(''); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Districts</option>
          {data.districts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={block} onChange={e => { setBlock(e.target.value); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Blocks</option>
          {data.blocks.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={village} onChange={e => setVillage(e.target.value)} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Villages</option>
          {data.villages.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <div style={{ position: 'relative', minWidth: 240 }}>
          <Search className="w-3.5 h-3.5" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: FF.textFaint }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={config.searchPlaceholder}
            className="rounded-lg pl-8 pr-3 py-2 text-sm outline-none w-full"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
          />
        </div>
        {(data.rows.length > 0 || selectedRows.length > 0) && (
          <button
            onClick={() => onBulkPrint(selectedRows.length > 0 ? selectedRows : data.rows)}
            title={selectedRows.length > 0 ? 'Print an ID card for each selected beneficiary (across however many pages you picked them from)' : 'Print an ID card for every beneficiary on this page'}
            className="ml-auto flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, background: '#fff' }}
          >
            <Printer className="w-3.5 h-3.5" />
            {selectedRows.length > 0 ? `Print Selected (${selectedRows.length})` : `Print ID Cards (${data.rows.length})`}
          </button>
        )}
        {selectedRows.length > 0 && (
          <button
            onClick={handleExportSelected}
            disabled={exporting}
            title="Download the selected beneficiaries as an Excel file"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, background: '#fff' }}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            Download Excel ({selectedRows.length})
          </button>
        )}
        {selectedRows.length > 0 && (
          <button
            onClick={() => setSelected(new Map())}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ color: FF.textMuted }}
          >
            Clear selection
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : loadError ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.red, background: '#FFFFFF', color: FF.red }}>
          {loadError}
        </div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No {config.label.toLowerCase()} records found.
        </div>
      ) : (
        <>
          <KpiGrid cols={config.kpiTiles.length}>
            {config.kpiTiles.map(kt => (
              <KpiTile key={kt.label} label={kt.label} value={kt.value(data.kpis)} note={kt.note?.(data.kpis)} />
            ))}
          </KpiGrid>

          <SectionCard
            title="By Type of Production System"
            titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>No. of {config.label.toLowerCase()} records per system · one can be in several</span>}
          >
            <KpiGrid cols={PRODUCTION_TILES.length}>
              {PRODUCTION_TILES.map(pt => (
                <KpiTile key={pt.label} label={pt.label} value={data.kpis[pt.countKey] ?? 0} note={pt.note(data.kpis)} />
              ))}
            </KpiGrid>
          </SectionCard>

          <SectionCard noPadding>
            {/* Desktop/tablet — real grid "table" (≥ md; below that a
                7-column layout would need 800px+ to stay legible, so the
                same rows render as cards instead — see the md:hidden block
                below). */}
            <div className="hidden md:flex md:flex-col">
              <div style={{ display: 'grid', gridTemplateColumns: '28px 110px 1.3fr 1fr 110px 100px 90px 36px', gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} title="Select all on this page" style={{ width: 15, height: 15, cursor: 'pointer' }} />
                <div>UID</div><div>Name</div><div>Detail</div><div>Contact</div><div>Location</div><div /><div />
              </div>
              {data.rows.map(r => (
                <div
                  key={r.id}
                  onClick={() => onSelectUid(r.uid)}
                  className="cursor-pointer"
                  style={{ display: 'grid', gridTemplateColumns: '28px 110px 1.3fr 1fr 110px 100px 90px 36px', gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13, background: selected.has(r.uid) ? FF.bg : undefined }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.uid)}
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggleOne(r)}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                  />
                  <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                  <div style={{ color: FF.tealDark, fontWeight: 500 }}>{config.nameOf(r)}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{config.subLabelOf(r)}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.village || r.block || '—'}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: FF.purple }}>View →</div>
                  <button
                    onClick={e => { e.stopPropagation(); onShowCard(r) }}
                    title="Print ID card"
                    style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${FF.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}
                  >
                    <QrCode className="w-3.5 h-3.5" style={{ color: FF.tealDark }} />
                  </button>
                </div>
              ))}
            </div>

            {/* Mobile — one card per row instead of a 7-column
                horizontally-scrolling table. */}
            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {data.rows.map(r => (
                <div key={r.id} onClick={() => onSelectUid(r.uid)} className="p-4 cursor-pointer" style={{ background: selected.has(r.uid) ? FF.bg : undefined }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={selected.has(r.uid)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleOne(r)}
                        className="shrink-0 mt-0.5"
                        style={{ width: 15, height: 15, cursor: 'pointer' }}
                      />
                      <div className="min-w-0">
                        <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                        <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{config.nameOf(r)}</div>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); onShowCard(r) }}
                      title="Print ID card"
                      className="shrink-0"
                      style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${FF.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}
                    >
                      <QrCode className="w-3.5 h-3.5" style={{ color: FF.tealDark }} />
                    </button>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 12.5 }}>{config.subLabelOf(r)}</div>
                  <div className="mt-2 flex items-center justify-between" style={{ fontSize: 12, color: FF.textMuted }}>
                    <span>{r.contact_no || '—'} · {r.village || r.block || '—'}</span>
                    <span style={{ fontWeight: 600, color: FF.purple }}>View →</span>
                  </div>
                </div>
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40" style={{ borderColor: FF.border, color: FF.tealDark }}>Previous</button>
                <span className="text-xs" style={{ color: FF.textFaint }}>
                  Page {page + 1} of {pageCount} · {data.totalRows} records
                  {selectedRows.length > 0 && ` · ${selectedRows.length} selected across pages`}
                </span>
                <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40" style={{ borderColor: FF.border, color: FF.tealDark }}>Next</button>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
