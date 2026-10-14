-- In-game friends: requests sent with a friend code or from an online room (the worker also creates this on first use).
-- Who's online and room invites live in the Hub Durable Object, not in the database.
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_id);
