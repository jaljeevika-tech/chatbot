// Floating org-aware AI chat (POST /api/ai/ask, SSE) with thumbs up/down feedback.

import { useState, useRef, useEffect } from 'react'
import { Sparkles, X, Send, Bot, User, ThumbsUp, ThumbsDown } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { useAuthContext } from '../../context/AuthContext'

interface Message {
  id:            string
  role:          'user' | 'assistant'
  text:          string
  interactionId?: number
}

const BRAND = '#341272'
const BG    = '#FBF9F4'

const STARTER_PROMPTS = [
  'Summarise recent field activity',
  'What are the main barriers workers face?',
  'Which project has the most beneficiary outreach?',
  'What patterns appear across the latest reports?',
]

export function AIAssistantPanel() {
  const { user }               = useAuthContext()
  const isAdmin                = user?.role === 'admin' || user?.role === 'superadmin'
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [busy,     setBusy]     = useState(false)
  const [seeding,   setSeeding]  = useState(false)
  const autoChecked             = useRef(false)
  const bottomRef               = useRef<HTMLDivElement>(null)
  const textareaRef             = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 80)
  }, [open])

  // First open per session (admin): seed org memories if there are none.
  useEffect(() => {
    if (!open || !isAdmin || autoChecked.current) return
    autoChecked.current = true
    apiFetch('/api/ai/memories')
      .then(r => r.json())
      .then(({ needsSeed }) => {
        if (needsSeed) seedMemories()
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdmin])

  function addMessage(msg: Message) {
    setMessages(prev => [...prev, msg])
  }

  function updateLastMessage(patch: Partial<Message>) {
    setMessages(prev => {
      if (!prev.length) return prev
      const copy = [...prev]
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch }
      return copy
    })
  }

  async function sendFeedback(interactionId: number, feedback: 1 | -1) {
    await apiFetch('/api/ai/feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ interactionId, feedback }),
    }).catch(() => {})
  }

  // Silent background seed: drains the SSE stream, shows nothing
  async function seedMemories() {
    if (seeding) return
    setSeeding(true)
    try {
      const res = await apiFetch('/api/ai/seed-memories', { method: 'POST' })
      if (!res.body) return
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
            if (chunk.error) console.warn('[AI] Seed error:', chunk.error)
          } catch { /* skip */ }
        }
      }
    } catch { /* silent */ } finally {
      setSeeding(false)
    }
  }

  async function send(override?: string) {
    const text = (override ?? input).trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)

    addMessage({ id: crypto.randomUUID(), role: 'user', text })
    addMessage({ id: crypto.randomUUID(), role: 'assistant', text: '' })

    try {
      const history = messages.slice(-6).map(m => ({ role: m.role, text: m.text.slice(0, 400) }))

      const res = await apiFetch('/api/ai/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, history }),
      })

      if (!res.body) throw new Error('No response stream')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   accum   = ''
      let   buffer  = ''
      let   iid: number | undefined

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
            if (chunk.interactionId) {
              iid = chunk.interactionId
            }
            if (chunk.error) {
              accum += `\n\n⚠️ ${chunk.error}`
              updateLastMessage({ text: accum.trim(), interactionId: iid })
              break
            }
            if (chunk.text) {
              accum += chunk.text
              updateLastMessage({ text: accum, interactionId: iid })
            }
          } catch { /* skip unparseable frames */ }
        }
      }

      if (iid !== undefined) {
        updateLastMessage({ text: accum || '…', interactionId: iid })
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        updateLastMessage({ text: `⚠️ ${e instanceof Error ? e.message : 'Unknown error'}` })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="FieldFlow AI Assistant"
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-2xl shadow-xl flex items-center justify-center transition-all hover:scale-105 hover:shadow-2xl"
          style={{ background: BRAND }}
        >
          <Sparkles className="w-6 h-6 text-white" />
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 sm:inset-auto sm:bottom-6 sm:right-6 z-50 flex flex-col sm:rounded-2xl shadow-2xl overflow-hidden w-full h-full sm:w-[376px] sm:h-[584px] sm:border-[1.5px] sm:border-[#D9E6E8]"
          style={{ background: '#fff' }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ background: BRAND }}
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-4 h-4 text-white" />
              <span className="text-sm font-bold text-white">FieldFlow AI</span>
              <span className="text-[10px] text-white/50 ml-1">Beta</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-white/50 hover:text-white transition"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0" style={{ background: BG }}>
            {messages.length === 0 && (
              <div className="space-y-2 pt-1">
                {seeding
                  ? <p className="text-[10px] text-purple-400 text-center animate-pulse pb-1">
                      Learning from your field reports…
                    </p>
                  : <p className="text-[11px] text-gray-400 text-center pb-1">
                      Ask anything about your field data
                    </p>
                }
                {STARTER_PROMPTS.map(s => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={busy}
                    className="w-full text-left text-xs px-3 py-2.5 rounded-xl bg-white border border-gray-100 hover:border-purple-200 hover:bg-purple-50 transition text-gray-600 shadow-sm disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                <div
                  className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: msg.role === 'user' ? '#0E3A46' : '#fff' }}
                >
                  {msg.role === 'user'
                    ? <User className="w-3 h-3 text-white" />
                    : <Bot  className="w-3 h-3" style={{ color: BRAND }} />}
                </div>

                <div className="flex flex-col gap-1 max-w-[82%]">
                  <div
                    className="px-3 py-2.5 rounded-xl text-xs leading-relaxed whitespace-pre-wrap"
                    style={{
                      background:              msg.role === 'user' ? '#0E3A46' : '#fff',
                      color:                   msg.role === 'user' ? '#fff' : '#111',
                      borderBottomRightRadius: msg.role === 'user' ? 4 : undefined,
                      borderBottomLeftRadius:  msg.role === 'user' ? undefined : 4,
                      border:                  msg.role === 'assistant' ? '1px solid #F3F4F6' : undefined,
                    }}
                  >
                    {msg.text
                      ? msg.text
                      : <span className="opacity-30 animate-pulse">● ● ●</span>}
                  </div>

                  {/* Feedback: completed assistant messages only */}
                  {msg.role === 'assistant' && msg.text && msg.interactionId && (
                    <div className="flex gap-1.5 pl-1">
                      <button
                        onClick={() => sendFeedback(msg.interactionId!, 1)}
                        className="text-gray-300 hover:text-green-500 transition"
                        title="Helpful"
                      >
                        <ThumbsUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => sendFeedback(msg.interactionId!, -1)}
                        className="text-gray-300 hover:text-red-400 transition"
                        title="Not helpful"
                      >
                        <ThumbsDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            <div ref={bottomRef} />
          </div>

          <div
            className="px-3 py-3 shrink-0"
            style={{ borderTop: '1px solid #F3F4F6', background: '#fff' }}
          >
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                }}
                placeholder="Ask about your data…"
                rows={1}
                disabled={busy}
                className="flex-1 resize-none text-xs px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:border-purple-400 transition placeholder-gray-300 disabled:opacity-60"
                style={{ maxHeight: 84 }}
              />
              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
                className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center transition hover:opacity-80 disabled:opacity-40"
                style={{ background: BRAND }}
              >
                <Send className="w-3.5 h-3.5 text-white" />
              </button>
            </div>
            <p className="text-[9px] text-gray-300 mt-1.5 text-center">
              Answers are based on your org's saved context. Verify critical numbers.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
