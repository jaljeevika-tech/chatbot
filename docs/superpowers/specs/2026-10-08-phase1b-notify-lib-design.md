# Phase 1b — Notify Library — Design

Date: 2026-10-08 · Status: approved in chat (option A, dedupe only), awaiting spec review
Parent: `2026-10-08-platform-microservices-design.md` Phase 1 (1a kit ✓ → **1b Notify** → 1c Core Records → 1d Files).

## 1. Goal

HR and Finance stop carrying two copies of the same email + WhatsApp-template sending code. One `lib/notify.js` holds it; each service keeps everything that is genuinely its own.

Constraint: **no behaviour change.** Same SMTP mailbox (env `SMTP_*`), same subjects, bodies, links, templates, quick-reply payloads, language fallback and error messages.

## 2. What is duplicated today

`services/hr/notify.js` and `services/finance/src/notify.js` contain identical copies of: the cached nodemailer transport (env `SMTP_HOST/PORT/USER/PASS/FROM`), HTML escaping, the email text/HTML layout, `waNumber`, the template text (whitespace-collapsed, 900 chars, ` Details: <link>`), the Graph API template send, and the Meta #132001 handling (`approvedTemplateLang`, `sameLangHint`, retry in the approved language).

Different per service (stays in the service): settings shape and loading, events, recipient queries, deep-link routes, subject prefix (`[HR]` / `[Finance]`), template + button choice and payload, in-app notification rows, the dispatch loop and its result reporting.

## 3. Design

### `lib/notify.js` (new)

| Export | Behaviour (copied from today's code) |
|---|---|
| `emailConfigured() → boolean` | `SMTP_USER && SMTP_PASS` |
| `sendEmail({ to, subject, title, body, link }) → Promise` | sends via the cached transport; text + HTML layout exactly as today; throws `Email is not configured on the server (SMTP_USER / SMTP_PASS).` when there is no transport |
| `waNumber(phone) → string \| null` | digits only; 10 digits → `91` prefix; ≥11 kept; else `null` |
| `waTemplateText({ title, body, link }) → string` | `title — body`, whitespace collapsed, sliced to 900, then ` Details: <link>` |
| `sendWaTemplate(cfg, { to, name, lang, text, payload }) → Promise` | POST to Graph v19.0 `/{phone_number_id}/messages`, body param `text`, quick-reply button only when `payload` is set; on #132001 looks up the approved language and retries once, or throws the same diagnostic messages as today; throws `j.error.message` or `WhatsApp API <status>` on failure |

The transport-unavailable warning becomes `[notify] email disabled — nodemailer unavailable: …` (was `[hr-notify]` / `[fm-notify]`); log-only.

### HR (`services/hr/notify.js`)

Keeps `EVENTS`, `DEFAULT_NOTIFY`, `notifySettings`, `appLink`, `approvePayload`, `hrApproverIds`, `dispatch`, and re-exports `emailConfigured` (imported by `router.js`). Its private `sendEmail` becomes `sendEmail({ to, subject: '[HR] ' + title, title, body, link: appLink(msg) })`; its `sendWhatsApp` keeps the template/button/payload choice and the `No valid phone number.` throw, then calls `sendWaTemplate`.

### Finance (`services/finance/src/notify.js`)

Keeps `DEFAULT_SETTINGS`, `loadSettings`, `queueNotifications`, `appLink`, `dispatchExternal`. Email is sent only when `emailConfigured()` (today's `sendEmail` silently returned without a transport — same outcome). WhatsApp keeps its silent return on an invalid number and its `ffa:<entityType>:<stage>:<entityId>` payload, then calls `sendWaTemplate`.

### Dockerfiles

Finance and HR copy `lib/notify.js` alongside `lib/serviceApp.js` (both already build from the repo root; both list `nodemailer`).

### Not doing

| Skipped | Add when |
|---|---|
| Routing HR/Finance email through `lib/mailer.js` `sendOrgEmail` (Resend / org SMTP, branding, `email_log`) | user wants org-branded service emails — visible change, its own step |
| Shared in-app badge / push code | a second service needs the same in-app store (today only Finance writes `fm_notifications`) |
| Shared dispatch loop | the loops differ (HR returns per-send results and filters by event; Finance doesn't) |

## 4. Testing

- `lib/notify.check.mjs` (node, assert; stubs `globalThis.fetch`): `waNumber` cases (10-digit, `+91…`, short → null); `waTemplateText` collapses whitespace, caps at 900, appends link; `sendWaTemplate` request body equals today's shape with and without `payload`; #132001 → approved `en_US` → retried with `en_US`; #132001 with the same language → phone-number hint; template not approved → status message; other error → Meta's message; `sendEmail` without `SMTP_*` → the "not configured" error.
- HR's `dates` / `shifts` / `reminders` tests still pass.
- Finance and HR services boot (`/healthz`), monolith `tsc` + `npm run build`.
- In prod (HR + Finance run in-process): after deploy, one HR or Finance action that notifies (e.g. a leave request) still sends.
