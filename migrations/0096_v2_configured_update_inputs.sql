-- Source-only additive capability, not a live migration or Form/profile activation.
-- CREATE custody and its 0081 cleanup remain unchanged. Accepted UPDATE ciphertext
-- survives soft deletion, transfer erasure and replay expiry. Core has no Operation
-- GC; future owner-confirmed native closure/purge requires separately reviewed work.
CREATE TABLE tf_v2_operation_configured_private_inputs (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id) ON DELETE RESTRICT,
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation > 1),
  key_id TEXT NOT NULL CHECK (length(key_id) > 0),
  nonce TEXT NOT NULL CHECK (length(nonce) > 0),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) > 0),
  UNIQUE (resource_uid, generation)
);

CREATE TRIGGER tf_v2_operation_configured_private_acceptance
BEFORE INSERT ON tf_v2_operation_configured_private_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND op.resource_uid = NEW.resource_uid
    AND op.generation = NEW.generation AND op.action = 'update'
    AND op.status = 'queued' AND op.effect = 'none' AND op.dispatch_possible = 0
    AND op.private_inputs_present = 1 AND resource.deleted_at IS NULL
    AND resource.last_operation = op.id AND resource.busy_operation = op.id
    AND resource.generation = op.generation AND resource.principal = op.principal
    AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
    AND resource.spec_json = op.accepted_spec_json
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_configured_private_unaccepted');
END;

-- REPLACE's implicit delete need not run DELETE triggers when recursive_triggers
-- is OFF. Reject replacement in BEFORE INSERT as well, without relying on it.
CREATE TRIGGER tf_v2_operation_configured_private_no_replace
BEFORE INSERT ON tf_v2_operation_configured_private_inputs
WHEN EXISTS (SELECT 1 FROM tf_v2_operation_configured_private_inputs
  WHERE operation_id = NEW.operation_id OR
    (resource_uid = NEW.resource_uid AND generation = NEW.generation))
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_configured_private_immutable');
END;

CREATE TRIGGER tf_v2_operation_configured_private_no_update
BEFORE UPDATE ON tf_v2_operation_configured_private_inputs
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_configured_private_immutable');
END;

-- No lease/status/clock proves closure of all native consumers. Preserve history
-- rather than copying CREATE's soft-delete cleanup or adding an automatic purge.
CREATE TRIGGER tf_v2_operation_configured_private_no_delete
BEFORE DELETE ON tf_v2_operation_configured_private_inputs
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_configured_private_immutable');
END;
