-- Friends (from Facebook's "App friends" permission) and shareable cards
CREATE TABLE IF NOT EXISTS friendships (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  friend_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- rank | match | achievement
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  png         BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id, created_at DESC);
