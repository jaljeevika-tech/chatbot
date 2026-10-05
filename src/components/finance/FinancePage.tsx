import { useState, useEffect, useMemo } from 'react'
import { ArrowLeft, Download, Search, Loader2, AlertCircle, RefreshCw } from 'lucide-react'

const C = {
  bg:      '#F2F7F8',   // FF.bg
  sidebar: '#341272',
  dark:    '#0E3A46',   // FF.tealDark
  lime:    '#A78BFA',
  surface: '#D9E6E8',   // FF.border
  muted:   '#86A0A5',   // FF.textFaint
}

type Row = Record<string, unknown>

function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return true
  if (typeof v === 'string') return v.trim() !== '' && !isNaN(Number(v))
  return false
}

function isDateLike(v: unknown): boolean {
  if (!v) return false
  const s = String(v)
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s)
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') {
    // BigQuery DATE/TIMESTAMP often comes as { value: '...' }
    const obj = v as Record<string, unknown>
    if ('value' in obj) return fmtCell(obj.value)
    return JSON.stringify(v)
  }
  if (isDateLike(v)) {
    const d = new Date(String(v))
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    }
  }
  if (isNumeric(v)) {
    const n = Number(v)
    return Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  }
  return String(v)
}

function downloadCSV(rows: Row[], filename: string) {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const header = cols.join(',')
  const body = rows.map(r =>
    cols.map(c => {
      const v = fmtCell(r[c])
      return v.includes(',') ? `"${v}"` : v
    }).join(',')
  ).join('\n')
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function SummaryCards({ rows }: { rows: Row[] }) {
  if (!rows.length) return null
  const cols = Object.keys(rows[0])

  const numCols = cols.filter(c => isNumeric(rows[0][c]))
  const cards: { label: string; value: string }[] = [
    { label: 'Total Records', value: rows.length.toLocaleString('en-IN') },
    ...numCols.slice(0, 3).map(c => {
      const sum = rows.reduce((s, r) => s + (Number(r[c]) || 0), 0)
      return {
        label: c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        value: sum.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
      }
    }),
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      {cards.map(card => (
        <div key={card.label} className="rounded-2xl p-4" style={{ background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' }}>
          <div className="text-xl font-serif font-semibold" style={{ color: C.dark }}>{card.value}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mt-1" style={{ color: C.muted }}>{card.label}</div>
        </div>
      ))}
    </div>
  )
}

function DataTable({ rows, search }: { rows: Row[]; search: string }) {
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const cols = rows.length ? Object.keys(rows[0]) : []

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      Object.values(r).some(v => fmtCell(v).toLowerCase().includes(q))
    )
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sortCol) return filtered
    return [...filtered].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol]
      if (isNumeric(av) && isNumeric(bv)) {
        return sortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av)
      }
      const as = fmtCell(av), bs = fmtCell(bv)
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
  }, [filtered, sortCol, sortDir])

  function toggleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  if (!rows.length) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-sm font-medium">No records found.</p>
      </div>
    )
  }

  return (
    <div className="overflow-auto rounded-2xl" style={{ boxShadow: '0 1px 6px rgba(0,0,0,0.07)' }}>
      <table className="w-full text-[11px] sm:text-xs border-collapse min-w-max">
        <thead>
          <tr style={{ background: C.sidebar }}>
            {cols.map(col => (
              <th
                key={col}
                onClick={() => toggleSort(col)}
                className="px-2 sm:px-3 py-2 sm:py-2.5 text-left font-bold text-white cursor-pointer select-none whitespace-nowrap"
                style={{ borderRight: '1px solid rgba(255,255,255,0.1)' }}
              >
                {col.replace(/_/g, ' ')}
                {sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={i}
              style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}
              className="hover:bg-violet-50 transition-colors"
            >
              {cols.map(col => {
                const v = row[col]
                const num = isNumeric(v)
                return (
                  <td
                    key={col}
                    className="px-2 sm:px-3 py-1.5 sm:py-2 whitespace-nowrap"
                    style={{
                      color: num ? C.dark : '#374151',
                      fontWeight: num ? 600 : 400,
                      textAlign: num ? 'right' : 'left',
                      borderBottom: '1px solid #F3F4F6',
                    }}
                  >
                    {fmtCell(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 1000 && (
        <p className="text-[10px] text-center text-gray-400 py-2">
          Showing first 1,000 records
        </p>
      )}
    </div>
  )
}

function TableSection({ endpoint, filename }: { endpoint: string; filename: string }) {
  const [rows,    setRows]    = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await fetch(endpoint)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setRows(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [endpoint])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 gap-3 text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: C.lime }} />
        <span className="text-sm">Loading from BigQuery…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl p-5 flex flex-col items-center gap-3 text-center" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
        <AlertCircle className="w-8 h-8 text-red-400" />
        <p className="text-sm font-semibold text-red-700">Failed to load data</p>
        <p className="text-xs text-red-500 max-w-md">{error}</p>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white mt-1"
          style={{ background: '#B0473C' }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SummaryCards rows={rows} />
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border outline-none bg-white"
            style={{ borderColor: C.surface }}
          />
        </div>
        <button
          onClick={() => downloadCSV(rows, filename)}
          className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold border transition hover:opacity-80 whitespace-nowrap w-full sm:w-auto"
          style={{ borderColor: C.sidebar, color: C.sidebar }}
        >
          <Download className="w-3.5 h-3.5" /> Download CSV
        </button>
      </div>
      <DataTable rows={rows} search={search} />
    </div>
  )
}

type PageTab = 'finance' | 'attendance'

export function FinancePage() {
  const [tab, setTab] = useState<PageTab>('finance')

  function goBack() {
    window.location.hash = ''
  }

  const TABS: { key: PageTab; label: string }[] = [
    { key: 'finance',    label: 'Finance'    },
    { key: 'attendance', label: 'Attendance' },
  ]

  return (
    <div className="min-h-screen" style={{ background: C.bg }}>
      <div className="sticky top-0 z-10 flex items-center gap-3 sm:gap-4 px-4 sm:px-6 py-3 sm:py-4 flex-wrap" style={{ background: C.sidebar }}>
        <button
          onClick={goBack}
          className="flex items-center gap-2 text-white/70 hover:text-white transition-colors text-sm font-semibold"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <div className="h-5 w-px bg-white/20" />
        <span className="text-white font-black text-base tracking-wide">JEMS Data</span>
        <div className="flex items-center gap-1 ml-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-4 py-1.5 rounded-lg text-sm font-bold transition-all"
              style={{
                background: tab === t.key ? 'rgba(255,255,255,0.18)' : 'transparent',
                color:      tab === t.key ? '#fff' : 'rgba(255,255,255,0.55)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {tab === 'finance' && (
          <TableSection
            key="finance"
            endpoint="/api/bq/finance"
            filename="jems_finance.csv"
          />
        )}
        {tab === 'attendance' && (
          <TableSection
            key="attendance"
            endpoint="/api/bq/attendance"
            filename="jems_attendance.csv"
          />
        )}
      </div>
    </div>
  )
}
