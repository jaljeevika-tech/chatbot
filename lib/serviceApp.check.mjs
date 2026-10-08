// Run: node lib/serviceApp.check.mjs — self-check for the service kit (createServiceApp).
process.env.NODE_ENV = 'test'  // Express skips its error-stack log (expected 413 below)
import assert from 'node:assert/strict'
import { createServiceApp } from './serviceApp.js'

const identity = req => req.headers['x-org-id'] ? { orgId: req.headers['x-org-id'] } : null
const mount = app => {
  app.get('/api/echo', (req, res) => res.json({ user: req.user, cid: req.correlationId }))
  app.post('/api/echo', (_req, res) => res.json({ ok: true }))
}
const demo = extra => createServiceApp({
  name: 'demo', version: '9.9.9', keyEnv: 'DEMO_KEY', bodyLimit: '1kb', identityKey: 'user', identity, mount, ...extra,
})

async function serve(app) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { headers = {}, method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, cid: r.headers.get('x-correlation-id') }
  }
  return { call, close: () => server.close() }
}

// Local dev: no key configured and not on Cloud Run → key check lets requests through.
delete process.env.K_SERVICE
delete process.env.DEMO_KEY
{
  const { call, close } = await serve(demo())
  const h = await call('/healthz')
  assert.equal(h.status, 200)
  assert.deepEqual(h.json, { ok: true, service: 'demo', version: '9.9.9' })
  const e = await call('/api/echo', { headers: { 'x-org-id': 'o1' } })
  assert.equal(e.status, 200)
  assert.equal(e.json.user.orgId, 'o1')
  close()
}

// Cloud Run with a key: key + identity both required; healthz stays open.
process.env.K_SERVICE = 'x'
process.env.DEMO_KEY = 'secret'
{
  const { call, close } = await serve(demo())
  assert.equal((await call('/healthz')).status, 200)
  let r = await call('/api/echo', { headers: { 'x-org-id': 'o1' } })
  assert.equal(r.status, 401); assert.deepEqual(r.json, { error: 'Unauthorized caller' })
  r = await call('/api/echo', { headers: { 'x-org-id': 'o1', 'x-internal-key': 'wrong' } })
  assert.equal(r.status, 401)
  r = await call('/api/echo', { headers: { 'x-internal-key': 'secret' } })
  assert.equal(r.status, 401); assert.deepEqual(r.json, { error: 'Authentication required' })
  const ok = { 'x-internal-key': 'secret', 'x-org-id': 'o1' }
  r = await call('/api/echo', { headers: { ...ok, 'x-correlation-id': 'abc' } })
  assert.equal(r.status, 200); assert.equal(r.json.user.orgId, 'o1')
  assert.equal(r.cid, 'abc'); assert.equal(r.json.cid, 'abc')
  r = await call('/api/nope', { headers: ok })
  assert.equal(r.status, 404); assert.deepEqual(r.json, { error: 'Not found' })
  r = await call('/api/echo', { method: 'POST', headers: ok, body: JSON.stringify({ x: 'y'.repeat(2048) }) })
  assert.equal(r.status, 413)
  close()
}

// HR-style options: custom key header and messages.
{
  const { call, close } = await serve(demo({ keyHeader: 'x-internal-token', keyError: 'Unauthorized', identityError: 'Missing caller identity' }))
  let r = await call('/api/echo', { headers: { 'x-internal-key': 'secret', 'x-org-id': 'o1' } })
  assert.equal(r.status, 401); assert.deepEqual(r.json, { error: 'Unauthorized' })
  r = await call('/api/echo', { headers: { 'x-internal-token': 'secret' } })
  assert.equal(r.status, 401); assert.deepEqual(r.json, { error: 'Missing caller identity' })
  r = await call('/api/echo', { headers: { 'x-internal-token': 'secret', 'x-org-id': 'o1' } })
  assert.equal(r.status, 200)
  close()
}

console.log('serviceApp.check: ok')
