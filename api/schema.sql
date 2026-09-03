-- Shared state for a group of friends. Everything is scoped to a group; there
-- are no global users, and a member exists only inside one group.

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);

-- One row per member per day, overwritten in place. This is what makes posting
-- frequency free: logging eight times a day rewrites the same row eight times
-- rather than adding eight rows, so storage tracks people x days, not activity.
CREATE TABLE IF NOT EXISTS days (
  group_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  eaten       INTEGER NOT NULL DEFAULT 0,
  budget      INTEGER NOT NULL DEFAULT 0,
  exercise    INTEGER NOT NULL DEFAULT 0,
  protein     INTEGER NOT NULL DEFAULT 0,
  carbs       INTEGER NOT NULL DEFAULT 0,
  fat         INTEGER NOT NULL DEFAULT 0,
  entries     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id, date)
);

-- The feed. Deliberately not one row per logged food: a group of ten would
-- produce eighty of those a day and nobody would read any of them. Only things
-- worth looking at land here.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT,
  photo_key   TEXT,
  calories    INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id, created_at);

-- Tracks the byte size of every photo actually written to R2, independent of
-- whether the event that references it ever gets posted. This is what a
-- billing-safety ceiling checks against before accepting a new upload: R2 is
-- the one piece of this deployment that can be charged for going over its
-- free tier (Workers and D1 stay on the free plan and just reject over-quota
-- requests instead), so it is the one worth guarding in code rather than
-- trusting Cloudflare's own alerting to catch after the fact.
CREATE TABLE IF NOT EXISTS photo_sizes (
  photo_key   TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- One row per shared meal (a whole breakfast/lunch/dinner/snacks, not a
-- single food), keyed to the event that carries it in the feed. A separate
-- table rather than new columns on events, so this stays a plain additive
-- CREATE TABLE IF NOT EXISTS against a database that already exists in the
-- wild - SQLite/D1 can't add a column to an existing table idempotently the
-- way it can create one.
--
-- items_json holds the individual foods that made up the meal (name,
-- serving, qty, full macros per item) so the group can see what was
-- actually eaten, not just a total; the other columns are that list's sums,
-- kept alongside it so the board can show a total without re-parsing JSON
-- for every row. This is a real step up in what a group sees about each
-- other beyond a day's totals, and only happens when a member deliberately
-- taps Share; nothing here is automatic.
CREATE TABLE IF NOT EXISTS shared_meals (
  event_id    TEXT PRIMARY KEY,
  meal_key    TEXT NOT NULL,
  calories    INTEGER NOT NULL DEFAULT 0,
  protein     REAL NOT NULL DEFAULT 0,
  carbs       REAL NOT NULL DEFAULT 0,
  fat         REAL NOT NULL DEFAULT 0,
  fiber       REAL NOT NULL DEFAULT 0,
  sugar       REAL NOT NULL DEFAULT 0,
  sodium      REAL NOT NULL DEFAULT 0,
  items_json  TEXT NOT NULL DEFAULT '[]'
);

-- A picture and a short bio per member, shown on their profile. Separate
-- table rather than new columns on members, for the same reason as above:
-- a plain additive CREATE TABLE IF NOT EXISTS stays safe against a database
-- that already exists in the wild. avatar holds a single emoji chosen by the
-- member (or is empty, in which case the client falls back to their initials).
CREATE TABLE IF NOT EXISTS member_profiles (
  member_id   TEXT PRIMARY KEY,
  avatar      TEXT NOT NULL DEFAULT '',
  info        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- One row per member per day, overwritten in place just like `days` - this is
-- what makes a profile's "what they had today" section possible. Unlike
-- shared_meals (which only exists once someone deliberately taps Share on one
-- meal), this is written automatically alongside every day summary, so a
-- member's profile shows their actual logged foods without them doing
-- anything beyond logging. That is a real step past the rest of Friends'
-- opt-in model, and is deliberate - see README.
CREATE TABLE IF NOT EXISTS day_items (
  group_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  items_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id, date)
);
