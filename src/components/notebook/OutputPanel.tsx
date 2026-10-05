import { useState, useMemo, useEffect } from 'react'
import { Mic2, BookOpen, Presentation, Video, Network, GraduationCap, Loader2 } from 'lucide-react'
import type { NotebookSource, NotebookOutputs } from '../../types/notebook'
import { AudioOverview } from './AudioOverview'
import { StudyGuide } from './StudyGuide'
import { SlideDeck } from './SlideDeck'
import { VideoOverview } from './VideoOverview'
import { MindMap } from './MindMap'
import { FlashcardsQuiz } from './FlashcardsQuiz'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF' }

type OutputTab = 'audio' | 'guide' | 'slides' | 'video' | 'mindmap' | 'learn'

const OUTPUT_TABS: { key: OutputTab; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
  { key: 'audio',   label: 'Audio',    icon: Mic2         },
  { key: 'guide',   label: 'Guide',    icon: BookOpen     },
  { key: 'slides',  label: 'Slides',   icon: Presentation },
  { key: 'video',   label: 'Video',    icon: Video        },
  { key: 'mindmap', label: 'Map',      icon: Network      },
  { key: 'learn',   label: 'Learn',    icon: GraduationCap },
]

interface Props {
  sources: NotebookSource[]
  onAskQuestion: (question: string) => void
  /** Saved content per output tab (074_notebook_outputs). Omitted by the ephemeral
   *  single-document Ask AI panel, which has nothing to persist against. */
  outputs?: NotebookOutputs
  onSaveOutput?: (kind: keyof NotebookOutputs, data: unknown) => void
  /** Notebook id keying this device's cached audio/images; omitted by the ephemeral panel. */
  cacheKey?: string
  /** True while any output tab is generating (so the notebook stays mounted). */
  onBusyChange?: (busy: boolean) => void
  /** Notebook name — the Video Overview's title card / file name. */
  title?: string
}

export function OutputPanel({ sources, onAskQuestion, outputs = {}, onSaveOutput, cacheKey, onBusyChange, title }: Props) {
  const [tab, setTab] = useState<OutputTab>('audio')
  // Tabs stay mounted once opened so a generation keeps running in the background.
  const [visited, setVisited] = useState<Set<OutputTab>>(() => new Set(['audio']))
  const [busy, setBusy] = useState<Partial<Record<OutputTab, boolean>>>({})

  const busyHandlers = useMemo(() => {
    const h = {} as Record<OutputTab, (b: boolean) => void>
    for (const { key } of OUTPUT_TABS) h[key] = (b: boolean) => setBusy(p => (!!p[key] === b ? p : { ...p, [key]: b }))
    return h
  }, [])

  const anyBusy = Object.values(busy).some(Boolean)
  useEffect(() => { onBusyChange?.(anyBusy) }, [anyBusy, onBusyChange])

  function open(key: OutputTab) {
    setTab(key)
    setVisited(v => (v.has(key) ? v : new Set(v).add(key)))
  }

  const pane = (key: OutputTab, el: React.ReactNode) =>
    visited.has(key) && <div key={key} className={tab === key ? 'h-full' : 'hidden'}>{el}</div>

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <h2 className="text-sm font-black mb-3" style={{ color: C.dark }}>Outputs</h2>
        <div className="flex gap-1.5">
          {OUTPUT_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => open(key)}
              title={busy[key] ? `${label} — generating…` : undefined}
              className="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-semibold transition-all"
              style={{
                background: tab === key ? C.dark : C.bg,
                color:      tab === key ? C.white : '#5C7378',
              }}
            >
              {busy[key] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {pane('audio',   <AudioOverview sources={sources} initial={outputs.audio_overview?.data} onChange={data => onSaveOutput?.('audio_overview', data)} cacheKey={cacheKey} onBusyChange={busyHandlers.audio} />)}
        {pane('guide',   <StudyGuide    sources={sources} initial={outputs.study_guide?.data}    onChange={data => onSaveOutput?.('study_guide', data)} onBusyChange={busyHandlers.guide} />)}
        {pane('slides',  <SlideDeck     sources={sources} initial={outputs.slide_deck?.data}     onChange={data => onSaveOutput?.('slide_deck', data)} onBusyChange={busyHandlers.slides} />)}
        {pane('video',   <VideoOverview sources={sources} initial={outputs.video_overview?.data} onChange={data => onSaveOutput?.('video_overview', data)} cacheKey={cacheKey} onBusyChange={busyHandlers.video} title={title} />)}
        {pane('mindmap', <MindMap       sources={sources} onAskQuestion={onAskQuestion} initial={outputs.mind_map?.data} onChange={data => onSaveOutput?.('mind_map', data)} onBusyChange={busyHandlers.mindmap} />)}
        {pane('learn',   <FlashcardsQuiz sources={sources} initial={outputs.flashcards_quiz?.data} onChange={data => onSaveOutput?.('flashcards_quiz', data)} onBusyChange={busyHandlers.learn} />)}
      </div>
    </div>
  )
}
