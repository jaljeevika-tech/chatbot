// Upload a hierarchical Budget Utilisation Report (Section > Subsection > Line item)
// with one column per calendar month. Sr No only classifies rows; (section, budget_head)
// is the identity the backend upserts on, since real exports don't keep Sr No stable.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Download, X, Loader2, AlertCircle, CheckCircle2, FileSpreadsheet } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { FF } from '../../theme/colors'

type ParsedRow = {
  section: string
  subsection: string | null
  sr_no: string
  budget_head: string
  budget_line_item: string | null
  budget: number | null
  monthly: { period_month: string; expenses: number | null; planned_expenses: number | null }[]
}
type Parsed = { rows: ParsedRow[]; months: string[] }

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

// Apr–Mar FY, matching BudgetUtilisationPage.tsx and the backend's fyStartYearOfMonth().
function defaultFYStartYear() {
  const now = new Date()
  return now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1
}
function fyOfMonth(periodMonth: string): number {
  const [y, m] = periodMonth.split('-').map(Number)
  return m >= 4 ? y : y - 1
}
function fyLabel(y: number): string {
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}
// String compare on 'YYYY-MM' is fine for equality; ordering uses a month index.
function monthToIndex(m: string): number {
  const [y, mo] = m.split('-').map(Number)
  return y * 12 + (mo - 1)
}
// Default period is the sheet's own first..last month; every project has its own
// tracker period, so none is assumed here.
function defaultPeriodForMonths(months: string[]): { from: string; to: string } | null {
  if (!months.length) return null
  return { from: months[0].slice(0, 7), to: months[months.length - 1].slice(0, 7) }
}

