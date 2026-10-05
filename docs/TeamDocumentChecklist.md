# Documents Required From the Team

**A checklist of what every team member, project, and field activity must submit & maintain — for compliance, audit-readiness, and day-to-day operations**

*Companion to [GovernanceRequirements.md](./GovernanceRequirements.md)*

---

## Purpose

This document lists every document the NGO needs from its **own team** — staff, volunteers, field workers, and project leads — to operate legally, defensibly, and efficiently.

It is the **flip side** of the Governance Requirements doc:
- *Governance Requirements* says what information leadership needs to **see**.
- *This document* says what evidence team members need to **submit** so that information exists in the first place.

For each document we specify: **who submits it**, **when**, **where it lives in FieldFlow**, **retention period**, and **legal/compliance reference** where applicable.

---

## 1. Onboarding — every new team member

Required **before** the team member's first day of work or first field deployment. No FieldFlow login should be issued until items marked ⚠ are received.

### 1.1 Identity & KYC

| # | Document | Mandatory | Format | Reference |
|---|---|---|---|---|
| 1 | ⚠ Aadhaar card (masked — last 4 digits visible) | Yes | PDF/image | DPDP Act 2023, KYC norms |
| 2 | ⚠ PAN card | Yes for salary >₹2.5L/year | PDF/image | Income Tax Act |
| 3 | Voter ID / Driving License / Passport (any one) | Yes | PDF/image | KYC backup |
| 4 | Bank account proof (cancelled cheque or passbook page) | Yes for paid staff | PDF/image | Salary disbursement |
| 5 | Passport-size photograph | Yes | JPG | ID card generation |
| 6 | Address proof (utility bill, rent agreement) | Yes | PDF | Record |

### 1.2 Qualifications & background

| # | Document | Mandatory | Format |
|---|---|---|---|
| 7 | Highest education certificate | Yes | PDF |
| 8 | Resume / CV | Yes | PDF |
| 9 | Previous employment certificates (last 2 employers) | If applicable | PDF |
| 10 | Professional certifications (if claimed) | If applicable | PDF |
| 11 | Two reference contact details (name, phone, relationship) | Yes | Text |
| 12 | Police verification certificate (or undertaking pending) | Mandatory for field roles working with children | PDF |

### 1.3 Employment

| # | Document | Mandatory | Format |
|---|---|---|---|
| 13 | ⚠ Signed offer letter | Yes | PDF |
| 14 | ⚠ Signed employment contract / appointment letter | Yes | PDF |
| 15 | ⚠ Signed Code of Conduct | Yes | PDF |
| 16 | ⚠ Signed POSH Policy acknowledgement | Yes (all staff) | PDF |
| 17 | ⚠ Signed Child Safeguarding Policy acknowledgement | Yes for any role with child contact | PDF |
| 18 | ⚠ Signed Confidentiality / NDA | Yes | PDF |
| 19 | ⚠ Signed Conflict of Interest declaration | Yes | PDF |
| 20 | Signed Anti-Bribery & Anti-Corruption acknowledgement | Yes | PDF |
| 21 | Signed Whistleblower Policy acknowledgement | Yes | PDF |
| 22 | Signed IT Acceptable Use Policy | Yes | PDF |
| 23 | Signed Social Media Policy | Yes | PDF |
| 24 | Emergency contact form (next of kin, blood group, allergies) | Yes | PDF |
| 25 | Nomination form (gratuity, PF) | Yes for paid staff | PDF |

### 1.4 Health & safety

| # | Document | Mandatory | Format |
|---|---|---|---|
| 26 | Self-declaration of fitness | Yes | PDF |
| 27 | Vaccination records (COVID, TT, Hep-B for healthcare-adjacent roles) | Recommended | PDF |
| 28 | Health insurance enrollment form | Yes for paid staff | PDF |
| 29 | Driving license + vehicle RC + valid insurance | If using own vehicle for work | PDF |

### 1.5 Where they live in FieldFlow
- All onboarding documents attached to the user's profile under `users.documents JSONB` (encrypted at rest)
- Original signed copies in physical/secure cloud folder, link recorded in FieldFlow
- Retention: full duration of employment + 7 years after exit (statutory retention)

---

## 2. Ongoing — every team member, weekly/monthly

