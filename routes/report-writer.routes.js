// Report Writer (/api/rw/*). The routes live in services/report-writer/src/router.js:
// proxied to the Cloud Run service when RW_SERVICE_URL is set, run in-process when
// unset, the breaker is open or the service fails. Fallback rules: lib/serviceProxy.js.

import { Router } from 'express'
import { streamingServiceProxy } from '../lib/serviceProxy.js'
import rwRouter from '../services/report-writer/src/router.js'

const router = Router()

// The */save routes append to the Sheet, so they never re-run after a mid-flight failure.
router.use('/rw', streamingServiceProxy({
  name: 'report-writer', label: 'Report Writer', urlEnv: 'RW_SERVICE_URL', keyEnv: 'RW_INTERNAL_KEY',
  retrySafe: req => !req.path.endsWith('/save'),
}))
router.use(rwRouter)

export default router
