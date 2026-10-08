# FieldFlow as a Pool of Microservices — Design

Date: 2026-10-08 · Status: approved in chat, trimmed (ponytail pass) 2026-10-08, awaiting spec review
Related: integrated platform direction, superadmin SaaS spec, microservices restructure (2026-10-07), forms microservice spec, dashboard service spec.

## 1. Goal

Turn FieldFlow from "monolith + a few side services" into a pool of apps where each app can be:

1. **Sold separately** — an org can buy only HR, only Forms, etc.
2. **Called by third parties** — public, versioned APIs with API keys and webhooks.
3. **Self-hosted** — a customer runs one app (plus its platform dependencies) on their own server.

Goal 1 is delivered first and cheaply (entitlements in the existing guard). Goals 2 and 3 are built only when a paying customer needs them — each deferred piece below names its trigger.

Constraint: live NGOs see **no behaviour change**. Existing `/api/*` routes and responses stay identical; every move is reversible via the in-process fallback.

## 2. Decisions

| Topic | Decision |
|---|---|
| Selling separately | `apps[]` per plan; `lib/subscriptionGuard.js` (already gates AI by plan via `AI_PREFIXES`) generalised to per-app route prefixes; tabs hidden by `apps[]` in `dashboardTabs.ts` |
| Identity | Firebase login + existing `req.user` stays. Identity owns users, orgs, roles, entitlements, billing, super admin. FieldFlow JWT is **deferred** (see §5) |
| Shared records | Core Records owns People, Projects, Locations, Staff directory, plus consent/DSR/erasure |
| Granularity | 2 platform services + 8 sellable apps. Notify and Files are libraries in the service kit, not services |
| Frontend | One React shell; tabs shown per org `apps[]`; PWAs (/org, /collect) stay focused apps |
| Approach | **Dual-mode modules**: each app is a package with one router + own schema + DB role; runs in-process (`SERVICES=all`, prod default) or standalone (`SERVICES=hr`) |
| Registrations | The 4 registration services fold into Forms templates writing to Core Records |
| Report Writer | Unused today (no frontend caller, `RW_SHEET_ID` never set, saves always fail). Proposal: merge into Reports & Content Hub. **Open — to be discussed with user before any action.** |
| Infra | Postgres only, no Redis / broker / separate vector DB. Events are in-process function calls until services actually split (§7) |

## 3. Service catalog

### Platform services

| # | Service | Schema | Owns | Comes from |
|---|---|---|---|---|
| 1 | Identity & Org | `identity` | users, orgs, roles, app entitlements (`apps[]`), plans/subscriptions/invoices, super admin console | auth, org, admin, superadmin*, billing, lib/subscriptionGuard, lib/authTokens |
| 2 | Core Records | `people` | People (generalised beneficiary), Projects, Locations/LGD, Staff directory, custom fields, duplicate matching, consent, DSR, erasure | beneficiaries, individual-beneficiaries, beneficiary-profile, lgd, collectives, micro-entrepreneurs, indirect-beneficiaries, consent, dsr, beneficiary-erasure |

Shared libraries (in `lib/service-kit/`, not services): **Notify** (email via Resend / org SMTP, in-app badges, push, WhatsApp template sends — replaces `lib/mailer` + finance/hr `notify.js` copies) and **Files** (document vault, media, uploads via the S3 API — GCS interop on our cloud, MinIO/disk self-host).

### Sellable apps

| # | App | Schema | Includes | Today |
|---|---|---|---|---|
| 3 | Forms & Collect | `forms` | builder, ODK/OpenRosa, Collect PWA, Form AI, registration templates | monolith (spec exists) + 4 registration services |
| 4 | Programs / M&E | `programs` | 11 MIS activities, mis-entries, trainings, exposure visits, input distributions, action plans, indicators, impact framework | monolith |
| 5 | HR | `hr` | attendance, leave, shifts, performance | service (performance still in monolith) |
| 6 | Finance | `finance` | advance/ledger/settlement, budget mgmt, financial tracker, budget utilisation, income | service (partial) |
| 7 | Dashboards & Analytics | `dashboard` | dashboards, per-org custom dashboards from metric catalog | service |
| 8 | AI Copilot | `ai` | Ask AI, Notebook + TTS, extraction, story finder, prompts, correctness, AI settings | Notebook service + monolith |
| 9 | Reports & Content Hub | `reports` | reports, saved/quick reports, Content Hub, impact reports (+ Report Writer if merged) | monolith + RW service |
| 10 | Engage (WhatsApp) | `engage` | Meta direct, Glific connector, flow generator, campaigns, WA reports | monolith |

Compliance (due dates, scheme/credit/grant access) and Fundraising CRM (leads, data sources, donor intelligence) **stay in the monolith** behind an `apps[]` prefix. Extract one when an org wants to buy it on its own.

\*Super admin stays with Identity because it manages orgs and entitlements.

Exact route-to-app assignment for every file in `routes/` is produced per phase in that phase's plan, not here.

## 4. Service anatomy

```
services/<name>/
  router.js        createRouter({ db, auth, clients }) — the only entry point
  migrations/      own schema only; applied by the service at boot
  index.js         standalone server (Cloud Run / Docker)
```