These are the recurring submissions that drive daily operations.

### 2.1 Field staff — daily

| # | Document/Submission | Cadence | Format | Where |
|---|---|---|---|---|
| 1 | Daily field report | Every working day before 7pm | WhatsApp message or app entry | `daily_reports` |
| 2 | Photo/video evidence | At least 1 per major activity | JPG/MP4 in WhatsApp | `daily_reports.attachment_url` |
| 3 | GPS/location stamp | Auto-captured | Lat/long | `daily_reports.location` |
| 4 | Beneficiary names contacted (or list reference) | Daily | Text or list | `daily_reports.custom_data` |
| 5 | Travel log (distance, mode) | If claiming reimbursement | App form | Finance module |
| 6 | Activity-specific data (numbers, indicators) | Daily | Structured | `project_deliverables` |

### 2.2 Field staff — weekly

| # | Document/Submission | Day | Format |
|---|---|---|---|
| 7 | Weekly plan for next week | Friday | App form |
| 8 | Issues escalation list | Friday | App / WhatsApp |
| 9 | Photo/voice testimonial of a beneficiary (rotating) | Weekly | JPG + audio |

### 2.3 Field staff — monthly

| # | Document/Submission | Day | Format |
|---|---|---|---|
| 10 | Monthly self-assessment | Last working day | App form |
| 11 | Expense claim with bills | By 5th of next month | PDF/image attachments |
| 12 | Attendance reconciliation (any discrepancy from daily_reports) | By 5th | Form |
| 13 | Achievements vs. monthly plan | Last day | App |

### 2.4 Program managers — weekly

| # | Document/Submission | Day | Format |
|---|---|---|---|
| 14 | Project status note | Monday | Auto-drafted from FieldFlow, manager edits |
| 15 | Risk register update | Monday | Structured entry |
| 16 | Approval log (advances, leaves, vendors signed off) | Friday | Auto from `audit_log` |
| 17 | Field-visit report (if visited field this week) | Friday | PDF + photos |

### 2.5 Program managers — monthly

| # | Document/Submission | Day | Format |
|---|---|---|---|
| 18 | Monthly progress report per project (donor-format aligned) | By 7th | PDF |
| 19 | Updated Action Plan (status of each cell) | By 5th | Auto in FieldFlow |
| 20 | Variance analysis (planned vs. actual, with reasons) | By 7th | PDF |
| 21 | Beneficiary list reconciliation | By 7th | Excel |
| 22 | Photo evidence pack (curated for donors) | By 10th | Folder |
| 23 | Compliance attestation (POSH, child safeguarding nil-incident or list) | Monthly | Signed form |

### 2.6 Finance team — daily/weekly/monthly

| # | Document/Submission | Cadence | Format |
|---|---|---|---|
| 24 | Daily cash position update | Daily | Spreadsheet/system |
| 25 | Bank reconciliation (FCRA + Local) | Weekly | PDF |
| 26 | Vendor payment vouchers | Per payment | PDF + bill |
| 27 | Salary disbursement statement | Monthly | PDF |
| 28 | Statutory deduction confirmations (PF, ESI, TDS) | Monthly | PDF |
| 29 | Donor-wise utilisation statement | Monthly | Excel |
| 30 | Petty cash log with bills | Weekly | PDF |

### 2.7 MEAL team — weekly/quarterly

| # | Document/Submission | Cadence | Format |
|---|---|---|---|
| 31 | Data quality audit (10% sample) | Weekly | Report |
| 32 | Indicator-data integrity check | Weekly | Report |
| 33 | Field verification visit log | Monthly | PDF |
| 34 | Beneficiary feedback summary | Monthly | PDF |
| 35 | Case studies (deep-dive) | At least 2 per quarter | PDF + photos |
| 36 | Theory-of-change evidence update | Quarterly | Document |

### 2.8 HR team — monthly

| # | Document/Submission | Cadence | Format |
|---|---|---|---|
| 37 | Attendance summary | Monthly | Excel |
| 38 | Leave records | Monthly | Excel |
| 39 | Joiner/leaver report | Monthly | PDF |
| 40 | Statutory filings (PF, ESI, professional tax) | Monthly | PDF |
| 41 | Training conducted log | Monthly | PDF |
| 42 | Grievance / POSH register update | Monthly | Confidential |

