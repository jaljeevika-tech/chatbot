import { useCallback, useEffect, useRef, useState } from 'react'
import { BookMarked, MessageSquare, Layers, ArrowLeft, AlertCircle } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import type { NotebookSource, ChatMessage, NotebookOutputs } from '../../types/notebook'
import type { DailyReport, ActiveFilters } from '../../types/report'
import { NotebookHome } from './NotebookHome'
import { SourcePanel } from './SourcePanel'
import { ChatPanel, type ChatPanelHandle } from './ChatPanel'
import { OutputPanel } from './OutputPanel'
import { useLanguage } from '../../context/LanguageContext'
import { deleteNotebookMedia } from '../../utils/notebookMediaCache'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

type MobileTab = 'sources' | 'chat' | 'output'

interface Props {
  baseReports:     DailyReport[]
  filteredReports: DailyReport[]
  filters:         ActiveFilters
  /** True while any notebook is generating; the dashboard keeps this page mounted (hidden) meanwhile. */
  onBusyChange?: (busy: boolean) => void
}

const LG_QUERY = '(min-width: 1024px)'
function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(LG_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(LG_QUERY)
    const on = () => setDesktop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return desktop
}

export function NotebookPage({ onBusyChange, ...props }: Props) {
  const [notebookId, setNotebookId] = useState<string | null>(null)
  // A notebook left mid-generation stays mounted (hidden) until it finishes and auto-saves.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const busyIds = Object.keys(busy).filter(id => busy[id])
  const mountedIds = notebookId && !busyIds.includes(notebookId) ? [...busyIds, notebookId] : busyIds

  const setNotebookBusy = useCallback((id: string, b: boolean) => {
    setBusy(p => (!!p[id] === b ? p : { ...p, [id]: b }))
  }, [])

  const anyBusy = busyIds.length > 0
  useEffect(() => { onBusyChange?.(anyBusy) }, [anyBusy, onBusyChange])

  // Closing/reloading the browser tab would still kill in-flight generation, so warn.
  useEffect(() => {
    if (!anyBusy) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyBusy])

  return (
    <>
      {!notebookId && (
        <NotebookHome
          onOpen={setNotebookId}
          generatingIds={busyIds}
          onDeleted={id => { setBusy(p => { const n = { ...p }; delete n[id]; return n }); deleteNotebookMedia(id) }}
        />
      )}
      {mountedIds.map(id => (
        <div key={id} className={id === notebookId ? 'h-full' : 'hidden'}>
          <NotebookDetail
            {...props}
            notebookId={id}
            onBack={() => setNotebookId(null)}
            onBusyChange={setNotebookBusy}
          />
        </div>
      ))}
    </>
  )
}

interface DetailProps extends Omit<Props, 'onBusyChange'> {
  notebookId: string
  onBack: () => void
  onBusyChange: (notebookId: string, busy: boolean) => void
}

