-- Owner-scoped SQLiteMigrationSet custody. No v1 artifact or Operation authority is reused.
CREATE TABLE tf_v2_migration_set_owners (
  resource_uid TEXT PRIMARY KEY REFERENCES tf_v2_resources(uid),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  manifest_bytes BLOB NOT NULL CHECK (length(manifest_bytes) <= 1048576),
  staged_operation_id TEXT NOT NULL,
  staged_lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging', 'verified')),
  observation_json TEXT,
  verified_operation_id TEXT,
  verified_lease_token TEXT,
  CHECK ((state = 'staging' AND observation_json IS NULL AND verified_operation_id IS NULL
    AND verified_lease_token IS NULL) OR
    (state = 'verified' AND observation_json IS NOT NULL AND verified_operation_id IS NOT NULL
    AND verified_lease_token IS NOT NULL))
);

CREATE TABLE tf_v2_migration_set_chunks (
  resource_uid TEXT NOT NULL REFERENCES tf_v2_migration_set_owners(resource_uid) ON DELETE CASCADE,
  file_index INTEGER NOT NULL CHECK (file_index BETWEEN 0 AND 511),
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 255),
  -- An empty file has one zero-byte sentinel, still fenced by its source read.
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 0 AND 65536),
  operation_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  PRIMARY KEY (resource_uid, file_index, chunk_index)
);

CREATE TABLE tf_v2_resource_references (
  target_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  referrer_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  PRIMARY KEY (target_uid, referrer_uid)
);
CREATE INDEX tf_v2_resource_references_referrer
  ON tf_v2_resource_references(referrer_uid, target_uid);

-- Insertion is one SQL mutation fenced by the current accepted Operation.
CREATE TRIGGER tf_v2_migration_set_owner_insert_guard
BEFORE INSERT ON tf_v2_migration_set_owners
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE r.uid = NEW.resource_uid AND r.busy_operation = op.id AND r.last_operation = op.id
    AND r.generation = op.generation AND r.deleted_at IS NULL
    AND r.backend_id = op.backend_id AND r.target_key = op.target_key
    AND op.id = NEW.staged_operation_id AND op.action IN ('create', 'update')
    AND op.status = 'reconciling' AND op.lease_token = NEW.staged_lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_migration_set_owner_writer_fenced');
END;

CREATE TRIGGER tf_v2_migration_set_chunk_insert_guard
BEFORE INSERT ON tf_v2_migration_set_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE r.uid = NEW.resource_uid AND r.busy_operation = op.id AND r.last_operation = op.id
    AND r.generation = op.generation AND r.deleted_at IS NULL
    AND r.backend_id = op.backend_id AND r.target_key = op.target_key
    AND op.id = NEW.operation_id AND op.action IN ('create', 'update')
    AND op.status = 'reconciling' AND op.lease_token = NEW.lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_migration_set_chunk_writer_fenced');
END;

CREATE TRIGGER tf_v2_migration_set_chunk_immutable
BEFORE UPDATE ON tf_v2_migration_set_chunks
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_migration_set_chunk_immutable');
END;

CREATE TRIGGER tf_v2_migration_set_owner_update_guard
BEFORE UPDATE ON tf_v2_migration_set_owners
WHEN OLD.state <> 'staging' OR NEW.state <> 'verified' OR
  NEW.resource_uid IS NOT OLD.resource_uid OR
  NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR
  NEW.manifest_bytes IS NOT OLD.manifest_bytes OR
  NEW.staged_operation_id IS NOT OLD.staged_operation_id OR
  NEW.staged_lease_token IS NOT OLD.staged_lease_token OR
  NOT EXISTS (
    SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
    WHERE r.uid = NEW.resource_uid AND r.busy_operation = op.id AND r.last_operation = op.id
      AND r.generation = op.generation AND r.deleted_at IS NULL
      AND r.backend_id = op.backend_id AND r.target_key = op.target_key
      AND op.id = NEW.verified_operation_id AND op.action IN ('create', 'update')
      AND op.status = 'reconciling' AND op.lease_token = NEW.verified_lease_token
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_migration_set_owner_update_fenced');
END;

CREATE TRIGGER tf_v2_resource_reference_insert_guard
BEFORE INSERT ON tf_v2_resource_references
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_resources target JOIN tf_v2_resources referrer
    ON referrer.uid = NEW.referrer_uid
  WHERE target.uid = NEW.target_uid AND target.deleted_at IS NULL
    AND target.busy_operation IS NULL AND target.phase = 'idle'
    AND target.observed_generation > 0 AND referrer.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_resource_reference_unavailable');
END;

-- Terminal failed admission cannot leave unbounded partial staged bytes behind.
CREATE TRIGGER tf_v2_migration_set_failed_stage_gc
AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status = 'failed' AND OLD.status <> 'failed'
  AND NEW.action IN ('create', 'update')
BEGIN
  DELETE FROM tf_v2_migration_set_owners
  WHERE resource_uid = NEW.resource_uid AND state = 'staging';
END;
