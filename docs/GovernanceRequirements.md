# Governance Information Requirements

**Data & information needs for board and senior management in day-to-day NGO operations**

*Companion to [Technical.md](./Technical.md) and [Whitepaper.md](./Whitepaper.md)*

---

## Purpose

This document defines the minimum set of data, reports, dashboards, and alerts that the **board** and **senior management** of an NGO using FieldFlow need to see — and at what cadence — to discharge their fiduciary, strategic, and operational responsibilities.

It is written from two angles simultaneously:
- **What** the platform must surface (a product spec)
- **Who** needs to see it, **when**, and **why** (a governance spec)

Use it to:
1. Configure FieldFlow dashboards and report schedules for a new NGO.
2. Brief a new board member or director on what they should be looking at.
3. Audit whether the current platform setup meets governance needs.

---

## 1. Stakeholder map

| Role | Decision horizon | Primary concern |
|---|---|---|
| **Board of Trustees** | Quarterly · annual | Mission, compliance, financial health, reputational risk |
| **Executive Director / CEO** | Weekly · monthly | Program delivery, donor relations, team health, cash |
| **Program Director** | Daily · weekly | Project delivery vs. plan, exception management |
| **Finance Controller** | Daily · monthly | Cash position, FCRA compliance, audit-readiness |
| **MEAL Lead** | Weekly · quarterly | Data quality, indicator integrity, impact attribution |
| **HR Lead** | Weekly | Attrition, attendance, payroll compliance |
| **Field Manager** | Daily | Today's plan, today's exceptions, tomorrow's deployment |

This document covers the top 5 rows. Field-manager day-to-day is covered in [Walkthrough.md](./Walkthrough.md).

---

## 2. Board of Trustees — quarterly information pack

The board meets quarterly. They are unpaid, time-constrained, and legally accountable. Their information needs must be **summarised, comparative, and exception-driven** — never raw operational data.

### 2.1 Required quarterly report (single PDF, ≤12 pages)

| # | Section | What it shows | FieldFlow source |
|---|---|---|---|
| 1 | Mission delivery scorecard | One-page table: every active project, % of annual target reached, traffic-light status | `action_plans` × `project_deliverables` aggregate |
| 2 | Beneficiaries served | Cumulative unique beneficiaries this FY, broken down by gender/age/caste/disability | `daily_reports.custom_data` aggregates |
| 3 | Geographic footprint | Map of villages reached + new villages this quarter | `daily_reports.location` distinct |
| 4 | Financial summary | Cash on hand, burn rate, donor receivables, FCRA balance | External (finance team to supply) |
| 5 | Grant pipeline | Active grants, expiring grants, prospects in pipeline | External |
| 6 | Compliance heatmap | FCRA, ITR, 12A/80G, state society returns — green/amber/red | External + audit log |
| 7 | Risk register | Top 5 risks with severity, owner, mitigation status | Manual entry by ED, surfaced in FieldFlow |
| 8 | People | Headcount, attrition rate, hires, exits, gender ratio | `users` table |
| 9 | Significant events | Major incidents, audits, media coverage, donor visits | Audit log + ED narrative |
| 10 | Strategic decisions needed | 1–3 issues requiring board approval | Manual — ED prepared |

### 2.2 Required board KPIs (4-quarter trend visible at every meeting)

| KPI | Definition | Target |
|---|---|---|
| **Mission scorecard average** | Mean % of annual targets reached across all projects | ≥ Expected by date |
| **Beneficiaries served (YoY)** | Unique beneficiaries this quarter vs. same quarter last year | +10% YoY |
| **Cost per beneficiary** | Total program spend ÷ unique beneficiaries | Stable or declining |
| **Donor retention** | Returning donors as % of last year's donor base | ≥80% |
| **Months of operating runway** | (Cash + receivables) ÷ monthly burn | ≥6 months |
| **Compliance index** | % of compliance items in "green" status | 100% |
| **Voluntary attrition** | Staff exits initiated by employee | <15% annualised |
| **Audit observations** | Internal + statutory + donor audit findings | 0 critical |

### 2.3 Off-cycle alerts to board chair
The platform should immediately alert the board chair (email + WhatsApp) when:
- Cash runway drops below 3 months
- A FCRA, ITR, or society return goes overdue
- A donor formally raises a grievance
- A media-coverage event (positive or negative) is flagged
- A safeguarding/POSH incident is reported
- Any single payment >₹5 lakh is initiated

These are exceptions, not routine reports. The chair should receive ≤6 of these per year in a well-run NGO.

---

## 3. Executive Director — weekly + monthly view

The ED needs **real-time visibility** without being buried in detail. The platform should give the ED a single landing page that loads in under 2 seconds and answers: *"What needs my attention today?"*

### 3.1 Required daily landing dashboard

