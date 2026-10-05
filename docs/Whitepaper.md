# FieldFlow Whitepaper

**AI-native operating system for grassroots development NGOs**

*June 2026 · v1.0*

---

## Executive summary

Indian development NGOs spend 30–60% of their staff time on reporting paperwork — not field work. The data they collect is fragmented across Excel files, WhatsApp groups, paper logbooks, and donor portals. By the time a quarterly report reaches a funder, it is three months stale, manually re-keyed twice, and unverifiable against ground truth.

FieldFlow is an AI-native operating system that collapses this reporting overhead to near-zero while raising data quality. Field staff submit one daily WhatsApp message; the platform extracts structured data, updates the action plan in real time, generates donor-ready reports on demand, and routes exceptions to managers. One full-time program officer can now oversee 5× the geography they could a year ago.

This whitepaper describes the problem space, the platform's design choices, early results at Kosi Sahjivan Vikas Samiti (a Bihar-based NGO operating in 32 villages), and a path to serving 1,000+ NGOs at zero marginal cost.

---

## 1. The reporting overhead crisis

### 1.1 What the data shows

Across 14 Indian development NGOs we interviewed in 2025–26, program staff reported the following weekly time allocation:

| Activity | % of work week |
|---|---|
| Travel to/from field sites | 22% |
| Direct beneficiary engagement | 18% |
| Reporting & data entry | 31% |
| Internal meetings | 14% |
| Donor reports & MIS uploads | 11% |
| Training / capacity building | 4% |

Reporting and donor-facing documentation consume **42% of staff time**. Direct beneficiary engagement — the actual mission of the organisation — gets less than half of that.

### 1.2 Where it goes wrong

The mechanics of NGO reporting are broken in five recurring ways:

1. **Re-keying.** A frontline worker writes notes in a paper logbook. A field officer transcribes those into an Excel sheet. A program manager copies cells from that Excel into a donor template. A finance officer re-enters figures into a quarterly MIS portal. The same number is touched by 4 people.
2. **Reconciliation drift.** Each transcription introduces small errors. By month-end, the action plan, the field log, the donor report, and the MIS portal all show different numbers for the same activity. No one trusts the totals.
3. **Lag.** Field data takes 7–30 days to reach decision-makers. By the time a program manager learns that "Khagaria fish-pond construction is behind schedule," two construction weeks have already been lost.
4. **Unverifiable.** Donor reports are narrative-heavy and number-light. There is no audit trail from a final reported figure back to the field event that generated it. Funders are increasingly demanding this trail.
5. **Reporting fatigue.** Frontline workers — often women, often paid stipends not salaries — burn out on paperwork. Attrition is high. Each replacement loses 6 months of institutional context.

### 1.3 Why existing tools haven't solved it

NGOs have tried:

- **Generic CRMs (Salesforce, HubSpot)** — too expensive, too sales-focused, require dedicated admins
- **Form builders (KoBoToolbox, ODK)** — solid for surveys but no AI, no real-time dashboards, no donor reports
- **Microsoft 365 + SharePoint** — yes, but the moment you have 50 villages × 12 activities × 12 months you're back in Excel hell
- **MEAL-platforms (DevResults, TolaData)** — enterprise-priced; require months of customisation; designed for big INGOs not lean grassroots groups
- **WhatsApp groups** — chaotic, no structured data, no audit trail, conversations buried after 24h

What's been missing is a platform that meets NGOs *where they already work* — on WhatsApp, in their local language — and lifts the reporting burden using AI rather than asking them to learn yet another tool.

---

## 2. Design principles

FieldFlow was built around five non-negotiable principles drawn from 200+ hours of field observation.

### Principle 1 — Meet workers on WhatsApp
80% of Indian field workers cannot reliably use a smartphone app, but 100% use WhatsApp daily. Any new behavior we introduce must fit inside an existing WhatsApp conversation.

### Principle 2 — Voice and vernacular first
Most field workers are more fluent dictating in Bhojpuri, Maithili, or Marathi than typing in English. Voice → text → structured data must work end-to-end with no UI burden on the worker.

### Principle 3 — AI does the work, humans approve
The AI's job is to draft (the form, the report, the message reply). The human's job is to approve. Never invert this — never put the human in the role of constructing structured output.

### Principle 4 — Zero data loss, zero PII leakage
Every message, every submission, every signature is encrypted at rest. Failed webhooks go to a retryable dead-letter queue. Audit logs redact PII. The platform should be defensible under the strictest donor compliance audit.

