/**
 * Unnumbered, unregistered additive storage candidate for Core accepted UPDATE
 * ciphertext. Not part of MIGRATIONS or a physical-target readiness assertion.
 *
 * Apply only as one owning transaction after the existing Core schema. Plain
 * CREATE refuses collisions; it does not adopt an existing table or trigger.
 * Legacy CREATE, void UPDATE hooks and DELETE do not require this candidate.
 */
export const additiveV2ConfiguredUpdateInputsDDL = `
CREATE TABLE tf_v2_operation_configured_private_inputs (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(operation_id) = 'text' AND length(operation_id) > 0),
  resource_uid TEXT NOT NULL CHECK (typeof(resource_uid) = 'text' AND length(resource_uid) > 0),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 2 AND generation <= 9007199254740991),
  key_id TEXT NOT NULL CHECK (typeof(key_id) = 'text' AND length(key_id) > 0),
  nonce TEXT NOT NULL CHECK (typeof(nonce) = 'text' AND length(nonce) > 0),
  ciphertext TEXT NOT NULL CHECK (typeof(ciphertext) = 'text' AND length(ciphertext) > 0),
  FOREIGN KEY (operation_id) REFERENCES tf_v2_operations(id),
  FOREIGN KEY (resource_uid) REFERENCES tf_v2_resources(uid)
);
CREATE TRIGGER tf_v2_operation_configured_private_inputs_insert_guard
BEFORE INSERT ON tf_v2_operation_configured_private_inputs
WHEN EXISTS (
  SELECT 1 FROM tf_v2_operation_configured_private_inputs retained
  WHERE retained.operation_id = NEW.operation_id
) OR NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
  WHERE op.id = NEW.operation_id
    AND op.resource_uid = NEW.resource_uid
    AND op.generation = NEW.generation
    AND op.action = 'update'
    AND op.private_inputs_present = 1
    AND op.status = 'queued'
    AND resource.uid = NEW.resource_uid
    AND resource.generation = op.generation
    AND resource.busy_operation = op.id
    AND resource.last_operation = op.id
    AND resource.principal = op.principal
    AND resource.backend_id = op.backend_id
    AND resource.target_key = op.target_key
    AND resource.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid accepted UPDATE configured private input custody');
END;
CREATE TRIGGER tf_v2_operation_configured_private_inputs_immutable_update
BEFORE UPDATE ON tf_v2_operation_configured_private_inputs
BEGIN
  SELECT RAISE(ABORT, 'immutable configured UPDATE custody');
END;
CREATE TRIGGER tf_v2_operation_configured_private_inputs_immutable_delete
BEFORE DELETE ON tf_v2_operation_configured_private_inputs
BEGIN
  SELECT RAISE(ABORT, 'immutable configured UPDATE custody');
END;
`;
