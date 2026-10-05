import { apiFetch } from '../../utils/apiFetch'
import { useState, useEffect } from 'react'
import { BookOpen, Loader2, Download, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import type { NotebookSource, StudyGuideFormat, StudyGuideOutputData } from '../../types/notebook'
import { exportToDocx } from '../../utils/docxExport'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

const FORMATS: { key: StudyGuideFormat; label: string; desc: string }[] = [
  { key: 'summary',  label: 'Summary',  desc: 'Executive overview & key themes' },
  { key: 'faq',      label: 'FAQ',      desc: 'Top 10 questions & answers' },
  { key: 'timeline', label: 'Timeline', desc: 'Chronological events extracted' },
  { key: 'briefing', label: 'Briefing', desc: 'One-page briefing document' },
]

interface Props {
  sources: NotebookSource[]
  /** Saved guide, restored on notebook load. */
  initial?: StudyGuideOutputData
  onChange?: (data: StudyGuideOutputData) => void
  /** Reported up so OutputPanel can show a spinner and keep this tab mounted. */
  onBusyChange?: (busy: boolean) => void
}

export function StudyGuide({ sources, initial, onChange, onBusyChange }: Props) {
  const [format, setFormat]   = useState<StudyGuideFormat>(initial?.format ?? 'summary')
  const [content, setContent] = useState(initial?.content ?? '')
  const [loading, setLoading] = useState(false)
  useEffect(() => { onBusyChange?.(loading) }, [loading, onBusyChange])
  const [error, setError]     = useState<string | null>(null)
  const [showPrompt, setShowPrompt]     = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')

  async function generate() {
    if (sources.length === 0) return
    setLoading(true)
    setError(null)
    setContent('')

    try {
      const res = await apiFetch('/api/notebook/study-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })),
          format,
          customPrompt,
        }),
      })

      if (!res.body) throw new Error('No stream')
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   accum   = ''
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const raw = trimmed.slice(6).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            const chunk = JSON.parse(raw)
            if (chunk.error) { setError(chunk.error); return }
            if (chunk.text) { accum += chunk.text; setContent(accum) }
          } catch { /* skip */ }
        }
      }
      if (accum) onChange?.({ format, content: accum })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  async function exportDocx() {
    if (!content) return
    const label = FORMATS.find(f => f.key === format)?.label ?? 'Study Guide'
    await exportToDocx(`Notebook ${label}`, content)
  }

  function renderContent(text: string) {
    return text.split('\n').map((line, i) => {
      const t = line.trim()
      if (!t) return <div key={i} className="h-2" />
      if (t.startsWith('# '))  return <h1 key={i} className="text-base font-black mt-4 mb-1" style={{ color: C.dark }}>{t.slice(2)}</h1>
      if (t.startsWith('## ')) return <h2 key={i} className="text-sm font-black mt-3 mb-1" style={{ color: C.dark }}>{t.slice(3)}</h2>
      if (t.startsWith('### '))return <h3 key={i} className="text-xs font-bold mt-2 mb-0.5" style={{ color: C.sidebar }}>{t.slice(4)}</h3>
      if (t.startsWith('- ') || t.startsWith('* ')) {
        return <div key={i} className="flex gap-2 text-xs leading-relaxed" style={{ color: '#374151' }}>
          <span style={{ color: C.lime }}>•</span><span>{t.slice(2)}</span>
        </div>
      }
      return <p key={i} className="text-xs leading-relaxed" style={{ color: '#374151' }}>{t}</p>
    })
  }

  const noSources = sources.length === 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <div className="grid grid-cols-2 gap-1.5 mb-3">
          {FORMATS.map(f => (
            <button
              key={f.key}
              onClick={() => setFormat(f.key)}
              className="px-2 py-1.5 rounded-lg text-[11px] font-semibold text-left transition-all"
              style={{
                background: format === f.key ? C.dark : C.bg,
                color:      format === f.key ? C.white : '#5C7378',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowPrompt(v => !v)}
          className="w-full flex items-center gap-1.5 mb-2 text-[11px] font-semibold transition-all"
          style={{ color: showPrompt ? C.dark : '#86A0A5' }}
        >
          <Sparkles className="w-3 h-3" />
          Custom instructions
          {showPrompt ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
        </button>
        {showPrompt && (
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder="Focus on a specific theme, target a particular audience, or emphasize certain sections…"
            rows={3}
            className="w-full text-[11px] rounded-xl px-3 py-2 mb-2 resize-none outline-none"
            style={{ background: C.bg, color: '#374151', border: '1.5px solid #D9E6E8' }}
          />
        )}

        <div className="flex gap-2">
          <SubscriptionGate featureName="AI Study Guide">
          <button
            onClick={generate}
            disabled={loading || noSources}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all"
            style={{
              background: noSources || loading ? '#D9E6E8' : C.dark,
              color:      noSources || loading ? '#86A0A5' : C.white,
            }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
            {loading ? 'Generating...' : 'Generate'}
          </button>
          </SubscriptionGate>
          {content && (
            <button
              onClick={exportDocx}
              className="px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all"
              style={{ background: C.bg, color: C.dark, border: '1.5px solid #D9E6E8' }}
            >
              <Download className="w-3.5 h-3.5" />
              DOCX
            </button>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {content ? (
          <div className="space-y-1">{renderContent(content)}</div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <BookOpen className="w-8 h-8" style={{ color: C.lime }} />
            <p className="text-xs font-semibold" style={{ color: C.dark }}>AI Study Guide</p>
            <p className="text-[11px]" style={{ color: '#86A0A5' }}>
              {noSources ? 'Add sources first' : 'Choose a format and generate'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
