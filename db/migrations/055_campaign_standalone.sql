-- db/migrations/055_campaign_standalone.sql
--
-- Campaign — redesigned to NOT link to any beneficiary. The source sheet
-- changed shape entirely (Campaign Name, Total No. of Attendees, No. of
-- Male, No. of Female, No. of Children, Date, Place — no UID/Name/Contact
-- No. columns at all), confirming a campaign is an aggregate EVENT record
-- (attendee headcounts), not a per-beneficiary one like its seven siblings
-- (046/048/049/050/051/052/054). DROP + recreate rather than ALTER: the
-- 053_campaign.sql table is confirmed empty (never had real uploads — the
-- earlier client-side bug plus this immediate redesign meant nothing of
-- value was ever stored), and the shape change is total (every
-- beneficiary_* column goes away, four new headcount columns appear), so
-- there's nothing worth preserving through an ALTER path.
--
-- No beneficiary_uid means no CHECK on beneficiary_type either, and no
-- interaction with indirect_beneficiaries (047) — Campaign no longer mints
-- or looks up Indirect Beneficiaries. See routes/campaign.routes.js's
-- rewritten header for what replaced the UID-resolution logic.

DROP TABLE IF EXISTS campaign;

CREATE TABLE campaign (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_name    TEXT         NOT NULL,
  total_attendees  INTEGER,
  male_count       INTEGER,
  female_count     INTEGER,
  children_count   INTEGER,
  campaign_date    DATE,
  place            TEXT,
  uploaded_by      TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaign_org ON campaign (org_id, created_at DESC);

-- Identity for re-upload safety: an event is the same event if it shares a
-- name, date, and place — no beneficiary to key on anymore, so this is the
-- closest equivalent to the beneficiary+topic+date key the other
-- categories use. A row missing date or place always inserts fresh (NULL
-- <> NULL in a unique index) — same accepted gap as the sibling tables.
CREATE UNIQUE INDEX campaign_upsert_key
  ON campaign (org_id, campaign_name, campaign_date, place);

ALTER TABLE campaign ENABLE ROW LEVEL SECURITY;
CREATE POLICY campaign_org_isolation ON campaign
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
