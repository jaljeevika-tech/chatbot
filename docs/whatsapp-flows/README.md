# WhatsApp form for field reports

`field-report.flow.json` is a WhatsApp Flow (WhatsApp's built-in form screen). It
asks for the same six answers the chat questions used to ask, under the same names,
so the report-save step (`lib/waReportSubmit.js`) gets the same data as before.

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
3. **Webhook Call** step to `/api/wa/reports/submit`, body as before
   (`{"project": "{{project}}", "state": "{{state}}", ...}`). Files are attached automatically.
4. **End** step.

## Limits worth knowing

- One screen holds up to 50 fields. A text box takes up to 80 characters by default,
  a long-text box up to 600. Field labels can be at most 20 characters.
- A form without an endpoint (like this one) can't load per-organisation lists such as
  project names. That's why Project is a typed field here, not a drop-down.
- The form's own photo/document pickers allow up to 10 files (100 MB total) per submission.
  We collect files in chat instead, as agreed.
- WhatsApp Forms are a Meta Cloud API feature; Glific connections don't send them.