### Principle 5 — Near-zero marginal cost
The platform must run on free-tier cloud infrastructure for an NGO of ≤1000 beneficiaries. We chose: Google App Engine free tier + Neon free Postgres + Gemini's generous free quota + Meta's free first-1000 WhatsApp conversations. An NGO can run FieldFlow for ~₹0/month until they exceed 1,000 active beneficiaries on WhatsApp.

---

## 3. How FieldFlow works

### 3.1 Daily field workflow

```
Morning   Worker (in WhatsApp): "Today at Khagaria fish-pond,
          we trained 15 women on pond hygiene. 3 ponds
          inspected. 1 issue — outlet pipe broken at pond 7."

          ↓ (within 4 seconds)

  FieldFlow: ✅ Logged
            • Activity: Training (Fisheries · Khagaria)
            • Beneficiaries: 15 women
            • Output: 3 pond inspections
            • Flagged for follow-up: outlet pipe pond 7
            Anything else?

  Worker:   "no thats all"

  FieldFlow: Got it. Have a good evening.
```

In the background, FieldFlow has:
- Created a `daily_reports` row linked to the worker's UID + the active project
- Updated `project_deliverables` for Khagaria · Training · June from 142 → 157
- Created a tagged "Needs Attention" entry the field officer will see in tomorrow's dashboard
- Stored the original message + audio file for audit
- Updated the village-level beneficiary count for the monthly donor view

The worker did not log into anything, did not fill any form, did not learn any new tool.

### 3.2 Manager workflow

The field officer opens the Action Plan tab on their laptop and sees:

- **Status panel:** "Project is on-track. 67.3% of annual target reached. Expected by now: 50% (we're 17.3 percentage points ahead.)"
- **Needs Attention:** 8 cells flagged — including pond 7's broken outlet pipe with the worker's exact message attached
- **Per-village progress:** Khagaria is leading; Saharsa is 22% behind. One click drills into Saharsa's village-level activity breakdown.

For the donor report, they click "Generate Report → Quarterly Progress" and answer 3 questions in plain English. The AI assembles a 14-page report citing the underlying daily_reports rows. The manager reviews, edits two paragraphs, and downloads the PDF. Total time: 18 minutes.

The same process previously took 3 working days.

### 3.3 The architecture (one diagram)

```
Field worker (WhatsApp / Voice / Vernacular)
         │
         ▼
Meta WhatsApp Cloud API ──webhook──► FieldFlow server (App Engine)
                                        │
                                        ├── Gemini 2.5 Flash (NLU + extraction)
                                        ├── Postgres on Neon (data + audit)
                                        ├── Notebook (RAG over project docs)
                                        ├── Report Writer (Cloud Run microservice)
                                        └── Action Plan engine (multi-project)
                                        │
                                        ▼
                          NGO staff (React SPA on browser)
                          NGO donors (Generated PDF reports)
                          Government (Compliance Excel exports)
```

Single codebase. Single deploy. Zero infrastructure for the NGO to manage. The platform's full architecture is documented in [Technical.md](./Technical.md).

---

## 4. Case study — Kosi Sahjivan Vikas Samiti

Kosi Sahjivan Vikas Samiti is a 14-year-old NGO operating in 32 villages across Khagaria, Saharsa, and Madhubani districts of Bihar. Their work covers fisheries, women's collectives, agriculture, and education. They have 18 field staff and ~5,400 beneficiary households.

### Before FieldFlow (FY 2024–25)

- Action plan tracked in 7 separate Excel files (one per project funder)
- Daily reporting via paper logbooks + monthly Excel rollups
- Donor reports took 5–7 working days each, prepared by 2 senior staff
- Quarterly state-government MIS uploads required ~3 person-days per quarter
- ~40% of staff time on reporting
- 4 audit queries from donors per year that required reconstructing data from scratch (one took 11 days)

### After FieldFlow (Q1 FY 2026–27, 3 months in)

- Single multi-project action plan with 472 cells across 6 projects × 4 locations × 12 months
- Daily reporting via WhatsApp (Hindi + Maithili supported)
- Donor reports generated in 15–30 minutes (5 generated in Q1 across 3 funders)
- ~14% of staff time on reporting (a 26-point reduction, freeing ~520 staff-hours per quarter)
- 1 donor audit query in Q1 — resolved in 40 minutes by drilling from the report figure to the source `daily_reports` row

**Numbers from Q1 (April–June 2026):**

| Metric | Value |
|---|---|
| Daily reports submitted via WhatsApp | 1,247 |
| Voice messages transcribed | 312 |
| Unique field workers using the platform | 21 |
| Action Plan cells updated | 1,884 |
| AI-generated donor reports | 5 |
| Beneficiary contacts in WhatsApp module | 1,608 |
| Cost to KSVS for the entire quarter | ₹0 |

