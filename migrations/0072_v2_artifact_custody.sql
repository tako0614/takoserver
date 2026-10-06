-- Additive Resource-owned custody for new immutable artifact Forms. Historical
-- SQLiteMigrationSet custody remains authoritative in 0071; no bytes are copied.
CREATE TABLE tf_v2_artifact_owners (
  resource_uid TEXT PRIMARY KEY REFERENCES tf_v2_resources(uid),
  form_url TEXT NOT NULL,
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

CREATE TABLE tf_v2_artifact_chunks (
  resource_uid TEXT NOT NULL REFERENCES tf_v2_artifact_owners(resource_uid) ON DELETE CASCADE,
  file_index INTEGER NOT NULL CHECK (file_index BETWEEN 0 AND 511),
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 255),
  -- One zero-byte sentinel represents an authorized and verified empty file.
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 0 AND 65536),
  operation_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  PRIMARY KEY (resource_uid, file_index, chunk_index)
);

CREATE TRIGGER tf_v2_artifact_owner_insert_guard
BEFORE INSERT ON tf_v2_artifact_owners
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE r.uid = NEW.resource_uid AND r.form_url = NEW.form_url
    AND r.busy_operation = op.id AND r.last_operation = op.id
    AND r.generation = op.generation AND r.deleted_at IS NULL
    AND r.backend_id = op.backend_id AND r.target_key = op.target_key
    AND op.id = NEW.staged_operation_id AND op.action IN ('create', 'update')
    AND op.status = 'reconciling' AND op.lease_token = NEW.staged_lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_owner_writer_fenced');
END;

CREATE TRIGGER tf_v2_artifact_chunk_insert_guard
BEFORE INSERT ON tf_v2_artifact_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_artifact_owners owner
  JOIN tf_v2_resources r ON r.uid = owner.resource_uid
  JOIN tf_v2_operations op ON op.resource_uid = r.uid
  WHERE owner.resource_uid = NEW.resource_uid AND owner.state = 'staging'
    AND owner.form_url = r.form_url AND r.busy_operation = op.id
    AND r.last_operation = op.id AND r.generation = op.generation
    AND r.deleted_at IS NULL AND r.backend_id = op.backend_id
    AND r.target_key = op.target_key AND op.id = NEW.operation_id
    AND op.action IN ('create', 'update') AND op.status = 'reconciling'
    AND op.lease_token = NEW.lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_chunk_writer_fenced');
END;

CREATE TRIGGER tf_v2_artifact_chunk_immutable
BEFORE UPDATE ON tf_v2_artifact_chunks
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_chunk_immutable');
END;

CREATE TRIGGER tf_v2_artifact_owner_update_guard
BEFORE UPDATE ON tf_v2_artifact_owners
WHEN OLD.state <> 'staging' OR NEW.state <> 'verified' OR
  NEW.resource_uid IS NOT OLD.resource_uid OR NEW.form_url IS NOT OLD.form_url OR
  NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR
  NEW.manifest_bytes IS NOT OLD.manifest_bytes OR
  NEW.staged_operation_id IS NOT OLD.staged_operation_id OR
  NEW.staged_lease_token IS NOT OLD.staged_lease_token OR
  NOT EXISTS (
    SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
    WHERE r.uid = NEW.resource_uid AND r.form_url = NEW.form_url
      AND r.busy_operation = op.id AND r.last_operation = op.id
      AND r.generation = op.generation AND r.deleted_at IS NULL
      AND r.backend_id = op.backend_id AND r.target_key = op.target_key
      AND op.id = NEW.verified_operation_id AND op.action IN ('create', 'update')
      AND op.status = 'reconciling' AND op.lease_token = NEW.verified_lease_token
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_owner_update_fenced');
END;

-- A terminal no-effect failure removes only unverified stage bytes in the
-- same Operation settlement statement; verified custody remains traceable.
CREATE TRIGGER tf_v2_artifact_failed_stage_gc
AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status = 'failed' AND OLD.status <> 'failed'
  AND NEW.action IN ('create', 'update')
BEGIN
  DELETE FROM tf_v2_artifact_owners
  WHERE resource_uid = NEW.resource_uid AND state = 'staging';
END;
