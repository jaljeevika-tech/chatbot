// public/sw.js — lets the app open with no network so the HR tab works
// offline (its data lives in IndexedDB, see src/utils/hr). Deliberately small:
//
//   • page loads  — network first, so a deploy is picked up immediately;
//                   offline (or > 8 s on a bad connection) → the saved shell
//   • /assets/*   — content-hashed and immutable → served from cache, saved
//                   as they're fetched (no up-front precache to burn mobile data)
//   • everything else, including every /api call — not touched
//
// server.js serves this file with no-cache so a new version is always seen.

const SHELL_CACHE = 'ff-shell-v1'
const ASSET_CACHE = 'ff-assets-v1'
const MAX_ASSETS = 400
const NAV_TIMEOUT_MS = 8000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.add(new Request('/', { cache: 'reload' })))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key)
    await self.clients.claim()
  })())
})

// The page sends the assets it loaded before this worker took control.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_URLS' || !Array.isArray(event.data.urls)) return
  event.waitUntil((async () => {
    const cache = await caches.open(ASSET_CACHE)
    for (const url of event.data.urls) {
      if (!isAsset(new URL(url, self.location.origin))) continue
      if (await cache.match(url)) continue
      try {
        const res = await fetch(url)
        if (res.ok) await cache.put(url, res)
      } catch { /* offline — picked up on a later visit */ }
    }
    await trim(cache)
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req, event))
  } else if (isAsset(url)) {
    event.respondWith(cacheFirst(req, event))
  } else if (url.pathname === '/logo.png') {
    event.respondWith(cacheFirst(req, event, SHELL_CACHE))
  }
})

function isAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/assets/')
}

async function networkFirstShell(req, event) {
  const cache = await caches.open(SHELL_CACHE)
  const network = fetch(req).then((res) => {
    // Every app path serves index.html (SPA catch-all) — keep the newest.
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      event.waitUntil(cache.put('/', res.clone()))
    }
    return res
  })
  const cached = await cache.match('/')
  if (!cached) return network
  // Slow 2G: don't leave a field worker staring at a blank screen.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
  return Promise.race([network.catch(() => cached), timeout])
}

async function cacheFirst(req, event, cacheName = ASSET_CACHE) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) {
    // Re-insert so the entry order tracks recent use and trim() drops the
    // least recently used — never the vendor chunks every page needs.
    if (cacheName === ASSET_CACHE) {
      const copy = hit.clone()   // before the page consumes the body
      event.waitUntil(cache.delete(req).then(() => cache.put(req, copy)))
    }
    return hit
  }
  const res = await fetch(req)
  if (res.ok) event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)))
  return res
}

async function trim(cache) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i])
}
