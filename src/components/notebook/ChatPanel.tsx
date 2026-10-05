import { apiFetch } from '../../utils/apiFetch'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Send, Bot, User, AlertCircle, Sparkles } from 'lucide-react'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import { SourceViewerModal } from './SourceViewerModal'
import type { NotebookSource, ChatMessage } from '../../types/notebook'

const C = {
  dark:   '#0E3A46',
  lime:   '#341272',
  bg:     '#F2F7F8',
  white:  '#FFFFFF',
  sidebar:'#341272',
}

export interface ChatPanelHandle {
  /** Send a question programmatically — used by the Mind Map tab's "tell me more" nodes and the landing guide's suggested-question chips. */
  ask: (question: string) => void
}

interface Props {
  sources: NotebookSource[]
  messages: ChatMessage[]
  onAddMessage: (msg: ChatMessage) => void
  onUpdateLastMessage: (text: string) => void
  /** Fires once with the final text when an assistant reply finishes streaming (or a user message is added) — lets the caller persist it. */
  onMessageComplete?: (msg: ChatMessage) => void
}

/** Renders `[1]`, `[2]`, ... citation markers as clickable chips; everything else as plain text. */
function renderWithCitations(
  text: string,
  sourceCount: number,
  onCite: (sourceIdx: number, context: string) => void,
) {
  const parts = text.split(/(\[\d+\])/g)
  let context = ''
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/)
    if (m) {
      const idx = parseInt(m[1], 10) - 1
      if (idx >= 0 && idx < sourceCount) {
        const ctx = context
        return (
          <button
            key={i}
            onClick={() => onCite(idx, ctx)}
            className="inline-flex items-center justify-center w-4 h-4 mx-0.5 rounded-full text-[9px] font-bold align-super"
            style={{ background: C.lime + '22', color: C.sidebar }}
          >
            {m[1]}
          </button>
        )
      }
      return <span key={i}>{part}</span>
    }
    context = (context + part).slice(-220)
    return <span key={i}>{part}</span>
  })
}

