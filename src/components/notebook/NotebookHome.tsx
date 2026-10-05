// "Ask AI" landing grid of saved notebooks (create/rename/delete/open; routes/notebooks.routes.js).

import { useEffect, useState } from 'react'
import { apiFetch } from '../../utils/apiFetch'
import { Plus, BookMarked, FileText, MessageSquare, Pencil, Trash2, Loader2, AlertCircle, Check, X } from 'lucide-react'
import type { NotebookMeta } from '../../types/notebook'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

interface Props {
  onOpen: (notebookId: string) => void
  /** Notebooks with an output still generating in the background. */
  generatingIds?: string[]
  onDeleted?: (notebookId: string) => void
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

export function NotebookHome({ onOpen, generatingIds = [], onDeleted }: Props) {
  const [notebooks, setNotebooks] = useState<NotebookMeta[] | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [creating, setCreating]   = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  async function load() {
    setError(null)
    try {
      const res = await apiFetch('/api/notebooks')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load notebooks')
      setNotebooks(data.notebooks || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notebooks')
      setNotebooks([])
    }
  }

  useEffect(() => { load() }, [])

  async function createNotebook() {
    setCreating(true)
    try {
      const res = await apiFetch('/api/notebooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled notebook' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create notebook')
      onOpen(data.notebook.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create notebook')
    } finally {
      setCreating(false)
    }
  }

  async function submitRename(id: string) {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    setNotebooks(prev => prev?.map(n => n.id === id ? { ...n, name } : n) ?? prev)
    try {
      await apiFetch(`/api/notebooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    } catch { /* local state already updated; next load() reconciles */ }
  }

  async function deleteNotebook(id: string) {
    if (!confirm('Delete this notebook? Its sources and chat history will be permanently removed.')) return
    setNotebooks(prev => prev?.filter(n => n.id !== id) ?? prev)
    onDeleted?.(id)
    try {
      await apiFetch(`/api/notebooks/${id}`, { method: 'DELETE' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete notebook')
      load()
    }
  }

  return (
    <div className="flex flex-col h-full overflow-auto" style={{ background: C.bg }}>
      <div className="max-w-4xl w-full mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-black" style={{ color: C.dark }}>Ask AI</h1>
            <p className="text-xs mt-1" style={{ color: '#86A0A5' }}>
              Notebooks ground answers, audio, mind maps, and slides in your own sources.
            </p>
          </div>
          <button
            onClick={createNotebook}
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all shrink-0"
            style={{ background: C.sidebar, color: C.white }}
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            New notebook
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl text-xs" style={{ background: '#FEE2E2', color: '#991B1B' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
          </div>
        )}

        {notebooks === null ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: C.lime }} />
          </div>
        ) : notebooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: C.white }}>
              <BookMarked className="w-7 h-7" style={{ color: C.lime }} />
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: C.dark }}>No notebooks yet</p>
              <p className="text-xs mt-1" style={{ color: '#86A0A5' }}>Create one to start chatting with your sources</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {notebooks.map(nb => (
              <div
                key={nb.id}
                onClick={() => renamingId !== nb.id && onOpen(nb.id)}
                className="group relative flex flex-col gap-3 p-4 rounded-2xl cursor-pointer transition-all hover:shadow-md"
                style={{ background: C.white, border: `1.5px solid #D9E6E8` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: C.bg }}>
                    <BookMarked className="w-4 h-4" style={{ color: C.sidebar }} />
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={e => { e.stopPropagation(); setRenamingId(nb.id); setRenameValue(nb.name) }}
                      className="p-1.5 rounded-lg hover:bg-black/5"
                    >
                      <Pencil className="w-3.5 h-3.5" style={{ color: '#86A0A5' }} />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); deleteNotebook(nb.id) }}
                      className="p-1.5 rounded-lg hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                    </button>
                  </div>
                </div>

                {renamingId === nb.id ? (
                  <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') submitRename(nb.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="flex-1 text-sm font-bold px-2 py-1 rounded-lg border outline-none min-w-0"
                      style={{ borderColor: C.sidebar, color: C.dark }}
                    />
                    <button onClick={() => submitRename(nb.id)} className="p-1 rounded-lg hover:bg-black/5 shrink-0">
                      <Check className="w-3.5 h-3.5" style={{ color: C.sidebar }} />
                    </button>
                    <button onClick={() => setRenamingId(null)} className="p-1 rounded-lg hover:bg-black/5 shrink-0">
                      <X className="w-3.5 h-3.5" style={{ color: '#86A0A5' }} />
                    </button>
                  </div>
                ) : (
                  <p className="text-sm font-bold truncate" style={{ color: C.dark }}>{nb.name}</p>
                )}

                <div className="flex items-center gap-3 text-[11px]" style={{ color: '#86A0A5' }}>
                  <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{nb.source_count}</span>
                  <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{nb.message_count}</span>
                  {generatingIds.includes(nb.id) && (
                    <span className="flex items-center gap-1 font-semibold" style={{ color: C.lime }}>
                      <Loader2 className="w-3 h-3 animate-spin" />Generating…
                    </span>
                  )}
                  <span className="ml-auto">{formatDate(nb.updated_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
