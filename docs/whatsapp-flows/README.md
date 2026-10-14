# WhatsApp form for field reports

`field-report.flow.json` is a WhatsApp Flow (WhatsApp's built-in form screen) that
mirrors the Glific reporting flow "FieldFlow Daily Report" (`glific/fieldflow-report-flow.json`):
the same 6 questions in the same order, with Project, State and Activity type as
drop-downs carrying exactly the same options.

Answer names: `project`, `state`, `location`, `area_of_intervention`, `beneficiaries`,
`description`. Both save steps accept them: `lib/waReportSubmit.js` (Meta flow →
dashboard) reads them as-is, and the Glific save step (`routes/whatsapp.routes.js`)
accepts `area_of_intervention` in place of its `area`. Activity type lands in the
report's "Area of Intervention" column. Drop-down answers are the option text
(e.g. "Community Mobilization"), the same text the Glific list saved. To change the
options, edit `data-source` (and the Glific flow) and publish a new version in WhatsApp
Manager. `lib/waReportSubmit.check.mjs` fails if the form's names or option lists drift
from the save step or the Glific flow.

Phone and name aren't form fields: the save step's webhook body supplies them as
`"phone": "{{contact.wa_id}}"` and `"name": "{{contact.name}}"`.

## Set up (once, in Meta WhatsApp Manager)

1. WhatsApp Manager → Account tools → Flows → Create Flow (no endpoint).
2. Paste `field-report.flow.json` into the editor, check the preview, then **Publish**.
   Until it is published you can still test it by setting the step's Version to "Draft".
3. Copy the Flow ID.

## Use it in a FieldFlow WhatsApp flow

Replace the chat questions in the Reporting flow with:

1. **WhatsApp Form** step: paste the Flow ID; first screen `REPORT`.
2. **Wait for Input** step: validation "Photos / videos / PDFs (several, then DONE)",
   save as e.g. `files`. Up to 10 files.
3. **Webhook Call** step to `/api/wa/reports/submit` with this body (files are attached automatically):
   ```json
   { "phone": "{{contact.wa_id}}", "name": "{{contact.name}}",
     "project": "{{project}}", "state": "{{state}}", "location": "{{location}}",
     "beneficiaries": "{{beneficiaries}}", "area_of_intervention": "{{area_of_intervention}}",
     "description": "{{description}}" }
   ```
   Don't copy the URL from the "Field Report Collection" template: its
   `/api/wa/webhook-submit` doesn't exist on the server.
4. **End** step.

## Limits worth knowing

- One screen holds up to 50 fields. A text box takes up to 80 characters by default,
  a long-text box up to 600. Field labels can be at most 20 characters.
- A form without an endpoint (like this one) can't load lists from the app, so the
  Project/State/Activity options are written into the form. A new project means editing
  the form and publishing a new version. Option titles can be at most 30 characters.
- The form's own photo/document pickers allow up to 10 files (100 MB total) per submission.
  We collect files in chat instead, as agreed.
- WhatsApp Forms are a Meta Cloud API feature; Glific connections don't send them.
