-- SYNTHETIC ROOT FIXTURE ONLY; not adopted Auth103.
CREATE TABLE shared_auth_sessions (
  digest TEXT PRIMARY KEY NOT NULL,account_id TEXT NOT NULL,principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,
  grant_checked_at INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL
);
