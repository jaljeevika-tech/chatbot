// lib/serviceApp.js — the shared setup every standalone service starts from (Finance,
// HR, Dashboard, Notebook): body parser, correlation ID, /healthz, the internal-key
// check (lib/internalCaller.js), the caller identity the monolith forwards, the
// service's routes and a JSON 404. Returns the app unlistened, so callers do
// createServiceApp({...}).listen(PORT) and tests can listen on port 0.
//
// identity(req) maps the monolith's trusted headers to the object the service's
// router already reads, stored at req[identityKey] ('fm', 'hrIdent' or 'user');
// returning null answers 401 { error: identityError }.

import express from 'express'
import { correlationId } from './correlationId.js'
import { requireInternalKey } from './internalCaller.js'

export function createServiceApp({
  name, version, keyEnv, keyHeader = 'x-internal-key', keyError = 'Unauthorized caller',
  bodyLimit = '1mb', identity, identityKey, identityError = 'Authentication required', mount,
}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: bodyLimit }))
  app.use(correlationId)
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: name, version }))
  app.use('/api', requireInternalKey(name, keyEnv, keyHeader, keyError), (req, res, next) => {
    const id = identity(req)
    if (!id) return res.status(401).json({ error: identityError })
    req[identityKey] = id
    next()
  })
  mount(app)
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
  return app
}
