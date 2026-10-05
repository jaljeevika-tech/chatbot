// Broadcast messages to opted-in contacts or a collection.

import { useState, useEffect } from 'react'
import { Send, Users, CheckCircle2, AlertCircle, Loader2, History, MessageSquare, Layers } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'

interface Broadcast {
  id:           string
  name:         string
  message_body: string
  total_sent:   number
  total_failed: number
  status:       string
  created_at:   string
}

export function BroadcastPanel() {
  const [name, setName]     = useState('')
  const [message, setMessage] = useState('')
  const [optedIn, setOptedIn] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult]   = useState<{ sent: number; failed: number } | null>(null)
  const [error, setError]     = useState('')
  const [history] = useState<Broadcast[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [collections, setCollections]       = useState<Array<{ name: string; member_count: number; opted_in_count: number }>>([])
  const [target, setTarget]                 = useState<string>('all')  // 'all' = all opted-in; otherwise = collection name

  useEffect(() => {
    apiFetch('/api/wa/contacts?opted_in=true&limit=1')
      .then(r => r.json())
      .then(d => setOptedIn(d.total ?? null))
      .catch(() => {})

    apiFetch('/api/wa/collections')
      .then(r => r.json())
      .then(d => setCollections(Array.isArray(d.collections) ? d.collections : []))
      .catch(() => {})

    // No dedicated history endpoint yet; stats stand in
    apiFetch('/api/wa/stats')
      .then(r => r.json())
      .then(() => {})
      .catch(() => {})
      .finally(() => setLoadingHistory(false))
  }, [])

  // Resolve the audience size for the confirm dialog
  const targetCount = target === 'all'
    ? (optedIn ?? 0)
    : (collections.find(c => c.name === target)?.opted_in_count ?? 0)

  const charsLeft = 1024 - message.length
  const canSend   = name.trim() && message.trim() && message.length <= 1024 && !sending

  async function handleSend() {
    if (!canSend) return
    const audience = target === 'all'
      ? `${optedIn ?? 'all'} opted-in contacts`
      : `${targetCount} contacts in collection "${target}"`
    const confirm = window.confirm(
      `Send this message to ${audience}?\n\n"${message.slice(0, 100)}${message.length > 100 ? '…' : ''}"`
    )
    if (!confirm) return

    setSending(true); setError(''); setResult(null)
    try {
      const recipient_filter = target === 'all' ? {} : { tags: [target] }
      const res = await apiFetch('/api/wa/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message_body: message, recipient_filter }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Broadcast failed')
      setResult({ sent: d.total ?? 0, failed: 0 })
      setName('')
      setMessage('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">

      <div className="rounded-xl border border-[#D9E6E8] bg-white p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Users className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <div className="font-bold text-gray-900">Broadcast Audience</div>
            {optedIn !== null ? (
              <div className="text-sm text-gray-500">
                <span className="font-semibold text-purple-700">{optedIn.toLocaleString()}</span> opted-in contacts will receive this message
              </div>
            ) : (
              <div className="text-sm text-gray-400">Loading audience size…</div>
            )}
          </div>
        </div>
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800">
          ⚠️ <strong>Important:</strong> WhatsApp only allows businesses to initiate messages using approved templates. Make sure your message complies with Meta's Business Policy. Free-form messages can only be sent within 24h of user contact.
        </div>
      </div>

      <div className="rounded-xl border border-[#D9E6E8] bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Compose Broadcast</h3>
        </div>
        <div className="p-5 space-y-4">

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              Broadcast Name <span className="text-red-400">*</span>
            </label>
            <input
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="e.g. May Health Camp Reminder"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-purple-500" /> Send To
            </label>
            <select
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
              value={target}
              onChange={e => setTarget(e.target.value)}
            >
              <option value="all">All opted-in contacts {optedIn != null ? `(${optedIn})` : ''}</option>
              {collections.length > 0 && <option disabled>──── Collections ────</option>}
              {collections.map(c => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.opted_in_count} opted-in)
                </option>
              ))}
            </select>
            {target !== 'all' && (
              <p className="text-[10px] text-gray-400 mt-1">
                Only opted-in members of <strong>{target}</strong> will receive this message.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              Message <span className="text-red-400">*</span>
            </label>
            <textarea
              rows={6}
              className="w-full rounded-xl border border-[#D9E6E8] px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
              placeholder="Type your broadcast message here…"
              value={message}
              onChange={e => setMessage(e.target.value)}
            />
            <div className={`text-xs mt-1 text-right ${charsLeft < 50 ? 'text-red-500' : 'text-gray-400'}`}>
              {charsLeft} characters remaining
            </div>
          </div>

          {message && (
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">
                Preview
              </div>
              <div className="flex justify-start">
                <div className="max-w-[80%] bg-white border border-[#D9E6E8] rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-gray-800 shadow-sm whitespace-pre-wrap">
                  {message}
                  <div className="text-[9px] text-gray-400 mt-1 text-right">
                    {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          {result && (
            <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 rounded-xl px-4 py-3">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Sent to <strong>{result.sent}</strong> contacts
              {result.failed > 0 && <span className="text-red-500 ml-1">({result.failed} failed)</span>}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            Messages are sent at ~80/second to avoid rate limiting
          </p>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: '#341272' }}
          >
            {sending
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
              : <><Send className="w-4 h-4" /> Send Broadcast</>
            }
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#D9E6E8] bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <History className="w-4 h-4 text-gray-500" />
          <h3 className="font-bold text-gray-900 text-sm">Broadcast History</h3>
        </div>
        {loadingHistory ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
          </div>
        ) : history.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <MessageSquare className="w-7 h-7 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No broadcasts sent yet</p>
          </div>
        ) : (
          <div>
            {history.map(b => (
              <div key={b.id} className="px-5 py-4 border-b border-gray-50 flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-gray-900 truncate">{b.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {new Date(b.created_at).toLocaleDateString('en-IN')} · {b.total_sent} sent · {b.total_failed} failed
                  </div>
                </div>
                <StatusBadge status={b.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    completed: { bg: FF.greenBg, text: FF.green, label: 'Completed' },
    sending:   { bg: '#DBEAFE',  text: '#1D4ED8', label: 'Sending'   },
    failed:    { bg: FF.redBg,   text: FF.red,    label: 'Failed'    },
    draft:     { bg: '#F3F4F6',  text: '#374151', label: 'Draft'     },
  }
  const s = map[status] ?? map.draft
  return (
    <span className="text-[10px] font-bold px-2.5 py-1 rounded-full" style={{ background: s.bg, color: s.text }}>
      {s.label}
    </span>
  )
}
