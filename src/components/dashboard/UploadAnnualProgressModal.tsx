// Upload one FY+Month snapshot of an Annual Progress Report (cumulative achievement to date).
// Columns are found by label: every column between "Achievement" and "Related Link" is a
// location. activity_name is the upsert identity (S.N. is blank in real exports); FY and
// Month come from the UI, never the file.

import { useCallback, useState } from 'react'
import { Upload, Download, X, Loader2, AlertCircle, CheckCircle2, FileSpreadsheet } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { FF } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'

const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'] as const
type Month = typeof MONTHS[number]

function defaultFYStartYear() {
  const now = new Date()
  const y = now.getFullYear()
  return now.getMonth() + 1 >= 4 ? y : y - 1
}
function fyLabel(y: number) {
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}
function defaultMonth(): Month {
  const short = new Date().toLocaleDateString('en-US', { month: 'short' }) as Month
  return MONTHS.includes(short) ? short : 'Apr'
}

type ParsedRow = {
  sn: number
  activity: string
  target: number | null
  achievement_total: number | null
  locations: Record<string, number | null>
  related_link: string | null
  remark: string | null
}
type Parsed = { rows: ParsedRow[]; locationNames: string[] }

export function UploadAnnualProgressModal({ planId, onClose, onUploaded }: {
  planId:     string
  onClose:    () => void
  onUploaded: (info: { fy_start_year: number; month: string; count: number }) => void
}) {
  const [fyStartYear, setFyStartYear] = useState(defaultFYStartYear())
  const [month, setMonth]             = useState<Month>(defaultMonth())
  const [mode, setMode]               = useState<'template' | 'ai'>('template')
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<Parsed | null>(null)
  const [error, setError]             = useState('')
  const [uploading, setUploading]     = useState(false)
  const [dragOver, setDragOver]       = useState(false)

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const XLSX: any = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb  = XLSX.read(buf, { type: 'array' })
      const ws  = wb.Sheets[wb.SheetNames[0]]
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

      const norm = (v: any) => String(v || '').trim().toLowerCase()
      const headerIdx = rows.findIndex(r => /s\.?n\.?/i.test(norm(r[0])))
      if (headerIdx < 0) throw new Error('Header row not found (no "S.N." in column A)')
      const header = rows[headerIdx]
      const subheader = rows[headerIdx + 1] || []

      const snIdx       = header.findIndex(c => /s\.?n\.?/i.test(norm(c)))
      const activityIdx = header.findIndex(c => norm(c).includes('activity'))
      const targetIdx   = header.findIndex(c => norm(c).includes('target'))
      const achIdx      = header.findIndex(c => norm(c) === 'achievement')
      const linkIdx      = header.findIndex(c => norm(c).includes('related link'))
      const remarkIdx    = header.findIndex(c => norm(c).includes('remark'))
      if (activityIdx < 0) throw new Error('"Activity/Deliverables" column not found')
      if (achIdx < 0 || linkIdx < 0 || linkIdx <= achIdx) {
        throw new Error('Could not locate the "Achievement" / "Related Link" header columns')
      }

      const locationCols: { col: number; location: string }[] = []
      for (let c = achIdx + 1; c < linkIdx; c++) {
        const label = String(subheader[c] || '').trim()
        if (label) locationCols.push({ col: c, location: label })
      }
      if (!locationCols.length) throw new Error('No location columns found between "Achievement" and "Related Link"')

      const num = (v: any): number | null => {
        if (v === '' || v == null) return null
        const n = Number(v)
        return isNaN(n) || !isFinite(n) ? null : n
      }

      // sheet_to_json returns displayed text only, so a hyperlinked "View Photo" cell would store
      // the label as the link. Prefer the cell's hyperlink target (.l.Target).
      const linkAt = (r: number, c: number): string | null => {
        if (c < 0) return null
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        if (!cell) return null
        const target = cell.l?.Target
        if (target) return String(target).trim()
        return String(cell.v ?? '').trim() || null
      }

      const parsedRows: ParsedRow[] = []
      let position = 0
      for (let r = headerIdx + 2; r < rows.length; r++) {
        const row = rows[r]
        if (!row) continue
        const activity = String(row[activityIdx] || '').trim()
        if (!activity) continue
        position += 1
        const locations: Record<string, number | null> = {}
        for (const { col, location } of locationCols) locations[location] = num(row[col])
        parsedRows.push({
          sn: num(row[snIdx]) ?? position,
          activity,
          target: targetIdx >= 0 ? num(row[targetIdx]) : null,
          achievement_total: num(row[achIdx]),
          locations,
          related_link: linkAt(r, linkIdx),
          remark: remarkIdx >= 0 ? (String(row[remarkIdx] || '').trim() || null) : null,
        })
      }
      if (!parsedRows.length) throw new Error('No activity rows found below the header')

      setParsed({ rows: parsedRows, locationNames: locationCols.map(l => l.location) })
    } catch (e: any) {
      setError(e.message || 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }, [])

  // Any-format path: the server extracts the file's text and has Gemini restructure it into
  // the same { rows, locationNames } shape as the template parser.
  const handleFileAI = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const r = await apiFetch('/api/ai-extract/annual-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, file_type: file.type, data: dataUrl }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'AI extraction failed'); setParsing(false); return }
      setParsed(d)
    } catch (e: any) {
      setError(e.message || 'AI extraction failed')
    } finally {
      setParsing(false)
    }
  }, [])

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
      const r = await apiFetch(`/api/action-plans/${planId}/annual-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fy_start_year: fyStartYear, month, rows: parsed.rows }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Upload failed'); setUploading(false); return }
      onUploaded({ fy_start_year: fyStartYear, month, count: d.count ?? parsed.rows.length })
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setUploading(false)
  }

  const fyOptions = [fyStartYear - 1, fyStartYear, fyStartYear + 1]
    .filter((y, i, arr) => arr.indexOf(y) === i)
    .sort((a, b) => a - b)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-xl max-h-[92vh] sm:max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: FF.border }}>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" style={{ color: FF.purple }} />
            <h3 className="font-bold" style={{ color: FF.tealDark }}>Upload Annual Progress Report</h3>
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
            <div className="rounded-xl p-3 flex items-center gap-3" style={{ background: FF.bg, border: `1px solid ${FF.border}` }}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold" style={{ color: FF.tealDark }}>Download the template</div>
                <div className="text-[11px]" style={{ color: FF.textMuted }}>S.N. / Activity / Target / Achievement / per-location / Related Link / Remark, with sample rows.</div>
              </div>
              <button
                onClick={() => authedDownload('/api/action-plans/annual-progress-template.xlsx', 'annual-progress-template.xlsx').catch(e => setError('Download failed: ' + e.message))}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white shrink-0"
                style={{ background: FF.purple }}
              >
                <Download className="w-3.5 h-3.5" /> Template
              </button>
            </div>
          )}

          {mode === 'ai' && (
            <div className="rounded-xl p-3 text-xs" style={{ background: '#EEF2FF', border: '1px solid #C7D2FE', color: '#3730A3' }}>
              Upload a PDF, Word doc, or any spreadsheet — even one that doesn't match the template layout.
              AI extracts the activities, targets, and per-location achievement figures. <strong>Review the preview below carefully before saving.</strong>
            </div>
          )}

          {/* Financial Year + Month: always explicit, never parsed from the file */}
          <div className="rounded-xl p-3" style={{ background: FF.bg, border: `1px solid ${FF.border}` }}>
            <div className="text-[11px] font-semibold mb-2" style={{ color: FF.textMuted }}>
              This snapshot is "as of" which Financial Year and Month?
            </div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <select
                value={fyStartYear}
                onChange={e => setFyStartYear(Number(e.target.value))}
                disabled={uploading}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
              >
                {fyOptions.map(y => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
              </select>
            </div>
            <TabPill
              tabs={MONTHS.map(m => ({ key: m, label: m }))}
              active={month}
              onChange={setMonth}
              size="xs"
            />
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
                : (mode === 'ai' ? 'Drop any file here or click to choose' : 'Drop the Annual Progress .xlsx here or click to choose')}
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
                <div><strong style={{ color: FF.tealDark }}>FY:</strong> {fyLabel(fyStartYear)} &nbsp; <strong style={{ color: FF.tealDark }}>Month:</strong> {month}</div>
                <div><strong style={{ color: FF.tealDark }}>Activities:</strong> {parsed.rows.length}</div>
                <div><strong style={{ color: FF.tealDark }}>Locations:</strong> {parsed.locationNames.join(', ')}</div>
                <div className="mt-2 max-h-32 overflow-auto text-[10px]">
                  {parsed.rows.slice(0, 5).map(r => (
                    <div key={r.sn}>• {r.sn}. {r.activity} — target {r.target ?? '—'}, achieved {r.achievement_total ?? '—'}</div>
                  ))}
                  {parsed.rows.length > 5 && <div className="italic">…and {parsed.rows.length - 5} more</div>}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} disabled={uploading}
              className="px-4 py-2 rounded-xl text-sm font-semibold border disabled:opacity-50"
              style={{ borderColor: FF.border, color: FF.textMuted }}>
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!parsed || uploading}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {uploading ? 'Saving…' : 'Save Snapshot'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
