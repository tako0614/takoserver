-- Provider execution crosses an external side-effect boundary. Persist the
-- exact logical intent before entering that boundary, then persist the
-- sanitized receipt before the Host commits any logical state. A retry uses
-- the same operation id and receipt; the final D1/SQLite batch consumes the
-- receipt together with the Deployment, Resource, replay, claims, and
-- Operation rows.

CREATE TABLE tf_provider_mutation_sagas (
  operation_id TEXT PRIMARY KEY NOT NULL,
  replay_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  target_space TEXT NOT NULL,
  target_api_version TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  accepted_uid TEXT,
  accepted_generation TEXT,
  accepted_revision TEXT,
  phase TEXT NOT NULL,
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(fingerprint) BETWEEN 2 AND 8192),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(target_space) BETWEEN 1 AND 128),
  CHECK (length(target_api_version) BETWEEN 1 AND 255),
  CHECK (length(target_kind) BETWEEN 1 AND 128),
  CHECK (length(target_name) BETWEEN 1 AND 128),
  CHECK (
    (accepted_uid IS NULL AND accepted_generation IS NULL AND accepted_revision IS NULL) OR
    (accepted_uid IS NOT NULL AND accepted_generation IS NOT NULL AND accepted_revision IS NOT NULL)
  ),
  CHECK (phase IN ('planned', 'executed')),
  CHECK (
    (phase = 'planned' AND receipt_json IS NULL) OR
    (phase = 'executed' AND receipt_json IS NOT NULL AND length(receipt_json) BETWEEN 2 AND 1048576)
  ),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (phase = 'planned' AND expires_at IS NOT NULL AND expires_at >= updated_at) OR
    (phase = 'executed' AND expires_at IS NULL)
  )
);

CREATE INDEX tf_provider_mutation_sagas_expiry
  ON tf_provider_mutation_sagas (expires_at) WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX tf_provider_mutation_sagas_target
  ON tf_provider_mutation_sagas (
    tenant_id, target_space, target_api_version, target_kind, target_name
  );