---

## 3. Project-level — required at project launch

For every new project (each donor-funded initiative), the project lead must lodge in FieldFlow:

### 3.1 Project initiation pack

| # | Document | Mandatory | Owner |
|---|---|---|---|
| 1 | Approved project proposal | Yes | PD |
| 2 | Signed grant agreement / MoU with donor | Yes | ED + Finance |
| 3 | Detailed budget (donor-approved) | Yes | Finance |
| 4 | Logframe / Theory of Change | Yes | MEAL |
| 5 | Annual Action Plan (Excel — upload to FieldFlow) | Yes | PM |
| 6 | Indicator definitions document | Yes | MEAL |
| 7 | Beneficiary inclusion/exclusion criteria | Yes | PM |
| 8 | Geographic scope document (villages, blocks, district) | Yes | PM |
| 9 | Government NOC / permissions (if required) | If applicable | Compliance |
| 10 | Partner agreement (if implementing with partners) | If applicable | ED |
| 11 | Risk assessment | Yes | PM |
| 12 | Communication & reporting calendar (donor-mandated) | Yes | PM |
| 13 | Branding guidelines (donor logos, attribution) | If applicable | PM |
| 14 | Project staff list with roles | Yes | HR |
| 15 | Procurement plan | If procurement >₹5L | Finance |

### 3.2 During implementation

| # | Document | Cadence |
|---|---|---|
| 16 | Monthly progress report | Monthly |
| 17 | Quarterly narrative report | Quarterly |
| 18 | Quarterly financial report | Quarterly |
| 19 | Annual report (technical + financial) | Annual |
| 20 | Mid-term review report | Mid-project |
| 21 | Donor visit minutes | Per visit |
| 22 | Steering committee minutes | Per meeting |
| 23 | Audit reports (project-specific) | Annual |

### 3.3 At project closure

| # | Document |
|---|---|
| 24 | Final narrative report |
| 25 | Final financial report + utilisation certificate |
| 26 | Asset transfer / disposal note |
| 27 | Beneficiary handover plan |
| 28 | Sustainability plan |
| 29 | Lessons-learned document |
| 30 | Statutory audit certificate (Form FC-4 if FCRA) |
| 31 | Donor satisfaction survey response |
| 32 | Archive of all evidence (photos, videos, testimonials) |

---

## 4. Beneficiary documentation

Every beneficiary touched must have a minimum data footprint — without it, the activity is unverifiable.

### 4.1 Required per beneficiary (one-time)

| # | Document | Mandatory |
|---|---|---|
| 1 | Name + parent/spouse name | Yes |
| 2 | Gender, age, social category (SC/ST/OBC/General) | Yes (disaggregation requirement) |
| 3 | Address (village, block, district) | Yes |
| 4 | Phone number | Yes (when collectable) |
| 5 | Signed/thumb-printed enrollment consent form | Yes |
| 6 | Aadhaar (masked, last 4 only) — **only if** scheme requires | If applicable |
| 7 | Photograph (only with explicit consent) | Optional |
| 8 | Disability status, vulnerability flags | If applicable |
| 9 | Household income bracket (if scheme-linked) | If applicable |
| 10 | Existing scheme enrollment (PMJAY, MGNREGA card, etc.) | If relevant |

**Critical:** If the beneficiary is under 18, parent/guardian signed consent is mandatory. The platform should refuse to register a minor without it.

### 4.2 Per interaction with beneficiary

| # | Document | Mandatory |
|---|---|---|
| 11 | Activity name + date + location | Yes |
| 12 | What was delivered (training, kit, service) | Yes |
| 13 | Quantity / duration | Yes |
| 14 | Beneficiary acknowledgement (signature, thumb, OTP, or WhatsApp confirmation) | Yes |
| 15 | Field staff who delivered | Yes |
| 16 | Photo of delivery (with consent) | Recommended |
| 17 | GPS stamp | Auto |

### 4.3 Beneficiary rights documents (must exist on file, surfaced on request)

| # | Document |
|---|---|
| 18 | Privacy notice (in local language) |
| 19 | Grievance redressal mechanism poster |
| 20 | Anti-fraud / anti-bribery commitment |
| 21 | Beneficiary list publicly displayed (community noticeboard photo) |
| 22 | Right-to-information process |
| 23 | Right-to-data-export / deletion procedure (under DPDP) |