function MessageBubble({ msg, sources, onCite }: {
  msg: ChatMessage
  sources: NotebookSource[]
  onCite: (sourceIdx: number, context: string) => void
}) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: isUser ? C.dark : C.bg }}
      >
        {isUser
          ? <User className="w-3.5 h-3.5 text-white" />
          : <Bot className="w-3.5 h-3.5" style={{ color: C.sidebar }} />}
      </div>
      <div
        className="max-w-[80%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap"
        style={{
          background: isUser ? C.dark : C.white,
          color:      isUser ? C.white : '#111111',
          borderBottomRightRadius: isUser ? 4 : undefined,
          borderBottomLeftRadius:  isUser ? undefined : 4,
        }}
      >
        {msg.text
          ? (isUser ? msg.text : renderWithCitations(msg.text, sources.length, onCite))
          : <span className="opacity-40 animate-pulse">●●●</span>}
      </div>
    </div>
  )
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  { sources, messages, onAddMessage, onUpdateLastMessage, onMessageComplete }, ref,
) {
  const [input, setInput]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [citation, setCitation] = useState<{ source: NotebookSource; context: string } | null>(null)
  const [guide, setGuide]         = useState<{ overview: string; questions: string[] } | null>(null)
  const guideStartedRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // [N] citations are numbered against the sources as they were when the reply was
  // generated; snapshot per message so removing a source later doesn't shift them.
  const sourceSnapshotsRef = useRef<Map<string, NotebookSource[]>>(new Map())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Landing "notebook guide" — one auto-summary + suggested questions, fetched
  // once per notebook as soon as sources exist and no chat has started yet.
  useEffect(() => {
    if (sources.length === 0) { setGuide(null); guideStartedRef.current = false; return }
    if (messages.length > 0 || guideStartedRef.current) return
    guideStartedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch('/api/notebook/guide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })) }),
        })
        if (!res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let accum = '', buffer = ''
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
              if (chunk.text) accum += chunk.text
            } catch { /* skip */ }
          }
        }
        if (cancelled) return
        const [overviewPart, questionsPart] = accum.split(/##\s*Suggested questions/i)
        const questions = (questionsPart || '')
          .split('\n').map(l => l.trim()).filter(l => l.startsWith('-'))
          .map(l => l.replace(/^-\s*/, '')).filter(Boolean).slice(0, 4)
        setGuide({ overview: (overviewPart || '').trim(), questions })
      } catch { /* landing guide is a nice-to-have — fail silently */ }
    })()
    return () => { cancelled = true }
  }, [sources.length, messages.length])

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim()
    if (!text || busy) return
    if (sources.length === 0) return

    setInput('')
    setBusy(true)

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, timestamp: new Date().toISOString() }
    onAddMessage(userMsg)
    onMessageComplete?.(userMsg)

    const assistantId = crypto.randomUUID()
    // Snapshot before the request goes out — this is the list the model cites against.
    sourceSnapshotsRef.current.set(assistantId, sources)
    onAddMessage({
      id: assistantId,
      role: 'assistant',
      text: '',
      timestamp: new Date().toISOString(),
    })

    let accum = ''
    try {
      const res = await apiFetch('/api/notebook/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })),
          message: text,
          history: messages.slice(-10).map(m => ({ role: m.role, text: m.text })),
        }),
      })

      if (!res.body) throw new Error('No response stream')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
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
            if (chunk.error) { accum += `\n\n⚠️ ${chunk.error}`; onUpdateLastMessage(accum); break }
            if (chunk.text)  { accum += chunk.text; onUpdateLastMessage(accum) }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      accum = `⚠️ ${e instanceof Error ? e.message : 'Unknown error'}`
      onUpdateLastMessage(accum)
    } finally {
      setBusy(false)
      onMessageComplete?.({ id: assistantId, role: 'assistant', text: accum, timestamp: new Date().toISOString() })
    }
  }

  useImperativeHandle(ref, () => ({ ask: (q: string) => sendMessage(q) }))

  const noSources = sources.length === 0

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <h2 className="text-sm font-black" style={{ color: C.dark }}>Chat</h2>
        <p className="text-[11px] mt-0.5" style={{ color: '#86A0A5' }}>
          Ask questions about your sources
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center pt-8">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: C.bg }}
            >
              <Bot className="w-6 h-6" style={{ color: C.lime }} />
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: C.dark }}>Ask your sources anything</p>
              <p className="text-[11px] mt-1 max-w-xs" style={{ color: '#86A0A5' }}>
                {noSources
                  ? 'Add at least one source to start chatting'
                  : guide?.overview || 'What are the key themes? Summarize the main points...'}
              </p>
            </div>
            {guide && guide.questions.length > 0 && (
              <div className="flex flex-col gap-1.5 w-full max-w-xs mt-2">
                {guide.questions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-semibold text-left transition-all hover:opacity-80"
                    style={{ background: C.white, color: C.dark, border: '1.5px solid #D9E6E8' }}
                  >
                    <Sparkles className="w-3 h-3 shrink-0" style={{ color: C.lime }} />
                    <span>{q}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map(msg => {
          // History loaded from the server has no snapshot; best-effort with the live list.
          const msgSources = sourceSnapshotsRef.current.get(msg.id) ?? sources
          return (
            <MessageBubble
              key={msg.id}
              msg={msg}
              sources={msgSources}
              onCite={(idx, context) => setCitation({ source: msgSources[idx], context })}
            />
          )
        })}

        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t shrink-0" style={{ borderColor: '#D9E6E8', background: C.white }}>
        {noSources && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl text-[11px]" style={{ background: '#FEF3C7', color: '#92400E' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Add a source first to enable chat
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            disabled={busy || noSources}
            placeholder={noSources ? 'Add a source first...' : 'Ask a question... (Enter to send)'}
            rows={2}
            className="flex-1 text-xs px-3 py-2.5 rounded-xl border outline-none resize-none"
            style={{
              borderColor: '#D9E6E8',
              background: noSources ? '#F9FAFB' : C.bg,
              color: '#111',
            }}
          />
          <SubscriptionGate featureName="AI Chat">
            <button
              onClick={() => sendMessage()}
              disabled={busy || !input.trim() || noSources}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all shrink-0"
              style={{
                background: busy || !input.trim() || noSources ? '#D9E6E8' : C.dark,
                color: busy || !input.trim() || noSources ? '#86A0A5' : C.white,
              }}
            >
              <Send className="w-4 h-4" />
            </button>
          </SubscriptionGate>
        </div>
      </div>

      {citation && (
        <SourceViewerModal source={citation.source} context={citation.context} onClose={() => setCitation(null)} />
      )}
    </div>
  )
})
