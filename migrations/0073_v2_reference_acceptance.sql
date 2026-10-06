-- A Form's complete outbound reference set is pinned to the accepted v2
-- Operation. Existing 0071 edges remain the conservative active union; no
-- historical Resource, Operation, or custody row is rewritten.
CREATE TABLE tf_v2_operation_reference_sets (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1))
);

CREATE TABLE tf_v2_operation_references (
  operation_id TEXT NOT NULL REFERENCES tf_v2_operation_reference_sets(operation_id),
  target_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  form_url TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('observed', 'ready')),
  target_spec_path TEXT,
  target_spec_equals TEXT,
  PRIMARY KEY (operation_id, target_uid),
  CHECK ((target_spec_path IS NULL) = (target_spec_equals IS NULL))
);
CREATE INDEX tf_v2_operation_references_target
  ON tf_v2_operation_references(target_uid, operation_id);

CREATE TRIGGER tf_v2_operation_reference_set_guard
BEFORE INSERT ON tf_v2_operation_reference_sets
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources referrer
    ON referrer.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND op.action IN ('create', 'update')
    AND op.status = 'queued' AND op.principal = referrer.principal
    AND referrer.deleted_at IS NULL AND referrer.busy_operation = op.id
    AND referrer.last_operation = op.id AND referrer.generation = op.generation
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_set_unavailable');
END;

-- The exact target check and edge insertion run inside the same accepted batch.
-- An invalid target aborts the whole Resource/Operation acceptance transaction.
CREATE TRIGGER tf_v2_operation_reference_guard
BEFORE INSERT ON tf_v2_operation_references
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operation_reference_sets chosen
  JOIN tf_v2_operations op ON op.id = chosen.operation_id
  JOIN tf_v2_resources referrer ON referrer.uid = op.resource_uid
  JOIN tf_v2_resources target ON target.uid = NEW.target_uid
  WHERE chosen.operation_id = NEW.operation_id AND chosen.sealed = 0
    AND op.action IN ('create', 'update') AND op.status = 'queued'
    AND op.principal = referrer.principal AND referrer.deleted_at IS NULL
    AND referrer.busy_operation = op.id AND referrer.last_operation = op.id
    AND referrer.generation = op.generation
    AND target.principal = referrer.principal AND target.space = referrer.space
    AND target.form_url = NEW.form_url AND target.deleted_at IS NULL
    AND target.busy_operation IS NULL AND target.phase = 'idle'
    AND target.observed_generation = target.generation
    AND (NEW.readiness = 'observed' OR
      json_type(target.observed_json, '$.ready') = 'true')
    AND (NEW.target_spec_path IS NULL OR
      (json_type(target.spec_json, NEW.target_spec_path) = 'text' AND
       json_extract(target.spec_json, NEW.target_spec_path) = NEW.target_spec_equals))
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

CREATE TRIGGER tf_v2_operation_reference_reserve
AFTER INSERT ON tf_v2_operation_references
BEGIN
  INSERT OR IGNORE INTO tf_v2_resource_references (target_uid, referrer_uid)
  SELECT NEW.target_uid, op.resource_uid FROM tf_v2_operations op
  WHERE op.id = NEW.operation_id;
END;

CREATE TRIGGER tf_v2_operation_reference_set_immutable
BEFORE UPDATE ON tf_v2_operation_reference_sets
WHEN NOT (
  OLD.operation_id IS NEW.operation_id AND OLD.sealed = 0 AND NEW.sealed = 1
  AND EXISTS (
    SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources referrer
      ON referrer.uid = op.resource_uid
    WHERE op.id = NEW.operation_id AND op.action IN ('create', 'update')
      AND op.status = 'queued' AND op.principal = referrer.principal
      AND referrer.deleted_at IS NULL AND referrer.busy_operation = op.id
      AND referrer.last_operation = op.id AND referrer.generation = op.generation)
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_set_immutable');
END;
CREATE TRIGGER tf_v2_operation_reference_set_no_delete
BEFORE DELETE ON tf_v2_operation_reference_sets
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_set_immutable');
END;
CREATE TRIGGER tf_v2_operation_reference_immutable
BEFORE UPDATE ON tf_v2_operation_references
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_immutable');
END;
CREATE TRIGGER tf_v2_operation_reference_no_delete
BEFORE DELETE ON tf_v2_operation_references
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_immutable');
END;

-- A successful complete replacement may retire previous edges; a failed or
-- uncertain update keeps the old and pending sets until a later confirmed
-- replacement or the referrer's successful delete.
CREATE TRIGGER tf_v2_reference_success_replace
AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status = 'succeeded' AND OLD.status <> 'succeeded'
  AND NEW.action IN ('create', 'update')
  AND EXISTS (SELECT 1 FROM tf_v2_operation_reference_sets
    WHERE operation_id = NEW.id AND sealed = 1)
BEGIN
  DELETE FROM tf_v2_resource_references
  WHERE referrer_uid = NEW.resource_uid AND NOT EXISTS (
    SELECT 1 FROM tf_v2_operation_references wanted
    WHERE wanted.operation_id = NEW.id
      AND wanted.target_uid = tf_v2_resource_references.target_uid);
END;

CREATE TRIGGER tf_v2_reference_successful_delete
AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status = 'succeeded' AND OLD.status <> 'succeeded'
  AND NEW.action = 'delete'
BEGIN
  DELETE FROM tf_v2_resource_references WHERE referrer_uid = NEW.resource_uid;
END;