The platform stayed inside free-tier limits for: Google App Engine (1 instance), Neon Postgres (under 0.5 GB), Gemini API (under free monthly quota), and Meta WhatsApp Cloud (under 1000 monthly conversations).

### What surprised us

Three things we didn't expect:

1. **Voice adoption was instantaneous.** Within 2 weeks, 60% of daily reports were voice notes rather than typed messages. Older women workers — who had previously avoided written reporting altogether — became the most active reporters.
2. **Manager workload increased, not decreased.** Counterintuitive but expected on reflection — when reporting is free, you get 10× more reports. Managers now had ground-truth visibility they didn't have before, but they had to triage it.
3. **Donor trust went up sharply.** Two major funders began asking for the audit trail by default — and the audit trail existed, in seconds.

---

## 5. The platform's economic moat

### 5.1 Why "free tier" matters strategically

Most enterprise NGO MIS tools charge ₹5,000–25,000 per month per organisation. For a small NGO with a ₹50 lakh annual budget, that's 2–6% of operating expenses — politically untenable. They opt to keep using Excel.

FieldFlow's free tier serves NGOs with up to:
- 1 always-on web server instance (free under App Engine)
- 500 MB Postgres (free under Neon)
- ~1 million Gemini tokens/day (free under AI Studio quota)
- 1,000 monthly active WhatsApp conversations (free under Meta Cloud API)

That envelope comfortably covers an NGO with up to ~50 field workers and ~5,000 active beneficiaries. Above that, costs scale linearly but stay below 0.5% of operating budget.

### 5.2 Why the moat compounds

The platform's value compounds in three ways:

1. **Data flywheel.** Every report submitted improves the org's AI memory layer, making the next report's auto-extracted fields more accurate.
2. **Reporting template library.** Each generated donor report becomes a template for next time. After 12 months, every recurring report is one-click.
3. **Workflow standardisation.** Once 18 staff are using the platform, switching costs become organisational, not technical. The NGO has built institutional knowledge into the system.

### 5.3 Comparison to incumbents

| Capability | KoBoToolbox | DevResults | Glific | FieldFlow |
|---|---|---|---|---|
| WhatsApp-native | ❌ | ❌ | ✅ | ✅ |
| Voice + vernacular | ❌ | ❌ | Partial | ✅ |
| AI report generation | ❌ | Partial | ❌ | ✅ |
| Action Plan / MEAL | ❌ | ✅ | ❌ | ✅ |
| Donor report automation | ❌ | Partial | ❌ | ✅ |
| Closed loop (WA → MEAL) | ❌ | ❌ | ❌ | ✅ |
| Multi-project | ✅ | ✅ | ❌ | ✅ |
| Multi-tenant SaaS | Self-host | ✅ | ✅ | ✅ |
| Cost for small NGO | Free | $500/mo+ | $100/mo+ | Free |

FieldFlow's defensible position is the **closed-loop** column. We are the only platform where a beneficiary's WhatsApp reply automatically updates the donor-facing action plan. Everyone else stops at the survey response.

---

## 6. Governance, security, and compliance

### 6.1 Data governance

- **Per-org isolation.** Every business table partitions on `org_id`. No cross-org query is possible by design.
- **Encryption at rest.** WhatsApp access tokens, webhook secrets, and PII fields use AES-256-GCM via Google Cloud Secret Manager.
- **Encryption in transit.** All connections enforce TLS 1.3.
- **PII redaction in logs.** Phone numbers are masked, message previews capped at 40 characters, sensitive notes redacted in audit diffs.
- **Retention policies.** WhatsApp messages auto-purge after 180 days, audit logs after 365, dead-letter events after 30. Configurable per org.

### 6.2 Compliance

The platform's design anticipates:

- **India's Digital Personal Data Protection Act 2023** — explicit consent, data minimisation, retention limits, breach notification, principal rights (export, deletion).
- **Donor-specific frameworks** — ECHO, USAID, EU SDGs reporting, NABCONS.
- **Government MIS interoperability** — Excel exports formatted for PMMSY, PMKSY, NRLM, MoTA-TRIFED templates.

### 6.3 Failure modes documented

Crash-proofing matters in a tool that NGOs rely on at month-end. The platform handles:

- **Unhandled promise rejections** — logged, never exit
- **Uncaught exceptions** — logged, never exit
- **Request timeouts** — 60s ceiling prevents slow-client resource exhaustion
- **Graceful shutdown** — 25s in-flight drain on SIGTERM
- **Webhook signature failures in production** — fail-closed (the message is dropped, not blindly executed)
- **Webhook processing failures** — captured in dead-letter queue, admin-retryable
- **Token expiry** — automatic refresh on 401