---

## 5. Asset & inventory documentation

Anything purchased with grant funds must be tracked.

### 5.1 At acquisition

| # | Document |
|---|---|
| 1 | Approved purchase requisition |
| 2 | Quotations (minimum 3 above ₹10,000) |
| 3 | Comparative statement |
| 4 | Purchase order |
| 5 | Invoice + GST bill |
| 6 | Goods received note (GRN) |
| 7 | Asset tag photograph |
| 8 | Asset register entry |

### 5.2 During use

| # | Document |
|---|---|
| 9 | Asset assignment log (who has what) |
| 10 | Annual physical verification report |
| 11 | Maintenance log (vehicles, equipment) |
| 12 | Insurance documents (if insured) |

### 5.3 At disposal

| # | Document |
|---|---|
| 13 | Disposal approval (board / donor) |
| 14 | Disposal mode (sale / donation / scrap) with documentation |
| 15 | Sale proceeds receipt (if sold) |
| 16 | Donor notification of disposal |

---

## 6. Vendor & partner documentation

For every recurring vendor or implementation partner.

| # | Document |
|---|---|
| 1 | Vendor registration form |
| 2 | PAN + GSTIN + cancelled cheque |
| 3 | MSME certificate (if claiming MSME benefits) |
| 4 | Latest ITR / financial statement (for vendors >₹5L/year) |
| 5 | Conflict of interest declaration |
| 6 | Master service agreement / MoU |
| 7 | Insurance certificate (for service providers entering premises) |
| 8 | Annual vendor evaluation form |
| 9 | Per-engagement work order |
| 10 | Per-payment invoice + work-completion certificate |

---

## 7. Statutory & compliance documentation (org-level)

These are NGO-wide documents that must exist and be currently valid. The finance/compliance team owns them; FieldFlow surfaces them as the always-on compliance dashboard.

### 7.1 Registration & status
| # | Document | Validity |
|---|---|---|
| 1 | Society / Trust / Section 8 registration certificate | Permanent |
| 2 | 12A registration (income tax exemption) | Permanent (post-2021 — 5 year) |
| 3 | 80G registration (donor tax benefit) | 5 years (renewable) |
| 4 | FCRA registration certificate | 5 years (renewable) |
| 5 | NGO Darpan registration | Permanent |
| 6 | CSR-1 form (to receive CSR funds) | Permanent |
| 7 | GST registration (if turnover requires) | Permanent |
| 8 | PAN | Permanent |
| 9 | TAN | Permanent |
| 10 | PF/ESI establishment registration | Permanent |
| 11 | Professional Tax registration (state-wise) | Permanent |
| 12 | Shops & Establishments registration (state-wise) | Annual renewal |

### 7.2 Recurring filings
| # | Document | Cadence |
|---|---|---|
| 13 | ITR-7 (income tax return) | Annual |
| 14 | Form 10B / 10BB (audit report) | Annual |
| 15 | Form 9A / 10 (accumulation of income) | If applicable |
| 16 | FCRA quarterly return (Form FC-4) | Quarterly |
| 17 | FCRA annual return | Annual (Dec 31) |
| 18 | Society annual return (state-wise) | Annual |
| 19 | GST returns (GSTR-1, 3B) | Monthly/Quarterly |
| 20 | TDS returns (24Q, 26Q) | Quarterly |
| 21 | PF + ESI monthly returns | Monthly |
| 22 | Professional Tax returns | Monthly |
| 23 | Statutory audit report | Annual |
| 24 | Internal audit report | Half-yearly |
| 25 | Annual report (printed) | Annual |
| 26 | Annual budget (board-approved) | Annual |