**Top strip — at-a-glance numbers:**
- Reports submitted today / yesterday / 7-day rolling
- Active WhatsApp conversations
- Field staff online today
- Beneficiaries reached this week
- Cash position (read-only from finance system)

**Middle — needs attention (max 7 items):**
- Activity cells flagged behind schedule
- Field staff who haven't reported in 5+ days
- Unanswered donor queries >48h
- Pending approvals (leave, advances, vendor payments)
- WhatsApp conversations escalated to human handoff
- Dead-letter queue entries
- Open safeguarding/grievance cases

**Bottom — this week's calendar:**
- Donor commitments due
- Board / advisor calls
- Field visits planned
- Statutory filings due

### 3.2 Required weekly summary (delivered Monday 8am, single email)

- One-paragraph narrative: where we made progress, where we slipped, what changed
- Top 3 wins (auto-extracted from daily_reports with positive sentiment)
- Top 3 concerns (auto-extracted from needs-attention queue)
- Last week's beneficiary numbers
- This week's calendar
- Action items from last board meeting — status update

### 3.3 Required monthly close package (delivered first working day)
- Action Plan status per project (annual % achieved, traffic light)
- Beneficiary count for the month
- Cost-per-output for the month (where measurable)
- Field-staff time-allocation breakdown
- WhatsApp engagement metrics (sessions, completion rate, handoff rate)
- Audit log highlights — anything unusual

---

## 4. Program Director — daily + weekly view

The program director runs delivery. Their information needs are **operational, granular, and exception-driven**.

### 4.1 Required daily operations dashboard

| Panel | Content |
|---|---|
| **Today's field plan** | Per worker: where they're going, what activities planned |
| **Yesterday's reports** | Submitted vs. expected. Workers who didn't report flagged. |
| **Action plan exceptions** | Cells where actual is <50% of expected-by-now |
| **Inbox** | Field staff messages requiring program-director response |
| **Approvals queue** | Leave, advances, vendor payments awaiting their sign-off |
| **Travel / logistics** | Vehicles deployed, fuel logs, accommodation bookings |

