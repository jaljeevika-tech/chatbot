// Admin-only row delete for the MIS sub-tabs: a bin per row plus tick-boxes for
// bulk delete (POST /api/mis-records/:kind/delete). Selection only counts rows on
// the current page, so ticks left over from another page/filter are ignored.

import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useAuthContext } from '../../context/AuthContext'
import { apiFetch } from '../../utils/apiFetch'

export function useMisRowActions(kind: string, rows: { id: string }[], reload: () => void) {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const picked = rows.filter(r => selected.has(r.id)).map(r => r.id)
  const allPicked = rows.length > 0 && picked.length === rows.length

  const toggle = (id: string) => setSelected(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(rows.map(r => r.id)))

  const remove = async (ids: string[]) => {
    const msg = ids.length === 1 ? 'Delete this record?' : `Delete ${ids.length} records?`
    if (!window.confirm(`${msg} This cannot be undone.`)) return
    setBusy(true)
    try {
      const r = await apiFetch(`/api/mis-records/${kind}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Couldn't delete (error ${r.status})`)
      setSelected(new Set())
      reload()
    } catch (e: any) {
      window.alert(e.message || "Couldn't delete")
    } finally {
      setBusy(false)
    }
  }

  return { isAdmin, selected, picked, allPicked, busy, toggle, toggleAll, remove }
}

type RowActions = ReturnType<typeof useMisRowActions>

export function MisSelectAll({ a }: { a: RowActions }) {
  return <input type="checkbox" checked={a.allPicked} onChange={a.toggleAll} aria-label="Select all on this page" />
}

export function MisRowActions({ a, id }: { a: RowActions; id: string }) {
  return (
    <div className="flex items-center gap-1">
      <input type="checkbox" checked={a.selected.has(id)} onChange={() => a.toggle(id)} aria-label="Select record" />
      <button
        onClick={() => a.remove([id])}
        disabled={a.busy}
        title="Delete record"
        aria-label="Delete record"
        className="p-1.5 rounded-lg disabled:opacity-40 hover:bg-red-50"
        style={{ color: '#B0473C' }}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  )
}

export function MisBulkDeleteBar({ a }: { a: RowActions }) {
  if (!a.picked.length) return null
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-sm" style={{ background: '#FDF1EF', color: '#B0473C' }}>
      <span><b>{a.picked.length}</b> selected</span>
      <button
        onClick={() => a.remove(a.picked)}
        disabled={a.busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold text-white disabled:opacity-50"
        style={{ background: '#B0473C' }}
      >
        {a.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete selected
      </button>
    </div>
  )
}