### 7.3 Policies & governance docs (current versions on file)
| # | Document |
|---|---|
| 27 | Memorandum of Association / Trust Deed |
| 28 | Bye-laws / Rules & Regulations |
| 29 | HR Policy / Employee Handbook |
| 30 | Financial Policy & Procedures Manual |
| 31 | Procurement Policy |
| 32 | Travel Policy |
| 33 | POSH Policy + Internal Committee constitution |
| 34 | Child Safeguarding Policy |
| 35 | Anti-Bribery & Anti-Corruption Policy |
| 36 | Whistleblower Policy |
| 37 | Conflict of Interest Policy |
| 38 | Code of Conduct |
| 39 | Privacy Policy (DPDP-compliant) |
| 40 | Data Protection / IT Security Policy |
| 41 | Social Media Policy |
| 42 | Volunteer Policy |
| 43 | Donor Privacy & Acknowledgement Policy |
| 44 | Risk Management Policy |
| 45 | Reserves Policy |
| 46 | Records Retention Schedule |
| 47 | Delegation of Authority Matrix |
| 48 | Disaster Recovery / Business Continuity Plan |

### 7.4 Board governance
| # | Document |
|---|---|
| 49 | Current trustees list with PAN / Aadhaar / addresses |
| 50 | Board meeting minutes (all) — at least quarterly |
| 51 | Annual General Meeting minutes |
| 52 | Sub-committee constitutions (Audit, HR, Finance, POSH) |
| 53 | Conflict of Interest declarations from each trustee (annual) |
| 54 | Term-of-office records |
| 55 | Resolutions register |

---

## 8. Incident & exception documentation

When something goes wrong, paper-trail it immediately.

| # | Document | Trigger |
|---|---|---|
| 1 | Incident report (accident, injury, death) | Any safety incident |
| 2 | Safeguarding incident report | Any child/vulnerable adult safety concern |
| 3 | POSH complaint form | Any sexual harassment complaint |
| 4 | Grievance form | Any staff or beneficiary grievance |
| 5 | Whistleblower disclosure | Any whistleblower report |
| 6 | Fraud / theft incident report | Any suspected fraud |
| 7 | Data breach report | Any suspected data exposure (under DPDP, 72hr to DPB) |
| 8 | Media incident log | Any media coverage requiring response |
| 9 | Donor complaint log | Any donor formal complaint |
| 10 | Audit observation log | Any audit finding |
| 11 | Police complaint copy (FIR) | If reported to police |
| 12 | Insurance claim form | If insurance claim filed |

**Critical:** these go into a sealed folder. Access limited to ED + Chair + designated committee. FieldFlow's audit log records who accessed.

---

## 9. Volunteer documentation

For volunteers (unpaid), a lighter version of staff onboarding:

| # | Document | Mandatory |
|---|---|---|
| 1 | Volunteer agreement signed | Yes |
| 2 | ID proof | Yes |
| 3 | Emergency contact | Yes |
| 4 | Code of Conduct acknowledgement | Yes |
| 5 | POSH + Safeguarding policy acknowledgement | Yes |
| 6 | Volunteer activity log | Per engagement |
| 7 | Hours contributed | Monthly aggregate |
| 8 | Exit feedback | At exit |

---

## 10. What FieldFlow tracks vs. what stays in physical/external systems

| Document type | Lives in FieldFlow | Lives elsewhere |
|---|---|---|
| Daily field reports | ✅ Primary | — |
| Photos / videos / voice | ✅ Primary (cloud) | — |
| Beneficiary contact info | ✅ Primary | — |
| Action Plan | ✅ Primary | Excel backup |
| Audit logs | ✅ Primary | — |
| WhatsApp message history | ✅ Primary | — |
| Staff KYC docs | ✅ Reference link | Physical/HRMS |
| Signed policies | ✅ Reference link | Physical |
| Financial vouchers | Reference only | Tally / accounting system |
| Bank statements | — | Bank portal |
| Statutory filings | Status only | MCA / FCRA / IT portal |
| Board minutes | Reference link | Physical / secure cloud |
| Insurance / legal contracts | Reference link | Physical |
| Tax returns | Reference link | CA system |

The principle: FieldFlow tracks **operational** data; authoritative copies of legal/financial documents live in their respective systems with FieldFlow linking to them.

---

## 11. Onboarding to FieldFlow — staff document checklist

Before a new staff member can be added to FieldFlow as an active user, the following must be uploaded to their profile:

- [ ] Aadhaar (masked) — for identity verification
- [ ] Signed appointment letter — to establish employment
- [ ] Signed Code of Conduct — for accountability
- [ ] Signed POSH acknowledgement — legal requirement
- [ ] Signed Child Safeguarding (if field role) — legal requirement
- [ ] Signed NDA / Confidentiality — for data access
- [ ] Police verification or undertaking (if field role with children)
- [ ] Project assignment confirmation by Program Director
- [ ] Role / designation set in `users.designation`
- [ ] Reporting manager set in `users.manager_id`
- [ ] WhatsApp phone number set in `users.phone`
- [ ] Firebase login email set in `users.email`
- [ ] Training acknowledgement (FieldFlow user training completed)

