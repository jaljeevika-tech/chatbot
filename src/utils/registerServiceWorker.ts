// Registers public/sw.js (production builds only — Vite's dev server has no
// hashed /assets). The worker lets the app open offline for the HR tab.

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(reg => {
        // Assets this page loaded before the worker was in control.
        const urls = performance.getEntriesByType('resource')
          .map(e => e.name)
          .filter(u => u.startsWith(`${location.origin}/assets/`))
        reg.active?.postMessage({ type: 'CACHE_URLS', urls })
      })
      .catch(() => { /* unsupported / blocked — the app still works online */ })
  })
}
