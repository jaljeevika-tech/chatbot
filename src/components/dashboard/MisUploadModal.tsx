// Excel upload for every MIS category: parse the sheet client-side, preview,
// then POST the rows as JSON. Per-category differences live in misUploadConfigs.tsx.
// Name/Contact No. are parsed only for the preview: the server re-resolves every
// UID against the beneficiary tables and stores what that lookup returns.

import { useCallback, useState } from 'react'
import { Upload, X, Loader2, AlertCircle, CheckCircle2, FileSpreadsheet, Download } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { FF } from '../../theme/colors'
import type { UploadRowError, UploadRowWarning } from '../ui/UploadResultBanner'
import type { MisRow, MisUploadConfig } from './misUploadConfigs'

function norm(v: any): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function parseWorkbook(XLSX: any, buf: ArrayBuffer, config: MisUploadConfig): MisRow[] {
  const wb = XLSX.read(buf, config.cellDates ? { type: 'array', cellDates: true } : { type: 'array' })
  const rows: MisRow[] = []

  for (const sheetName of wb.SheetNames) {
    const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' })

    const headerIdx = grid.findIndex(r => r.some(c => config.isHeaderCell(norm(c))))
    if (headerIdx < 0) continue // not this category's sheet
    const header = grid[headerIdx]

    const colIndex: Record<string, number> = {}
    for (const [key, test] of Object.entries(config.columnMatchers)) {
      colIndex[key] = header.findIndex(h => test(norm(h)))
    }
    if (config.requiredColumns.some(key => colIndex[key] < 0)) continue

    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r]
      if (!row) continue
      const get = (key: string) => (colIndex[key] >= 0 ? row[colIndex[key]] : undefined)
      const parsed = config.parseRow(get, XLSX)
      if (parsed) rows.push(parsed)
    }
  }

  return rows
}

export type MisUploadProps = {
  projectKey: string
  onClose:    () => void
  onUploaded: (saved: number, errors: UploadRowError[], duplicates: number, warnings: UploadRowWarning[]) => void
}

export function MisUploadModal({ config, projectKey, onClose, onUploaded }: MisUploadProps & { config: MisUploadConfig }) {
  const [parsing, setParsing]     = useState(false)
  const [rows, setRows]           = useState<MisRow[] | null>(null)
  const [error, setError]         = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)

  const handleFile = useCallback(async (file: File) => {
    setParsing(true); setError(''); setRows(null)
    try {
      const XLSX: any = await import('xlsx')
      const buf = await file.arrayBuffer()
      const result = parseWorkbook(XLSX, buf, config)
      if (!result.length) throw new Error(`No ${config.label.toLowerCase()} rows found (expected columns: ${config.columns})`)
      setRows(result)
    } catch (e: any) {
      setError(e.message || 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }, [config])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const handleConfirm = async () => {
    if (!rows) return
    setUploading(true); setError('')
    try {
      const r = await apiFetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_key: projectKey, rows }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Upload failed'); setUploading(false); return }
      onUploaded(d.saved ?? 0, d.errors ?? [], d.duplicates ?? 0, d.warnings ?? [])
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setUploading(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: FF.border }}>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" style={{ color: FF.purple }} />
            <h3 className="font-bold" style={{ color: FF.tealDark }}>Upload {config.label} Records</h3>
          </div>
          <button onClick={onClose} disabled={uploading} className="disabled:opacity-50" style={{ color: FF.textFaint }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl p-3 flex items-center gap-3" style={{ background: FF.bg, border: `1px solid ${FF.border}` }}>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold" style={{ color: FF.tealDark }}>Download the template</div>
              <div className="text-[11px]" style={{ color: FF.textMuted }}>{config.templateHint ?? 'Pre-formatted columns with sample rows.'}</div>
            </div>
            <button
              onClick={() => authedDownload(`${config.templateUrl}?project_key=${encodeURIComponent(projectKey)}`, config.templateFile).catch(e => setError('Download failed: ' + e.message))}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white shrink-0"
              style={{ background: FF.purple }}
            >
              <Download className="w-3.5 h-3.5" /> Template
            </button>
          </div>

          <div className="rounded-xl p-3 text-xs" style={{ background: FF.bg, border: `1px solid ${FF.border}`, color: FF.textMuted }}>
            Columns: <strong>{config.columns}</strong>. {config.notes}
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
              {parsing ? 'Parsing…' : `Drop the ${config.label} .xlsx here or click to choose`}
            </div>
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              disabled={parsing || uploading}
            />
          </label>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {rows && (
            <div className="rounded-xl p-4" style={{ border: `2px solid ${FF.purple}` }}>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4" style={{ color: FF.green }} />
                <span className="text-sm font-bold" style={{ color: FF.tealDark }}>Preview</span>
              </div>
              <div className="space-y-1 text-xs" style={{ color: FF.textMuted }}>
                <div><strong style={{ color: FF.tealDark }}>Total rows:</strong> {rows.length}</div>
                {config.previewStats?.(rows)}
                <div className="mt-2 max-h-32 overflow-auto text-[10px]">
                  {rows.slice(0, 5).map((r, i) => (
                    <div key={i}>{config.previewLine(r)}</div>
                  ))}
                  {rows.length > 5 && <div className="italic">…and {rows.length - 5} more</div>}
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
              disabled={!rows || uploading}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {uploading ? 'Saving…' : 'Save Records'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
