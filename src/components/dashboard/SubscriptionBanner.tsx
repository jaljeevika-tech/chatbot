// Shown across the dashboard when the org's subscription is in its grace period
// or the org is read-only (expired beyond grace, or suspended). The server
// enforces the same states (lib/subscriptionGuard.js); this only explains them.

import { AlertTriangle, Lock } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'

export function SubscriptionBanner() {
  const { subscription } = useOrg()
  const access = subscription?.access
  if (!access || access.state === 'ok') return null

  const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')
  const readOnly = access.state === 'read_only'
  const text = readOnly
    ? access.reason === 'suspended'
      ? 'This organisation has been suspended. You can view and export data, but cannot add or change data, and AI features are paused.'
      : 'Your subscription has expired. You can view and export data, but cannot add or change data, and AI features are paused.'
    : `Your subscription expired on ${fmt(access.expires_at)}. Everything keeps working until ${fmt(access.grace_ends_at)}; after that the account becomes read-only.`

  return (
    <div role="status"
      className="flex items-start gap-2 px-4 py-2 text-sm shrink-0"
      style={{ background: readOnly ? '#FEE2E2' : '#FEF3C7', color: readOnly ? '#991B1B' : '#92400E', borderBottom: `1px solid ${readOnly ? '#FCA5A5' : '#FCD34D'}` }}>
      {readOnly ? <Lock className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
      <span>{text} Contact your administrator{subscription?.billing_email ? ` (${subscription.billing_email})` : ''} to renew.</span>
    </div>
  )
}