export function UploadBudgetUtilisationModal({ planId, fyGrants, onClose, onUploaded }: {
  planId:     string
  fyGrants:   Record<number, number>
  onClose:    () => void
  onUploaded: (info: { count: number; periods: string[]; fy_start_year: number }) => void
}) {
  const [mode, setMode]               = useState<'template' | 'ai'>('template')
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<Parsed | null>(null)
  const [error, setError]             = useState('')
  const [uploading, setUploading]     = useState(false)
  const [dragOver, setDragOver]       = useState(false)
  // Each upload replaces saved data for the months it covers (merging never removed
  // deleted line items or cleared cells). Months outside the file are untouched.
  const [replaceFy, setReplaceFy]     = useState(true)

  // Inclusive 'YYYY-MM' period the Total Budget covers. Only budgetFromMonth decides
  // which FY gets stored.
  const [budgetFromMonth, setBudgetFromMonth] = useState(`${defaultFYStartYear()}-04`)
  const [budgetToMonth, setBudgetToMonth] = useState(`${defaultFYStartYear() + 1}-03`)
  // Everything is tagged to the FY that "From month" falls in; a later FY reached by
  // "To month" gets nothing and must be uploaded separately.
  const fyStartYear = fyOfMonth(budgetFromMonth)
  // Once the admin picks a period by hand, re-parsing must not reset it.
  const periodTouched = useRef(false)
  const applyFileDefaults = useCallback((months: string[]) => {
    if (periodTouched.current) return
    const p = defaultPeriodForMonths(months)
    if (p) { setBudgetFromMonth(p.from); setBudgetToMonth(p.to) }
  }, [])
  // Only months inside From–To are saved.
  const inPeriod = (periodMonth: string) => {
    const i = monthToIndex(periodMonth.slice(0, 7))
    return i >= monthToIndex(budgetFromMonth) && i <= monthToIndex(budgetToMonth)
  }

  // Project-level Total Budget for this period, prefilled from the existing grant when
  // "From month" changes, without clobbering what the admin already typed.
  const [totalBudget, setTotalBudget] = useState(fyGrants[fyStartYear] != null ? String(fyGrants[fyStartYear]) : '')
  useEffect(() => {
    setTotalBudget(fyGrants[fyStartYear] != null ? String(fyGrants[fyStartYear]) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally NOT reacting to fyGrants itself (a fresh object each render), only to the admin changing "From month"
  }, [fyStartYear])

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const XLSX: any = await import('xlsx')
      const buf = await file.arrayBuffer()
      // Not cellDates:true: SheetJS builds the header Date via the local constructor and a
      // rounding error lands just before midnight, so east-of-UTC timezones (IST) read the
      // prior day and every month shifts back by one. Decoding the raw serial with
      // XLSX.SSF.parse_date_code is pure integer arithmetic and exact.
      const wb  = XLSX.read(buf, { type: 'array' })
      const ws  = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

      const norm = (v: any) => String(v ?? '').trim()
      const normLower = (v: any) => norm(v).toLowerCase()

      const headerIdx = rows.findIndex(r => r.some(c => normLower(c).includes('budget head')))
      if (headerIdx < 0) throw new Error('Header row not found (no "Budget Head" column)')
      const header = rows[headerIdx]

      // Matches "Sr No" / "SrNo" as well as "S.No." / "S No" — real exports use both.
      const snIdx     = header.findIndex(c => /^s(r)?\.?\s*no\.?$/i.test(normLower(c)))
      const headIdx   = header.findIndex(c => normLower(c).includes('budget head'))
      // "Budget Line Item" also starts with "budget" and lacks "head" — exclude it so it
      // isn't mistaken for the Budget amount column.
      const blItemIdx = header.findIndex(c => normLower(c).includes('line item'))
      const budgetIdx = header.findIndex(c => {
        const s = normLower(c)
        return s.startsWith('budget') && !s.includes('head') && !s.includes('line item')
      })
      if (snIdx < 0 || headIdx < 0 || budgetIdx < 0) {
        throw new Error('Could not locate required columns (Sr No / Budget Head / Budget)')
      }

      // Month columns: header cells after Budget that parse as dates, normalized to the 1st
      // (headers are usually month-end; period_month is stored as month-start).
      const toMonthStart = (v: any): string | null => {
        let d: Date | null = null
        if (v instanceof Date) d = v
        else if (typeof v === 'number' && v > 0 && XLSX.SSF?.parse_date_code) {
          const p = XLSX.SSF.parse_date_code(v)
          if (p) d = new Date(Date.UTC(p.y, p.m - 1, p.d))
        } else if (typeof v === 'string' && v.trim()) {
          const p = new Date(v)
          if (!isNaN(+p)) d = p
        }
        if (!d || isNaN(+d)) return null
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
      }

      // A month is either a single Actual column or a Plan+Actual pair. A "Plan"/"Actual"
      // sub-header row is used when present; otherwise the header merge structure decides.
      const subHeaderRow = rows[headerIdx + 1] || []
      const isPlanActualLabel = (v: any) => /^(plan|actual)$/i.test(normLower(v))
      const hasPlanActualSubHeader = subHeaderRow.some((c: any) => isPlanActualLabel(c))

      // `!merges` lives on the raw worksheet (sheet_to_json drops it). Within a merge on the
      // date row, only the anchor column's date is trusted: covered cells keep hidden values,
      // and copy-pasted trackers can leave stale dates there.
      const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = (ws as any)['!merges'] || []
      const anchorCols = new Set<number>()       // columns that anchor a 2+-column header-row merge
      const coveredToAnchor = new Map<number, number>() // covered column -> its merge's anchor column
      for (const m of merges) {
        if (m.s.r !== headerIdx || m.e.r !== headerIdx || m.e.c <= m.s.c) continue
        anchorCols.add(m.s.c)
        for (let c = m.s.c + 1; c <= m.e.c; c++) coveredToAnchor.set(c, m.s.c)
      }

      // A covered cell's date never advances carryMonth; the anchor to its left already set
      // the month. Unmerged sheets anchor every column off its own date.
      let carryMonth: string | null = null
      const monthCols = new Map<string, { planCol: number | null; actualCol: number | null }>()
      for (let c = budgetIdx + 1; c < header.length; c++) {
        const isCovered = coveredToAnchor.has(c)
        const asDate = toMonthStart(header[c])
        const label = normLower(subHeaderRow[c])
        if (asDate && !isCovered) carryMonth = asDate
        const isLabelled = label === 'plan' || label === 'actual'
        const isPaired = anchorCols.has(c) || isCovered // part of a Plan/Actual merge pair even without its own date/label
        if (!asDate && !isLabelled && !isPaired) continue // nothing here ties this column to any month at all
        if (!carryMonth) continue // nothing dated has appeared yet to anchor this column to
        const entry = monthCols.get(carryMonth) || { planCol: null, actualCol: null }
        if (label === 'plan') entry.planCol = c
        else if (label === 'actual') entry.actualCol = c
        else if (anchorCols.has(c)) entry.planCol = entry.planCol ?? c     // merged pair, no text label — anchor is Plan
        else if (isCovered) entry.actualCol = entry.actualCol ?? c        // merged pair, no text label — covered cell is Actual
        else entry.actualCol = entry.actualCol ?? c                        // no merge, no label at all — old single-column format
        monthCols.set(carryMonth, entry)
      }
      if (!monthCols.size) throw new Error('No month columns found (expected real dates in the header row after "Budget")')
      const dataStartIdx = hasPlanActualSubHeader ? headerIdx + 2 : headerIdx + 1

      const num = (v: any): number | null => {
        if (v === '' || v == null) return null
        const n = Number(v)
        return isNaN(n) || !isFinite(n) ? null : n
      }

      const parsedRows: ParsedRow[] = []
      let currentSection: string | null = null
      let currentSubsection: string | null = null

      for (let r = dataStartIdx; r < rows.length; r++) {
        const row = rows[r]
        if (!row) continue
        const sn = norm(row[snIdx])
        const head = norm(row[headIdx])

        if (!sn && !head) continue // blank spacer row
        if (!sn && /^sub\s*total/i.test(head)) continue    // derived subtotal — recompute, never stored
        if (!sn && /^total\b/i.test(head)) continue          // derived section total — recompute
        if (!sn && /^grand\s*total$/i.test(head)) continue   // derived grand total — recompute

        const budgetVal = num(row[budgetIdx])
        const monthly = [...monthCols.entries()].map(([period_month, { planCol, actualCol }]) => ({
          period_month,
          expenses: actualCol != null ? num(row[actualCol]) : null,
          planned_expenses: planCol != null ? num(row[planCol]) : null,
        }))
        // A zero doesn't count as an amount. A stray 0 on a bare section-header row would
        // otherwise turn it into a line item and misfile every following row under the
        // previous section. Real flat-format line items always carry a non-zero figure.
        const hasAmounts = (budgetVal != null && budgetVal !== 0)
          || monthly.some(m => (m.expenses != null && m.expenses !== 0) || (m.planned_expenses != null && m.planned_expenses !== 0))

        // Two conventions: (a) nested — numbered rows are bare section labels and only
        // "T..." rows carry figures; (b) flat — every numbered row carries figures.
        // Having amounts, not the Sr No shape, decides label vs line item.
        if (!hasAmounts && /^\d+$/.test(sn)) { currentSection = head; currentSubsection = null; continue }
        if (!hasAmounts && /^\d+\.\d+$/.test(sn)) { currentSubsection = head; continue }
        if (!hasAmounts && !/^t\s*/i.test(sn)) continue // label-shaped row with nothing to record

        if (!head) continue // amounts with no name — malformed, skip defensively
        parsedRows.push({
          section: currentSection || 'General', // flat sheets never set a section label
          subsection: currentSubsection,
          sr_no: sn || String(parsedRows.length + 1),
          budget_head: head,
          budget_line_item: blItemIdx >= 0 ? (norm(row[blItemIdx]) || null) : null,
          budget: budgetVal,
          monthly,
        })
      }
      if (!parsedRows.length) throw new Error('No line items found below the header')

      const months = [...monthCols.keys()].sort()
      setParsed({ rows: parsedRows, months })
      applyFileDefaults(months)
    } catch (e: any) {
      setError(e.message || 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }, [applyFileDefaults])

  // Any-format path: the server extracts text (PDF/Word/any Excel) and has Gemini
  // restructure it into the same { rows, months } shape as the template parser.
  const handleFileAI = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const r = await apiFetch('/api/ai-extract/budget-utilisation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, file_type: file.type, data: dataUrl }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'AI extraction failed'); setParsing(false); return }
      setParsed(d)
      applyFileDefaults(d.months || [])
    } catch (e: any) {
      setError(e.message || 'AI extraction failed')
    } finally {
      setParsing(false)
    }
  }, [applyFileDefaults])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) (mode === 'ai' ? handleFileAI(f) : handleFile(f))
  }, [mode, handleFile, handleFileAI])

  const handleConfirm = async () => {
    if (!parsed) return
    setUploading(true); setError('')
    try {
      if (monthToIndex(budgetFromMonth) > monthToIndex(budgetToMonth)) {
        setError('"From month" must be the same as or earlier than "To month"'); setUploading(false); return
      }
      const trimmed = totalBudget.trim()
      const parsedTotalBudget = trimmed === '' ? null : Number(trimmed)
      if (parsedTotalBudget !== null && isNaN(parsedTotalBudget)) { setError('Total Budget must be a number'); setUploading(false); return }
      const fyGrants = parsedTotalBudget != null
        ? [{ fy_start_year: fyStartYear, total_budget: parsedTotalBudget, period_from: `${budgetFromMonth}-01`, period_to: `${budgetToMonth}-01` }]
        : undefined
      const savedMonths = parsed.months.filter(inPeriod)
      if (!savedMonths.length) {
        setError('None of this file\'s months fall between "From month" and "To month"'); setUploading(false); return
      }
      const rows = parsed.rows.map(r => ({ ...r, monthly: r.monthly.filter(m => inPeriod(m.period_month)) }))
      const r = await apiFetch(`/api/action-plans/${planId}/budget-utilisation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows, fy_start_year: fyStartYear, ...(fyGrants ? { fy_grants: fyGrants } : {}),
          ...(replaceFy && savedMonths.length ? { replace_period: { from: savedMonths[0], to: savedMonths[savedMonths.length - 1] } } : {}),
        }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Upload failed'); setUploading(false); return }
      onUploaded({ count: d.count ?? rows.length, periods: d.periods ?? parsed.months.filter(inPeriod), fy_start_year: fyStartYear })
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setUploading(false)
  }

  const sections = parsed ? [...new Set(parsed.rows.map(r => r.section))] : []

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-xl max-h-[92vh] sm:max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: FF.border }}>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" style={{ color: FF.purple }} />
            <h3 className="font-bold" style={{ color: FF.tealDark }}>Upload Budget Utilisation Report</h3>
          </div>
          <button onClick={onClose} disabled={uploading} className="disabled:opacity-50" style={{ color: FF.textFaint }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex rounded-xl border p-1 text-xs font-semibold" style={{ borderColor: FF.border, background: FF.bg }}>
            <button
              onClick={() => { setMode('template'); setParsed(null); setError('') }}
              className="flex-1 py-1.5 rounded-lg transition"
              style={mode === 'template' ? { background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)', color: FF.tealDark } : { color: FF.textFaint }}
            >
              Excel template
            </button>
            <button
              onClick={() => { setMode('ai'); setParsed(null); setError('') }}
              className="flex-1 py-1.5 rounded-lg transition"
              style={mode === 'ai' ? { background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)', color: FF.tealDark } : { color: FF.textFaint }}
            >
              Any file (AI-assisted)
            </button>
          </div>

          {mode === 'template' && (
            <>
              <div className="rounded-xl p-3 flex items-center gap-3" style={{ background: FF.bg, border: `1px solid ${FF.border}` }}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold" style={{ color: FF.tealDark }}>Download the template</div>
                  <div className="text-[11px]" style={{ color: FF.textMuted }}>Section &gt; Subsection &gt; Line item, Plan + Actual columns per month, with sample rows.</div>
                </div>
                <button
                  onClick={() => authedDownload('/api/action-plans/budget-utilisation-template.xlsx', 'budget-utilisation-template.xlsx').catch(e => setError('Download failed: ' + e.message))}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white shrink-0"
                  style={{ background: FF.purple }}
                >
                  <Download className="w-3.5 h-3.5" /> Template
                </button>
              </div>

              <div className="rounded-xl p-3 text-xs" style={{ background: FF.bg, border: `1px solid ${FF.border}`, color: FF.textMuted }}>
                Months are read directly from the sheet's own header row (real dates) — a project can start in any
                calendar month. Each month has a Plan and an Actual column (see the sub-header row under each
                month's date) — leave Plan blank for anything not yet planned; a sheet with Actual-only columns
                (no Plan) still uploads fine. Re-uploading a fuller version of this file (more months filled in)
                only adds data; it never blanks a month that already has a value.
              </div>
            </>
          )}

          {mode === 'ai' && (
            <div className="rounded-xl p-3 text-xs" style={{ background: '#EEF2FF', border: '1px solid #C7D2FE', color: '#3730A3' }}>
              Upload a PDF, Word doc, or any spreadsheet — even one that doesn't match the template layout.
              AI extracts the sections, line items, and monthly figures. <strong>Review the preview below carefully before saving.</strong>
            </div>
          )}

          <div>
            <label className="text-xs font-bold block mb-1" style={{ color: FF.tealDark }}>Total Budget (₹)</label>
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1">
                <label className="text-[10px] block mb-0.5" style={{ color: FF.textFaint }}>From month</label>
                <input
                  type="month"
                  value={budgetFromMonth}
                  onChange={e => { periodTouched.current = true; setBudgetFromMonth(e.target.value) }}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] block mb-0.5" style={{ color: FF.textFaint }}>To month</label>
                <input
                  type="month"
                  value={budgetToMonth}
                  onChange={e => { periodTouched.current = true; setBudgetToMonth(e.target.value) }}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
                />
              </div>
            </div>
            <input
              type="number"
              value={totalBudget}
              onChange={e => setTotalBudget(e.target.value)}
              placeholder="Leave blank to keep this period's current Total Budget"
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{ border: `1.5px solid ${FF.border}` }}
            />
            <div className="text-[11px] mt-1" style={{ color: monthToIndex(budgetFromMonth) > monthToIndex(budgetToMonth) ? FF.red : FF.textFaint }}>
              {monthToIndex(budgetFromMonth) > monthToIndex(budgetToMonth)
                ? '"From month" must be the same as or earlier than "To month".'
                : `Only this file's months from "From month" to "To month" are saved. Total Budget is this project's own headline grant figure for this period — separate from each line item's Budget column below. It's recorded for exactly this From–To period, and the Financial Tracker's Total Budget / Expenses / Balance cards are measured over the same period. Leave blank to keep it unchanged.`}
            </div>
          </div>

          <label
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            className="block cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition"
            style={{
              borderColor: dragOver ? FF.purple : FF.border,
              background: dragOver ? FF.bg : '#FFFFFF',
            }}
          >
            <Upload className="w-7 h-7 mx-auto mb-1.5" style={{ color: dragOver ? FF.purple : FF.textFaint }} />
            <div className="text-xs font-semibold" style={{ color: FF.tealDark }}>
              {parsing
                ? (mode === 'ai' ? 'Reading with AI…' : 'Parsing…')
                : (mode === 'ai' ? 'Drop any file here or click to choose' : 'Drop the Budget Utilisation .xlsx here or click to choose')}
            </div>
            <input
              type="file"
              accept={mode === 'ai' ? '.pdf,.doc,.docx,.xls,.xlsx,.csv,.odt,.ods,.rtf,.html,.htm' : '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) (mode === 'ai' ? handleFileAI(f) : handleFile(f)) }}
              disabled={parsing || uploading}
            />
          </label>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {parsed && (
            <div className="rounded-xl p-4" style={{ border: `2px solid ${FF.purple}` }}>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4" style={{ color: FF.green }} />
                <span className="text-sm font-bold" style={{ color: FF.tealDark }}>Preview</span>
              </div>
              <div className="space-y-1 text-xs" style={{ color: FF.textMuted }}>
                <div>
                  <strong style={{ color: FF.tealDark }}>Months detected:</strong> {parsed.months.length}
                  {parsed.months.length > 0 && (
                    <span className="text-gray-400 ml-1">({monthLabel(parsed.months[0])} – {monthLabel(parsed.months[parsed.months.length - 1])})</span>
                  )}
                </div>
                {(() => {
                  const saved = parsed.months.filter(inPeriod)
                  return (
                    <div>
                      <strong style={{ color: FF.tealDark }}>Months to save:</strong> {saved.length}
                      {saved.length > 0 && <span className="text-gray-400 ml-1">({monthLabel(saved[0])} – {monthLabel(saved[saved.length - 1])}, FY {fyLabel(fyStartYear)})</span>}
                      {saved.length < parsed.months.length && <span className="ml-1" style={{ color: FF.textFaint }}>— {parsed.months.length - saved.length} outside the period skipped</span>}
                    </div>
                  )
                })()}
                <div><strong style={{ color: FF.tealDark }}>Line items:</strong> {parsed.rows.length}</div>
                <div><strong style={{ color: FF.tealDark }}>Sections:</strong> {sections.join(', ')}</div>
                <div className="mt-2 max-h-32 overflow-auto text-[10px]">
                  {parsed.rows.slice(0, 5).map((r, i) => {
                    const filledActual = r.monthly.filter(m => m.expenses != null).length
                    const filledPlan = r.monthly.filter(m => m.planned_expenses != null).length
                    return (
                      <div key={i}>• {r.sr_no} {r.budget_head}{r.budget_line_item ? ` (${r.budget_line_item})` : ''} — budget {r.budget ?? '—'}, {filledActual} month(s) actual, {filledPlan} month(s) planned</div>
                    )
                  })}
                  {parsed.rows.length > 5 && <div className="italic">…and {parsed.rows.length - 5} more</div>}
                </div>
              </div>
            </div>
          )}

          {parsed && (
            <label className="flex items-start gap-2 text-xs cursor-pointer" style={{ color: FF.textMuted }}>
              <input type="checkbox" checked={replaceFy} onChange={e => setReplaceFy(e.target.checked)} className="mt-0.5" />
              <span>
                {(() => {
                  const saved = parsed.months.filter(inPeriod)
                  const range = saved.length ? `${monthLabel(saved[0])} – ${monthLabel(saved[saved.length - 1])}` : 'these months'
                  return <>
                    <strong style={{ color: FF.tealDark }}>Replace saved data for {range}</strong> — this sheet becomes the new version
                    of those months only; any other month already saved is kept as it is (Total Budget is kept unless you enter a
                    new one). Untick to only add/fill in figures on top of what's saved.
                  </>
                })()}
              </span>
            </label>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} disabled={uploading}
              className="px-4 py-2 rounded-xl text-sm font-semibold border disabled:opacity-50"
              style={{ borderColor: FF.border, color: FF.textMuted }}>
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!parsed || uploading || monthToIndex(budgetFromMonth) > monthToIndex(budgetToMonth)}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {uploading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
