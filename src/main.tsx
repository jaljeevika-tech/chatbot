import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './utils/registerServiceWorker'
import { isOrgAppPath, setUpOrgAppPage } from './components/org-app/orgAppRoute'

// A tab open across a deploy holds the old chunk manifest, so dynamic imports 404.
// Reload to fetch the fresh one; time-based guard so a second deploy still recovers
// but an immediately repeated failure doesn't loop.
window.addEventListener('vite:preloadError', () => {
  const key = 'ff_reloaded_after_preload_error'
  const last = Number(sessionStorage.getItem(key) || 0)
  if (Date.now() - last < 60_000) return // just reloaded for this — avoid a loop
  sessionStorage.setItem(key, String(Date.now()))
  window.location.reload()
})

registerServiceWorker()

// FieldFlow Org (/org/) gets its own home-screen identity before first paint.
if (isOrgAppPath()) setUpOrgAppPage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
