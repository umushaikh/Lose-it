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
