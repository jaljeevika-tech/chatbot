# Phase 1a Service Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All four standalone services (Finance, HR, Dashboard, Notebook) start from one shared `createServiceApp` instead of their own boilerplate, with no behaviour change.

**Architecture:** New `lib/serviceApp.js` wires body parser, correlation ID, `/healthz`, internal-key check, per-service identity callback, routes and JSON 404. `lib/internalCaller.js` gains optional header + message args. Each service's `index.js` shrinks to `createServiceApp({...}).listen(PORT)`; Finance/HR Dockerfiles move to repo-root build context.

**Tech Stack:** Node 22 ESM, Express, `node:assert` self-checks (`lib/*.check.mjs` pattern).

**Spec:** `docs/superpowers/specs/2026-10-08-phase1a-service-kit-design.md`

## Global Constraints

- No behaviour change: same routes, headers, status codes, error messages, body limits, DB pools per service.
- Monolith in-process routers and `routes/*.routes.js` are not touched.
- HR keeps key header `x-internal-token` and key-failure message `Unauthorized`; everyone else `x-internal-key` / `Unauthorized caller`.
- No migration runner, no shared pool helper, no CI matrix changes.
- Never round-trip source files through PowerShell Get-Content/Set-Content (mojibake + BOM).
- `node_modules` resolve from `D:\chatbot\node_modules` (worktree has none); run tools via `node /d/chatbot/node_modules/<pkg>/...`.

## Review Focus

