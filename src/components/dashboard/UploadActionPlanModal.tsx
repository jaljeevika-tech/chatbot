// Action Plan upload: download template, parse the .xlsx client-side, preview, then POST to /api/action-plans.

import { useState, useCallback } from 'react'
import {
  Upload, Download, X, Loader2, AlertCircle, CheckCircle2, FileSpreadsheet,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'

const C = { purple: '#341272', green: '#3F7D5C', amber: '#d97706', red: '#dc2626', border: '#D9E6E8' }

type ParsedPlan = {
  name:         string
  year:         number | null
  start_month:  number
  locations:    string[]
  activities:   Array<{
    sn:             number
    activity:       string
    category:       string
    unit:           string
    times:          string
    responsibility: string
    description:    string
    process:        string
    locations:      Array<{
      location: string
      monthly:  Record<string, { target: number | null; achieved: number | null }>
    }>
  }>
}

export function UploadActionPlanModal({ onClose, onUploaded, existingPlanKey, existingPlanName }: {
  onClose:    () => void
  onUploaded: (plan: { id: string; name: string }) => void
  // Set when opened from an existing project's Action Plan tab; pins the upload to that
  // plan. Undefined only for the first upload, where the file's Name/Year create one.
  existingPlanKey?:  string
  existingPlanName?: string
}) {
  const [mode,       setMode]       = useState<'template' | 'ai'>('template')
  const [parsing,    setParsing]    = useState(false)
  const [parsed,     setParsed]     = useState<ParsedPlan | null>(null)
  const [error,      setError]      = useState('')
  const [uploading,  setUploading]  = useState(false)
  const [dragOver,   setDragOver]   = useState(false)

  // Any-format path: the server extracts text (PDF/Word/any Excel) and has Gemini
  // restructure it into the same ParsedPlan shape as the template parser.
  const handleFileAI = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const r = await apiFetch('/api/ai-extract/action-plan', {
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

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setParsed(null)
    try {
      const XLSX: any = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb  = XLSX.read(buf, { type: 'array' })

      // Plan Info sheet (optional)
      const info = wb.Sheets['Plan Info']
      let name = '', year: number | null = null, start_month = 4
      let locationsFromInfo: string[] = []
      if (info) {
        const infoRows: any[][] = XLSX.utils.sheet_to_json(info, { header: 1, defval: '' })
        const get = (label: string) => {
          const row = infoRows.find(r => String(r[0] || '').toLowerCase().trim() === label.toLowerCase())
          return row ? String(row[1] ?? '').trim() : ''
        }
        name              = get('Name')
        year              = parseInt(get('Year')) || null
        start_month       = parseInt(get('Start Month')) || 4
        locationsFromInfo = get('Locations').split(',').map(s => s.trim()).filter(Boolean)
      }
      if (!name) name = file.name.replace(/\.xlsx$/i, '').trim() || 'Untitled Plan'

      // Monthly Plan sheet. Matches any name containing "Monthly", which also covers the
      // original Kosi sheet name "Monthly Plan- April 26 - March ".
      const monthlyKey = Object.keys(wb.Sheets).find(k => /monthly/i.test(k))
      if (!monthlyKey) throw new Error('No "Monthly Plan" sheet found (case-insensitive, must include the word "Monthly")')
      const mp = wb.Sheets[monthlyKey]
      const mpRows: any[][] = XLSX.utils.sheet_to_json(mp, { header: 1, defval: '' })

      // Header row = first row with 'S.N.' in column A; col 7 is 'Category' in the new template, 'Apr' in the Kosi one.
      const headerIdx = mpRows.findIndex(r => /s\.?n\.?/i.test(String(r[0] || '')))
      if (headerIdx < 0) throw new Error('Monthly Plan sheet: header row not found (no "S.N." in column A)')
      const h1 = mpRows[headerIdx]
      const hasCategory = /category/i.test(String(h1[7] || ''))
      // Column positions:
      //   With Category:    Apr-T = 8,  Location = 9,  May-T = 10, May-A = 11, ...
      //   Without Category: Apr-T = 7,  Location = 8,  May-T = 9,  May-A = 10, ...
      const APR_T_COL = hasCategory ? 8 : 7
      const LOC_COL   = hasCategory ? 9 : 8
      const MAY_T_COL = hasCategory ? 10 : 9

      const validCats = new Set(['capacity','livelihood','enterprise','community','technology'])
      const activities: ParsedPlan['activities'] = []
      let current: ParsedPlan['activities'][0] | null = null
      const seenLocations = new Set<string>()

      // Non-numeric cells (including stray long text in Apr-T) become null.
      const num = (v: any): number | null => {
        if (v === '' || v == null) return null
        const n = Number(v)
        if (isNaN(n) || !isFinite(n)) return null
        return n
      }

      for (let r = headerIdx + 1; r < mpRows.length; r++) {
        const row = mpRows[r]
        if (!row) continue
        const sn = parseInt(row[0])

        if (!isNaN(sn)) {
          let cat = hasCategory ? String(row[7] || '').trim().toLowerCase() : 'capacity'
          if (cat && !validCats.has(cat)) {
            console.warn(`Activity #${sn}: unknown category "${cat}", defaulting to "capacity"`)
            cat = 'capacity'
          }
          current = {
            sn,
            activity:       String(row[1] || '').trim(),
            category:       cat || 'capacity',
            unit:           String(row[2] || '').trim(),
            times:          String(row[3] || '').trim(),
            description:    String(row[4] || '').trim(),
            responsibility: String(row[5] || '').trim(),
            process:        String(row[6] || '').trim(),
            locations:      [],
          }
          activities.push(current)
        }
        if (!current) continue

        const loc = String(row[LOC_COL] || '').trim()
        if (!loc) continue
        seenLocations.add(loc)

        const monthly: Record<string, { target: number | null; achieved: number | null }> = {}
        // Apr has only a Target column; May–Mar are Target/Achieved pairs.
        monthly['Apr'] = { target: num(row[APR_T_COL]), achieved: null }
        const restMonths = ['May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar']
        for (let i = 0; i < restMonths.length; i++) {
          const tCol = MAY_T_COL + i * 2
          const aCol = MAY_T_COL + i * 2 + 1
          monthly[restMonths[i]] = { target: num(row[tCol]), achieved: num(row[aCol]) }
        }
        current.locations.push({ location: loc, monthly })
      }

      if (!activities.length) throw new Error('No activities found in Monthly Plan sheet')

      // Locations from the rows are more accurate than Plan Info's list.
      const locationsFromRows = Array.from(seenLocations)
      const locations = locationsFromRows.length ? locationsFromRows : locationsFromInfo
      if (!locations.length) throw new Error('No locations found in any row')

      setParsed({ name, year, start_month, locations, activities })
    } catch (e: any) {
      setError(e.message || 'Failed to parse file')
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
      // Pin the write to the open plan. Otherwise the server derives project_key from this
      // file's Name/Year, and any mismatch (casing, reused template, typo) creates a new project.
      const body = existingPlanKey ? { ...parsed, project_key: existingPlanKey } : parsed
      const r = await apiFetch('/api/action-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Upload failed'); setUploading(false); return }
      onUploaded({ id: d.id, name: d.name })
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setUploading(false)
  }

  const totalTargets = parsed?.activities.reduce((s, a) =>
    s + a.locations.reduce((sl, l) =>
      sl + Object.values(l.monthly).filter(m => m.target != null).length, 0), 0) ?? 0

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>

        <div className="flex justify-center pt-3 pb-1 sm:hidden shrink-0">
          <div className="w-10 h-1 bg-gray-300 rounded-full" />
        </div>

        <div className="px-5 py-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: C.border }}>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" style={{ color: C.purple }} />
            <h3 className="font-bold text-gray-900">{existingPlanKey ? 'Update Action Plan' : 'Upload Action Plan'}</h3>
          </div>
          <button onClick={onClose} disabled={uploading} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {existingPlanKey && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-[11px] text-blue-800">
              This updates <strong>{existingPlanName || 'this project'}</strong>’s Action Plan data — it will not create a new project, even if the file's Plan Info sheet has a different Name or Year.
            </div>
          )}
          <div className="flex rounded-xl border border-gray-200 p-1 bg-gray-50 text-xs font-semibold">
            <button
              onClick={() => { setMode('template'); setParsed(null); setError('') }}
              className={`flex-1 py-1.5 rounded-lg transition ${mode === 'template' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
            >
              Excel template
            </button>
            <button
              onClick={() => { setMode('ai'); setParsed(null); setError('') }}
              className={`flex-1 py-1.5 rounded-lg transition ${mode === 'ai' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
            >
              Any file (AI-assisted)
            </button>
          </div>

          {mode === 'template' ? (
            <>
              <div className="rounded-xl bg-purple-50 border border-purple-100 p-3 flex items-center gap-3">
                <span className="text-2xl">1️⃣</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-purple-900">Download the template</div>
                  <div className="text-[11px] text-purple-700">Pre-formatted with 3 sheets + sample rows. Fill it in Excel.</div>
                </div>
                <button
                  onClick={() => authedDownload('/api/action-plans/template.xlsx', 'action-plan-template.xlsx').catch(e => setError('Download failed: ' + e.message))}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
                  style={{ background: C.purple }}
                >
                  <Download className="w-3.5 h-3.5" /> Template
                </button>
              </div>

              <div className="rounded-xl bg-green-50 border border-green-100 p-3">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl">2️⃣</span>
                  <div>
                    <div className="text-xs font-bold text-green-900">Upload your filled Excel</div>
                    <div className="text-[11px] text-green-700">Drag & drop, or click to choose.</div>
                  </div>
                </div>

                <label
                  onDrop={handleDrop}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  className={`block cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${dragOver ? 'border-green-500 bg-green-100' : 'border-green-300 bg-white hover:border-green-400'}`}
                >
                  <Upload className={`w-7 h-7 mx-auto mb-1.5 ${dragOver ? 'text-green-700' : 'text-green-400'}`} />
                  <div className="text-xs font-semibold text-gray-700">
                    {parsing ? 'Parsing…' : 'Drop .xlsx here or click to choose'}
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                    disabled={parsing || uploading}
                  />
                </label>
              </div>
            </>
          ) : (
            <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-3">
              <div className="text-[11px] text-indigo-800 mb-2">
                Upload a PDF, Word doc, or any spreadsheet — even one that doesn't match the template layout.
                AI extracts the plan's activities, locations, and monthly targets. <strong>Review the preview below carefully before saving.</strong>
              </div>
              <label
                onDrop={handleDrop}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                className={`block cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${dragOver ? 'border-indigo-500 bg-indigo-100' : 'border-indigo-300 bg-white hover:border-indigo-400'}`}
              >
                <Upload className={`w-7 h-7 mx-auto mb-1.5 ${dragOver ? 'text-indigo-700' : 'text-indigo-400'}`} />
                <div className="text-xs font-semibold text-gray-700">
                  {parsing ? 'Reading with AI…' : 'Drop any file here or click to choose'}
                </div>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.odt,.ods,.rtf,.html,.htm"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileAI(f) }}
                  disabled={parsing || uploading}
                />
              </label>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {parsed && (
            <div className="rounded-xl bg-white border-2 border-purple-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <span className="text-sm font-bold text-gray-900">Preview</span>
              </div>
              <div className="space-y-1 text-xs text-gray-700">
                <div><strong>Name:</strong> {parsed.name}</div>
                <div><strong>Year:</strong> {parsed.year || '—'} <span className="text-gray-400 ml-2">(starts month {parsed.start_month})</span></div>
                <div><strong>Locations:</strong> {parsed.locations.join(', ')}</div>
                <div className="pt-1.5 mt-1.5 border-t" style={{ borderColor: C.border }}>
                  <strong>Activities:</strong> {parsed.activities.length}
                  <span className="text-gray-400 ml-2">across {parsed.locations.length} locations</span>
                </div>
                <div><strong>Targets set:</strong> {totalTargets} of {parsed.activities.length * parsed.locations.length * 12} possible cells</div>
                <div className="mt-2 text-[10px] text-gray-500 max-h-32 overflow-auto">
                  {parsed.activities.slice(0, 5).map(a => (
                    <div key={a.sn}>• {a.sn}. {a.activity} <span className="text-gray-400">({a.category})</span></div>
                  ))}
                  {parsed.activities.length > 5 && <div className="text-gray-400 italic">…and {parsed.activities.length - 5} more</div>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sticky footer keeps the buttons reachable when the body scrolls on small screens. */}
        <div className="px-5 py-4 border-t flex justify-end gap-2 shrink-0" style={{ borderColor: C.border }}>
          <button onClick={onClose} disabled={uploading}
            className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!parsed || uploading}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: C.green }}
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            {uploading ? 'Saving…' : 'Save Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}