### 4.2 Required weekly view (delivered Friday afternoon)
- Per-project, per-location, per-activity status with last-7-days delta
- Top 10 underperforming cells with assigned owner
- Top 5 outperforming cells (replicate the success pattern)
- Staff productivity: reports per staff-day, average response latency
- Quality flags: reports flagged by AI as anomalous (numbers don't reconcile, location mismatch, etc.)

### 4.3 Required monthly view (delivered first working day)
- Full action plan rollup (downloadable Excel matches the donor format)
- Per-project narrative auto-drafted from daily_reports — for ED review then donor submission
- MEAL data quality score
- Field staff individual scorecards (for HR + performance review feed)

### 4.4 Real-time alerts to program director
- Field worker missed 3 consecutive daily reports
- An Action Plan cell shifts from amber to red
- A beneficiary survey response triggers a "grievance" intent in the WA NLU
- A donor-funded activity falls below 70% of monthly target with <5 working days left in month

---

## 5. Finance Controller — daily + monthly view

Finance has the **highest data-integrity bar** and the **strictest compliance burden**. Even though FieldFlow is not a finance system, governance information passes through it: who approved what, when, with what supporting evidence.

### 5.1 Required daily view
- Pending payment approvals
- Advances outstanding to field staff (with aging)
- Vendor invoices received via WhatsApp/email — awaiting matching
- FCRA bank balance vs. local bank balance (separation required by law)
- Reimbursement queue

### 5.2 Required monthly view
- Project-level burn vs. budget
- Grant-level fund utilisation
- Donor-restricted vs. unrestricted balances
- Statutory dues (TDS, PF, ESI, professional tax)
- Open audit findings + status

### 5.3 Compliance dashboard (always-on)
A traffic-light board for the following, with last-checked date:

| Item | Frequency | Owner |
|---|---|---|
| FCRA quarterly return | Quarterly | Finance |
| FCRA annual return (FC-4) | Annual (Dec 31) | Finance |
| ITR-7 | Annual (Oct 31) | Finance |
| Form 10B | Annual | Finance |
| State Society Annual Return | Annual | Compliance |
| GST returns (if applicable) | Monthly | Finance |
| PF / ESI returns | Monthly | HR |
| TDS returns | Quarterly | Finance |
| 12A / 80G validity | Periodic | Finance |
| FCRA registration renewal | 5-year | Finance |
| POSH committee constitution | Annual | HR |
| Internal audit | Half-yearly | Audit committee |
| Statutory audit | Annual | Audit committee |
| Donor audit reports | Per donor | Finance |

### 5.4 Audit-readiness on demand
The platform must support producing the following on 24-hour notice for any external audit:
- All daily_reports for a date range + linked attachments
- All audit_log entries for a user / date range
- All wa_messages with a beneficiary for a date range
- All donor reports generated with timestamps and authors
- Original raw data behind any aggregate number in any donor report

---

## 6. MEAL Lead — weekly + quarterly view

MEAL owns indicator integrity. Their needs are about **data quality** and **causal attribution**, not just totals.

### 6.1 Required weekly view
- Indicator-level data freshness (how stale is each cell's underlying data)
- Anomaly report: numbers that fail sanity checks (e.g., beneficiaries today > population)
- Disaggregation completeness: % of reports where gender/age/caste fields are filled
- Voice-message transcription quality (when manual review flags transcript as wrong)
- Photo/attachment evidence rate (% of activities with supporting evidence)

### 6.2 Required quarterly view
- Per-indicator: planned vs. achieved with 95% confidence interval
- Theory-of-change tree with current evidence strength per link
- Outlier analysis: villages/activities deviating from norm
- Sample verification: 5% random sample of reports flagged for independent field verification
- Cross-source reconciliation: Action Plan totals vs. WhatsApp survey responses vs. donor reports

### 6.3 Annual view (for impact report)
- Cohort analysis (beneficiaries who entered Year 1 — where are they in Year 3?)
- Outcome vs. output ratios
- Cost-per-outcome
- Counterfactual narrative (what would have happened without the intervention)

---

## 7. HR Lead — weekly view

HR's information needs touch FieldFlow because **field staff identity, role, and activity** live there.

### 7.1 Required weekly view
- Attendance summary (derived from daily_reports submission days)
- Workers with zero submissions in last 5 days
- Anomalous activity patterns (e.g., reports submitted from outside designated area)
- Productivity per staff (reports/day, beneficiaries reached)
- Leave applications pending
- Birthdays + anniversaries this week
- Open grievances / POSH complaints

### 7.2 Required monthly view
- Headcount by role / project / location
- Joiners / leavers
- Voluntary vs. involuntary exits
- Gender ratio, social-category ratio
- Average tenure
- Training completion rates

### 7.3 Annual view
- Attrition rate
- Promotion velocity
- Compensation distribution by role
- Diversity scorecard

---

## 8. Cross-cutting requirements

These apply to every dashboard and report regardless of role.

### 8.1 Audit trail
Every numeric figure shown in any report must be drillable to its source: which daily_report, which staff member, which date, which beneficiary. No "magic numbers" allowed.

### 8.2 Period comparisons
Every metric should show a comparison: same period last year, last quarter, last month. A number without a comparison is decoration, not information.

### 8.3 Exception-first
Dashboards must surface exceptions before averages. A 95% on-track average is uninformative if there's one 30% outlier hidden inside it.

### 8.4 Mobile-readable
Board members and the ED read on phones at 6am and 11pm. Every dashboard must render legibly at 380px width.

### 8.5 Export-friendly
Every view must export to Excel/PDF in one click. Information that lives only inside the platform is information that doesn't get used in meetings.

### 8.6 Role-segregated access
A field worker must not see donor financials. A donor portal user must not see HR data. RBAC is enforced server-side, not just hidden in the UI. Currently: `superadmin > admin > manager > employee` with per-tab gating.

### 8.7 Language
Dashboards in English by default. Reports configurable in Hindi + 4 regional languages. WhatsApp interactions auto-detect.

### 8.8 Offline-tolerance
Field reports must queue and re-sync if connectivity drops. Already supported via WhatsApp's own delivery retry.

---

## 9. What the platform must NOT do

Equally important — to avoid scope creep and false confidence:

- **It does not replace a finance system.** Tally, Zoho Books, QuickBooks remain authoritative for ledgers. FieldFlow consumes summary figures.
- **It does not replace a payroll system.** Payroll computation, statutory deductions, and bank disbursement stay in the dedicated tool.
- **It does not authorise payments.** Approvals are recorded; the actual fund movement happens in the bank's portal.
- **It does not make legal compliance decisions.** It flags due dates and tracks status; a qualified CA or company secretary signs.
- **It does not replace human judgement in safeguarding.** It captures incident reports and routes them to the designated committee; investigation is human.
- **It does not generate fake data.** AI assists with extraction and narrative drafting, never with creating beneficiaries or activities that didn't happen.

---

## 10. Implementation checklist for a new NGO

When onboarding a new NGO to FieldFlow, ensure the following before the first board meeting:

- [ ] Org created with correct legal name, FCRA number, society registration
- [ ] All current trustees added with `superadmin` role
- [ ] Executive Director added with `admin` role
- [ ] Program Director(s) added with `admin` role
- [ ] All field staff added with `employee` role and correct project assignments
- [ ] Active projects added with annual targets and donor mapping
- [ ] Action Plan uploaded (Excel) for current FY
- [ ] WhatsApp Business number configured + webhook verified
- [ ] At least one welcome flow published
- [ ] Compliance calendar entries created with owners assigned
- [ ] Board email distribution list configured for alerts
- [ ] First weekly summary email scheduled (test delivery before the first Monday)
- [ ] First quarterly board report draft generated (test the format with the chair)
- [ ] Audit log retention confirmed at 365 days
- [ ] Data export procedure documented and tested
- [ ] Disaster-recovery contact (who calls Anthropic / Google support) identified

---

## 11. Governance maturity model

A scoring framework to assess where the NGO is on its data-governance journey.

| Level | Description |
|---|---|
| **L0 — Manual** | Excel + paper. Board sees data 30+ days late. |
| **L1 — Digitised** | Forms exist. Data is captured but reports are still hand-built. |
| **L2 — Integrated** | One source of truth. Standard reports generated automatically. |
| **L3 — Real-time** | Dashboards live. Board can self-serve current state any time. |
| **L4 — Predictive** | AI flags risks before they materialise. Anomaly detection on indicators. |
| **L5 — Closed-loop** | Field input → MEAL → donor reports → strategy → field input, all flowing. |

FieldFlow is designed to take an NGO from L0/L1 to L3 within 3 months and to L4/L5 within 12 months.

---

## 12. Open questions for the board to decide

These are governance choices the platform exposes but cannot decide for you:

1. **Data retention.** Default is 180 days for WhatsApp messages, 365 for audit logs (unchanged, technical tables). For beneficiary PII specifically, the platform now supports a **per-org retention/anonymization policy** (`organizations.metadata->'dpdp'->>'beneficiary_retention_days'` and `'dsr_retention_days'`, `lib/retention.js`) — but ships disabled (no default assumed) until the board picks a number. Some donors require 7 years; decide and configure.
2. **Beneficiary consent model.** Opt-in vs. legitimate-interest. The platform now records consent per beneficiary per purpose (`consent_records` table, `routes/consent.routes.js`) and enforces parent/guardian consent for minors on photo/naming — but which lawful basis (opt-in vs. legitimate-interest) governs *data collection itself* is still legal counsel's call, not decided in code.
3. **AI-generated content review threshold.** Should all AI-drafted donor reports be reviewed by a human, or just summarised totals? Default is full review.
4. **Beneficiary data export rights.** Under DPDP, beneficiaries can request their data. The platform now has a staff-mediated DSR intake/fulfillment workflow (`dsr_requests` table, `routes/dsr.routes.js` — access, correction, and erasure requests, each producing an audited trail) and erasure endpoints (`routes/beneficiary-erasure.routes.js`, anonymize by default). Still undecided: the response SLA (see item 1's `dsr_sla_days` — unset by default) and who holds the "Grievance Officer" handling designation (the platform runs this off existing admin/superadmin roles for now, pending that decision). A public self-service intake form (no staff mediation) is deliberately not built yet — it needs its own identity-verification process first.
5. **Cross-NGO benchmarking.** If you join a peer benchmarking cohort, what data is shared? Aggregates only, or sample-level?
6. **Whistleblower channel.** Currently routed to the ED. Some boards want it routed to the chair. Decide.
7. **Photo / video consent.** Do you require explicit per-event consent before any beneficiary image is captured? The platform now has a `photo_video` consent purpose in `consent_records`, with a structural minors safeguard (a beneficiary flagged `is_minor` cannot have `photo_video`/`named_attribution` consent recorded as self-granted — it must come from a parent/guardian). Default capture behavior for a given event is still an org decision.
8. **Subscription approval authority.** Who can approve moving from free tier to paid? Default is ED + Finance Controller jointly.
9. **Field-level encryption scope.** Beneficiary phone numbers, income/revenue figures, and sub-district (panchayat) names are now encrypted at rest across all three registration channels (Individual Beneficiary, Micro-Entrepreneur, Collective). Name, state/district/block, and village stayed unencrypted deliberately — they're needed for live search/filtering/display, and encrypting them would have broken those features. If the board wants that tradeoff revisited (e.g. stronger protection at the cost of losing village-level search), that's a policy call, not a technical blocker.
10. **Data residency.** The primary database (Neon Postgres) is hosted in **AWS `ap-southeast-1` (Singapore)**, not India; the platform's registration microservices run in GCP `asia-south1` (Mumbai). This is not a DPDP violation — India does not mandate in-country storage for this data category — but it is a fact beneficiaries and donors may reasonably want disclosed. Decide whether to disclose as-is or migrate the primary database to an India region.

---

*This document should be reviewed at least annually by the board's governance committee and updated when material changes happen to the platform, the NGO's structure, or the regulatory environment.*

*Last updated: August 2026 · v1.1 — §12 items 1, 2, 4, 7, 9, 10 updated to reflect the DPDP Act 2023 / DPDP Rules 2025 compliance rollout (consent capture, DSR workflow, retention automation, field-level PII encryption).*
