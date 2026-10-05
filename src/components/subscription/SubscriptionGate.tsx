import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'

interface Props {
  children:     ReactNode
  featureName?: string
}

export function SubscriptionGate({ children, featureName }: Props) {
  const { hasAI, subscription } = useOrg()
  if (hasAI) return <>{children}</>
  return <LockedFeature featureName={featureName} planName={subscription?.plan?.name} status={subscription?.status} />
}

function LockedFeature({
  featureName,
  planName,
  status,
}: {
  featureName?: string
  planName?: string
  status?: string
}) {
  const isExpired  = status === 'expired'
  const isInactive = !status || status === 'inactive'

  const reason = isExpired
    ? 'Your subscription has expired.'
    : isInactive
    ? 'Your organisation does not have an active subscription.'
    : 'This feature is not included in your current plan.'

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
        <Lock className="h-6 w-6 text-gray-400" />
      </div>

      <div>
        <p className="text-sm font-bold text-gray-700">
          {featureName ? `${featureName} — ` : ''}AI Feature Locked
        </p>
        <p className="mt-1 text-xs text-gray-500">{reason}</p>
      </div>

      {planName && (
        <p className="text-[11px] text-gray-400">
          Current plan: <span className="font-semibold">{planName}</span>
        </p>
      )}

      <p className="rounded-xl bg-violet-50 px-4 py-2 text-[11px] font-semibold text-violet-700">
        Contact your administrator to upgrade to Professional or Enterprise
      </p>
    </div>
  )
}
