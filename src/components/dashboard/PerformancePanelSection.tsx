import { Loader2, Sparkles, BarChart2, Download, MessageSquare, Globe, FileText } from 'lucide-react'
import { AnalysisRenderer } from './AnalysisRenderer'
import type { DailyReport } from '../../types/report'

const C = {
  dark:    '#0E3A46',
  sidebar: '#341272',
  surface: '#D9E6E8',
  muted:   '#86A0A5',
  green:   '#3F7D5C',
  amber:   '#B8862E',
  red:     '#B0473C',
  lime:    '#16a34a',
}

function PctBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.surface }}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="text-[10px] font-bold w-7 text-right tabular-nums shrink-0" style={{ color }}>{value}%</span>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-4 py-2 border-b" style={{ borderColor: C.surface, background: '#FAFAFA' }}>
      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: C.muted }}>{title}</p>
    </div>
  )
}

function StatChip({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl" style={{ background: C.surface }}>
      <span className="text-lg font-black tabular-nums leading-tight" style={{ color: color || C.dark }}>{value}</span>
      <span className="text-[9px] uppercase tracking-wide text-center leading-tight" style={{ color: C.muted }}>{label}</span>
    </div>
  )
}

interface WorkerSummary {
  name: string
  reportCount: number
  recentCount: number
  totalBenef: number
  quality: { overall: number; description: number; beneficiaries: number; photo: number; location: number }
  topAreas: { area: string; count: number }[]
  reports: DailyReport[]
}

interface Props {
  aiStatus:         'idle' | 'loading' | 'done' | 'error'
  aiText:           string
  aiError:          string
  worker:           WorkerSummary
  exportingDocx:    boolean
  onExportDocx:     () => void
  onOpenFullReview: () => void
}

