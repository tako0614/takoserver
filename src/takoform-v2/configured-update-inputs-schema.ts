import type { SqlStatement } from "../ports.ts";

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

const TABLE = "tf_v2_operation_configured_private_inputs";
const GATE = "tf_v2_configured_update_discard_gate";
const DELETE_TRIGGER = `${TABLE}_immutable_delete`;

// The installed leaf's exact DELETE trigger is an immutable transition
// preimage. A different trigger must not be silently replaced.
const immutableDeletePreimage = `CREATE TRIGGER ${DELETE_TRIGGER}
BEFORE DELETE ON ${TABLE}
BEGIN
  SELECT RAISE(ABORT, 'immutable configured UPDATE custody');
END`;

export const v2ConfiguredUpdateDiscardObjects = Object.freeze({
  gate: GATE,
  index: `${TABLE}_resource_generation`,
  insertGuard: `${GATE}_insert_guard`,
  deleteGuard: DELETE_TRIGGER,
  consume: `${TABLE}_discard_consume`,
});

const tableDDL = `CREATE TABLE ${GATE} (
  operation_id TEXT PRIMARY KEY NOT NULL,
  resource_uid TEXT NOT NULL,
  generation INTEGER NOT NULL,
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  name TEXT NOT NULL,
  form_url TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES ${TABLE}(operation_id) ON DELETE CASCADE
)`;

const indexDDL = `CREATE INDEX ${v2ConfiguredUpdateDiscardObjects.index}
ON ${TABLE}(resource_uid, generation)`;

// This is a Core accepted-map gate, not physical-retirement evidence. The
// trusted runtime verifier must establish exact retirement before this batch,
// including when the Resource has already been soft-deleted.
const insertGuardDDL = `CREATE TRIGGER ${v2ConfiguredUpdateDiscardObjects.insertGuard}
BEFORE INSERT ON ${GATE}
WHEN EXISTS (SELECT 1 FROM ${GATE}) OR NOT EXISTS (
  SELECT 1 FROM ${TABLE} material
  JOIN tf_v2_operations op ON op.id = material.operation_id
  JOIN tf_v2_resources resource ON resource.uid = material.resource_uid
  WHERE material.operation_id = NEW.operation_id
    AND material.resource_uid = NEW.resource_uid
    AND material.generation = NEW.generation
    AND resource.uid = NEW.resource_uid
    AND resource.principal = NEW.principal
    AND resource.space = NEW.space
    AND resource.name = NEW.name
    AND resource.form_url = NEW.form_url
    AND resource.backend_id = NEW.backend_id
    AND resource.target_key = NEW.target_key
    AND resource.observed_generation > material.generation
    AND resource.generation > material.generation
    AND op.resource_uid = resource.uid
    AND op.principal = resource.principal
    AND op.backend_id = resource.backend_id
    AND op.target_key = resource.target_key
    AND op.generation = material.generation
    AND op.action = 'update'
    AND op.private_inputs_present = 1
    AND (SELECT COUNT(*) FROM ${TABLE} same_generation
      WHERE same_generation.resource_uid = resource.uid
        AND same_generation.generation = material.generation) = 1
    AND (SELECT COUNT(*) FROM ${TABLE} latest
      WHERE latest.resource_uid = resource.uid
        AND latest.generation = (SELECT MAX(all_material.generation)
          FROM ${TABLE} all_material WHERE all_material.resource_uid = resource.uid)) = 1
    AND EXISTS (
      SELECT 1 FROM ${TABLE} latest
      JOIN tf_v2_operations latest_op ON latest_op.id = latest.operation_id
      WHERE latest.resource_uid = resource.uid
        AND latest.generation > material.generation
        AND latest.generation <= resource.generation
        AND latest.generation = (SELECT MAX(all_material.generation)
          FROM ${TABLE} all_material WHERE all_material.resource_uid = resource.uid)
        AND latest_op.resource_uid = resource.uid
        AND latest_op.principal = resource.principal
        AND latest_op.backend_id = resource.backend_id
        AND latest_op.target_key = resource.target_key
        AND latest_op.generation = latest.generation
        AND latest_op.action = 'update'
        AND latest_op.private_inputs_present = 1
    )
)
BEGIN
  SELECT RAISE(ABORT, 'configured UPDATE discard not eligible');
END`;

// Every direct DELETE, including a broad DELETE, still trips the trigger
// without the exact one-row gate inserted by the owning atomic batch.
const deleteGuardDDL = `CREATE TRIGGER ${DELETE_TRIGGER}
BEFORE DELETE ON ${TABLE}
WHEN NOT EXISTS (
  SELECT 1 FROM ${GATE} gate
  WHERE gate.operation_id = OLD.operation_id
    AND gate.resource_uid = OLD.resource_uid
    AND gate.generation = OLD.generation
)
BEGIN
  SELECT RAISE(ABORT, 'immutable configured UPDATE custody');
END`;

const consumeDDL = `CREATE TRIGGER ${v2ConfiguredUpdateDiscardObjects.consume}
AFTER DELETE ON ${TABLE}
BEGIN
  DELETE FROM ${GATE} WHERE operation_id = OLD.operation_id;
END`;

export const v2ConfiguredUpdateDiscardSchema = Object.freeze({
  gate: tableDDL,
  index: indexDDL,
  insertGuard: insertGuardDDL,
  deleteGuard: deleteGuardDDL,
  consume: consumeDDL,
});

/**
 * Source-only successor for the unregistered accepted UPDATE leaf. The owner
 * must apply this entire fixed list in one atomic batch; it is not a migration
 * registration, a live apply helper, or a native retirement qualification.
 */
export function v2ConfiguredUpdateDiscardTransition(): readonly SqlStatement[] {
  const assertion = `${GATE}_transition_assertion`;
  return Object.freeze([
    { sql: `CREATE TABLE ${assertion} (ok INTEGER NOT NULL CHECK (ok = 1))` },
    {
      sql: `INSERT INTO ${assertion} (ok)
        SELECT CASE WHEN (SELECT sql FROM sqlite_schema WHERE type = 'trigger'
          AND name = ? AND tbl_name = ?) = ? THEN 1 ELSE 0 END`,
      params: [DELETE_TRIGGER, TABLE, immutableDeletePreimage],
    },
    { sql: tableDDL },
    { sql: indexDDL },
    { sql: insertGuardDDL },
    { sql: `DROP TRIGGER ${DELETE_TRIGGER}` },
    { sql: deleteGuardDDL },
    { sql: consumeDDL },
    { sql: `DROP TABLE ${assertion}` },
  ]);
}
