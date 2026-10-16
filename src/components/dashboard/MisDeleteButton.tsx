// Admin-only per-row delete for the MIS sub-tabs (DELETE /api/mis-records/:kind/:id).

import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useAuthContext } from '../../context/AuthContext'
import { apiFetch } from '../../utils/apiFetch'

export function useIsAdmin() {
  const { user } = useAuthContext()
  return user?.role === 'admin' || user?.role === 'superadmin'
}

export function MisDeleteButton({ kind, id, onDeleted }: { kind: string; id: string; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)

  const handleDelete = async () => {
    if (!window.confirm('Delete this record? This cannot be undone.')) return
    setBusy(true)
    try {
      const r = await apiFetch(`/api/mis-records/${kind}/${id}`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Couldn't delete (error ${r.status})`)
      onDeleted()
    } catch (e: any) {
      window.alert(e.message || "Couldn't delete the record")
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      title="Delete record"
      aria-label="Delete record"
      className="p-1.5 rounded-lg disabled:opacity-40 hover:bg-red-50"
      style={{ color: '#B0473C' }}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
    </button>
  )
}
