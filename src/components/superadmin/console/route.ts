// Hash routes for the console, so every page can be linked and survives reload:
//   #superadmin                      → overview
//   #superadmin/orgs                 → organisation list
//   #superadmin/orgs/<id>[/<tab>]    → one organisation
//   #superadmin/plans | billing | prompts | audit

import { useEffect, useState } from 'react'

export type Page = 'overview' | 'orgs' | 'plans' | 'billing' | 'prompts' | 'audit'
export type OrgTab = 'overview' | 'users' | 'plan' | 'branding' | 'modules' | 'data' | 'integrations' | 'audit'

export interface Route { page: Page; orgId?: string; orgTab?: OrgTab }

const PAGES: Page[] = ['overview', 'orgs', 'plans', 'billing', 'prompts', 'audit']
const ORG_TABS: OrgTab[] = ['overview', 'users', 'plan', 'branding', 'modules', 'data', 'integrations', 'audit']

export function parseRoute(hash: string): Route {
  // A trailing ?flag (e.g. #superadmin/orgs?new) is page state, not a path segment.
  const parts = hash.split('?')[0].replace(/^#superadmin\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const page = (PAGES as string[]).includes(parts[0]) ? parts[0] as Page : 'overview'
  if (page === 'orgs' && parts[1]) {
    const orgTab = (ORG_TABS as string[]).includes(parts[2]) ? parts[2] as OrgTab : 'overview'
    return { page, orgId: parts[1], orgTab }
  }
  return { page }
}

export function routeHref(r: Route): string {
  if (r.page === 'overview') return '#superadmin'
  if (r.page === 'orgs' && r.orgId) {
    return `#superadmin/orgs/${encodeURIComponent(r.orgId)}${r.orgTab && r.orgTab !== 'overview' ? `/${r.orgTab}` : ''}`
  }
  return `#superadmin/${r.page}`
}

export function navigate(r: Route) {
  window.location.hash = routeHref(r)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
