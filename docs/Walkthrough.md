# FieldFlow Walkthrough

A guided tour of FieldFlow — from your first login through running real NGO operations. Read this end-to-end your first week. Refer back to specific sections as you go.

Each chapter is a self-contained exercise you can do in 5–15 minutes.

---

## Chapter 1 — Your first login

You'll have received a welcome message from your administrator with your phone number and a temporary password (or an SMS OTP link).

**Step 1.** Open the FieldFlow URL in your browser (or PWA on your phone). You'll see the login screen.

**Step 2.** Enter your phone number. Choose your sign-in method:
- **SMS OTP** — fastest if you have your phone in front of you
- **Password** — works on shared devices

**Step 3.** Once verified, you land on the **Overview** tab. The left sidebar shows every tab you have permission to see.

**Tip.** Your **role** determines what you see — managers see more than employees, admins see everything. If a tab is missing, your admin needs to grant access in Settings → Tab Permissions.

---

## Chapter 2 — Your dashboard at a glance

Here are the tabs in the left sidebar and what they're for:

| Tab | Purpose |
|---|---|
| **Overview** | Today's stats, recent reports, weekly trends |
| **Reports** | All field reports submitted in your org |
| **Media** | Photos attached to reports |
| **Impact** | Aggregate progress + per-project + per-activity breakdown |
| **ToC Analysis** | Theory-of-Change distribution across reports |
| **Analytics** | Worker performance, project performance |
| **Notebook** | Upload PDFs and chat with them (RAG) |
| **Action Plan** | Multi-project target/achieved grid with editing |
| **+ Quick Report** | Submit a field report from your phone using AI |
| **WhatsApp** | Flows, contacts, broadcasts, analytics |
| **Settings** | Org config, users, branding, permissions |

**Tip.** Click your avatar in the top-right to switch organisations (if you belong to more than one) or to sign out.

---

## Chapter 3 — Adding your team members

If you're an admin, this is the first thing to do. Without team members, only you can submit reports.

**Step 1.** Click **Settings** → **User Management**.

**Step 2.** Click **+ Add User**. Fill in:
- **Name** — full name as it should appear in reports
- **Phone** — international format, e.g. `+919876543210`
- **Role** — pick `manager` for team leads, `employee` for field staff
- **Manager** — pick the person they report to (optional)
- **Designation** — optional title like "Field Coordinator"
- **Projects** — pick the projects they work on (multi-select)
- **Password** — for sheet-login. They can also use SMS OTP.

**Step 3.** Click **Save**. The new user can now log in with their phone + password.

**Tip.** To assign someone to specific Action Plan activities, just type their first name or designation into the activity's "Responsibility" column when uploading the plan — the `My Focus` filter will surface only their rows for them.

---

## Chapter 4 — Setting up your first project

A "project" is an Excel-uploaded Action Plan with activities × locations × monthly targets. You can have many.

### 4.1 Download the template

**Step 1.** Click **Action Plan** in the sidebar.

**Step 2.** Click the **⚙ Manage** button (top-right) → **Download template**.

**Step 3.** Open the downloaded `action-plan-template.xlsx` in Excel. It has 3 sheets:

| Sheet | Fill with |
|---|---|
| **Plan Info** | Project name, year, locations |
| **Monthly Plan** | One row per activity + sub-rows per location, with monthly Target columns |
| **README** | Documentation, don't edit |

### 4.2 Fill in your data

In **Plan Info**:
- `Name` — e.g. `JJM Bihar 2026`
- `Year` — `2026`
- `Start Month` — `4` (April)
- `Locations` — comma-separated, e.g. `Patna, Gaya, Muzaffarpur, Bhagalpur`

In **Monthly Plan**, one row per activity with metadata + sub-rows for each location. Categories must be one of: `capacity`, `livelihood`, `enterprise`, `community`, `technology`.

### 4.3 Upload

**Step 1.** Click **⚙ Manage** → **Upload new plan**.

**Step 2.** Drag-drop your filled Excel file. The system parses it client-side and shows a preview: "Found X activities, Y locations".

**Step 3.** Click **Save**.

The new project now appears in the dropdown at the top of the Action Plan tab.

**Tip.** Re-uploading the same project name overwrites the previous activities. To version-track, change the year (e.g. `JJM Bihar 2027`).

---

## Chapter 5 — Tracking progress on the Action Plan

Once a plan is uploaded, you can edit any cell.

**Step 1.** Open the **Action Plan** tab. The big grid shows activities (rows) × locations × months (columns).

**Step 2.** Click any cell — it's a `target / achieved` pair. The numbers turn editable.
- Click the left number (target) to edit the planned value
- Click the right number (achieved) to edit the actual value
- **Tab** moves to the next field
- **Enter** moves to the next location, same column

