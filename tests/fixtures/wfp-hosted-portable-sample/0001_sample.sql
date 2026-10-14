CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  body TEXT NOT NULL
);
CREATE INDEX posts_room ON posts(room_id, id);
CREATE TABLE attachments (id INTEGER PRIMARY KEY, object_key TEXT NOT NULL);
CREATE TABLE probes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE scheduled_receipts (
  run_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, slot)
);
