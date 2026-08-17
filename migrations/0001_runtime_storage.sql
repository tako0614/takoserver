CREATE TABLE runtime_grant_keys (
  key_id TEXT PRIMARY KEY NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at_epoch_seconds INTEGER NOT NULL,
  revoked_at_epoch_seconds INTEGER,
  CHECK (length(key_id) BETWEEN 3 AND 128),
  CHECK (length(public_jwk) BETWEEN 1 AND 4096),
  CHECK (created_at_epoch_seconds >= 0),
  CHECK (revoked_at_epoch_seconds IS NULL OR revoked_at_epoch_seconds >= created_at_epoch_seconds)
);

CREATE INDEX runtime_grant_keys_active
  ON runtime_grant_keys (key_id)
  WHERE revoked_at_epoch_seconds IS NULL;

CREATE TABLE runtime_grant_replays (
  grant_id TEXT PRIMARY KEY NOT NULL,
  expires_at_epoch_seconds INTEGER NOT NULL,
  consumed_at_epoch_seconds INTEGER NOT NULL,
  CHECK (length(grant_id) BETWEEN 3 AND 256),
  CHECK (expires_at_epoch_seconds > consumed_at_epoch_seconds),
  CHECK (consumed_at_epoch_seconds >= 0)
);

CREATE INDEX runtime_grant_replays_expiry
  ON runtime_grant_replays (expires_at_epoch_seconds, grant_id);

CREATE TABLE runtime_resources (
  organization_id TEXT NOT NULL,
  security_domain_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  allowances_json TEXT NOT NULL,
  created_at_epoch_seconds INTEGER NOT NULL,
  PRIMARY KEY (security_domain_id, tenant_ref, resource_ref),
  UNIQUE (backend_id, native_id),
  CHECK (length(organization_id) BETWEEN 3 AND 128),
  CHECK (length(security_domain_id) BETWEEN 3 AND 128),
  CHECK (length(tenant_ref) BETWEEN 3 AND 128),
  CHECK (length(resource_ref) BETWEEN 3 AND 128),
  CHECK (length(reservation_id) BETWEEN 3 AND 128),
  CHECK (length(offering_id) BETWEEN 3 AND 128),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(backend_id) BETWEEN 3 AND 128),
  CHECK (length(native_id) BETWEEN 3 AND 512),
  CHECK (length(allowances_json) BETWEEN 2 AND 4096),
  CHECK (created_at_epoch_seconds >= 0)
);

CREATE INDEX runtime_resources_reservation
  ON runtime_resources (reservation_id, offering_id);
