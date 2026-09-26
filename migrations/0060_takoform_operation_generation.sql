-- Migration 0059 added an apply-selection fence to the released saga table,
-- but older binaries do not understand that fence. Keep their rows physically
-- intact as quarantine evidence and give the current runtime a paired storage
-- generation. There is deliberately no copy, backfill, view, or promotion:
-- missing historical selection/operation evidence cannot be reconstructed.

CREATE TABLE tf_deferred_operations_selection_v1 (
  id TEXT PRIMARY KEY NOT NULL,
  protocol_generation INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  phase TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_query TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  request_body_json TEXT,
  fingerprint TEXT NOT NULL,
  replay_key TEXT NOT NULL UNIQUE,
  target_space TEXT NOT NULL,
  target_api_version TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_form_ref_json TEXT NOT NULL,
  accepted_uid TEXT,
  accepted_generation TEXT,
  accepted_revision TEXT,
  resource_uid TEXT NOT NULL,
  polls_remaining INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  terminal_json TEXT,
  committed_uid TEXT,
  created_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  worker_endpoint_origin_reservation_id TEXT,
  CHECK (protocol_generation = 1),
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(principal_id) BETWEEN 1 AND 255),
  CHECK (operation IN ('apply', 'import', 'delete')),
  CHECK (phase IN ('pending', 'committing', 'succeeded', 'failed', 'cancelled')),
  CHECK (length(request_path) BETWEEN 1 AND 2048),
  CHECK (length(request_query) <= 4096),
  CHECK (length(request_headers_json) BETWEEN 2 AND 16384),
  CHECK (request_body_json IS NULL OR length(request_body_json) BETWEEN 2 AND 1048576),
  CHECK (length(fingerprint) BETWEEN 2 AND 8192),
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (length(target_form_ref_json) BETWEEN 2 AND 4096),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (polls_remaining >= 0),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (terminal_json IS NULL OR length(terminal_json) BETWEEN 2 AND 1048576),
  CHECK (updated_at >= 0),
  CHECK (expires_at >= 0),
  CHECK (
    worker_endpoint_origin_reservation_id IS NULL OR
    length(worker_endpoint_origin_reservation_id) BETWEEN 1 AND 128
  ),
  CHECK (
    (phase IN ('pending', 'committing') AND terminal_json IS NULL) OR
    (phase IN ('succeeded', 'failed', 'cancelled') AND terminal_json IS NOT NULL)
  )
);

CREATE INDEX tf_deferred_operations_selection_v1_owner
  ON tf_deferred_operations_selection_v1 (tenant_id, principal_id, id);
CREATE INDEX tf_deferred_operations_selection_v1_expiry
  ON tf_deferred_operations_selection_v1 (expires_at);
CREATE INDEX tf_deferred_operations_selection_v1_recovery
  ON tf_deferred_operations_selection_v1 (phase, lease_until);
CREATE INDEX tf_deferred_operations_selection_v1_endpoint_reservation
  ON tf_deferred_operations_selection_v1 (worker_endpoint_origin_reservation_id)
  WHERE worker_endpoint_origin_reservation_id IS NOT NULL;

