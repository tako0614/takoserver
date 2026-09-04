-- Durable, value-free proof of each successful Resource mutation.
--
-- The row is inserted in the same D1 batch as the logical Resource commit.
-- It therefore proves only what Takoserver itself owns: one exact operation
-- committed one exact version of one Resource incarnation.  Resource address
-- and Form identity remain owned by the durable deletion attestation.  This
-- deliberately stores no desired values, outputs, provider-native handles,
-- credentials, artifact identity, or provider receipt bytes/digests.

CREATE TABLE tf_resource_execution_evidence (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  action TEXT NOT NULL,
  resource_generation TEXT NOT NULL,
  resource_revision TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, resource_uid, sequence),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, resource_uid)
    REFERENCES tf_resource_deletion_attestations (tenant_id, resource_uid)
    ON DELETE RESTRICT,
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (sequence >= 1),
  CHECK (action IN ('create', 'update', 'delete')),
  CHECK (
    length(resource_generation) BETWEEN 1 AND 128 AND
    resource_generation NOT GLOB '*[^0-9]*'
  ),
  CHECK (
    length(resource_revision) BETWEEN 1 AND 128 AND
    resource_revision NOT GLOB '*[^0-9]*'
  ),
  CHECK (committed_at >= 0)
);

-- Operation ids are consumed by the first settled Host operation. Evidence is
-- inserted before that operation row in the same atomic batch, so a pre-existing
-- id can only belong to another commit (including an identity-preserving no-op).
CREATE TRIGGER tf_resource_execution_evidence_operation_unclaimed
BEFORE INSERT ON tf_resource_execution_evidence
WHEN EXISTS (
  SELECT 1 FROM tf_operations AS operation
  WHERE operation.id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_operation_claimed');
END;

CREATE TRIGGER tf_resource_execution_evidence_immutable_update
BEFORE UPDATE ON tf_resource_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_immutable');
END;

CREATE TRIGGER tf_resource_execution_evidence_durable_delete
BEFORE DELETE ON tf_resource_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_durable');
END;

-- The store computes the next sequence inside the same serialized D1 batch;
-- the database still verifies that callers cannot skip or reuse a position.
CREATE TRIGGER tf_resource_execution_evidence_contiguous_insert
BEFORE INSERT ON tf_resource_execution_evidence
WHEN NEW.sequence <> COALESCE((
  SELECT MAX(previous.sequence) + 1
  FROM tf_resource_execution_evidence AS previous
  WHERE previous.tenant_id = NEW.tenant_id
    AND previous.resource_uid = NEW.resource_uid
), 1)
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_noncontiguous');
END;

CREATE TRIGGER tf_resource_execution_evidence_create_first
BEFORE INSERT ON tf_resource_execution_evidence
WHEN NEW.action = 'create' AND NEW.sequence <> 1
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_create_not_first');
END;

-- A delete is terminal for one immutable Resource UID. The store's exact
-- replay statement has a NOT EXISTS predicate and therefore writes no second
-- row; no different operation can append beyond the terminal receipt.
CREATE TRIGGER tf_resource_execution_evidence_terminal_insert
BEFORE INSERT ON tf_resource_execution_evidence
WHEN EXISTS (
  SELECT 1 FROM tf_resource_execution_evidence AS terminal
  WHERE terminal.tenant_id = NEW.tenant_id
    AND terminal.resource_uid = NEW.resource_uid
    AND terminal.action = 'delete'
    AND terminal.operation_id <> NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'resource_execution_evidence_deleted');
END;
