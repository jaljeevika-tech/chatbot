-- db/migrations/072_location_geocodes.sql
--
-- Cache table for the Beneficiary Dashboard's location drill-down map (see
-- routes/beneficiary-dashboard.routes.js). Individual/Micro-Entrepreneur/
-- Collective registrations only ever collect place names (State/District/
-- Block/Village) — unlike `resources` (043_*.sql), they carry no lat/long
-- of their own — so plotting District/Block/Village as real map bubbles
-- (rather than the state-only bubbles STATE_COORDS already gives for free)
-- requires resolving those place names via an external geocoding lookup
-- (OpenStreetMap Nominatim — see lib/geocodeLocation.js).
--
-- Nominatim's usage policy caps lookups at 1 request/sec and disallows bulk
-- use, so this table exists to make sure any given place is only ever
-- geocoded once, not on every dashboard load. One row can represent a
-- District, Block, or Village-level place — whichever fields are set
-- (deeper fields left NULL) determines the granularity. `location_key`
-- normalizes State/District/Block/Village into one lookup key (case/
-- whitespace-insensitive, NULL-safe, Panchayat deliberately excluded — see
-- lib/geocodeLocation.js's header) so a location is recognized as "the
-- same" even when a NULL-vs-NULL comparison would otherwise make a plain
-- multi-column UNIQUE index treat every NULL-containing row as distinct.

CREATE TABLE IF NOT EXISTS location_geocodes (
  id             SERIAL PRIMARY KEY,
  state          TEXT,
  district       TEXT,
  block          TEXT,
  village        TEXT,
  location_key   TEXT GENERATED ALWAYS AS (
    lower(trim(
      coalesce(state, '') || '|' || coalesce(district, '') || '|' ||
      coalesce(block, '') || '|' || coalesce(village, '')
    ))
  ) STORED,
  latitude       DOUBLE PRECISION,
  longitude      DOUBLE PRECISION,
  -- 'pending' (not yet attempted), 'found' (latitude/longitude set), or
  -- 'not_found' (Nominatim returned no match — don't keep retrying it on
  -- every geocode run).
  geocode_status TEXT NOT NULL DEFAULT 'pending',
  geocoded_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS location_geocodes_key_idx ON location_geocodes (location_key);
