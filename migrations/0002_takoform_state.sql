-- Durable Takoform Host state.
--
-- The resource envelope is stored whole in `resource_json` because that
-- document is the wire contract; the surrounding columns exist only where
-- something is fenced, made unique, or swept. Adding a wire field therefore
-- needs no migration, while every column here earns its place.

CREATE TABLE tf_resources (
  tenant_id TEXT NOT NULL,
  space TEXT NOT NULL,
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  uid TEXT NOT NULL,
  generation TEXT NOT NULL,
  revision TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  native_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, space, api_version, kind, name),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(space) BETWEEN 1 AND 255),
  CHECK (length(uid) BETWEEN 3 AND 128),
  CHECK (length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (native_id IS NULL OR length(native_id) BETWEEN 1 AND 4096),
  CHECK (updated_at >= 0)
);

-- One native resource may back at most one address per tenant. Import conflict
-- is therefore a constraint violation rather than a check the code must
-- remember to perform.
CREATE UNIQUE INDEX tf_resources_native_claim
  ON tf_resources (tenant_id, native_id)
  WHERE native_id IS NOT NULL;

CREATE TABLE tf_prepares (
  tenant_id TEXT NOT NULL,
  prepare_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expected_generation TEXT,
  current_uid TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, prepare_digest),
  CHECK (
    substr(prepare_digest, 1, 7) = 'sha256:' AND
    length(prepare_digest) = 71 AND
    substr(prepare_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(fingerprint) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);

CREATE INDEX tf_prepares_expiry ON tf_prepares (expires_at);

CREATE TABLE tf_replays (
  replay_key TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  resource_json TEXT,
  bound_uid TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (status BETWEEN 100 AND 599),
  CHECK (resource_json IS NULL OR length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);

CREATE INDEX tf_replays_expiry ON tf_replays (expires_at);

-- Artifacts: metadata here, bytes in the object store under `art/<digest>`.
-- Content addressing deduplicates bytes across tenants; the hold rows below are
-- what actually grant a tenant access, so identical content never leaks.

CREATE TABLE tf_artifact_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(manifest_json) BETWEEN 2 AND 1048576),
  CHECK (
    substr(manifest_digest, 1, 7) = 'sha256:' AND
    length(manifest_digest) = 71 AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX tf_artifact_uploads_owner ON tf_artifact_uploads (tenant_id, principal_id);

CREATE TABLE tf_artifact_manifests (
  digest TEXT PRIMARY KEY NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(manifest_json) BETWEEN 2 AND 1048576)
);

CREATE TABLE tf_artifact_holds (
  tenant_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (tenant_id, digest, kind),
  CHECK (kind IN ('blob', 'manifest'))
);

CREATE TABLE tf_artifact_replays (
  replay_key TEXT PRIMARY KEY NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (status BETWEEN 100 AND 599),
  CHECK (expires_at >= 0)
);

CREATE INDEX tf_artifact_replays_expiry ON tf_artifact_replays (expires_at);

-- Settled operations. Every mutation records one, synchronous or not, so a
-- caller that asks about an operation id always gets an answer rather than a
-- 404 that only means "this Host never implemented operations".

CREATE TABLE tf_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  resource_json TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (state IN ('succeeded', 'failed')),
  CHECK (resource_json IS NULL OR length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);

CREATE INDEX tf_operations_tenant ON tf_operations (tenant_id, id);
CREATE INDEX tf_operations_expiry ON tf_operations (expires_at);
