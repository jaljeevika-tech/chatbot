// Glific-style live conversations: contact list by last activity + WhatsApp-style chat.

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, Send, RefreshCw, Loader2, X, Tag, StopCircle,
  MessageSquare, BotOff, Bot, Phone, Clock, User, HandHelping, UserCheck, ChevronLeft,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import type { ConversationItem, WaMessage } from '../../types/whatsapp'

const POLL_MS = 20_000   // refresh conversation list every 20s

function stringToColor(s: string) {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash)
  return `hsl(${Math.abs(hash) % 360}, 50%, 45%)`
}

function timeAgo(iso: string | null) {
  if (!iso) return ''
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function lastMsgPreview(c: ConversationItem) {
  if (!c.last_message_content) return 'No messages yet'
  const content = c.last_message_content as any
  const text = content?.text?.body || content?.body || content?.interactive?.body?.text
  if (text) return String(text).slice(0, 70)
  if (c.last_message_type === 'image') return '📷 Image'
  if (c.last_message_type === 'interactive') return '🔘 Interactive'
  return c.last_message_type || ''
}

function getMsgText(m: WaMessage): string {
  const c = m.content as any
  return (
    c?.text?.body ||
    c?.body ||
    c?.interactive?.body?.text ||
    c?.button?.text ||
    (m.type === 'interactive' ? (c?.interactive?.button_reply?.title || c?.interactive?.list_reply?.title) : '') ||
    m.type
  )
}

export function ConversationsTab() {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [loading, setLoading]             = useState(true)
  const [search, setSearch]               = useState('')
  const [filter, setFilter]               = useState<'all' | 'mine' | 'handoff' | 'active' | 'opted_in'>('all')
  const [selected, setSelected]           = useState<ConversationItem | null>(null)
  const [messages, setMessages]           = useState<WaMessage[]>([])
  const [msgLoading, setMsgLoading]       = useState(false)
  const [compose, setCompose]             = useState('')
  const [sending, setSending]             = useState(false)
  const [newTag, setNewTag]               = useState('')
  const [showTagInput, setShowTagInput]   = useState(false)
  const [stoppingSession, setStoppingSession] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [suggestions, setSuggestions]     = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const bottomRef   = useRef<HTMLDivElement>(null)
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // Read through refs so fetchConversations stays stable and the poll effect doesn't refetch per keystroke.
  const searchRef = useRef(search)
  searchRef.current = search
  const filterRef = useRef(filter)
  filterRef.current = filter

  const fetchConversations = useCallback(async (q = searchRef.current, filt = filterRef.current) => {
    try {
      const params = new URLSearchParams({ limit: '60' })
      if (q) params.set('q', q)
      if (filt === 'mine') params.set('assigned', 'me')
      const r = await apiFetch(`/api/wa/conversations?${params}`)
      const d = await r.json()
      if (q !== searchRef.current || filt !== filterRef.current) return
      setConversations(d.conversations || [])
    } catch {}
    setLoading(false)
  }, [])

  // `silent` = background poll: no spinner, just swap in the fresh list.
  const fetchMessages = useCallback(async (contactId: string, silent = false) => {
    if (!silent) setMsgLoading(true)
    try {
      const r = await apiFetch(`/api/wa/contacts/${contactId}/messages`)
      const d = await r.json()
      if (selectedRef.current?.id !== contactId) return
      setMessages(d.messages || [])
    } catch {}
    if (selectedRef.current?.id === contactId) setMsgLoading(false)
  }, [])

  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchConversations()
      if (selectedRef.current) fetchMessages(selectedRef.current.id, true)
    }, POLL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchConversations, fetchMessages])

  // Initial load, debounced search, and refetch on filter change ('mine' is a server-side query)
  useEffect(() => {
    const t = setTimeout(() => fetchConversations(search, filter), 300)
    return () => clearTimeout(t)
  }, [search, filter, fetchConversations])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchSuggestions = useCallback(async (contactId: string) => {
    setLoadingSuggestions(true)
    setSuggestions([])
    try {
      const r = await apiFetch(`/api/wa/contacts/${contactId}/suggest-replies`, { method: 'POST' })
      const d = await r.json()
      if (selectedRef.current?.id !== contactId) return
      setSuggestions(d.suggestions || [])
    } catch {}
    if (selectedRef.current?.id === contactId) setLoadingSuggestions(false)
  }, [])

  async function openConversation(c: ConversationItem) {
    setSelected(c)
    setCompose('')
    setShowTagInput(false)
    setSuggestions([])
    fetchSuggestions(c.id)
    await fetchMessages(c.id)
  }

  async function handleSend() {
    if (!compose.trim() || !selected || sending) return
    setSending(true)
    try {
      const r = await apiFetch(`/api/wa/contacts/${selected.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: compose.trim() }),
      })
      if (!r.ok) throw new Error()
      const d = await r.json()
      if (d.message) setMessages(prev => [...prev, d.message])
      else await fetchMessages(selected.id)
      setCompose('')
      setSuggestions([])  // refresh AI suggestions after a reply was sent
      setConversations(prev => prev.map(c =>
        c.id === selected.id
          ? { ...c, last_message_direction: 'outbound', last_message_content: { text: { body: compose.trim() } }, last_message_at: new Date().toISOString() }
          : c
      ))
    } catch {}
    setSending(false)
  }

  async function handleStopSession() {
    if (!selected?.session_id || stoppingSession) return
    setStoppingSession(true)
    try {
      await apiFetch(`/api/wa/sessions/${selected.session_id}`, { method: 'DELETE' })
      setSelected(prev => prev ? { ...prev, session_id: null, session_status: null, flow_name: null } : null)
      setConversations(prev => prev.map(c =>
        c.id === selected.id ? { ...c, session_id: null, session_status: null, flow_name: null } : c
      ))
    } catch {}
    setStoppingSession(false)
  }

  async function handleTakeover() {
    if (!selected?.session_id || handoffBusy) return
    setHandoffBusy(true)
    try {
      const r = await apiFetch(`/api/wa/sessions/${selected.session_id}/takeover`, { method: 'POST' })
      const d = await r.json()
      if (r.ok) {
        const patch = { session_status: 'handoff' as const, assigned_to_name: d.assigned_to_name || null }
        setSelected(prev => prev ? { ...prev, ...patch } : null)
        setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, ...patch } : c))
      }
    } catch {}
    setHandoffBusy(false)
  }

  async function handleReturnToBot() {
    if (!selected?.session_id || handoffBusy) return
    setHandoffBusy(true)
    try {
      const r = await apiFetch(`/api/wa/sessions/${selected.session_id}/return-to-bot`, { method: 'POST' })
      if (r.ok) {
        setSelected(prev => prev ? { ...prev, session_id: null, session_status: null, flow_name: null, assigned_to_name: null } : null)
        setConversations(prev => prev.map(c =>
          c.id === selected.id ? { ...c, session_id: null, session_status: null, flow_name: null, assigned_to_name: null } : c
        ))
      }
    } catch {}
    setHandoffBusy(false)
  }

  async function handleAddTag() {
    if (!newTag.trim() || !selected) return
    const newTags = [...new Set([...(selected.tags || []), newTag.trim().toLowerCase()])]
    try {
      await apiFetch(`/api/wa/contacts/${selected.id}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: newTags }),
      })
      setSelected(prev => prev ? { ...prev, tags: newTags } : null)
      setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, tags: newTags } : c))
      setNewTag(''); setShowTagInput(false)
    } catch {}
  }

  async function handleRemoveTag(tag: string) {
    if (!selected) return
    const newTags = (selected.tags || []).filter(t => t !== tag)
    try {
      await apiFetch(`/api/wa/contacts/${selected.id}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: newTags }),
      })
      setSelected(prev => prev ? { ...prev, tags: newTags } : null)
      setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, tags: newTags } : c))
    } catch {}
  }

  const visible = conversations.filter(c => {
    if (filter === 'handoff')  return c.session_status === 'handoff'
    if (filter === 'active')   return !!c.session_id && c.session_status !== 'handoff'
    if (filter === 'opted_in') return c.opted_in
    return true
  })

  const handoffCount = conversations.filter(c => c.session_status === 'handoff').length

  return (
    <div className="flex h-full min-h-0 gap-0 bg-white rounded-xl border border-[#D9E6E8] overflow-hidden">

      {/* Left: conversation list (hidden on mobile once a conversation is open) */}
      <div className={`w-full lg:w-72 lg:shrink-0 flex-col border-r border-gray-100 ${selected ? 'hidden lg:flex' : 'flex'}`}>

        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-gray-900 text-sm">Conversations</span>
            <button
              onClick={() => fetchConversations()}
              className="w-7 h-7 rounded-lg border border-[#D9E6E8] flex items-center justify-center hover:bg-gray-50 transition"
            >
              <RefreshCw className="w-3.5 h-3.5 text-gray-500" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-[#D9E6E8] text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="Search name or phone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1 mt-2 flex-wrap">
            {(['all', 'mine', 'handoff', 'active', 'opted_in'] as const).map(f => {
              const isActive = filter === f
              const label =
                f === 'all'      ? 'All'
              : f === 'mine'     ? '👤 Mine'
              : f === 'handoff'  ? `🙋 Needs reply${handoffCount > 0 ? ` (${handoffCount})` : ''}`
              : f === 'active'   ? '🤖 Bot'
              : '✅ Opt-in'
              const isHandoff = f === 'handoff' && handoffCount > 0
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="flex-1 text-[10px] font-semibold rounded-lg py-1 px-1 transition whitespace-nowrap"
                  style={{
                    background: isActive ? (isHandoff ? FF.red : '#341272') : (isHandoff ? FF.redBg : '#F3F4F6'),
                    color:      isActive ? '#fff' : (isHandoff ? FF.red : FF.textMuted),
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16 px-4 text-gray-400">
              <MessageSquare className="w-7 h-7 mx-auto mb-2 opacity-40" />
              <p className="text-xs">No conversations yet</p>
              <p className="text-[10px] mt-1 opacity-70">They'll appear when contacts message you</p>
            </div>
          ) : (
            visible.map(c => (
              <button
                key={c.id}
                onClick={() => openConversation(c)}
                className={`w-full text-left px-3 py-3 border-b border-gray-50 hover:bg-gray-50 transition flex items-start gap-2.5 ${selected?.id === c.id ? 'bg-purple-50 border-l-2 border-l-purple-500' : ''}`}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-bold mt-0.5"
                  style={{ background: stringToColor(c.wa_id) }}
                >
                  {(c.name || c.wa_id).charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-xs text-gray-900 truncate">
                      {c.name || `+${c.wa_id}`}
                    </span>
                    <span className="text-[9px] text-gray-400 shrink-0">
                      {timeAgo(c.last_message_at)}
                    </span>
                  </div>
                  <p className={`text-[10px] truncate mt-0.5 ${c.last_message_direction === 'inbound' ? 'text-gray-700' : 'text-gray-400'}`}>
                    {c.last_message_direction === 'outbound' && <span className="mr-1">↗</span>}
                    {lastMsgPreview(c)}
                  </p>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {c.session_status === 'handoff' ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 flex items-center gap-0.5 animate-pulse">
                        <HandHelping className="w-2.5 h-2.5" />
                        {c.assigned_to_name ? c.assigned_to_name.slice(0, 10) : 'Needs reply'}
                      </span>
                    ) : c.session_id && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 flex items-center gap-0.5">
                        <Bot className="w-2.5 h-2.5" />
                        {c.flow_name ? c.flow_name.slice(0, 12) : 'In flow'}
                      </span>
                    )}
                    {c.tags?.slice(0, 2).map(tag => (
                      <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: chat view (replaces the list on mobile) */}
      {selected ? (
        <div className="w-full lg:flex-1 lg:min-w-0 flex flex-col">

          <div className="px-3 sm:px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <button
                onClick={() => { setSelected(null); setMessages([]) }}
                className="lg:hidden w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-100 transition shrink-0 -ml-1"
                title="Back to conversations"
              >
                <ChevronLeft className="w-5 h-5 text-gray-600" />
              </button>
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                style={{ background: stringToColor(selected.wa_id) }}
              >
                {(selected.name || selected.wa_id).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-900 text-sm truncate">{selected.name || 'Unknown'}</span>
                  {selected.opted_in && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 shrink-0">OPT-IN</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <Phone className="w-3 h-3 text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-500">+{selected.wa_id}</span>
                  <Clock className="w-3 h-3 text-gray-400 ml-1 shrink-0" />
                  <span className="text-xs text-gray-500">Last seen {timeAgo(selected.last_seen)}</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => { setSelected(null); setMessages([]) }}
              className="hidden lg:flex w-7 h-7 rounded-lg items-center justify-center hover:bg-gray-100 transition shrink-0"
              title="Close conversation"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          <div className="px-5 py-2 border-b border-gray-50 bg-gray-50 flex items-center gap-3 flex-wrap shrink-0">
            {selected.session_status === 'handoff' ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-100 rounded-full px-2.5 py-1">
                  <HandHelping className="w-3.5 h-3.5" />
                  <span>Handoff{selected.assigned_to_name ? ` · ${selected.assigned_to_name}` : ' · unassigned'}</span>
                </div>
                {!selected.assigned_to_name && (
                  <button
                    onClick={handleTakeover}
                    disabled={handoffBusy}
                    title="Claim this conversation"
                    className="flex items-center gap-1 text-[10px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded-full px-2.5 py-1 transition"
                  >
                    {handoffBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCheck className="w-3 h-3" />}
                    Take over
                  </button>
                )}
                <button
                  onClick={handleReturnToBot}
                  disabled={handoffBusy}
                  title="Hand the conversation back to the bot"
                  className="flex items-center gap-1 text-[10px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-full px-2.5 py-1 transition"
                >
                  {handoffBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />}
                  Return to bot
                </button>
              </div>
            ) : selected.session_id ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-700 bg-purple-100 rounded-full px-2.5 py-1">
                  <Bot className="w-3.5 h-3.5" />
                  <span>{selected.flow_name || 'Flow active'}</span>
                </div>
                <button
                  onClick={handleTakeover}
                  disabled={handoffBusy}
                  title="Pause bot and take over manually"
                  className="flex items-center gap-1 text-[10px] font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-full px-2 py-1 transition"
                >
                  {handoffBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <HandHelping className="w-3 h-3" />}
                  Take over
                </button>
                <button
                  onClick={handleStopSession}
                  disabled={stoppingSession}
                  title="End the session entirely"
                  className="flex items-center gap-1 text-[10px] font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-full px-2 py-1 transition"
                >
                  {stoppingSession ? <Loader2 className="w-3 h-3 animate-spin" /> : <StopCircle className="w-3 h-3" />}
                  End
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <BotOff className="w-3.5 h-3.5" />
                <span>No active session — manual mode</span>
              </div>
            )}

            <div className="flex items-center gap-1 flex-wrap ml-auto">
              {(selected.tags || []).map(tag => (
                <span key={tag} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">
                  {tag}
                  <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-500 transition">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {showTagInput ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    className="text-[10px] px-2 py-0.5 rounded-full border border-purple-300 focus:outline-none w-20"
                    placeholder="tag name"
                    value={newTag}
                    onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setShowTagInput(false); setNewTag('') } }}
                  />
                  <button onClick={handleAddTag} className="text-purple-600 hover:text-purple-800">
                    <Send className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowTagInput(true)}
                  className="text-[10px] text-gray-400 hover:text-purple-600 transition flex items-center gap-0.5"
                >
                  <Tag className="w-3 h-3" /> Add tag
                </button>
              )}
            </div>
          </div>

          {Object.keys(selected.fields || {}).length > 0 && (
            <div className="px-5 py-2 border-b border-gray-50 bg-amber-50 shrink-0">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-[9px] font-bold text-amber-700 uppercase tracking-widest flex items-center gap-1">
                  <User className="w-3 h-3" /> Collected data
                </span>
                {Object.entries(selected.fields).map(([k, v]) => (
                  <div key={k} className="text-[10px] flex items-center gap-1">
                    <span className="text-gray-500">{k}:</span>
                    <span className="font-semibold text-gray-800">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[#f0f2f5]">
            {msgLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              messages.map((m, i) => {
                const isOut   = m.direction === 'outbound'
                const text    = getMsgText(m)
                const isManual = (m.content as any)?._manual

                return (
                  <div key={m.id || i} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[72%] rounded-2xl px-3.5 py-2 shadow-sm ${
                        isOut
                          ? isManual
                            ? 'bg-teal-600 text-white rounded-tr-sm'
                            : 'bg-purple-600 text-white rounded-tr-sm'
                          : 'bg-white text-gray-900 rounded-tl-sm'
                      }`}
                    >
                      {isManual && (
                        <div className="text-[9px] font-bold text-teal-200 mb-0.5 uppercase tracking-wide">
                          Agent reply
                        </div>
                      )}
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
                      <p className={`text-[9px] mt-1 ${isOut ? 'text-white/60' : 'text-gray-400'} text-right`}>
                        {new Date(m.created_at).toLocaleTimeString('en-IN', {
                          hour: '2-digit', minute: '2-digit',
                        })}
                        {isOut && m.status && ` · ${m.status}`}
                      </p>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>

          <div className="px-4 py-3 border-t border-gray-100 bg-white shrink-0">
            {selected.session_status === 'handoff' ? (
              <div className="text-[10px] text-red-700 mb-2 flex items-center gap-1 font-semibold">
                <HandHelping className="w-3 h-3" />
                You're in handoff mode — the bot is paused. Reply normally, then click <b>Return to bot</b> when done.
              </div>
            ) : selected.session_id && (
              <div className="text-[10px] text-amber-600 mb-2 flex items-center gap-1">
                <Bot className="w-3 h-3" />
                Bot is active. Your message will be sent but the bot may also respond. Click <b>Take over</b> to pause it.
              </div>
            )}
            {(loadingSuggestions || suggestions.length > 0) && (
              <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-purple-600 font-semibold flex items-center gap-1">
                  <Bot className="w-3 h-3" /> AI suggestions
                </span>
                {loadingSuggestions ? (
                  <span className="text-[10px] text-gray-400 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> thinking…
                  </span>
                ) : (
                  <>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setCompose(s)}
                        title="Click to insert"
                        className="text-[11px] px-2 py-1 rounded-full bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 transition max-w-[280px] truncate"
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => selected && fetchSuggestions(selected.id)}
                      title="Refresh suggestions"
                      className="text-[10px] text-gray-400 hover:text-purple-600 px-1"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                className="flex-1 rounded-2xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
                placeholder="Type a message…"
                value={compose}
                onChange={e => setCompose(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
              />
              <button
                onClick={handleSend}
                disabled={!compose.trim() || sending}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0 transition disabled:opacity-50"
                style={{ background: '#25D366' }}
              >
                {sending
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Send className="w-4 h-4" />
                }
              </button>
            </div>
            <p className="text-[9px] text-gray-400 mt-1">Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      ) : (
        /* Empty state, desktop only; mobile shows the list */
        <div className="hidden lg:flex flex-1 flex-col items-center justify-center text-gray-400 bg-[#f0f2f5]">
          <div className="text-6xl mb-4">💬</div>
          <p className="font-semibold text-gray-600">Select a conversation</p>
          <p className="text-sm mt-1">Click a contact on the left to start chatting</p>
        </div>
      )}
    </div>
  )
}
