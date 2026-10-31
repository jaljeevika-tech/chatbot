// Organisation login slug. Read from ?org=<slug> (the login link), or from the subdomain
// (pratham.fieldimpact.in → "pratham") so each organisation can have its own address.
const BASE_DOMAIN = 'fieldimpact.in'
const NOT_ORG_SUBDOMAINS = new Set(['www', 'app', 'org', 'superadmin'])

/** The subdomain label in front of BASE_DOMAIN, or null on any other host. */
function subdomainLabel(): string | null {
  const host = window.location.hostname.toLowerCase()
  if (!host.endsWith(`.${BASE_DOMAIN}`)) return null
  const label = host.slice(0, -(BASE_DOMAIN.length + 1))
  return label && !label.includes('.') ? label : null
}

/** superadmin.fieldimpact.in opens the super admin console (same as #superadmin). */
export function isSuperadminHost(): boolean {
  return subdomainLabel() === 'superadmin'
}

/** An organisation's own subdomain (pratham.fieldimpact.in), not the landing page host. */
export function isOrgSubdomain(): boolean {
  const label = subdomainLabel()
  return !!label && !NOT_ORG_SUBDOMAINS.has(label)
}

export function getLoginSlug(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('org')
  if (fromQuery) return fromQuery
  return isOrgSubdomain() ? subdomainLabel() : null
}
