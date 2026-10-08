// Notebook AI (/api/notebook/*). The routes live in services/notebook/src/router.js:
// proxied to the Cloud Run service when NOTEBOOK_SERVICE_URL is set, run in-process
// when unset, the breaker is open or the service fails. Fallback rules: lib/serviceProxy.js.

import { Router } from 'express'
import { streamingServiceProxy } from '../lib/serviceProxy.js'
import notebookRouter from '../services/notebook/src/router.js'

const router = Router()

// Always served here: big media payloads and long-running generation (podcast/video
// voices, pictures, Veo) stay on App Engine.
const LOCAL_ONLY = new Set(['/imagen', '/nanobanana', '/veo-start', '/veo-poll', '/tts', '/tts-multi', '/audio', '/video-slides', '/upload', '/fetch-url'])

router.use('/notebook', streamingServiceProxy({
  name: 'notebook', label: 'Notebook', urlEnv: 'NOTEBOOK_SERVICE_URL', keyEnv: 'NOTEBOOK_INTERNAL_KEY', localOnly: LOCAL_ONLY,
}))
router.use(notebookRouter)

export default router
