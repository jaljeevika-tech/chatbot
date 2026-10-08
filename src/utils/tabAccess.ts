// Who can see which dashboard tab — shared by DashboardPage's sidebar and the
// standalone FieldFlow Org app (/org), so both follow the same
// Settings → Tab Access rules (per-user override first, then per-role).

import { DEFAULT_TAB_PERMISSIONS } from '../components/dashboard/TabAccessSettings'
import type { AuthUser } from '../context/AuthContext'
import type { OrgMetadata } from '../types/org'

// userTabPermissions is keyed by phone as 91XXXXXXXXXX.
function normPhone(p: string): string {
  const c = String(p || '').replace(/[\s-]/g, '').replace(/^\+/, '')
  return c.length === 10 ? '91' + c : c
}

// Tabs that belong to a sellable app (mirrors lib/subscriptionGuard.js APP_PREFIXES).
const TAB_APPS: Record<string, string> = {
  forms: 'forms', hr: 'hr', financemgmt: 'finance', whatsapp: 'engage', compliance: 'compliance',
}

// planApps: the org plan's apps (null/undefined = all). Hides tabs the plan doesn't
// include, even from admins — the server refuses their API calls anyway.
export function makeCanSeeTab(user: AuthUser | null, org: OrgMetadata | null, planApps?: string[] | null): (key: string) => boolean {
  const role = user?.role ?? 'employee'
  const isAdmin = role === 'admin' || role === 'superadmin'
  const tabPerms = (org?.tabPermissions ?? DEFAULT_TAB_PERMISSIONS) as Record<string, string[]>
  const userTabOverrides = org?.userTabPermissions?.[normPhone(user?.phone ?? '')] as string[] | undefined
  return (key: string) => {
    if (role !== 'superadmin' && planApps && TAB_APPS[key] && !planApps.includes(TAB_APPS[key])) return false
    if (isAdmin) return true  // admin always sees everything
    if (userTabOverrides) return userTabOverrides.includes(key)
    const allowed = tabPerms[key] ?? (DEFAULT_TAB_PERMISSIONS as Record<string, string[]>)[key] ?? ['admin']
    return allowed.includes(role)
  }
}