function NotebookDetail({ baseReports, filteredReports, filters, notebookId, onBack, onBusyChange }: DetailProps) {
  const isDesktop = useIsDesktop()
  const { t } = useLanguage()
  const [sources, setSources]     = useState<NotebookSource[]>([])
  const [messages, setMessages]   = useState<ChatMessage[]>([])
  const [outputs, setOutputs]     = useState<NotebookOutputs>({})
  const [loading, setLoading]     = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // A source that failed to save works until reload; say so rather than let it vanish.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notebookName, setNotebookName] = useState('')
  const [mobileTab, setMobileTab] = useState<MobileTab>('sources')
  const chatRef = useRef<ChatPanelHandle>(null)
  // Client source id -> in-flight POST resolving its real DB id (null on failure), so
  // removeSource can wait for the real id instead of deleting with a placeholder.
  const pendingAddsRef = useRef<Map<string, Promise<string | null>>>(new Map())

  // Output column width (desktop only), remembered per browser.
  const OUTPUT_MIN_WIDTH = 260
  const OUTPUT_MAX_WIDTH = 640
  const [outputWidth, setOutputWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('ff_notebook_output_width'))
      if (saved >= OUTPUT_MIN_WIDTH && saved <= OUTPUT_MAX_WIDTH) return saved
    } catch { /* ignore — private window / blocked storage */ }
    return 320
  })

  const handleResizerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = outputWidth
    let latestWidth = startWidth
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(OUTPUT_MIN_WIDTH, Math.min(OUTPUT_MAX_WIDTH, startWidth + (startX - ev.clientX)))
      latestWidth = next
      setOutputWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try { localStorage.setItem('ff_notebook_output_width', String(latestWidth)) } catch { /* ignore */ }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [outputWidth])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setLoadError(null)
    apiFetch(`/api/notebooks/${notebookId}`)
      .then(r => r.json())
      .then((data: { notebook?: { name: string }; sources?: NotebookSource[]; messages?: ChatMessage[]; outputs?: NotebookOutputs; error?: string }) => {
        if (cancelled) return
        if (data.error) { setLoadError(data.error); return }
        setNotebookName(data.notebook?.name || 'Untitled notebook')
        setSources(data.sources || [])
        setMessages(data.messages || [])
        setOutputs(data.outputs || {})
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load notebook') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [notebookId])

  const MOBILE_TABS: { key: MobileTab; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
    { key: 'sources', label: t.nbSources, icon: BookMarked    },
    { key: 'chat',    label: t.nbChat,    icon: MessageSquare },
    { key: 'output',  label: t.nbOutput,  icon: Layers        },
  ]

  const addSource = useCallback((src: NotebookSource) => {
    setSources(prev => [...prev, src])
    const pending = apiFetch(`/api/notebooks/${notebookId}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: src.name, type: src.type, content: src.content, charCount: src.charCount, imageUrls: src.imageUrls, imageCaptions: src.imageCaptions, imageMeta: src.imageMeta }),
    })
      .then(async r => {
        const data = await r.json().catch(() => ({})) as { id?: string; addedAt?: string; error?: string }
        if (!r.ok || !data.id) throw new Error(data.error || `HTTP ${r.status}`)
        return data
      })
      .then((data: { id?: string; addedAt?: string }) => {
        if (!data.id) return null
        setSources(prev => prev.map(s => s.id === src.id ? { ...s, id: data.id!, addedAt: data.addedAt || s.addedAt } : s))
        return data.id
      })
      .catch((e: unknown) => { // source stays in local state even if persistence failed
        setSaveError(`“${src.name}” couldn't be saved to this notebook (${e instanceof Error ? e.message : 'network error'}). You can use it now, but it won't be here after a reload.`)
        return null
      })
      .finally(() => { pendingAddsRef.current.delete(src.id) })
    pendingAddsRef.current.set(src.id, pending)
  }, [notebookId])

  const removeSource = useCallback((id: string) => {
    setSources(prev => prev.filter(s => s.id !== id))
    // While the add is in flight the id is a placeholder; deleting now would hit 0 rows
    // while the POST still inserts one. Wait for the real id (or the failure).
    const pending = pendingAddsRef.current.get(id)
    if (pending) {
      pending.then(realId => {
        if (realId) apiFetch(`/api/notebooks/${notebookId}/sources/${realId}`, { method: 'DELETE' }).catch(() => {})
      })
    } else {
      apiFetch(`/api/notebooks/${notebookId}/sources/${id}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [notebookId])

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev, msg])
  }, [])

  const updateLastMessage = useCallback((text: string) => {
    setMessages(prev => {
      if (prev.length === 0) return prev
      const copy = [...prev]
      copy[copy.length - 1] = { ...copy[copy.length - 1], text }
      return copy
    })
  }, [])

  const persistMessage = useCallback((msg: ChatMessage) => {
    if (!msg.text) return
    apiFetch(`/api/notebooks/${notebookId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: msg.role, text: msg.text }),
    }).catch(() => {})
  }, [notebookId])

  const askQuestion = useCallback((question: string) => {
    chatRef.current?.ask(question)
  }, [])

  const saveOutput = useCallback((kind: keyof NotebookOutputs, data: unknown) => {
    setOutputs(prev => ({ ...prev, [kind]: { data, updatedAt: new Date().toISOString() } as NotebookOutputs[typeof kind] }))
    apiFetch(`/api/notebooks/${notebookId}/outputs/${kind}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }).catch(() => { /* local state already updated; next reload reconciles */ })
  }, [notebookId])

  const sourcePanelProps = { sources, onAdd: addSource, onRemove: removeSource, baseReports, filteredReports, filters }
  const chatPanelProps   = { sources, messages, onAddMessage: addMessage, onUpdateLastMessage: updateLastMessage, onMessageComplete: persistMessage }
  const onOutputBusy = useCallback((b: boolean) => onBusyChange(notebookId, b), [notebookId, onBusyChange])
  const outputPanelProps = { sources, onAskQuestion: askQuestion, outputs, onSaveOutput: saveOutput, cacheKey: notebookId, onBusyChange: onOutputBusy, title: notebookName }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: C.bg }}>
        <div className="text-xs" style={{ color: '#86A0A5' }}>Loading notebook…</div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6" style={{ background: C.bg }}>
        <AlertCircle className="w-8 h-8" style={{ color: '#DC2626' }} />
        <p className="text-sm font-bold" style={{ color: C.dark }}>Couldn't load this notebook</p>
        <p className="text-xs" style={{ color: '#86A0A5' }}>{loadError}</p>
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold"
          style={{ background: C.dark, color: C.white }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to My notebooks
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: C.bg }}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0 bg-white">
        <button onClick={onBack} className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold hover:bg-black/5 transition" style={{ color: C.dark }}>
          <ArrowLeft className="w-3.5 h-3.5" />
          My notebooks
        </button>
        <span className="text-xs font-bold truncate" style={{ color: '#86A0A5' }}>/ {notebookName}</span>
      </div>
      {saveError && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs shrink-0" style={{ background: '#FEF2F2', color: '#991B1B', borderBottom: '1px solid #FECACA' }} role="alert">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{saveError}</span>
          <button onClick={() => setSaveError(null)} className="font-semibold hover:underline shrink-0">Dismiss</button>
        </div>
      )}

      {/* Only one layout is mounted, so an output never runs twice or loses state to a hidden copy */}
      {isDesktop ? (
      <div className="flex flex-1 min-h-0">
        <div className="w-64 xl:w-72 shrink-0 flex flex-col bg-white overflow-hidden border-r" style={{ borderColor: '#D9E6E8' }}>
          <SourcePanel {...sourcePanelProps} />
        </div>
        <div className="flex-1 flex flex-col bg-white overflow-hidden min-w-0">
          <ChatPanel ref={chatRef} {...chatPanelProps} />
        </div>
        <div
          onPointerDown={handleResizerPointerDown}
          className="w-1.5 shrink-0 cursor-col-resize hover:bg-black/10 active:bg-black/15 transition-colors"
          style={{ borderLeft: '1px solid #D9E6E8' }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize output panel"
        />
        <div className="shrink-0 flex flex-col bg-white overflow-hidden" style={{ width: outputWidth }}>
          <OutputPanel {...outputPanelProps} />
        </div>
      </div>

      ) : (
      /* Mobile: one visible panel + bottom tab bar; all three stay mounted so streaming continues. */
      <div className="flex flex-col flex-1 min-h-0 pb-14">
        <div className={`flex-1 bg-white overflow-hidden ${mobileTab === 'sources' ? '' : 'hidden'}`}>
          <SourcePanel {...sourcePanelProps} />
        </div>
        <div className={`flex-1 bg-white overflow-hidden flex-col ${mobileTab === 'chat' ? 'flex' : 'hidden'}`}>
          <ChatPanel ref={chatRef} {...chatPanelProps} />
        </div>
        <div className={`flex-1 bg-white overflow-hidden ${mobileTab === 'output' ? '' : 'hidden'}`}>
          <OutputPanel {...outputPanelProps} />
        </div>

        <div className="fixed bottom-0 left-0 right-0 flex z-50 border-t" style={{ background: C.sidebar, borderColor: 'rgba(255,255,255,0.15)' }}>
          {MOBILE_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setMobileTab(key)}
              className="flex-1 flex flex-col items-center justify-center py-2.5 gap-1 text-[10px] font-semibold transition-all"
              style={{ color: mobileTab === key ? C.white : 'rgba(255,255,255,0.45)' }}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </div>
      )}
    </div>
  )
}
