# Phase 1a — Service Kit — Design

Date: 2026-10-08 · Status: approved in chat, awaiting spec review
Parent: `2026-10-08-platform-microservices-design.md` (Phase 1, split into 1a kit → 1b Notify → 1c Core Records → 1d Files; each its own spec + PR).

## 1. Goal

Every standalone service starts from one shared setup instead of its own copy, so new services (Core Records, Forms, Programs, …) are a router plus ~10 lines of `index.js`.

Constraint: **no behaviour change.** Same routes, headers, status codes, error messages, body limits and DB pools. The monolith's in-process routers are untouched.

## 2. What exists today

| Service | Prod routing | Entry setup | Build context |
|---|---|---|---|
| Notebook | Cloud Run (`NOTEBOOK_SERVICE_URL`), CI-deployed | `lib/correlationId.js` + `lib/internalCaller.js` | repo root |
| Dashboard | in-process (no URL set), not CI-deployed | same shared libs | repo root |
| Finance | in-process (no URL set), not CI-deployed | inline copies of key check, correlation ID, healthz | `services/finance` only |
| HR | in-process (no URL set), not CI-deployed | inline copies; key header `x-internal-token` | `services/hr` only |

Report Writer and the 4 registration services are out of scope (Report Writer decision pending; registrations fold into Forms in Phase 2).

## 3. Design

### 3.1 `lib/serviceApp.js` (new)

```js
createServiceApp({ name, version, keyEnv, keyHeader = 'x-internal-key', bodyLimit = '1mb', identity, mount }) → express app
```

Wires, in order:
1. `app.disable('x-powered-by')`, `express.json({ limit: bodyLimit })`, `correlationId`.
2. `GET /healthz` → `{ ok: true, service: name, version }`.
3. On `/api`: `requireInternalKey(name, keyEnv, keyHeader)`; then `identity(req)` — returns the object the service already uses and the kit assigns it, or returns `null` → `401`. The identity callback owns its own field names and 401 message so each service keeps its current responses.
4. `mount(app)` — the service mounts its router(s).
5. Fallback `404 { error: 'Not found' }`.

The caller does `createServiceApp({...}).listen(PORT)`. Returning the app (not listening) keeps it testable.

### 3.2 `lib/internalCaller.js`

`requireInternalKey(service, keyEnv, header = 'x-internal-key')` — new optional third argument. Existing callers are unchanged.

### 3.3 Per-service changes

| Service | Change |
|---|---|
| Finance | `index.js` → `createServiceApp`; `identity` sets `req.fm` from `x-org-id` / `x-user-uid` / `x-user-role` / `x-user-phone`, message `Authentication required`; keeps its own `getPool`, body limit `20mb`, 404. Dockerfile → repo-root context, copies `lib/serviceApp.js`, `lib/internalCaller.js`, `lib/correlationId.js`. |
| HR | `index.js` → `createServiceApp` with `keyHeader: 'x-internal-token'`; `identity` sets `req.hrIdent` from `x-org-id` / `x-firebase-uid` / `x-user-role` / `x-user-phone`, message `Missing caller identity`; key-failure message becomes `Unauthorized caller` (was `Unauthorized`) — the only text change, on a service prod never calls. Dockerfile → repo-root context. |
| Dashboard | `index.js` → `createServiceApp`; identity unchanged (`req.user` with `name`). Dockerfile adds `lib/serviceApp.js`. |
| Notebook | `index.js` → `createServiceApp`, body limit `5mb`; identity unchanged (`req.user = { orgId }`). Dockerfile adds `lib/serviceApp.js`. |

Comment headers (env vars, deploy commands) stay in each `index.js`, updated for the new build context where it changed.

### 3.4 Not doing

| Skipped | Add when |
|---|---|
| Boot-time migration runner | never by default — migrations stay central in `db/migrations/`, confirmed and run by the user in the Neon SQL Editor |
| Shared DB pool helper | a second service needs the same pool shape (likely 1c Core Records) |
| Finance / HR / Dashboard in the CI Cloud Run matrix | in the same PR that sets that service's `*_SERVICE_URL` on the monolith |
| Unifying identity header names (`x-user-uid` vs `x-firebase-uid`) | the FieldFlow JWT lands (parent spec Phase 4) and replaces these headers |

## 4. Parent spec correction

The parent spec's risk table says "CI deploys every service on push to main". It deploys only Notebook, Report Writer and the 4 registration services. Update that row to: "CI deploys every service that prod routes to; a service joins the CI matrix in the PR that sets its `*_SERVICE_URL`."

## 5. Testing

- `lib/serviceApp.check.mjs` (node, assert, no framework): builds a throwaway app on port 0 and checks — `/healthz` 200 with name/version; with `K_SERVICE` set, missing or wrong key → 401; custom `keyHeader` honoured; `identity` returning `null` → 401; valid key + identity → reaches the mounted route and the identity object is on `req`; unknown path → JSON 404; correlation ID echoed.
- Each of the 4 services started locally (`node services/<name>/index.js`): boots, `/healthz` 200, `/api/...` without key → 401 when `K_SERVICE` is set.
- `tsc --noEmit` and `npm run build` (monolith untouched, but per the real-build rule).
- Not verifiable here: Docker image builds. The Dockerfile changes are exercised the next time each service is deployed; Notebook (CI-deployed) is the one that matters and only gains one copied file.

## 6. Rollout

One PR. Monolith behaviour unchanged, so merging is safe. CI redeploys Notebook with the new entry; check its `/healthz` and one Ask AI call after deploy.