Without these, the platform should refuse to provision the account.

---

## 12. Retention schedule (summary)

| Document category | Retention period | Why |
|---|---|---|
| Daily field reports | 7 years | Donor audit, tax |
| Audit logs | 7 years | Legal evidence |
| Financial vouchers | 8 years | Income tax + FCRA |
| Beneficiary consent | Lifetime of program + 7 years | Liability |
| Staff KYC | Employment + 7 years | Statutory |
| Staff exit documents | Permanent | Future reference |
| WhatsApp messages | 180 days (configurable) | DPDP minimisation |
| Voice transcripts | 30 days | DPDP minimisation |
| Incident reports | Permanent | Legal evidence |
| Board minutes | Permanent | Statutory |
| Statutory filings | Permanent | Statutory |
| Policy documents | Until superseded + 7 years | Reference |
| Project closure documents | 10 years | Donor + statutory |

These are conservative defaults; specific donors may demand longer (USAID requires 7 years post-final-payment; ECHO requires 5 years).

---

## 13. Document submission process

### How to submit
1. **Day-to-day operational documents** (daily reports, photos, expense claims) — via WhatsApp or FieldFlow app
2. **Onboarding / one-time documents** — emailed to HR, who uploads to FieldFlow profile
3. **Project documents** — uploaded by Program Manager to project workspace
4. **Statutory filings** — uploaded by Finance/Compliance to org-level workspace
5. **Incident reports** — sealed-envelope upload (encrypted, restricted access)

### Naming convention
All documents must be named:
`<YYYY-MM-DD>_<docType>_<projectOrStaffName>_<version>.<ext>`

Example: `2026-06-18_AppointmentLetter_PriyaKumari_v1.pdf`

### Approval workflow
- Daily reports: auto-approved (AI flags anomalies for review)
- Expense claims <₹5,000: line manager
- Expense claims ₹5,000–₹50,000: Program Director
- Expense claims >₹50,000: ED + Finance Controller
- Vendor onboarding: Finance Controller
- Staff onboarding: HR + reporting manager
- Project initiation: ED + Finance + relevant board sub-committee
- Incident reports: ED notified within 24 hours

---

## 14. Where this becomes audit-ready

When a donor or statutory audit lands, the platform should be able to produce within 24 hours:

1. List of all staff with KYC completeness score
2. List of all projects with documentation completeness score
3. List of all beneficiaries served with consent-on-file score
4. List of all financial transactions with voucher-on-file score
5. List of all assets with asset-tag-and-photo score
6. Compliance dashboard (all statutory items green)
7. All policy documents in current versions
8. All board minutes for the audit period
9. All incident reports for the audit period
10. Audit log of who-did-what-when

If any of these scores are below 100%, the audit will find gaps. The platform should surface those gaps in advance as a permanent "documentation health" dashboard for the ED.

---

## 15. Documentation health dashboard (proposed UI in FieldFlow)

The ED's landing page should include a "Documentation Health" widget showing:

```
DOCUMENTATION HEALTH                                     86%

✅ Staff KYC                  42/45 complete           93%
⚠ Beneficiary consent         1,247/1,608 on file     78%
✅ Asset tags & photos        287/290                  99%
✅ Vendor KYC                  18/19                    95%
⚠ Project closure docs        2/3 projects             67%
✅ Compliance filings          14/14 current           100%
✅ Board minutes                Q4 on file, Q1 pending  90%
✅ Policy documents            All current             100%
✅ Incident response           No open items          100%

[Drill in →]                                        Updated: today 09:30
```

This dashboard transforms "documentation" from a once-a-year audit panic into a continuous, observable signal.

---

*This is a living document. Annual review by the Audit Committee. Last updated: June 2026 · v1.0*

*For governance reporting needs (what management sees), refer to [GovernanceRequirements.md](./GovernanceRequirements.md).*
*For technical implementation, refer to [Technical.md](./Technical.md).*
