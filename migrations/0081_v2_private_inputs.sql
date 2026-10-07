-- Source-only additive v2 custody. No operator target is migrated by this file alone.
ALTER TABLE tf_v2_operations ADD COLUMN private_inputs_present INTEGER NOT NULL DEFAULT 0
  CHECK (private_inputs_present IN (0, 1));
ALTER TABLE tf_v2_operations ADD COLUMN input_required_names_json TEXT;
ALTER TABLE tf_v2_operations ADD COLUMN input_required_reason TEXT;

CREATE TABLE tf_v2_private_inputs (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id) ON DELETE CASCADE,
  names_json TEXT NOT NULL,
  comparison_key_id TEXT NOT NULL,
  comparison_tag TEXT NOT NULL,
  transfer_key_id TEXT,
  transfer_nonce TEXT,
  transfer_ciphertext TEXT,
  transfer_expires_at_ms INTEGER,
  CHECK ((transfer_key_id IS NULL) = (transfer_nonce IS NULL)),
  CHECK ((transfer_key_id IS NULL) = (transfer_ciphertext IS NULL)),
  CHECK ((transfer_key_id IS NULL) = (transfer_expires_at_ms IS NULL))
);

-- A Form may keep its own configured secret across immutable-version updates.
-- This ciphertext is Resource-owned, not the expiring per-Operation transfer.
CREATE TABLE tf_v2_configured_private_inputs (
  resource_uid TEXT PRIMARY KEY REFERENCES tf_v2_resources(uid) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

CREATE TRIGGER tf_v2_configured_private_acceptance BEFORE INSERT ON tf_v2_configured_private_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_resources resource
  JOIN tf_v2_operations op ON op.id = resource.last_operation
  WHERE resource.uid = NEW.resource_uid AND resource.busy_operation = op.id
    AND resource.generation = 1 AND op.action = 'create'
    AND op.resource_uid = resource.uid AND op.generation = 1
    AND op.status = 'queued' AND op.private_inputs_present = 1
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_configured_private_unaccepted');
END;

CREATE TRIGGER tf_v2_configured_private_immutable BEFORE UPDATE ON tf_v2_configured_private_inputs
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_configured_private_immutable');
END;

CREATE TRIGGER tf_v2_configured_private_delete_guard BEFORE DELETE ON tf_v2_configured_private_inputs
WHEN EXISTS (SELECT 1 FROM tf_v2_resources WHERE uid = OLD.resource_uid AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_configured_private_active');
END;

CREATE TRIGGER tf_v2_configured_private_delete AFTER UPDATE OF deleted_at ON tf_v2_resources
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM tf_v2_configured_private_inputs WHERE resource_uid = NEW.uid;
END;

CREATE TRIGGER tf_v2_private_inputs_acceptance BEFORE INSERT ON tf_v2_private_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op WHERE op.id = NEW.operation_id
    AND op.private_inputs_present = 1 AND op.status = 'queued'
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_private_inputs_unaccepted');
END;

CREATE TRIGGER tf_v2_private_input_presence_immutable BEFORE UPDATE OF private_inputs_present
ON tf_v2_operations WHEN OLD.private_inputs_present IS NOT NEW.private_inputs_present
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_private_input_presence_immutable');
END;

DROP TRIGGER tf_v2_operation_transition;
CREATE TRIGGER tf_v2_operation_transition BEFORE UPDATE OF status ON tf_v2_operations
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status = 'running') OR
  (OLD.status = 'running' AND NEW.status IN ('running', 'reconciling', 'waiting_input', 'failed')) OR
  (OLD.status = 'waiting_input' AND NEW.status = 'queued') OR
  (OLD.status = 'reconciling' AND NEW.status IN ('reconciling', 'succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_invalid_transition');
END;

CREATE TRIGGER tf_v2_private_transfer_dispatched AFTER UPDATE OF dispatch_possible
ON tf_v2_operations WHEN OLD.dispatch_possible = 0 AND NEW.dispatch_possible = 1
BEGIN
  UPDATE tf_v2_private_inputs SET transfer_key_id = NULL, transfer_nonce = NULL,
    transfer_ciphertext = NULL, transfer_expires_at_ms = NULL
  WHERE operation_id = NEW.id;
END;

CREATE TRIGGER tf_v2_private_transfer_waiting AFTER UPDATE OF status
ON tf_v2_operations WHEN NEW.status = 'waiting_input'
BEGIN
  UPDATE tf_v2_private_inputs SET transfer_key_id = NULL, transfer_nonce = NULL,
    transfer_ciphertext = NULL, transfer_expires_at_ms = NULL
  WHERE operation_id = NEW.id;
END;
