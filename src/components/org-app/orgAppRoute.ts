// FieldFlow Org (HR + Finance) as an installable phone app at /org/. Import-free leaf so the
// boot bundle can set up routing, manifest/iOS meta and the install prompt before React renders.

export const ORG_APP_PATH = '/org/'
export const ORG_APP_NAME = 'FieldFlow Org'
// Login needs the org's slug (?org=). Remembered here so the installed app,
// whose start URL may not carry it, can still sign in after a logout.
const SLUG_KEY = 'ff_org_app_slug'

export function isOrgAppPath(pathname: string = window.location.pathname): boolean {
  return pathname === '/org' || pathname.startsWith(ORG_APP_PATH)
}

/** Link that opens (and installs) the app for an org. */
export function orgAppUrl(slug: string | null): string {
  return slug ? `${ORG_APP_PATH}?org=${encodeURIComponent(slug)}` : ORG_APP_PATH
}

/** Once, at boot, on /org: canonical URL + login slug, then the head tags. */
export function setUpOrgAppPage(): void {
  const url = new URL(window.location.href)
  if (url.pathname === '/org') url.pathname = ORG_APP_PATH // inside the manifest's scope
  try {
    const slug = url.searchParams.get('org')
    if (slug) localStorage.setItem(SLUG_KEY, slug)
    else {
      const saved = localStorage.getItem(SLUG_KEY)
      if (saved) url.searchParams.set('org', saved)
    }
  } catch { /* storage blocked — the link's own ?org= still works */ }
  if (url.href !== window.location.href) history.replaceState(history.state, '', url.href)

  const slug = url.searchParams.get('org')
  const add = (tag: 'link' | 'meta', attrs: Record<string, string>) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    document.head.appendChild(el)
  }
  // The server fills the manifest's start_url with this org's ?org= (server.js).
  add('link', { rel: 'manifest', href: `/org-app/manifest.webmanifest${slug ? `?org=${encodeURIComponent(slug)}` : ''}` })
  add('link', { rel: 'apple-touch-icon', href: '/org-app/apple-touch-icon.png' })
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' })
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' })
  add('meta', { name: 'apple-mobile-web-app-title', content: ORG_APP_NAME })
  add('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' })
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0E3A46')
  // Lets the bottom tab bar pad itself clear of the iPhone home indicator.
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
  document.title = ORG_APP_NAME

  // Chrome offers installation once, early in the page's life — keep the
  // event so the app can show its own Install button instead of the infobar.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault()
    installPrompt = e as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => { installPrompt = null; notify() })
}

// Install prompt (Chrome / Edge / Samsung Internet on Android)
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let installPrompt: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(fn => fn())

export function subscribeInstallPrompt(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const canPromptInstall = (): boolean => installPrompt !== null

/** Shows the browser's install dialog; true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const p = installPrompt
  if (!p) return false
  installPrompt = null
  notify()
  await p.prompt()
  return (await p.userChoice).outcome === 'accepted'
}

/** Running from the home-screen icon rather than a browser tab. */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iPhone/iPad — no install prompt there; the person uses Share → Add to Home Screen. */
export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
