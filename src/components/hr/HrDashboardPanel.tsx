// HR dashboard (admins + HR users): preset widgets served by services/dashboard
// GET /api/hr-dashboard. Online only; lazy-loaded so recharts stays out of the offline HR chunk.

import { useEffect, useState } from 'react'
import { apiFetch } from '../../utils/apiFetch'
import { WidgetView, type Widget, type WidgetData } from '../dashboard/CustomDashboardPage'
import { Muted, Notice } from './hrUi'

export default function HrDashboardPanel() {
  const [out, setOut] = useState<{ widgets: Widget[]; data: Record<string, WidgetData> } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!navigator.onLine) { setError('The HR dashboard needs a connection.'); return }
    apiFetch('/api/hr-dashboard')
      .then(async r => r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error || `Request failed (${r.status})`)))
      .then(setOut)
      .catch(e => setError(e.message))
  }, [])

  if (error) return <Notice tone="red">{error}</Notice>
  if (!out) return <Muted>Loading dashboard…</Muted>
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {out.widgets.map(w => <WidgetView key={w.id} widget={w} data={out.data[w.id]} />)}
    </div>
  )
}
