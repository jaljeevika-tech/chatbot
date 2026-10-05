# FieldFlow Content Style Guide

The single source of truth for **what words to use**, **how to say things**, and **how to format them** across the FieldFlow platform — the dashboard, the WhatsApp messages, the AI-generated reports, the emails, the documentation.

If two pieces of content disagree, this guide wins.

*Maintained by Product. Reviewed quarterly. Last updated: June 2026 · v1.0*

---

## 1. Voice & tone

FieldFlow is the calm, capable colleague at the back of the room who knows where every file is. We are:

- **Respectful** — every user, from board chair to first-day field worker, gets the same dignity in language.
- **Plain** — short words, short sentences. Read at class-8 level.
- **Specific** — numbers in context, not adjectives ("12 trainings completed" not "great progress").
- **Honest** — say what we know, say what we don't. Never overpromise.
- **Hopeful** — we believe in our users' work. Our tone reflects that, never cynical.

What we are **not**:
- Cute or playful in serious moments (incident reports, errors)
- Salesy or hype-y ("Game-changing," "Revolutionary," "Best-in-class")
- Patronising ("Don't worry, we'll handle the hard stuff for you")
- Bureaucratic ("As per the aforementioned policy")
- Tech-jargony in user-facing surfaces ("Webhook signature validation failed")

### Quick voice test
Read your text out loud. If you wouldn't say it that way to a colleague over chai, rewrite it.

---

## 2. The canonical term list

These are the **only** terms used in the product, docs, and AI output for these concepts.

| Concept | Canonical term | Don't use |
|---|---|---|
| The people we serve | **beneficiaries** (formal) / **community members** (warm) | participants, recipients, users, end-users, targets |
| A person reachable via WhatsApp | **contact** | lead, user, subscriber |
| A tagged group of contacts | **collection** | list, audience, segment, group |
| The household-level data unit | **household** | family, HH, dwelling |
| Field staff who collect data | **field worker** (general) / **field officer** (mid-level) / **programme manager** (senior) | staff (alone), employee, agent, surveyor |
| The annual delivery matrix | **action plan** | workplan, project plan, MEAL plan |
| A row in the action plan | **activity** | task, intervention, line item |
| An outcome we measure | **indicator** | KPI, metric, measure |
| What was delivered | **output** | deliverable, achievement |
| What changed as a result | **outcome** | impact (reserve for the highest level), benefit |
| Long-term societal change | **impact** | difference, effect |
| A discrete field event | **report** (one) / **field report** (if disambiguation needed) | submission, entry, log, observation |
| An AI-generated narrative | **generated report** / **draft** | output, result |
| A WhatsApp conversation script | **flow** | bot, chatbot, dialogue, journey |
| A one-time WA mass message | **broadcast** | blast, campaign, push |
| The FieldFlow platform itself | **FieldFlow** (one word, capital F, capital F) | Field Flow, fieldflow, FF |
| The platform's AI brain | **the assistant** | the AI, the bot, FieldFlow AI |
| The login | **sign in** (verb) / **sign-in** (noun) | log in, login (verb) |
| The logout | **sign out** | log out, logout (verb) |
| An organisation on the platform | **organisation** (UK spelling — we serve India) | org (long form), tenant, account |
| A user's role | **role** | permission, level, tier |
| Funder of an NGO | **donor** | funder (acceptable in formal), sponsor, partner |
| The action plan accountability holder | **responsibility holder** / **owner** | assignee, person-in-charge |

**Capitalisation:** product feature names are Title Case in headings (Action Plan, Quick Report) and lowercase in running prose ("upload an action plan"). Tab labels are sentence case ("Action plan").

---

## 3. Numbers & dates

| Item | Style |
|---|---|
| Currency | **₹1,234** (no decimal for whole rupees). For large: ₹1.2 crore / ₹45 lakh — never ₹1,20,00,000 in user-facing text |
| Date (formal) | **18 June 2026** (DD Month YYYY — never US "June 18, 2026") |
| Date (compact / table) | **18 Jun 2026** |
| Date in WhatsApp | **18 June** (drop year unless ambiguous) |
| Time | **3:30pm** (lowercase am/pm, no period) |
| Date range | **18–25 June 2026** (en-dash, no spaces) |
| Quantities | Spell out **one through nine**, numerals for **10+**. Exception: tables always use numerals. |
| Percentages | **67%** (no space). For specific decimals: **67.3%** (one decimal). |
| Large numbers | **1,200** (comma) below 1 lakh. **1.2 lakh / 1.2 crore** beyond. |
| Indicator targets | **240 of 1,200** (not "240/1200") |
| Phone numbers | **+91 98765 43210** (with spaces). In WhatsApp logs, mask to **+91 ***** 3210**. |
| Mobile-only phone (Indian) | **9876543210** (no country code, no spaces) — for inline forms |