1. Local dev with no key and no `K_SERVICE` → requests pass the key check (today's behaviour) — test in Task 1.
2. `/healthz` must answer without the internal key — test in Task 1.
3. An unmatched `/api/...` path after a valid key must return the JSON 404, not Express's HTML — test in Task 1.
4. Notebook's SSE routes must still stream: the kit adds no compression or buffering middleware — checked by inspection in Task 4.
5. A request body over the service's limit still gets Express's 413 (limit passed through, e.g. Finance `20mb`) — test in Task 1 with a tiny limit.

---

### Task 1: `createServiceApp` + `requireInternalKey` options

**Files:**
- Modify: `lib/internalCaller.js`
- Create: `lib/serviceApp.js`
- Test: `lib/serviceApp.check.mjs`

**Interfaces:**
- Produces: `requireInternalKey(service: string, keyEnv: string, header = 'x-internal-key', message = 'Unauthorized caller') → express middleware`
- Produces: `createServiceApp({ name: string, version: string, keyEnv: string, keyHeader?: string, keyError?: string, bodyLimit?: string /* default '1mb' */, identity: (req) => object | null, identityKey: string, mount: (app) => void }) → express.Application` — not listening. On `/api`: key check, then `const id = identity(req)`; `null` → `res.status(401).json({ error: identityError })`, else `req[identityKey] = id`. Add `identityError?: string` (default `'Authentication required'`).
  - `identityKey` is the request property the service already reads: `'fm'` (Finance), `'hrIdent'` (HR), `'user'` (Dashboard, Notebook).

- [ ] **Step 1: Write the failing check** `lib/serviceApp.check.mjs` — run with `node lib/serviceApp.check.mjs`. Build an app with `name: 'demo'`, `version: '9.9.9'`, `keyEnv: 'DEMO_KEY'`, `bodyLimit: '1kb'`, `identityKey: 'user'`, `identity: req => req.headers['x-org-id'] ? { orgId: req.headers['x-org-id'] } : null`, `mount: app => app.get('/api/echo', (req, res) => res.json({ user: req.user, cid: req.correlationId }))` and `app.post('/api/echo', (req, res) => res.json({ ok: true }))`. Listen on port 0, use `fetch`. Assert:
  - `GET /healthz` → 200 `{ ok: true, service: 'demo', version: '9.9.9' }`, no key sent.
  - `process.env.K_SERVICE` unset, `DEMO_KEY` unset: `GET /api/echo` with `x-org-id: o1` → 200, `user.orgId === 'o1'`.
  - Set `K_SERVICE=x`, `DEMO_KEY=secret` **before** building a second app: no key → 401 `{ error: 'Unauthorized caller' }`; wrong key → 401; right key, no `x-org-id` → 401 `{ error: 'Authentication required' }`; right key + `x-org-id` → 200.
  - Sent `x-correlation-id: abc` → response header and `cid` are `abc`.
  - Right key + identity, `GET /api/nope` → 404 JSON `{ error: 'Not found' }`.
  - `POST /api/echo` with a 2 KB JSON body → 413.
  - Third app with `keyHeader: 'x-internal-token'`, `keyError: 'Unauthorized'`, `identityError: 'Missing caller identity'`: key in `x-internal-key` → 401 `{ error: 'Unauthorized' }`; key in `x-internal-token`, no identity → 401 `{ error: 'Missing caller identity' }`.
  - Close servers; print `serviceApp.check: ok`.

- [ ] **Step 2: Run it** — `node lib/serviceApp.check.mjs` → FAIL (module `./serviceApp.js` not found).

- [ ] **Step 3: Add `header` and `message` params to `requireInternalKey`** in `lib/internalCaller.js` (read `req.headers[header]`, respond `{ error: message }`). Existing two-arg callers unchanged.

- [ ] **Step 4: Implement `lib/serviceApp.js`** per the Interfaces block. Order: `disable('x-powered-by')`, `express.json({ limit: bodyLimit })`, `correlationId` (from `lib/correlationId.js`), `GET /healthz`, `app.use('/api', requireInternalKey(...), identityMiddleware)`, `mount(app)`, final `app.use((_req, res) => res.status(404).json({ error: 'Not found' }))`. No other middleware. File header comment: what it is, who uses it, that it returns an unlistened app.

- [ ] **Step 5: Run it** — `node lib/serviceApp.check.mjs` → `serviceApp.check: ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/internalCaller.js lib/serviceApp.js lib/serviceApp.check.mjs
git commit -m "Service kit: createServiceApp + header/message options on requireInternalKey"
```

### Task 2: Finance onto the kit

**Files:**
- Modify: `services/finance/index.js`, `services/finance/Dockerfile`

**Interfaces:**
- Consumes: `createServiceApp` (Task 1) via `../../lib/serviceApp.js`.

- [ ] **Step 1: Rewrite `services/finance/index.js`** — keep the header comment (update the deploy lines to the repo-root build: `docker build -f services/finance/Dockerfile .`), keep `getPool` exactly as is. Replace the express setup with `createServiceApp({ name: 'finance', version: '1.0.0', keyEnv: 'FINANCE_INTERNAL_KEY', bodyLimit: '20mb', identityKey: 'fm', identity, mount: app => app.use('/api', createFinanceRouter({ getPool })) }).listen(PORT, ...)`. `identity`: org from `x-org-id` must pass `isOrgId` (from `lib/internalCaller.js`), uid from `x-user-uid` non-empty, else `null`; returns `{ orgId, uid, role: header x-user-role || 'employee', phone: header x-user-phone || null }`. Keep the listen log `[finance] listening on :${PORT}`.

- [ ] **Step 2: Dockerfile → repo-root context** — mirror `services/dashboard/Dockerfile`: `COPY services/finance/package.json ./package.json`, `COPY lib/serviceApp.js lib/internalCaller.js lib/correlationId.js ./lib/`, `COPY services/finance/index.js ./services/finance/`, `COPY services/finance/src ./services/finance/src`, `CMD ["node", "services/finance/index.js"]`. Keep the header comment, add "Build context is the REPO ROOT".

- [ ] **Step 3: Boot check** — `PORT=18083 node services/finance/index.js &`, then `curl -s localhost:18083/healthz` → `{"ok":true,"service":"finance","version":"1.0.0"}`; `K_SERVICE=x PORT=18084 node services/finance/index.js &` then `curl -s -o /dev/null -w "%{http_code}" localhost:18084/api/finance-mgmt/advances` → `401`. Kill both.

- [ ] **Step 4: Commit** — `git commit -am "Finance service onto createServiceApp (repo-root Docker build)"`

### Task 3: HR onto the kit

**Files:**
- Modify: `services/hr/index.js`, `services/hr/Dockerfile`

**Interfaces:**
- Consumes: `createServiceApp` (Task 1).

- [ ] **Step 1: Rewrite `services/hr/index.js`** — keep header comment (update build lines to repo root). `createServiceApp({ name: 'hr', version: '1.0.0', keyEnv: 'HR_INTERNAL_TOKEN', keyHeader: 'x-internal-token', keyError: 'Unauthorized', identityError: 'Missing caller identity', identityKey: 'hrIdent', identity, mount: app => app.use('/api', createHrRouter()) })`. `identity`: `x-org-id` must match `UUID_RE` (from `./context.js`, as today), `x-firebase-uid` non-empty, else `null`; returns `{ orgId, uid, role: x-user-role || 'employee', phone: x-user-phone || '' }`. Body limit `1mb` (default). Keep log `[hr] listening on ${PORT}`.
  - Today HR's key check is mounted on `/api/hr` only, not `/api`. `createHrRouter()` serves only `/hr/*`, so mounting the check on `/api` changes nothing reachable; confirm with `grep -n "router\.\(get\|post\|put\|patch\|delete\)('" services/hr/router.js` that every path starts with `/hr`.

- [ ] **Step 2: Dockerfile → repo-root context** — `COPY services/hr/package.json ./package.json`, `COPY lib/serviceApp.js lib/internalCaller.js lib/correlationId.js ./lib/`, `COPY services/hr/*.js ./services/hr/`, `CMD ["node", "services/hr/index.js"]`.

- [ ] **Step 3: Boot check** — as Task 2 Step 3 on ports 18086/18087: healthz `{"ok":true,"service":"hr","version":"1.0.0"}`; with `K_SERVICE=x`, `curl -s localhost:18087/api/hr/attendance` → `{"error":"Unauthorized"}` (401). Also run `node services/hr/dates.test.js`, `node services/hr/shifts.test.js`, `node services/hr/reminders.test.js` → all pass (unchanged code, guards against import breakage).

- [ ] **Step 4: Commit** — `git commit -am "HR service onto createServiceApp (repo-root Docker build)"`

### Task 4: Dashboard + Notebook onto the kit

**Files:**
- Modify: `services/dashboard/index.js`, `services/dashboard/Dockerfile`, `services/notebook/index.js`, `services/notebook/Dockerfile`

**Interfaces:**
- Consumes: `createServiceApp` (Task 1).

- [ ] **Step 1: Dashboard** — `createServiceApp({ name: 'dashboard', version: '1.0.0', keyEnv: 'DASHBOARD_INTERNAL_KEY', identityKey: 'user', identity, mount: app => app.use('/api', createDashboardRouter({ getPool })) })`; `identity` returns `{ orgId, uid, role, name }` exactly as today or `null`. Keep `getPool`. Dockerfile: add `lib/serviceApp.js` to the `COPY lib/...` line.

- [ ] **Step 2: Notebook** — `createServiceApp({ name: 'notebook', version: '2.0.0', keyEnv: 'NOTEBOOK_INTERNAL_KEY', bodyLimit: '5mb', identityKey: 'user', identity: req => isOrgId(h) ? { orgId: h } : null, mount: app => app.use('/api', router) })`. Dockerfile: add `lib/serviceApp.js` to the `COPY lib/...` line. Confirm `lib/serviceApp.js` adds no compression/buffering (Review Focus 4).

- [ ] **Step 3: Boot checks** — Dashboard (port 18088) and Notebook (18089): healthz returns `{"ok":true,"service":"dashboard","version":"1.0.0"}` / `{"ok":true,"service":"notebook","version":"2.0.0"}`; with `K_SERVICE=x` an `/api/...` call → 401 `{"error":"Unauthorized caller"}`. If a service needs env to import (e.g. DB or Gemini key at import time), note it and check healthz with a dummy value.

- [ ] **Step 4: Commit** — `git commit -am "Dashboard + Notebook services onto createServiceApp"`

### Task 5: Whole-branch verification + PR

- [ ] **Step 1:** `node lib/serviceApp.check.mjs` and `node lib/subscriptionGuard.check.mjs` → both `ok`.
- [ ] **Step 2:** `node /d/chatbot/node_modules/typescript/bin/tsc --noEmit -p .` → exit 0; `node /d/chatbot/node_modules/vite/bin/vite.js build` → `built in`.
- [ ] **Step 3:** `git diff origin/main --stat` lists only `lib/internalCaller.js`, `lib/serviceApp.js`, `lib/serviceApp.check.mjs`, the 4 services' `index.js` + `Dockerfile`, and the docs. No `routes/` or `src/` changes.
- [ ] **Step 4:** Push branch; give the user the compare link + PR text (gh is not authenticated). After merge, CI redeploys Notebook: check `curl https://fieldflow-notebook-725980175357.asia-south1.run.app/healthz` is not reachable publicly (private) — instead verify one Ask AI call in the app works.
