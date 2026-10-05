-- db/migrations/056_community_meeting.sql
--
-- Community Meeting — MIS > Community Meeting sub-tab. Ninth category,
-- built the same way as the redesigned Campaign (055_campaign_standalone.sql)
-- rather than the original seven beneficiary-linked categories: the source
-- sheet (Community Meeting.xlsx: Purpose of Meeting, Total No. of
-- Attendees, No. of Male, No. of Female, No. of Children, Date, Place) has
-- no UID/Name/Contact No. columns either, so this is another aggregate
-- EVENT record with no beneficiary link at all — no beneficiary_uid, no
-- beneficiary_type CHECK, no interaction with indirect_beneficiaries (047).

CREATE TABLE IF NOT EXISTS community_meeting (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose          TEXT         NOT NULL,   -- Purpose of Meeting
  total_attendees  INTEGER,
  male_count       INTEGER,
  female_count     INTEGER,
  children_count   INTEGER,
  meeting_date     DATE,
  place            TEXT,
  uploaded_by      TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_meeting_org ON community_meeting (org_id, created_at DESC);

-- Same re-upload-is-safe identity as campaign_upsert_key (055) — a meeting
-- is the same meeting if it shares a purpose, date, and place. A row
-- missing date or place always inserts fresh (NULL <> NULL in a unique
-- index) — same accepted gap as every sibling table.
CREATE UNIQUE INDEX IF NOT EXISTS community_meeting_upsert_key
  ON community_meeting (org_id, purpose, meeting_date, place);

ALTER TABLE community_meeting ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'community_meeting' AND policyname = 'community_meeting_org_isolation') THEN
    CREATE POLICY community_meeting_org_isolation ON community_meeting
      USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;