**Step 3.** Add a note to any cell — hover the cell, click 💬, type why you're behind or ahead.

**Step 4.** Click **Quickfill** to bulk-update. Example: *"Set the achieved value of every cell where Location = Khagaria and Month = May to 30"*. The matching cells update in one batch.

**Tip.** The **Status panel** at the top tells you at a glance whether you're on track, slightly behind, or behind schedule for the year — with a "now" marker showing what you should have achieved by today's date.

The **Needs Attention** list (right side of the status panel) auto-surfaces the cells with the worst gaps. Click "Add note" to explain the situation.

---

## Chapter 6 — Submitting a field report

Field staff submit reports two ways:
- From the dashboard via **+ Quick Report**
- From their phone via WhatsApp (after a flow is set up)

### 6.1 Via Quick Report (dashboard)

**Step 1.** Click **+ Quick Report** in the sidebar.

**Step 2.** Type a sentence in any language: *"Today visited Khagaria, met 30 farmers, did training on pen culture."*

Or click the 🎙 mic icon and dictate. Pick your language from the dropdown (Hindi, English, Marathi, Tamil, Bengali).

**Step 3.** Click **Extract Fields**. AI parses your text into structured fields:
- Location: `Khagaria`
- Project: `Kosi Sahjivan`
- Area of Intervention: `training`
- Beneficiaries: `30`

**Step 4.** Review the fields. Edit anything that's wrong. Click **Save Report**.

**Step 5.** The report appears in the Reports tab. It's also counted in the Impact Dashboard.

### 6.2 Via WhatsApp (covered in Chapter 8 once a flow is configured)

---

## Chapter 7 — Setting up WhatsApp

This is a one-time setup. You'll need access to a Meta Business account.

### 7.1 Get your Meta credentials