- **Service kit** (`lib/service-kit/`): migration runner, healthz, correlation IDs, Notify, Files. Every service uses it; no copies.
- **One image, two modes**: `SERVICES=all` mounts every router in one process — **prod default**, plus self-host and dev. `SERVICES=hr,finance` mounts a subset. Our cloud keeps `serviceProxy` with in-process fallback for services already running standalone.
- `openapi.yaml` is added only for apps that get a public API (Phase 4).

## 5. Auth

- Now: Firebase login and the existing `req.user` (with `orgId`, `role`). The entitlement guard adds `apps[]` and returns 403 `PLAN_NO_APP` for routes outside the org's apps — enforced server-side, not only by hiding tabs. Fail-open on guard DB errors, same as today.
- Standalone services keep the current shared internal key.
- **Deferred — FieldFlow JWT** (RS256, `org`, `sub`, `role`, `apps[]`, JWKS at `/.well-known/jwks.json`; Firebase/API-key/OIDC exchange at Identity). Trigger: the first self-host customer or third-party API client.

## 6. Data

- One Postgres cluster; **one schema + one DB role per service** (pattern already used by Finance's `fm_service`).
- No cross-schema writes or foreign keys. Reads of people/projects from other apps go through **read-only views Core Records publishes in its own schema** (granted `SELECT` to each service role) — keeps the ~15 existing beneficiary joins as SQL instead of rewriting them as batch API calls.
- Self-hosting an app needs only its schema plus `identity` and `people`, so the views are always present.
- Transactions never span services.
- **Deferred — batch APIs / event-fed read models instead of views.** Trigger: a service must run against a separate database.

## 7. Events

- Now: in-process. A cross-app reaction (e.g. Programs reacting to a Forms submission) is a direct function call through the router's `clients`, inside the caller's transaction where possible.
- Naming kept for later: `<service>.<entity>.<verb>`, e.g. `people.person.created`, `forms.submission.received`, `people.erasure.requested`.
- **Deferred — per-schema outbox + LISTEN/NOTIFY relay, at-least-once delivery, idempotent consumers, third-party webhooks from the outbox.** Trigger: two apps that must react to each other run in separate processes, or the first webhook customer.

## 8. Edge

The monolith is the **Edge**: serves the SPA, auth, rate limits, entitlement guard, routing. Existing `/api/*` routes are kept unchanged. The shell shows tabs from the org's `apps[]` (existing lazy tab chunks in `dashboardTabs.ts`). Public `/api/v1/<app>/*` arrives with Phase 4.

## 9. Migration order

Each phase gets its own spec + plan + PR(s). Every DB migration is confirmed with the user first. Every move keeps the monolith route as fallback until verified.

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 Sell separately | `apps[]` on plans; `subscriptionGuard` generalised from `AI_PREFIXES` to per-app prefixes; tabs hidden by `apps[]`; super admin edits a plan's apps; Report Writer decision | an org on an HR-only plan gets 403 `PLAN_NO_APP` on Forms routes and sees no Forms tab; existing plans include all apps (no behaviour change) |
| 1 Service kit + dual-mode | service kit (migrations, healthz, correlation IDs, Notify, Files); Finance/HR/Dashboard/Notebook onto kit; monolith app code moved into `services/<name>/router.js` one app at a time; Core Records schema + read-only views | golden snapshots match with `SERVICES=all`; Finance/HR send via Notify |
| 2 Forms & Collect | forms service per existing spec; 4 registration services become Forms templates writing to Core Records | 4 registration deployables removed |
| 3 Programs / M&E, Engage, AI, Reports | move remaining apps onto routers; AI calls other apps through `clients` as the signed-in user | MIS routes served by Programs router |
| 4 Public API + self-host | **only when a customer needs it**: FieldFlow JWT, API keys + webhooks in super admin, outbox, `openapi.yaml` + `/api/v1` docs, per-app compose bundles (first: Identity + People + Forms) | external client calls an app with an API key; Forms runs alone via `docker compose up` |

Core Records' schema + views land in Phase 1 because beneficiary tables are joined from ~15 routes and every later app reads them.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Entitlement guard locks out a live org | every existing plan seeded with all apps; guard fails open on lookup errors; super admin bypass |
| Breaking beneficiary joins | read-only views keep the joins as SQL; schema moves behind golden snapshots |
| Latency from extra hops | `SERVICES=all` in prod — no hops |
| Cross-service consistency | transactions stay inside one service; no distributed transactions |
| Self-host drift | not shipped until Phase 4; then CI runs the compose stack each release |
| Prod drift (stale service copies, as found 2026-10-07) | CI deploys every service that prod routes to; a service joins the CI matrix in the PR that sets its `*_SERVICE_URL` |

## 11. Testing

- **Golden snapshots**: record existing `/api/*` responses (PGlite harness) before each move; must match after.
- **Entitlement test**: one check that the guard returns 403 for a route outside `apps[]` and passes for one inside (extend the existing `computeAccess`-style test).
- **Real build**: `npm run build` + load in browser for every PR.
- Contract tests against `openapi.yaml`: Phase 4, only for public apps.

## 12. Out of scope

Pricing per app, custom domains, Kubernetes/Helm packaging, rewriting service internals beyond what each move needs, the Report Writer decision (pending discussion), and everything marked **Deferred** above until its trigger fires.
