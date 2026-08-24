-- Durable, resumable Host operations. The original tf_operations table is a
-- released settled-operation ledger, so pending state is additive rather than
-- changing its closed state check in place.

CREATE TABLE tf_deferred_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  phase TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_query TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_json TEXT,
  fingerprint TEXT NOT NULL,
  replay_key TEXT NOT NULL UNIQUE,
  target_space TEXT NOT NULL,
  target_api_version TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_form_ref_json TEXT NOT NULL,
  accepted_uid TEXT,
  accepted_generation TEXT,
  accepted_revision TEXT,
  resource_uid TEXT NOT NULL,
  polls_remaining INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  terminal_json TEXT,
  committed_uid TEXT,
  created_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(principal_id) BETWEEN 1 AND 255),
  CHECK (operation IN ('apply', 'import', 'delete')),
  CHECK (phase IN ('pending', 'committing', 'succeeded', 'failed', 'cancelled')),
  CHECK (length(request_path) BETWEEN 1 AND 2048),
  CHECK (length(request_query) <= 4096),
  CHECK (length(request_headers_json) BETWEEN 2 AND 16384),
  CHECK (request_body_json IS NULL OR length(request_body_json) BETWEEN 2 AND 1048576),
  CHECK (length(fingerprint) BETWEEN 2 AND 8192),
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (length(target_form_ref_json) BETWEEN 2 AND 4096),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (polls_remaining >= 0),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (terminal_json IS NULL OR length(terminal_json) BETWEEN 2 AND 1048576),
  CHECK (updated_at >= 0),
  CHECK (expires_at >= 0),
  CHECK (
    (phase IN ('pending', 'committing') AND terminal_json IS NULL) OR
    (phase IN ('succeeded', 'failed', 'cancelled') AND terminal_json IS NOT NULL)
  )
);

CREATE INDEX tf_deferred_operations_owner
  ON tf_deferred_operations (tenant_id, principal_id, id);
CREATE INDEX tf_deferred_operations_expiry
  ON tf_deferred_operations (expires_at);
CREATE INDEX tf_deferred_operations_recovery
  ON tf_deferred_operations (phase, lease_until);

-- Definition-declared exclusive/claim holders are reserved before a provider
-- await. The canonical claim key is generic Form data; no Form-specific field
-- or provider identity is encoded in this schema.
CREATE TABLE tf_resource_claims (
  claim_key TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  holder_space TEXT NOT NULL,
  holder_api_version TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  holder_uid TEXT NOT NULL,
  owner_operation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (length(claim_key) BETWEEN 1 AND 1024),
  CHECK (length(holder_uid) BETWEEN 3 AND 128),
  CHECK (length(owner_operation_id) BETWEEN 3 AND 128),
  CHECK (state IN ('reserved', 'committed')),
  CHECK (
    (state = 'reserved' AND expires_at IS NOT NULL) OR
    (state = 'committed' AND expires_at IS NULL)
  ),
  CHECK (expires_at IS NULL OR expires_at >= 0),
  CHECK (updated_at >= 0)
);

CREATE INDEX tf_resource_claims_holder
  ON tf_resource_claims (
    tenant_id, holder_space, holder_api_version, holder_kind, holder_name, holder_uid
  );
CREATE INDEX tf_resource_claims_expiry
  ON tf_resource_claims (expires_at) WHERE expires_at IS NOT NULL;

-- A CHECK violation in this short-lived row aborts the surrounding D1/SQLite
-- batch. It turns a final re-read fence into an all-or-nothing commit guard.
CREATE TABLE tf_operation_commit_guards (
  token TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  CHECK (length(token) BETWEEN 3 AND 128)
);