**Step 1.** Go to [business.facebook.com](https://business.facebook.com) → **WhatsApp Manager**.

**Step 2.** Create or pick a WhatsApp Business Account. Note down:
- **Phone Number ID** (for inbound + outbound)
- **WABA ID** (your business account)
- **App Secret** (from your Meta App → Settings → Basic)
- **Permanent access token** (System User → Generate Token)

### 7.2 Configure FieldFlow

**Step 1.** In FieldFlow, go to **WhatsApp** → **Settings**.

**Step 2.** Paste:
- Phone Number ID
- Access Token (stored encrypted at rest in our DB)
- App Secret (used to verify webhook signatures)
- Webhook Verify Token — set a random string, you'll use it in Meta

**Step 3.** Save.

### 7.3 Register the webhook with Meta

**Step 1.** In Meta App → **WhatsApp** → **Configuration**.

**Step 2.** Set the **Callback URL** to:
```
https://chatbot-492915.el.r.appspot.com/api/wa/webhook
```

**Step 3.** Set the **Verify Token** to the same random string you used in FieldFlow.

**Step 4.** Click **Verify and Save**. Then subscribe to `messages` field.

**Tip.** If signature verification is failing, check the App Secret matches exactly (Meta shows it under App → Settings → Basic, you have to click "Show").

---

## Chapter 8 — Building your first WhatsApp flow

Now that WhatsApp is connected, you can build a flow that responds to inbound messages.

### 8.1 Open the flow builder

**Step 1.** Click **WhatsApp** → **Flows** → **+ New Flow** (or **+ Generate with AI** for a starter — see 8.4).

**Step 2.** Give it a name and 1–5 trigger keywords (lowercase, e.g. `start`, `hi`, `training`).

### 8.2 Add nodes

The flow builder is a visual canvas. Click **+ Add Node** to insert any of these:

| Node | When to use |
|---|---|
| `send_message` | Plain text reply |
| `wait_input` | Ask a question, save the answer to a variable |
| `send_buttons` | Up to 3 reply buttons |
| `send_list` | Up to 10 list options (with descriptions) |
| `condition` | Branch on a variable value |
| `set_field` | Save a value to a session variable |
| `update_contact` | Save a value globally (persists across flows) |
| `add_label` | Tag the contact (adds to a collection) |
| `remove_label` | Remove from a collection |
| `webhook` | Call an external API |
| `call_llm` | Ask Gemini something mid-flow |
| `llm_router` | Branch based on AI classification of free text |
| `random_split` | A/B test paths |
| `delay` | Pause N seconds |
| `human_handoff` | Escalate to a human agent |
| `enter_flow` | Hand off to another flow |
| `recap_confirm` | Summarise all collected answers, ask YES/EDIT |
| `end` | Send farewell and close |

Drag from a node's bottom handle to the top of another node to connect them. The visual graph lays out automatically.

### 8.3 Use variables in messages

Anywhere you have text (e.g. inside `send_message`), you can reference data the user has given you with `{{varname}}` syntax. Use the **Variables panel** at the bottom-right of the property editor — it lists every local variable in this flow plus every global contact field. Click a chip to insert it at your cursor.

- 🔵 **Local**: variables defined by `wait_input`/`send_buttons` etc. — exist only during this flow run
- 🟢 **Global**: written by `update_contact` or set on the contact at any point — persist forever and readable in any future flow as `{{contact.fieldname}}`

### 8.4 Simulate before publishing

**Step 1.** Click **▶ Simulate** in the flow builder header. A phone-frame popup opens.

**Step 2.** Click **Start** to begin the flow. Type replies as if you were a contact. Each step shows what the flow engine is doing.

**Step 3.** If something's wrong, fix the node, save, simulate again.

### 8.5 Publish

**Step 1.** Click **Save** in the flow header.

**Step 2.** Toggle the **Publish** switch.

The next inbound WhatsApp message that matches your trigger keywords (or that AI identifies as matching your flow's description) will start this flow.

### 8.6 Bonus: AI Flow Generator

If you don't want to build manually, click **+ Generate with AI**. Type what you want in plain English:

> Build a WASH baseline survey for fish farmers. Ask name, village, pond size, and main crop. Then thank them and end.

Gemini generates a complete flow JSON. Review it on the canvas, tweak as needed, save, publish.

---

## Chapter 9 — Sending a broadcast

A broadcast sends one message to many contacts at once.

**Step 1.** Click **WhatsApp** → **Broadcast**.

**Step 2.** Give it a name (e.g. *"May Health Camp Reminder"*).

**Step 3.** Pick the audience:
- **All opted-in contacts** — everyone
- A specific **collection** — see Chapter 10

**Step 4.** Type the message (max 1024 chars). The preview shows how it looks in WhatsApp.

**Step 5.** Click **Send**. Confirm the audience count in the dialog.

The system throttles delivery (~80 messages/sec) so it stays within Meta's rate limits. Track delivery status in **WhatsApp → Analytics → Recent Broadcasts**.

**Tip.** Broadcasts cap at 1000 recipients per send. For larger lists, split into multiple collections.

---

## Chapter 10 — Organising contacts into Collections

A Collection is just a tag applied to multiple contacts.

### 10.1 Create a collection by adding contacts

**Step 1.** Click **WhatsApp** → **Contacts**.

**Step 2.** Tick the checkbox on multiple rows.

**Step 3.** A purple bar appears with "Add to Collection" — click it.

**Step 4.** Type a collection name (e.g. `farmers-bihar`) or pick an existing one. Save.

### 10.2 Manage collections

**Step 1.** Click **WhatsApp** → **Collections**.

**Step 2.** Each collection appears as a card with its member count and last-activity date.

**Step 3.** Click a card to see members. From the drawer you can remove individual contacts or delete the whole collection (the contacts themselves are not deleted — just untagged).

### 10.3 Use collections in flows

Add an `add_label` node in your flow with the collection name. When the flow runs, the contact gets tagged. They'll appear in that collection automatically and can be targeted by future broadcasts.

---

## Chapter 11 — Live conversations & human handoff

Sometimes the bot can't handle a question. Either you set up `human_handoff` nodes in your flows, or an agent takes over manually.

### 11.1 The Conversations tab

**Step 1.** Click **WhatsApp** → **Conversations**.

**Step 2.** The left column shows every active or recent conversation, sorted by most recent. Filter pills at the top:
- **All** — every contact
- **👤 Mine** — contacts assigned to you
- **🙋 Needs Reply** — handoffs waiting for human
- **🤖 Bot** — active sessions with the bot
- **✅ Opt-in** — opted-in only

**Step 3.** Click any conversation. Right side shows the full message history.

### 11.2 Taking over from the bot

**Step 1.** In a conversation, click **Take Over**. The session moves to `handoff` status — the bot stops responding.

**Step 2.** Reply normally from the compose box at the bottom.

**Step 3.** AI suggests 3 reply candidates above the textarea. Click one to insert (you can still edit before sending).

**Step 4.** When you're done, click **Return to Bot**. The next inbound message starts a fresh flow.

**Tip.** If a flow uses `human_handoff` with `assign_to_users` set, those users get the conversation in their **Mine** filter automatically. Otherwise the conversation lands in the global Needs Reply queue.

---

## Chapter 12 — Tracking impact

The **Impact** tab is your one-stop view of how the whole org is doing.

### 12.1 Overview sub-tab

- **Hero metrics**: Active projects · Annual target · Achieved · Beneficiaries reached
- **Overall progress bar** with a "now" marker showing where you should be by today
- **Status badge**: On track / Slightly behind / Behind schedule

### 12.2 Projects sub-tab

- **Per-project progress** — list of every plan with its target/achieved/% and progress bar
- **By Category** — capacity, livelihood, enterprise, community, technology — combined across all projects, plus top 3 activity names per category
- **By Location** — combined totals per location across every project
- **By Activity** — every activity in every project, filterable by category

### 12.3 Field Data sub-tab

The Theory of Change analysis derived from your daily reports:
- **Outcome Indicators** — what changed
- **Theory of Change** — flow from activities to outputs to outcomes to impact
- **SDG Progress** — which Sustainable Development Goals your work contributes to
- **Logic Model** — inputs → activities → outputs → outcomes
- **Data Quality Scorecard** — how reliable your data is

---

## Chapter 13 — Generating reports for donors

When donors ask for a quarterly update, you don't write it by hand.

### 13.1 Self / Team / Project / Org / Impact reports

**Step 1.** Click **Overview** → **Generate Report** (or the **+ Generate** button on the Reports tab).

**Step 2.** Pick a report type:
- **Self** — individual staff member's activity
- **Team** — multiple staff under one manager
- **Project** — all activity for one project
- **Org** — entire org overview
- **Impact** — impact-focused narrative

**Step 3.** Pick filters: date range, project, location, who to include.

**Step 4.** Type a custom instruction if you want (e.g. *"Formal tone, 600 words, focus on women beneficiaries"*).

**Step 5.** Click **Generate**. Tokens stream in real-time. The full report appears in 30–60 seconds.

**Step 6.** Click **Download .docx** to save to disk, or **Save to Drive** to push it to your org's Google Drive folder.

### 13.2 Content Hub (broader content types)

For non-report content — donor letter, board deck, press release, blog post, newsletter — go to **Content Hub** and pick a content type. Same flow, same streaming AI.

### 13.3 Notebook (RAG over your own documents)

For deeper questions, upload your existing reports + policies as sources to **Notebook**:

**Step 1.** Click **Notebook** → **Add Source**. Drag-drop PDFs or paste URLs.

**Step 2.** Type a question. Gemini reads only the sources you added and answers with inline citations to page numbers.

**Step 3.** Click **Audio Overview** to get an AI-generated podcast-style audio. Or **Study Guide** for a PDF outline. Or **Slide Deck** for a PPTX.

---

## Chapter 14 — Daily admin tasks

What you'll do regularly (weekly/monthly):

| Cadence | Task |
|---|---|
| **Daily** | Review **Needs Attention** items in Action Plan; reply to **Mine** in Conversations |
| **Weekly** | Update achieved values in Action Plan for last week's work; check **Analytics** for dropped conversations |
| **Monthly** | Generate donor reports; check **Impact** trends; archive old plans |
| **Quarterly** | Upload new Action Plan if scope changed; sync HSM templates with Meta |
| **Yearly** | Renew Meta access tokens; review user list; rotate `ENCRYPTION_KEY` if compliance requires |

---

## Chapter 15 — Troubleshooting & tips

| Symptom | Likely cause / fix |
|---|---|
| "Tab missing from sidebar" | Your role doesn't have access. Ask your admin to grant it in Settings → Tab Permissions. |
| "I can edit cells but they don't save" | Check your network. If offline, edits go to localStorage but won't sync. Refresh once you're back online. |
| "Quick Report doesn't extract correctly" | The AI's confidence is low. Edit fields manually. Add more context (location + numbers + crop name) in your sentence. |
| "WhatsApp messages aren't arriving" | (1) Check **WhatsApp → Settings** — config marked Connected? (2) Check Meta dashboard — is the webhook URL still verified? (3) Check **Analytics → Dead Letter** for processing errors. |
| "Flow doesn't trigger" | Trigger keywords are case-insensitive but must match a whole word. Try the NLU fallback by giving the flow a `description` Gemini can match against. |
| "Bulk update timed out" | Indicators exceeding 5000 are capped. Chunk client-side. |
| "Delete plan accidentally" | Plans are soft-deleted for 30 days. Go to **⚙ Manage** → look for archived list (or hit `/api/action-plans/archived` directly) → restore. |
| "Token expired" | Sign out and sign back in. Firebase ID tokens expire after 1 hour but most clients auto-refresh — if yours doesn't, force-refresh. |

---

## Chapter 16 — Where to go next

After completing this walkthrough you should be able to:
- Add team members and assign roles
- Upload an Action Plan for a project
- Submit field reports both via dashboard and WhatsApp
- Build and publish a WhatsApp flow
- Send broadcasts to collections
- Hand off to a human agent when needed
- Read impact data across projects
- Generate donor reports

**Next reads:**
- [User Manual PDF](./FieldFlow_User_Manual.pdf) — exhaustive reference (every screen, every option)
- [API.md](./API.md) — all 140 endpoints, for developers
- [SDK.md](./SDK.md) — integration patterns + sample code

If you get stuck, every error response includes a **correlation ID** (`cid`). Pass it to support and they can find the exact request in logs.

Welcome to FieldFlow.
