// "Ask AI" about one Document Vault file: the notebook ChatPanel and OutputPanel fed with
// this document's extracted text as their only source.

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Loader2, AlertCircle, MessageSquare, Layers } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { ChatPanel, type ChatPanelHandle } from '../notebook/ChatPanel'
import { OutputPanel } from '../notebook/OutputPanel'
import type { NotebookSource, ChatMessage } from '../../types/notebook'

type Tab = 'chat' | 'output'

interface Props {
  projectKey: string
  documentId: string
  documentName: string
  onClose: () => void
}

export function DocumentAskAiPanel({ projectKey, documentId, documentName, onClose }: Props) {
  const [sources, setSources] = useState<NotebookSource[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  const chatRef = useRef<ChatPanelHandle>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/documents/${documentId}/text`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'This document has no extracted text yet')
        return r.json()
      })
      .then((d: { extracted_text: string }) => {
        if (cancelled) return
        setSources([{
          id: documentId,
          name: documentName,
          type: 'txt',
          content: d.extracted_text,
          charCount: d.extracted_text.length,
          addedAt: new Date().toISOString(),
        }])
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load document text') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectKey, documentId, documentName])

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full sm:w-[460px] lg:w-[560px] h-full bg-white flex flex-col shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: FF.border }}>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: FF.textFaint }}>Ask AI</p>
            <p className="text-sm font-semibold truncate" style={{ color: FF.tealDark }}>{documentName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 transition shrink-0">
            <X className="w-4 h-4" style={{ color: FF.textMuted }} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center" style={{ color: FF.textFaint }}>
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertCircle className="w-6 h-6" style={{ color: FF.red }} />
            <p className="text-xs" style={{ color: FF.textMuted }}>{error}</p>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5 px-3 py-2 border-b shrink-0" style={{ borderColor: FF.border }}>
              {([
                { key: 'chat' as const, label: 'Chat', icon: MessageSquare },
                { key: 'output' as const, label: 'Outputs', icon: Layers },
              ]).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: tab === key ? FF.tealDark : 'transparent',
                    color: tab === key ? '#FFFFFF' : FF.textMuted,
                  }}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              {tab === 'chat' ? (
                <ChatPanel
                  ref={chatRef}
                  sources={sources}
                  messages={messages}
                  onAddMessage={addMessage}
                  onUpdateLastMessage={updateLastMessage}
                />
              ) : (
                <OutputPanel sources={sources} onAskQuestion={q => { setTab('chat'); chatRef.current?.ask(q) }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
