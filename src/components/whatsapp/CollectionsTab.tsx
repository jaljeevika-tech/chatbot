// Glific-style Collections: a collection is a wa_contacts tag with admin UI around it.

import { useEffect, useState } from 'react'
import {
  Layers, Search, RefreshCw, Loader2, X, Users, Plus,
  Trash2, AlertCircle,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

const C = {
  purple: '#341272',
  green: '#3F7D5C',
  amber: '#B8862E',
  red: '#B0473C',
  border: '#D9E6E8',
  surface: '#FBF9F4',
}

type Collection = {
  name:            string
  member_count:    number
  opted_in_count:  number
  last_activity:   string | null
}

type Member = {
  id:        string
  wa_id:     string
  name:      string | null
  tags:      string[]
  opted_in:  boolean
  last_seen: string | null
}

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 3600)  return `${Math.max(1, Math.floor(diff / 60))}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

function colorFor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h)
  return `hsl(${Math.abs(h) % 360}, 55%, 45%)`
}

export function CollectionsTab() {
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [search, setSearch]           = useState('')
  const [selected, setSelected]       = useState<Collection | null>(null)
  const [members, setMembers]         = useState<Member[]>([])
  const [memLoading, setMemLoading]   = useState(false)
  const [newName, setNewName]         = useState('')
  const [creating, setCreating]       = useState(false)

  async function fetchCollections() {
    setLoading(true); setError('')
    try {
      const r = await apiFetch('/api/wa/collections')
      const d = await r.json()
      setCollections(d.collections || [])
    } catch (e: any) {
      setError(e.message || 'Failed to load collections')
    }
    setLoading(false)
  }
  useEffect(() => { fetchCollections() }, [])

  async function openCollection(c: Collection) {
    setSelected(c); setMemLoading(true); setMembers([])
    try {
      const r = await apiFetch(`/api/wa/collections/${encodeURIComponent(c.name)}/members`)
      const d = await r.json()
      setMembers(d.members || [])
    } catch {}
    setMemLoading(false)
  }

  async function removeMember(contactId: string) {
    if (!selected) return
    if (!confirm(`Remove this contact from "${selected.name}"?`)) return
    try {
      const r = await apiFetch(`/api/wa/collections/${encodeURIComponent(selected.name)}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: [contactId] }),
      })
      if (!r.ok) throw new Error()
      setMembers(m => m.filter(x => x.id !== contactId))
      setCollections(cs => cs.map(c => c.name === selected.name ? { ...c, member_count: Math.max(0, c.member_count - 1) } : c))
      setSelected(s => s ? { ...s, member_count: Math.max(0, s.member_count - 1) } : s)
    } catch (e: any) {
      alert('Remove failed: ' + (e.message || 'unknown'))
    }
  }

  async function deleteCollection(name: string) {
    if (!confirm(`Delete collection "${name}"? Contacts won't be deleted — they'll just be removed from this collection.`)) return
    try {
      const r = await apiFetch(`/api/wa/collections/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error()
      setCollections(cs => cs.filter(c => c.name !== name))
      setSelected(null)
    } catch (e: any) {
      alert('Delete failed: ' + (e.message || 'unknown'))
    }
  }

  async function createCollection() {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      // Empty collections exist only locally until members are added via the Contacts tab.
      setCollections(cs => cs.some(c => c.name === name) ? cs : [...cs, { name, member_count: 0, opted_in_count: 0, last_activity: null }])
      setNewName('')
    } catch {}
    setCreating(false)
  }

  const filtered = collections.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <Layers className="w-4 h-4" style={{ color: C.purple }} /> Collections
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Groups of contacts you can broadcast to, run flows for, or filter by. Backed by contact tags.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              className="pl-8 pr-3 py-1.5 rounded-xl border border-[#D9E6E8] text-xs focus:outline-none focus:ring-2 focus:ring-purple-300 w-48"
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={fetchCollections}
            className="w-9 h-9 rounded-xl border border-[#D9E6E8] flex items-center justify-center hover:bg-gray-50 transition"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border p-3 flex items-center gap-2" style={{ borderColor: C.border }}>
        <Plus className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          className="flex-1 text-sm focus:outline-none bg-transparent"
          placeholder="New collection name (e.g. farmers-bihar, women-vendors)…"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createCollection() }}
        />
        <button
          onClick={createCollection}
          disabled={!newName.trim() || creating}
          className="text-xs font-semibold px-3 py-1 rounded-lg text-white disabled:opacity-50"
          style={{ background: C.purple }}
        >
          Create
        </button>
      </div>
      {newName.trim() && (
        <p className="text-[10px] text-gray-400 px-2">
          Empty collection. Open the <strong>Contacts</strong> tab → select contacts → click "Add to Collection" to populate.
        </p>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading && !collections.length ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border p-10 text-center" style={{ borderColor: C.border }}>
          <Layers className="w-10 h-10 mx-auto text-gray-200 mb-3" />
          <p className="font-semibold text-gray-700">No collections yet</p>
          <p className="text-xs text-gray-400 mt-1">Create a collection above, or use an <code>add_label</code> node in a flow.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(c => (
            <button
              key={c.name}
              onClick={() => openCollection(c)}
              className="bg-white rounded-xl border p-4 text-left hover:shadow-md transition group"
              style={{ borderColor: C.border }}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: colorFor(c.name) }}>
                  {c.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="text-[10px] text-gray-400">{c.last_activity ? timeAgo(c.last_activity) : '—'}</span>
              </div>
              <div className="font-semibold text-gray-800 text-sm truncate">{c.name}</div>
              <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-3">
                <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {c.member_count}</span>
                <span className="text-green-600">✓ {c.opted_in_count} opted-in</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div
            className="bg-white w-full max-w-md h-full flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b" style={{ borderColor: C.border }}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-base font-bold shrink-0" style={{ background: colorFor(selected.name) }}>
                  {selected.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 truncate">{selected.name}</div>
                  <div className="text-[11px] text-gray-500">
                    {selected.member_count} members · {selected.opted_in_count} opted-in
                  </div>
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
              {memLoading ? (
                <div className="flex items-center justify-center py-8 text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              ) : members.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-8">No members yet. Add from the Contacts tab.</p>
              ) : (
                members.map(m => (
                  <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-gray-800 truncate">{m.name || `+${m.wa_id}`}</div>
                      <div className="text-[10px] text-gray-400">+{m.wa_id} · {m.opted_in ? '✓ opted-in' : '✗ not opted-in'}</div>
                    </div>
                    <button
                      onClick={() => removeMember(m.id)}
                      title="Remove from collection"
                      className="text-gray-300 hover:text-red-500 p-1"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="px-4 py-3 border-t flex items-center justify-between gap-2" style={{ borderColor: C.border }}>
              <button
                onClick={() => deleteCollection(selected.name)}
                className="text-[11px] text-red-500 hover:text-red-700 flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Delete collection
              </button>
              <div className="flex gap-2">
                <span className="text-[10px] text-gray-400 self-center">Use in a flow: <code className="bg-gray-100 px-1 rounded">add_label "{selected.name}"</code></span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