A 23-issue security audit was conducted and fully remediated in June 2026. Findings and fixes are documented in [Technical.md, Section 7](./Technical.md).

---

## 7. Roadmap

### Shipped (Q1–Q2 2026)
- Multi-project action plan with Excel upload + impact dashboard
- WhatsApp module with flows, broadcasts, collections, AI replies, voice transcription
- AI report generator with quarterly + custom templates
- Notebook RAG over project documents
- Cloud Run microservices for AI workload separation
- Security hardening (23 issues remediated)
- Documentation set (API, SDK, Walkthrough, Technical)

### Next 90 days (Q3 2026)
- **AI Flow Generator v2** — flow templates by sector (women's collective onboarding, fisheries, MGNREGA grievance)
- **Government compliance exports** — Excel formats matching PMMSY/PMKSY/NRLM official schemas
- **WhatsApp RAG** — beneficiaries can ask questions of project documents in their language

### Next 12 months
- **Multilingual UI** — Hindi, Marathi, Bengali, Tamil, Telugu for the dashboard itself (not just WhatsApp)
- **Donor integration** — direct push to ECHO, FCRA portals, KOICA via API
- **Mobile app for field officers** — for offline-first form filling in zero-connectivity geographies
- **Cross-NGO learning** — opt-in benchmark dashboard so an NGO can see how their indicators compare to peer organisations in the same sector and geography

### Long-term thesis
We believe the next decade of grassroots development will be measured by NGOs who can prove their impact to donors, governments, and their own beneficiaries — in near-real-time, with full audit trail. The OS for that future is what we are building.

---

## 8. The team and how to engage

FieldFlow is an open project under active development. We are working with a small cohort of partner NGOs to refine the platform before broader release.

### Get involved

- **NGO partnership:** if you run a grassroots NGO in India with 5+ field staff and would like FieldFlow to onboard your team, write to us at `ayush.chopra63@gmail.com`. We are currently selecting 10 partner NGOs for 2026–27.
- **Funder partnership:** if you fund grassroots NGOs and would like reporting from your portfolio organisations to flow into your dashboard automatically, we can build the connector. Same address.
- **Developer:** the platform is documented end-to-end. The technical doc set (4 PDFs, ~80 pages combined) covers every module. We accept contributions and can scope paid work for organisations needing a specific extension.

### Pricing philosophy

The free tier is permanent for organisations under the 1,000-active-beneficiary threshold. Above that, pricing is published and predictable, capped at 0.5% of an NGO's annual operating budget — designed to be lower than the cost of one full-time data entry clerk.

We will never charge for data export. Your data is yours, always, in CSV and Excel.

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| **Action Plan** | The annual matrix of indicators × locations × months that defines what an NGO will deliver. |
| **Beneficiary** | A person served by an NGO program. |
| **Closed loop** | The property of a system where field events flow back to the MEAL system without manual transcription. |
| **DPDP Act** | India's Digital Personal Data Protection Act, 2023. |
| **FCRA** | Foreign Contribution Regulation Act — governs foreign funding to Indian NGOs. |
| **Field staff** | Frontline workers visiting beneficiary households. |
| **MEAL** | Monitoring, Evaluation, Accountability, Learning — the donor framework for impact measurement. |
| **MIS** | Management Information System — typically the government portal NGOs upload to. |
| **NGO** | Non-Governmental Organisation. |
| **PII** | Personally Identifiable Information. |
| **SHG** | Self-Help Group — usually women's collectives. |
| **ToC** | Theory of Change — the causal chain from activity to impact. |

## Appendix B — Sources and citations

- 200+ hours of field observation across 14 NGOs in Bihar, Maharashtra, Tamil Nadu, Odisha (2025–26)
- Kosi Sahjivan Vikas Samiti deployment data (Q1 FY 2026–27)
- Time-allocation survey of 47 field staff (October 2025)
- NITI Aayog NGO Darpan dataset (2024)
- DPDP Act 2023 official gazette
- Meta WhatsApp Cloud API documentation
- Google Cloud Platform pricing (as of June 2026)

---

*Written from observation, deployed in production, maintained by [its users](./Walkthrough.md).*

*For the technical implementation, see the [Technical Documentation](./Technical.md).*
*For developer integration, see the [SDK Guide](./SDK.md).*
*For endpoint reference, see the [API Documentation](./API.md).*

---

**FieldFlow · June 2026**
