-- Block Arena accounts, sessions and ranked matches
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id         TEXT UNIQUE,              -- app-scoped Facebook user id
  name          TEXT NOT NULL,
  pic           TEXT,
  rp            INTEGER NOT NULL DEFAULT 0,
  peak_rp       INTEGER NOT NULL DEFAULT 0,
  ranked_games  INTEGER NOT NULL DEFAULT 0,
  ranked_wins   INTEGER NOT NULL DEFAULT 0,
  profile       TEXT NOT NULL DEFAULT '{}', -- xp, best scores and other progress, as JSON
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_rp ON users (rp DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,           -- sha256 of the cookie token, never the token itself
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,             -- cpu | arena | online
  level        TEXT,
  size         INTEGER NOT NULL DEFAULT 2,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  place        INTEGER,
  delta        INTEGER
);
CREATE INDEX IF NOT EXISTS matches_user ON matches (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS deletions (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
