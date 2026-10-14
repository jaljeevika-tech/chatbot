# WhatsApp form for field reports

`field-report.flow.json` is a WhatsApp Flow (WhatsApp's built-in form screen) built
from the "Field Report Collection" flow template: project, state, village, beneficiaries,
an **Activity type** drop-down (the template's 5 options) and a description.

Answer names match exactly what the report save step (`lib/waReportSubmit.js`) reads:
`project`, `state`, `location`, `beneficiaries`, `area_of_intervention`, `description`.
Activity type is saved in the report's `area_of_intervention` ("Area") column.
Drop-down answers are the option's title (e.g. "Training / Workshop"), the same text
the chat list step saved. To change the options, edit `data-source` and publish a new
version in WhatsApp Manager. `lib/waReportSubmit.check.mjs` fails if the form's
answer names drift from the save step.

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
- A form without an endpoint (like this one) can't load per-organisation lists such as
  project names. That's why Project is a typed field here, not a drop-down.
- The form's own photo/document pickers allow up to 10 files (100 MB total) per submission.
  We collect files in chat instead, as agreed.
- WhatsApp Forms are a Meta Cloud API feature; Glific connections don't send them.