CREATE TABLE tf_provider_mutation_sagas_selection_v1 (
  operation_id TEXT PRIMARY KEY NOT NULL,
  protocol_generation INTEGER NOT NULL,
  operation_kind TEXT NOT NULL,
  replay_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  target_space TEXT NOT NULL,
  target_api_version TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  accepted_uid TEXT,
  accepted_generation TEXT,
  accepted_revision TEXT,
  phase TEXT NOT NULL,
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  authority_head_digest TEXT,
  execution_lease_token TEXT,
  execution_lease_until INTEGER,
  execution_started_at INTEGER,
  provider_handle TEXT,
  provider_outcome TEXT NOT NULL DEFAULT 'planned',
  selection_json TEXT,
  selection_verified_lease_token TEXT,
  CHECK (protocol_generation = 1),
  CHECK (operation_kind IN ('apply', 'import', 'delete')),
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(fingerprint) BETWEEN 2 AND 8192),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(target_space) BETWEEN 1 AND 255),
  CHECK (length(target_api_version) BETWEEN 1 AND 255),
  CHECK (length(target_kind) BETWEEN 1 AND 128),
  CHECK (length(target_name) BETWEEN 1 AND 128),
  CHECK (
    (accepted_uid IS NULL AND accepted_generation IS NULL AND accepted_revision IS NULL) OR
    (accepted_uid IS NOT NULL AND accepted_generation IS NOT NULL AND accepted_revision IS NOT NULL)
  ),
  CHECK (phase IN ('planned', 'executed')),
  CHECK (
    (phase = 'planned' AND receipt_json IS NULL) OR
    (phase = 'executed' AND receipt_json IS NOT NULL AND length(receipt_json) BETWEEN 2 AND 1048576)
  ),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (phase = 'planned' AND expires_at IS NOT NULL AND expires_at >= updated_at) OR
    (phase = 'executed' AND expires_at IS NULL)
  ),
  CHECK (
    authority_head_digest IS NULL OR (
      length(authority_head_digest) = 71 AND
      substr(authority_head_digest, 1, 7) = 'sha256:' AND
      substr(authority_head_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    execution_lease_token IS NULL OR
    length(execution_lease_token) BETWEEN 3 AND 128
  ),
  CHECK (execution_lease_until IS NULL OR execution_lease_until >= 0),
  CHECK (execution_started_at IS NULL OR execution_started_at >= created_at),
  CHECK (provider_handle IS NULL OR length(provider_handle) BETWEEN 1 AND 4096),
  CHECK (provider_outcome IN ('planned', 'running', 'indeterminate')),
  CHECK (
    selection_json IS NULL OR (
      length(CAST(selection_json AS BLOB)) BETWEEN 2 AND 131072 AND
      json_valid(selection_json) AND json_type(selection_json) = 'object'
    )
  ),
  CHECK (
    selection_verified_lease_token IS NULL OR
    length(selection_verified_lease_token) BETWEEN 3 AND 128
  ),
  CHECK (
    operation_kind = 'apply' OR
    (selection_json IS NULL AND selection_verified_lease_token IS NULL)
  )
);

CREATE INDEX tf_provider_mutation_sagas_selection_v1_expiry
  ON tf_provider_mutation_sagas_selection_v1 (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX tf_provider_mutation_sagas_selection_v1_target
  ON tf_provider_mutation_sagas_selection_v1 (
    tenant_id, target_space, target_api_version, target_kind, target_name
  );
CREATE INDEX tf_provider_mutation_sagas_selection_v1_execution_lease
  ON tf_provider_mutation_sagas_selection_v1 (phase, execution_lease_until);
CREATE INDEX tf_provider_mutation_sagas_selection_v1_provider_outcome
  ON tf_provider_mutation_sagas_selection_v1 (
    phase, provider_outcome, execution_lease_until
  );

-- An apply must carry the accepted immutable selection verified by the same
-- live lease that crosses dispatch. Import/delete have no apply selection.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_selection_immutable
BEFORE UPDATE OF selection_json ON tf_provider_mutation_sagas_selection_v1
WHEN OLD.selection_json IS NOT NULL AND NEW.selection_json IS NOT OLD.selection_json
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_selection_immutable');
END;

CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_dispatch_verified
BEFORE UPDATE OF execution_started_at ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.operation_kind = 'apply' AND (
  NEW.selection_json IS NULL OR
  NEW.selection_verified_lease_token IS NULL OR
  NEW.selection_verified_lease_token IS NOT NEW.execution_lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_selection_unverified_constraint');
END;

CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_identity_immutable
BEFORE UPDATE OF
  operation_id, protocol_generation, operation_kind, tenant_id, fingerprint,
  resource_uid, target_space, target_api_version, target_kind, target_name,
  accepted_uid, accepted_generation, accepted_revision
ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.protocol_generation IS NOT OLD.protocol_generation
  OR NEW.operation_kind IS NOT OLD.operation_kind
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.resource_uid IS NOT OLD.resource_uid
  OR NEW.target_space IS NOT OLD.target_space
  OR NEW.target_api_version IS NOT OLD.target_api_version
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_name IS NOT OLD.target_name
  OR NEW.accepted_uid IS NOT OLD.accepted_uid
  OR NEW.accepted_generation IS NOT OLD.accepted_generation
  OR NEW.accepted_revision IS NOT OLD.accepted_revision
BEGIN
  SELECT RAISE(ABORT, 'takoform_operation_generation_identity_immutable');
END;

CREATE TRIGGER tf_deferred_operations_selection_v1_generation_immutable
BEFORE UPDATE OF
  id, protocol_generation, operation, tenant_id, fingerprint, resource_uid,
  target_space, target_api_version, target_kind, target_name,
  accepted_uid, accepted_generation, accepted_revision
ON tf_deferred_operations_selection_v1
WHEN NEW.id IS NOT OLD.id
  OR NEW.protocol_generation IS NOT OLD.protocol_generation
  OR NEW.operation IS NOT OLD.operation
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.resource_uid IS NOT OLD.resource_uid
  OR NEW.target_space IS NOT OLD.target_space
  OR NEW.target_api_version IS NOT OLD.target_api_version
  OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_name IS NOT OLD.target_name
  OR NEW.accepted_uid IS NOT OLD.accepted_uid
  OR NEW.accepted_generation IS NOT OLD.accepted_generation
  OR NEW.accepted_revision IS NOT OLD.accepted_revision
BEGIN
  SELECT RAISE(ABORT, 'takoform_operation_generation_identity_immutable');
END;

-- When both halves exist they describe the same exact command. Their replay
-- keys intentionally differ (public Host replay vs provider replay), so only
-- the shared command identity is compared.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_pair_exact
BEFORE INSERT ON tf_provider_mutation_sagas_selection_v1
WHEN EXISTS (
  SELECT 1 FROM tf_deferred_operations_selection_v1 AS operation
  WHERE operation.id = NEW.operation_id
) AND NOT EXISTS (
  SELECT 1 FROM tf_deferred_operations_selection_v1 AS operation
  WHERE operation.id = NEW.operation_id
    AND operation.protocol_generation = NEW.protocol_generation
    AND operation.operation = NEW.operation_kind
    AND operation.tenant_id = NEW.tenant_id
    AND operation.fingerprint = NEW.fingerprint
    AND operation.resource_uid = NEW.resource_uid
    AND operation.target_space = NEW.target_space
    AND operation.target_api_version = NEW.target_api_version
    AND operation.target_kind = NEW.target_kind
    AND operation.target_name = NEW.target_name
    AND operation.accepted_uid IS NEW.accepted_uid
    AND operation.accepted_generation IS NEW.accepted_generation
    AND operation.accepted_revision IS NEW.accepted_revision
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_operation_generation_pair_mismatch');
END;

CREATE TRIGGER tf_deferred_operations_selection_v1_pair_exact
BEFORE INSERT ON tf_deferred_operations_selection_v1
WHEN EXISTS (
  SELECT 1 FROM tf_provider_mutation_sagas_selection_v1 AS saga
  WHERE saga.operation_id = NEW.id
) AND NOT EXISTS (
  SELECT 1 FROM tf_provider_mutation_sagas_selection_v1 AS saga
  WHERE saga.operation_id = NEW.id
    AND saga.protocol_generation = NEW.protocol_generation
    AND saga.operation_kind = NEW.operation
    AND saga.tenant_id = NEW.tenant_id
    AND saga.fingerprint = NEW.fingerprint
    AND saga.resource_uid = NEW.resource_uid
    AND saga.target_space = NEW.target_space
    AND saga.target_api_version = NEW.target_api_version
    AND saga.target_kind = NEW.target_kind
    AND saga.target_name = NEW.target_name
    AND saga.accepted_uid IS NEW.accepted_uid
    AND saga.accepted_generation IS NEW.accepted_generation
    AND saga.accepted_revision IS NEW.accepted_revision
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_operation_generation_pair_mismatch');
END;

-- Freeze pre-0060 writers after the migration linearization point. IGNORE is
-- intentional: an older accept path observes no inserted row and stops before
-- claims. A planned legacy saga may only finish by updating to executed first;
-- any TTL/abandon/failure delete aborts the complete surrounding batch.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_legacy_insert_frozen
BEFORE INSERT ON tf_provider_mutation_sagas
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER tf_deferred_operations_selection_v1_legacy_insert_frozen
BEFORE INSERT ON tf_deferred_operations
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_legacy_planned_delete_durable
BEFORE DELETE ON tf_provider_mutation_sagas
WHEN OLD.phase = 'planned'
BEGIN
  SELECT RAISE(ABORT, 'takoform_legacy_provider_mutation_planned_durable');
END;

CREATE TRIGGER tf_deferred_operations_selection_v1_legacy_nonterminal_delete_durable
BEFORE DELETE ON tf_deferred_operations
WHEN OLD.phase IN ('pending', 'committing')
BEGIN
  SELECT RAISE(ABORT, 'takoform_legacy_deferred_operation_nonterminal_durable');
END;