---

## 4. Grammar & punctuation

- **Oxford comma:** yes. "Khagaria, Saharsa, and Madhubani."
- **Spelling:** UK English. "organise, recognise, behaviour, colour, programme." Exception: "program" when referring to software programs.
- **Quotes:** double "quotes" for speech, single 'quotes' inside.
- **Em-dashes:** use with NO spaces — like this. (Some teams use spaces; we don't.)
- **En-dashes:** for ranges (18–25), not hyphens.
- **Hyphens:** "field-officer training" (compound adjective before a noun). "training of field officers" (no hyphen).
- **Apostrophes:** "the worker's report" (singular possessive). "the workers' reports" (plural possessive).
- **Sentence length:** target ≤20 words. If you wrote 30, split it.
- **One thought per sentence.** If you used "and" or "however" mid-sentence, consider a full stop.

---

## 5. Buttons, labels, microcopy

### Button copy
Use **verbs in imperative form**. The button says what the user is about to do, not what the system will do.

| ✅ Use | ❌ Don't use |
|---|---|
| Save changes | Save / OK |
| Send report | Submit / Confirm |
| Generate report | Run / Process |
| Sign in | Login |
| Add team member | Create user |
| Upload action plan | Choose file |
| Cancel | Close / Dismiss |
| Discard draft | No (in a dialog) |

### Confirmation dialogs
Format: **{action verb} {object}?** in the title. Body explains consequence. Buttons are **{verb}** and **Cancel**.

```
Title:    Delete Khagaria action plan?
Body:     This will move the plan to archive. You can restore it from
          Manage → Archived plans within 30 days.
Buttons:  [Archive plan] [Cancel]
```

### Tooltips
Maximum **two sentences**. First sentence = what this is. Second sentence (optional) = how to use it.

✅ "Annual target — the total quantity this activity aims to achieve in the financial year. Updated only by admins."
❌ "Annual Target"

### Form labels
Sentence case. No colons. Use full words, not abbreviations.

✅ "Phone number"
❌ "Phone Number:" or "Phone No."

### Placeholders
Show **format**, not example data.

✅ "10 digits, no country code"
❌ "9876543210" (looks like a real number — confusing)

### Validation messages
Tell the user **what to do**, not what they did wrong.

✅ "Phone number needs 10 digits without country code."
❌ "Invalid phone number format."

---

## 6. WhatsApp-specific style

WhatsApp is the most-read channel. Every word matters.

- **Greeting:** "Namaste 🙏" (default Hindi-speaking regions). "Hello 👋" (default English). "Pranam" (formal, older audience). Never "Hi" or "Hey."
- **Sign-off:** "Thank you 🙏" or "Reply if you need anything else." Never "Have a great day!" or "Cheers."
- **Length:** under 200 characters for routine messages. Under 600 for instructional. Anything longer becomes a list with bullets.
- **Emojis:** sparingly, for warmth and visual anchor. One at start, maybe one at end. Never decorative-only.
- **Personalisation:** use `{{contact.name}} ji` for Hindi-region contacts. Use `{{contact.name}}` (no honorific) for English-speakers.
- **Calls to action:** ONE per message. "Reply YES to confirm" — not three things to do.
- **Avoid jargon:** "registered" → "added you to our list." "submission" → "what you sent."

---

## 7. AI-generated content style

When the AI drafts (reports, emails, replies), it MUST:

- **Lead with a number.** "47 women joined the SHG in June…" (not "We saw an increase in SHG membership in June…")
- **Use past tense for completed work.** Never present continuous ("we are conducting…").
- **Cite sources.** Every figure must trace back to a daily_report or DB field. Use `⟨MISSING⟩` when data is absent (defined below).
- **Refuse to fabricate.** If asked to "make the numbers look better," reply: "I can show the actual numbers in different framings, but I can't change what was reported. Let me show three honest framings."
- **No filler phrases.** No "It is important to note that…" / "In this report we will discuss…" / "As you can see from the data…"
- **Cite people by role, not name** in donor-facing reports. "A field officer in Khagaria reported…" not "Priya Kumari reported…" — unless the named individual gave explicit consent for attribution.

### The MISSING marker
When data is absent, use this **exact format**:

`⟨MISSING: <one-line description of what is needed>⟩`

Examples:
- `⟨MISSING: gender disaggregation for May training⟩`
- `⟨MISSING: photographs from Saharsa visit⟩`

This forces a human edit pass before sending to a donor. Do NOT pad or guess.

---

## 8. Empty states

Every empty state has three parts:

1. **Title** — one short sentence describing the current state ("No reports yet").
2. **Body** — one or two sentences explaining what populates this list and why it's empty.
3. **Action** — one clear next step ("Generate your first report") OR no action if the user is just supposed to wait.

✅
> **No reports yet**
> Your team can submit reports right from WhatsApp — no app to download. Share your WhatsApp business number and watch reports appear here.
> [See how it works]

❌
> **No data available.**

---

## 9. Error messages

Every error has three parts:

1. **What happened** — in plain words. "Couldn't reach the server."
2. **What to try** — one concrete next action. "Check your connection and try again."
3. **What if that fails** — reference ID or support contact.

Never show:
- HTTP status codes ("Error 500")
- Stack traces or technical jargon
- Generic "Something went wrong" without context
- Blame-shifting ("Bad request" — bad request from whom?)

See `src/i18n/errorCopy.ts` for the canonical error message library.

---

## 10. Inclusive language

- **Gender:** "they/them" as singular when gender is unknown. "Field worker," "field officer" (not "fieldman"). Avoid "manpower" → use "team" / "people."
- **Caste:** never reference caste publicly. Use "social category" in forms (SC/ST/OBC/General) only when statutorily required.
- **Disability:** "person with a disability" (person-first). Never "disabled person," "differently-abled," or "specially-abled."
- **Age:** "older adults" (not "elderly," "senior citizens" unless they self-identify).
- **Religion:** never assume. "Festival" is preferable to specific festival names unless contextually relevant.

---

## 11. Localisation principles

- **Hindi UI** is shipped as primary regional language. Marathi, Bengali, Tamil, Telugu, Odia follow.
- **WhatsApp messages** auto-detect language from the contact's first message, with manual override per contact.
- **Reports** generate in the language the user chose, but field-quote attributions keep the original language inline + translation in parentheses.

When translating:
- **Do not transliterate brand names.** "FieldFlow" stays as "FieldFlow" in Devanagari rendering.
- **Numbers stay in Western Arabic digits** (1, 2, 3) even in Hindi text, unless the org explicitly opts for Devanagari numerals.
- **Cultural specificity beats literal translation.** "Beneficiary" → "लाभार्थी" feels bureaucratic; for warm channels prefer "साथी" or context-specific words like "दीदी" / "किसान भाई."

---

## 12. Document headers (in the platform)

Every report / generated doc must have:

- **Title** — clear, no marketing fluff.
- **Period covered** — date range.
- **Generated by** — user name + timestamp.
- **Source disclosure** — "Based on 247 field reports between 1 April and 30 June 2026. Some figures pending verification."
- **Footer** — "Generated by FieldFlow · <date> · cid: <id>"

---

## 13. Things we explicitly DON'T do

- **No exclamation marks** outside genuine celebration (a worker hitting a milestone). Never in error messages, never in transactional confirmations.
- **No ALL CAPS** for emphasis. Bold or italics instead.
- **No "Click here"** links. The link text describes what the link goes to.
- **No "the user"** in user-facing copy. Address them as "you."
- **No "etc."** — finish the list or stop the list. "And more" if truly open-ended.
- **No "obviously," "simply," "just,"** — minimising words that shame the reader.
- **No emoji in headlines** of formal reports. Allowed in WhatsApp + dashboard cards.
- **No referring to AI as "magical"** — it's a tool, not magic.

---

## 14. Approval workflow for new copy

1. Anyone can draft copy.
2. Copy that ships externally (donor reports, public-facing communications, marketing) needs a second human reviewer.
3. AI-generated copy that goes external needs a designated human approver per the org's settings.
4. Microcopy changes (buttons, error messages) need product owner review before deploy.

---

## 15. Style guide changelog

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-06-18 | Initial. Established canonical term list, voice rules, WhatsApp style, AI output rules. |

---

*Style is the substance. Read the doc, apply the rules, push back when something feels wrong — this guide changes through use.*
