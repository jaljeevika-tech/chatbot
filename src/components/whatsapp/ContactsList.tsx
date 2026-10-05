// WhatsApp contacts list with a message-history drawer.

import { useState, useEffect, useCallback } from 'react'
import { Search, ChevronRight, ChevronLeft, MessageSquare, Tag, Loader2, X, RefreshCw, Layers, Plus } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import type { WaContact, WaMessage } from '../../types/whatsapp'
import { FF } from '../../theme/colors'

const PAGE_SIZE = 50

export function ContactsList() {
  const [contacts, setContacts] = useState<WaContact[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [offset, setOffset]     = useState(0)
  const [selected, setSelected] = useState<WaContact | null>(null)
  const [messages, setMessages] = useState<WaMessage[]>([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [addingCollection, setAddingCollection] = useState(false)
  const [collections, setCollections]           = useState<string[]>([])
  const [newCollection, setNewCollection]       = useState('')
  const [bulkBusy, setBulkBusy]                 = useState(false)

  function toggleSelect(id: string, e: React.MouseEvent | React.ChangeEvent) {
    e.stopPropagation()
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function clearSelection() { setSelectedIds(new Set()) }

  async function fetchCollections() {
    try {
      const r = await apiFetch('/api/wa/collections')
      const d = await r.json()
      setCollections((d.collections || []).map((c: { name: string }) => c.name))
    } catch {}
  }
  useEffect(() => { fetchCollections() }, [])

  async function addToCollection(name: string) {
    if (!name || !selectedIds.size) return
    setBulkBusy(true)
    try {
      const r = await apiFetch(`/api/wa/collections/${encodeURIComponent(name)}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: Array.from(selectedIds) }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Add failed')
      setContacts(cs => cs.map(c => selectedIds.has(c.id) && !c.tags?.includes(name)
        ? { ...c, tags: [...(c.tags || []), name] } : c))
      clearSelection()
      setAddingCollection(false)
      setNewCollection('')
      fetchCollections()
    } catch (e: any) {
      alert('Add failed: ' + (e.message || 'unknown'))
    }
    setBulkBusy(false)
  }

  const fetchContacts = useCallback(async (q: string, off: number) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) })
      if (q) params.set('q', q)
      const r = await apiFetch(`/api/wa/contacts?${params}`)
      const d = await r.json()
      if (off === 0) {
        setContacts(d.contacts || [])
      } else {
        setContacts(prev => [...prev, ...(d.contacts || [])])
      }
      setTotal(d.total || 0)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { setOffset(0); fetchContacts(search, 0) }, 300)
    return () => clearTimeout(t)
  }, [search, fetchContacts])

  async function openContact(c: WaContact) {
    setSelected(c)
    setMsgLoading(true)
    try {
      const r = await apiFetch(`/api/wa/contacts/${c.id}/messages`)
      const d = await r.json()
      setMessages(Array.isArray(d) ? d : (d.messages || []))
    } catch {}
    setMsgLoading(false)
  }

  function loadMore() {
    const next = offset + PAGE_SIZE
    setOffset(next)
    fetchContacts(search, next)
  }

  return (
    <div className="flex h-full gap-0 lg:gap-4">

      {/* Contact list (hidden on mobile once a contact is open) */}
      <div className={`w-full lg:flex-1 lg:min-w-0 flex-col bg-white rounded-xl border border-[#D9E6E8] overflow-hidden ${selected ? 'hidden lg:flex' : 'flex'}`}>

        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900">Contacts</h3>
            <p className="text-xs text-gray-500 mt-0.5">{total.toLocaleString()} total</p>
          </div>
          <button onClick={() => { setOffset(0); fetchContacts(search, 0) }}
            className="w-8 h-8 rounded-xl border border-[#D9E6E8] flex items-center justify-center hover:bg-gray-50 transition">
            <RefreshCw className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-[#D9E6E8] text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder="Search by name or phone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="px-4 py-2.5 bg-purple-50 border-b border-purple-100 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-purple-900">
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => setAddingCollection(true)}
              className="ml-auto text-[11px] font-semibold px-3 py-1 rounded-lg text-white flex items-center gap-1.5"
              style={{ background: '#341272' }}
            >
              <Layers className="w-3 h-3" /> Add to Collection
            </button>
            <button
              onClick={clearSelection}
              className="text-[11px] text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          </div>
        )}

        {addingCollection && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !bulkBusy && setAddingCollection(false)}>
            <div className="bg-white rounded-xl border border-[#D9E6E8] shadow-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
              <h3 className="font-bold text-gray-900 flex items-center gap-2 mb-3">
                <Layers className="w-4 h-4 text-purple-600" /> Add {selectedIds.size} contact{selectedIds.size === 1 ? '' : 's'} to…
              </h3>

              {collections.length > 0 && (
                <>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Existing</p>
                  <div className="flex flex-wrap gap-1.5 mb-3 max-h-32 overflow-auto">
                    {collections.map(name => (
                      <button
                        key={name}
                        onClick={() => addToCollection(name)}
                        disabled={bulkBusy}
                        className="text-[11px] px-2.5 py-1 rounded-full bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 transition disabled:opacity-50"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Or create new</p>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                  placeholder="farmers-bihar"
                  value={newCollection}
                  onChange={e => setNewCollection(e.target.value.trim().replace(/\s+/g, '-'))}
                  onKeyDown={e => { if (e.key === 'Enter') addToCollection(newCollection) }}
                  autoFocus
                />
                <button
                  onClick={() => addToCollection(newCollection)}
                  disabled={!newCollection.trim() || bulkBusy}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                  style={{ background: FF.green }}
                >
                  {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
                </button>
              </div>

              <button
                onClick={() => setAddingCollection(false)}
                disabled={bulkBusy}
                className="mt-3 w-full text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading && contacts.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No contacts yet</p>
              <p className="text-xs mt-1">Contacts appear when they message your number</p>
            </div>
          ) : (
            <>
              {contacts.map(c => (
                <div
                  key={c.id}
                  className={`w-full px-5 py-3.5 border-b border-gray-50 hover:bg-gray-50 transition flex items-center gap-3 cursor-pointer ${selected?.id === c.id ? 'bg-purple-50' : ''} ${selectedIds.has(c.id) ? 'bg-blue-50' : ''}`}
                  onClick={() => openContact(c)}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={e => toggleSelect(c.id, e)}
                    onClick={e => e.stopPropagation()}
                    className="w-4 h-4 accent-purple-600 shrink-0"
                    title="Select for bulk action"
                  />
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-bold"
                    style={{ background: stringToColor(c.wa_id) }}>
                    {(c.name || c.wa_id).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-gray-900 truncate">
                        {c.name || c.wa_id}
                      </span>
                      {c.opted_in && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                          OPT-IN
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 truncate">
                      +{c.wa_id} · {c.message_count} messages
                    </div>
                    {c.tags?.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {c.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                </div>
              ))}
              {contacts.length < total && (
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className="w-full py-3 text-sm font-semibold text-purple-600 hover:bg-purple-50 transition"
                >
                  {loading ? 'Loading…' : `Load more (${total - contacts.length} remaining)`}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Message history drawer (replaces the list on mobile) */}
      {selected && (
        <div className="w-full lg:w-80 flex flex-col bg-white rounded-xl border border-[#D9E6E8] overflow-hidden lg:shrink-0">
          <div className="px-3 sm:px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => setSelected(null)}
                className="lg:hidden w-7 h-7 rounded-lg flex items-center justify-center hover:bg-gray-100 transition shrink-0 -ml-1"
                title="Back to contacts"
              >
                <ChevronLeft className="w-5 h-5 text-gray-600" />
              </button>
              <div className="min-w-0">
                <h3 className="font-bold text-gray-900 text-sm truncate">{selected.name || selected.wa_id}</h3>
                <p className="text-xs text-gray-500">+{selected.wa_id}</p>
              </div>
            </div>
            <button onClick={() => setSelected(null)}
              className="hidden lg:flex w-7 h-7 rounded-lg items-center justify-center hover:bg-gray-100 transition shrink-0">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {Object.keys(selected.fields || {}).length > 0 && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1">
                <Tag className="w-3 h-3" /> Collected Fields
              </div>
              <div className="space-y-1">
                {Object.entries(selected.fields).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">{k}</span>
                    <span className="font-semibold text-gray-800 truncate max-w-[140px]">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto p-4 space-y-2">
            {msgLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-center text-xs text-gray-400 py-10">No messages yet</p>
            ) : (
              [...messages].reverse().map(m => {
                const isOut = m.direction === 'outbound'
                const text = (m.content as any)?.text?.body
                  || (m.content as any)?.body
                  || (m.content as any)?.template?.name
                  || m.type
                return (
                  <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 text-xs ${
                        isOut
                          ? 'bg-purple-600 text-white rounded-tr-sm'
                          : 'bg-gray-100 text-gray-800 rounded-tl-sm'
                      }`}
                    >
                      <p>{text}</p>
                      <p className={`text-[9px] mt-1 ${isOut ? 'text-purple-200' : 'text-gray-400'}`}>
                        {new Date(m.created_at).toLocaleString('en-IN', {
                          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                        {isOut && m.status && ` · ${m.status}`}
                      </p>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function stringToColor(s: string) {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 55%, 45%)`
}
