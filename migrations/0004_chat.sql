-- Chat between friends (also created by the worker on first use); kept 30 days
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS messages_unseen ON messages (to_id, seen);
CREATE INDEX IF NOT EXISTS messages_age ON messages (created_at);
