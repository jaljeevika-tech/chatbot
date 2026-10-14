-- db/migrations/091_wa_report_media.sql
--
-- Photos / videos / PDFs sent in a WhatsApp "Reporting" flow. Meta only gives a
-- media id (its download URL needs the org's token and the file is purged after
-- ~30 days), so lib/waReportSubmit.js downloads the bytes here. Links are
-- /api/wa/media/<id>: the first image goes in daily_reports.attachment_url, all
-- files in custom_data.attachments. The random UUID is the capability: <img>
-- tags can't send our auth header, so the route is public.

CREATE TABLE IF NOT EXISTS wa_report_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wa_report_media_org ON wa_report_media (org_id);
