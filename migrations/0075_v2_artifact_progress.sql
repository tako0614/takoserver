-- A bounded execution checkpoint for the existing v2 Operation, not another
-- Resource or Operation authority. Historical 0071/0072 custody bytes stay in
-- their original tables and are never copied or rewritten by this migration.
CREATE TABLE tf_v2_artifact_progress (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  form_url TEXT NOT NULL,
  next_file_index INTEGER NOT NULL DEFAULT 0 CHECK (next_file_index BETWEEN 0 AND 512),
  current_file_bytes INTEGER CHECK (current_file_bytes BETWEEN 0 AND 16777216),
  current_file_sha256 TEXT CHECK (
    current_file_sha256 IS NULL OR
    (length(current_file_sha256) = 64 AND
      current_file_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  file_sizes_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(file_sizes_json) AND json_type(file_sizes_json) = 'array' AND
    json_array_length(file_sizes_json) = next_file_index AND length(file_sizes_json) <= 8192
  ),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes BETWEEN 0 AND 134217728),
  lease_token TEXT NOT NULL CHECK (length(lease_token) > 0),
  CHECK ((current_file_bytes IS NULL) = (current_file_sha256 IS NULL))
);

-- An old process cannot advance progress after its lease is reclaimed, after
-- terminal settlement, or after another generation/backend owns the Resource.
-- Require the lease through the end of this DB clock second, not only through
-- a caller's pre-await timestamp.
CREATE TRIGGER tf_v2_artifact_progress_insert_guard
BEFORE INSERT ON tf_v2_artifact_progress
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND r.uid = NEW.resource_uid
    AND r.form_url = NEW.form_url AND r.principal = op.principal
    AND r.busy_operation = op.id AND r.last_operation = op.id
    AND r.generation = op.generation AND r.deleted_at IS NULL
    AND r.backend_id = op.backend_id AND r.target_key = op.target_key
    AND r.spec_json = op.accepted_spec_json
    AND op.action IN ('create', 'update') AND op.status = 'reconciling'
    AND op.dispatch_possible = 1 AND op.lease_token = NEW.lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_progress_writer_fenced');
END;

CREATE TRIGGER tf_v2_artifact_progress_update_guard
BEFORE UPDATE ON tf_v2_artifact_progress
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND r.uid = NEW.resource_uid
    AND r.form_url = NEW.form_url AND r.principal = op.principal
    AND r.busy_operation = op.id AND r.last_operation = op.id
    AND r.generation = op.generation AND r.deleted_at IS NULL
    AND r.backend_id = op.backend_id AND r.target_key = op.target_key
    AND r.spec_json = op.accepted_spec_json
    AND op.action IN ('create', 'update') AND op.status = 'reconciling'
    AND op.dispatch_possible = 1 AND op.lease_token = NEW.lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_progress_writer_fenced');
END;

CREATE TRIGGER tf_v2_artifact_progress_monotonic
BEFORE UPDATE ON tf_v2_artifact_progress
WHEN NEW.operation_id IS NOT OLD.operation_id OR
  NEW.resource_uid IS NOT OLD.resource_uid OR NEW.form_url IS NOT OLD.form_url OR
  NOT (
    (NEW.next_file_index = OLD.next_file_index AND
      NEW.file_sizes_json IS OLD.file_sizes_json AND
      NEW.total_bytes = OLD.total_bytes AND
      ((OLD.current_file_bytes IS NULL AND
          (NEW.current_file_bytes IS NULL OR NEW.current_file_bytes BETWEEN 0 AND 16777216)) OR
       (NEW.current_file_bytes IS OLD.current_file_bytes AND
        NEW.current_file_sha256 IS OLD.current_file_sha256))) OR
    (NEW.next_file_index = OLD.next_file_index + 1 AND
      OLD.current_file_bytes IS NOT NULL AND
      NEW.current_file_bytes IS NULL AND NEW.current_file_sha256 IS NULL AND
      NEW.total_bytes = OLD.total_bytes + OLD.current_file_bytes AND
      json_remove(NEW.file_sizes_json, '$[#-1]') = OLD.file_sizes_json AND
      json_extract(NEW.file_sizes_json, '$[#-1]') = OLD.current_file_bytes)
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_progress_not_monotonic');
END;

-- A terminal failure already deletes unverified 0071/0072 stage custody in
-- its own trigger. This checkpoint disappears in that same SQL statement.
CREATE TRIGGER tf_v2_artifact_progress_terminal_gc
AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status IN ('succeeded', 'failed') AND OLD.status NOT IN ('succeeded', 'failed')
BEGIN
  DELETE FROM tf_v2_artifact_progress WHERE operation_id = NEW.id;
END;

CREATE TRIGGER tf_v2_artifact_progress_no_early_delete
BEFORE DELETE ON tf_v2_artifact_progress
WHEN EXISTS (
  SELECT 1 FROM tf_v2_operations op
  WHERE op.id = OLD.operation_id AND op.status NOT IN ('succeeded', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_progress_immutable');
END;

-- The historical custody guards fence token/generation, but not lease time.
-- New source-only progress users must not stage or finalize bytes after a
-- lease has expired but before another worker has reclaimed it.
CREATE TRIGGER tf_v2_migration_set_owner_lease_guard
BEFORE INSERT ON tf_v2_migration_set_owners
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.staged_operation_id
    AND op.lease_token = NEW.staged_lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;

CREATE TRIGGER tf_v2_artifact_owner_lease_guard
BEFORE INSERT ON tf_v2_artifact_owners
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.staged_operation_id
    AND op.lease_token = NEW.staged_lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;

CREATE TRIGGER tf_v2_migration_set_chunk_lease_guard
BEFORE INSERT ON tf_v2_migration_set_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.operation_id
    AND op.lease_token = NEW.lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;

CREATE TRIGGER tf_v2_artifact_chunk_lease_guard
BEFORE INSERT ON tf_v2_artifact_chunks
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.operation_id
    AND op.lease_token = NEW.lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;

CREATE TRIGGER tf_v2_migration_set_verify_lease_guard
BEFORE UPDATE OF state ON tf_v2_migration_set_owners
WHEN NEW.state = 'verified' AND NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.verified_operation_id
    AND op.lease_token = NEW.verified_lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;

CREATE TRIGGER tf_v2_artifact_verify_lease_guard
BEFORE UPDATE OF state ON tf_v2_artifact_owners
WHEN NEW.state = 'verified' AND NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.verified_operation_id
    AND op.lease_token = NEW.verified_lease_token
    AND op.lease_until_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_artifact_lease_expired');
END;
