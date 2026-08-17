-- The prepaid wallet and the accounts that own it.
--
-- `ledger` is append-only and carries no balance column: every figure is
-- recomputed from the entries. The UNIQUE index is what makes each money
-- operation idempotent, so replaying a funding, capture, or release is a no-op
-- by construction rather than by a check the code has to remember.

CREATE TABLE ledger (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ref TEXT NOT NULL,
  settled_delta INTEGER NOT NULL,
  held_delta INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, type, ref),
  CHECK (type IN ('funding', 'hold', 'capture', 'release', 'usage_debit')),
  CHECK (length(org_id) BETWEEN 1 AND 128),
  CHECK (length(ref) BETWEEN 1 AND 256)
);

CREATE INDEX ledger_org ON ledger (org_id, created_at);

CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK (provider IN ('google', 'github'))
);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 128)
);

CREATE INDEX orgs_owner ON orgs (owner_principal_id);

-- Sessions and API keys are the same thing wearing different hats: a bearer
-- secret that resolves to a principal, optionally scoped to one organization.
-- Only the digest is stored, so the repository can never leak a usable
-- credential.
CREATE TABLE auth_tokens (
  secret_digest TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  org_id TEXT,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (kind IN ('session', 'api_key')),
  CHECK (length(secret_digest) = 71),
  CHECK (length(scopes_json) BETWEEN 2 AND 1024)
);

CREATE UNIQUE INDEX auth_tokens_id ON auth_tokens (id);
CREATE INDEX auth_tokens_org ON auth_tokens (org_id);
