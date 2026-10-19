-- Synthetic Auth authority candidate fixture ONLY. Not migration0103, not a
-- registered/applied predecessor and not proof/enrollment/payer authority.
-- Minimal Principal/token/Org/RP shapes mirror the consumed local columns.
-- No protected financial migration or runtime migration catalogue is imported.
CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK (provider IN ('takos-id', 'google', 'github', 'shared-account'))
);

CREATE TABLE orgs (id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE org_memberships (org_id TEXT NOT NULL,principal_id TEXT NOT NULL,
  role TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,principal_id));
CREATE TABLE auth_tokens (
  secret_digest TEXT PRIMARY KEY NOT NULL,id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('session','api_key')),principal_id TEXT NOT NULL,
  org_id TEXT,name TEXT NOT NULL,scopes_json TEXT NOT NULL,created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,revoked_at TEXT,
  CHECK(length(secret_digest)=71),CHECK(length(scopes_json) BETWEEN 2 AND 1024)
);
-- Synthetic RP payload store: no credential, decrypt/issuer verification or
-- production RP implementation is supplied by this table.
CREATE TABLE shared_auth_sessions (
  digest TEXT PRIMARY KEY NOT NULL,account_id TEXT NOT NULL,principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,
  grant_checked_at INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL
);
