// Opens from a chat citation ([1], [2], ...): shows the full source and highlights the
// paragraph best matching the cited sentence (plain word-overlap heuristic, no AI call).

import { useEffect, useMemo, useRef } from 'react'
import { X, FileText } from 'lucide-react'
import type { NotebookSource } from '../../types/notebook'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF' }

interface Props {
  source: NotebookSource
  /** The sentence (or nearby text) surrounding the citation marker in the answer — used to locate the best-matching passage. */
  context: string
  onClose: () => void
}

function wordSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  )
}

export function SourceViewerModal({ source, context, onClose }: Props) {
  const highlightRef = useRef<HTMLDivElement>(null)

  const { paragraphs, bestIndex } = useMemo(() => {
    const raw = source.content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    const paras = raw.length > 1 ? raw : source.content.split(/\n/).map(p => p.trim()).filter(Boolean)
    const ctxWords = wordSet(context)
    let best = -1, bestScore = 0
    if (ctxWords.size > 0) {
      paras.forEach((p, i) => {
        const pWords = wordSet(p)
        let score = 0
        ctxWords.forEach(w => { if (pWords.has(w)) score++ })
        if (score > bestScore) { bestScore = score; best = i }
      })
    }
    return { paragraphs: paras, bestIndex: bestScore >= 2 ? best : -1 }
  }, [source.content, context])

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [bestIndex])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[80vh] rounded-2xl flex flex-col overflow-hidden"
        style={{ background: C.white }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 shrink-0" style={{ color: C.lime }} />
            <p className="text-sm font-bold truncate" style={{ color: C.dark }}>{source.name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 shrink-0">
            <X className="w-4 h-4" style={{ color: '#86A0A5' }} />
          </button>
        </div>

        {bestIndex === -1 && (
          <div className="px-4 pt-3 text-[11px]" style={{ color: '#86A0A5' }}>
            Couldn't pinpoint the exact passage — showing the full source.
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {paragraphs.map((p, i) => (
            <p
              key={i}
              ref={i === bestIndex ? highlightRef : undefined}
              className="text-xs leading-relaxed rounded-lg px-2 py-1.5 -mx-2"
              style={{
                color: i === bestIndex ? '#111' : '#374151',
                background: i === bestIndex ? '#FEF3C7' : 'transparent',
                fontWeight: i === bestIndex ? 600 : 400,
              }}
            >
              {p}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