export function PerformancePanelSection({
  aiStatus, aiText, aiError,
  worker, exportingDocx, onExportDocx, onOpenFullReview,
}: Props) {
  const waCount  = worker.reports.filter(r => r.source === 'whatsapp').length
  const webCount = worker.reports.filter(r => r.source === 'web' || r.source === 'sheet').length

  const areaMap = new Map<string, { reports: number; benef: number; photos: number; located: number }>()
  for (const r of worker.reports) {
    const area = r.areaOfIntervention || 'Unknown'
    const e = areaMap.get(area) ?? { reports: 0, benef: 0, photos: 0, located: 0 }
    e.reports++
    e.benef    += parseInt(String(r.beneficiaries ?? 0)) || 0
    if (r.attachmentUrl) e.photos++
    if ((r.location || '').trim().split(/\s+/).length >= 2) e.located++
    areaMap.set(area, e)
  }
  const areaRows = Array.from(areaMap.entries())
    .sort((a, b) => b[1].reports - a[1].reports)

  return (
    <div className="flex flex-col">

      <SectionHeader title="Activity Overview" />
      <div className="px-4 py-3">
        <div className="grid grid-cols-3 gap-2 mb-3">
          <StatChip label="Total Reports"  value={worker.reportCount} />
          <StatChip label="Last 30 Days"   value={worker.recentCount} color={worker.recentCount > 0 ? C.green : C.red} />
          <StatChip label="Beneficiaries"  value={worker.totalBenef.toLocaleString('en-IN')} color={C.lime} />
        </div>

        <div className="flex flex-col gap-1.5 mb-2.5">
          {[
            { label: 'Description quality', value: worker.quality.description },
            { label: 'Beneficiary data',    value: worker.quality.beneficiaries },
            { label: 'Photo attached',      value: worker.quality.photo },
            { label: 'Location tagged',     value: worker.quality.location },
          ].map(q => {
            const color = q.value >= 75 ? C.green : q.value >= 50 ? C.amber : C.red
            return (
              <div key={q.label} className="flex items-center gap-2">
                <span className="text-[10px] w-20 sm:w-32 shrink-0" style={{ color: C.muted }}>{q.label}</span>
                <PctBar value={q.value} color={color} />
              </div>
            )
          })}
        </div>

        {(waCount > 0 || webCount > 0) && (
          <div className="flex items-center gap-3">
            {waCount > 0 && (
              <span className="flex items-center gap-1 text-[10px]" style={{ color: C.muted }}>
                <MessageSquare className="w-3 h-3" style={{ color: C.green }} />
                {waCount} WhatsApp
              </span>
            )}
            {webCount > 0 && (
              <span className="flex items-center gap-1 text-[10px]" style={{ color: C.muted }}>
                <Globe className="w-3 h-3" style={{ color: C.sidebar }} />
                {webCount} Web / Sheet
              </span>
            )}
          </div>
        )}
      </div>

      {areaRows.length > 0 && (
        <>
          <SectionHeader title="Area Breakdown" />
          <div className="px-4 py-3 overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr style={{ borderBottom: `1.5px solid ${C.surface}` }}>
                  {['Area', 'Reports', 'Beneficiaries', 'Photos', 'Located'].map(h => (
                    <th key={h} className="text-left font-bold uppercase tracking-wide pb-1.5 pr-2" style={{ color: C.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {areaRows.map(([area, d]) => (
                  <tr key={area} className="border-b last:border-b-0" style={{ borderColor: C.surface }}>
                    <td className="py-1.5 pr-3 max-w-[100px] truncate font-medium" style={{ color: C.dark }}>{area}</td>
                    <td className="py-1.5 pr-3 tabular-nums font-bold text-center" style={{ color: C.dark }}>{d.reports}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-center" style={{ color: C.lime }}>{d.benef.toLocaleString('en-IN')}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-center" style={{ color: d.photos > 0 ? C.green : C.muted }}>
                      {d.photos > 0 ? `${Math.round((d.photos / d.reports) * 100)}%` : '—'}
                    </td>
                    <td className="py-1.5 tabular-nums text-center" style={{ color: d.located > 0 ? C.green : C.muted }}>
                      {d.located > 0 ? `${Math.round((d.located / d.reports) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: `1.5px solid ${C.surface}` }}>
                  <td className="py-1.5 pr-3 font-bold" style={{ color: C.dark }}>Total</td>
                  <td className="py-1.5 pr-3 tabular-nums font-bold text-center" style={{ color: C.dark }}>{worker.reportCount}</td>
                  <td className="py-1.5 pr-3 tabular-nums font-bold text-center" style={{ color: C.lime }}>{worker.totalBenef.toLocaleString('en-IN')}</td>
                  <td className="py-1.5 pr-3 tabular-nums font-bold text-center" style={{ color: C.green }}>{worker.quality.photo}%</td>
                  <td className="py-1.5 tabular-nums font-bold text-center" style={{ color: C.green }}>{worker.quality.location}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionHeader title="AI Analysis" />
      <div style={{ background: '#FAFAFA' }}>
        {aiStatus === 'loading' && !aiText && (
          <div className="flex items-center gap-2 px-4 py-4">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: C.sidebar }} />
            <Sparkles className="w-3.5 h-3.5" style={{ color: C.sidebar }} />
            <span className="text-xs" style={{ color: C.muted }}>Generating AI analysis…</span>
          </div>
        )}
        {aiStatus === 'error' && (
          <p className="text-xs text-red-500 px-4 py-3">{aiError || 'AI analysis failed — please try again.'}</p>
        )}
        {aiText && (
          <AnalysisRenderer text={aiText} streaming={aiStatus === 'loading'} />
        )}
      </div>

      <div className="flex border-t" style={{ borderColor: C.surface }}>
        <button
          onClick={onExportDocx}
          disabled={exportingDocx}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-xs font-semibold transition-colors hover:bg-gray-50 border-r disabled:opacity-50"
          style={{ borderColor: C.surface, color: C.sidebar }}
        >
          {exportingDocx
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          Export DOCX
        </button>
        <button
          onClick={onOpenFullReview}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-xs font-semibold transition-colors hover:bg-gray-50 border-r"
          style={{ borderColor: C.surface, color: C.sidebar }}
        >
          <BarChart2 className="w-3.5 h-3.5" />
          Full Review
        </button>
        <button
          onClick={() => {
            try {
              sessionStorage.setItem('ff_saved_reports_filter_subject', worker.name)
            } catch { /* ignore */ }
            window.location.hash = '#settings/saved-reports'
          }}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-xs font-semibold transition-colors hover:bg-purple-50"
          style={{ color: C.sidebar }}
          title="Find AI-generated reports where this worker is the subject"
        >
          <FileText className="w-3.5 h-3.5" />
          AI Reports
        </button>
      </div>

    </div>
  )
}
