-- Provider repair commands must retain the Host-owned reservation assignment
-- reference across process reconstruction. The value is opaque to the
-- provider and is revalidated by the reservation authority on every resume.
ALTER TABLE tf_deferred_operations
  ADD COLUMN worker_endpoint_origin_reservation_id TEXT
  CHECK (
    worker_endpoint_origin_reservation_id IS NULL OR
    length(worker_endpoint_origin_reservation_id) BETWEEN 1 AND 128
  );

CREATE INDEX tf_deferred_operations_endpoint_reservation
  ON tf_deferred_operations (worker_endpoint_origin_reservation_id)
  WHERE worker_endpoint_origin_reservation_id IS NOT NULL;

-- Dispatched commands are repair authority, not a replay cache. A historical
-- saga without its complete, exact Host command cannot be reconstructed by a
-- generic migration: it needs provider-specific operator reconciliation.
-- Abort this whole migration before pinning any row or adding any schema when
-- even one such residual exists.
INSERT INTO tf_operation_commit_guards (token, valid)
SELECT 'migration_0036_provider_repair', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM tf_provider_mutation_sagas AS saga
  WHERE saga.phase = 'planned'
    AND saga.receipt_json IS NULL
    AND saga.execution_started_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM tf_deferred_operations AS operation
      WHERE operation.id = saga.operation_id
        AND operation.tenant_id = saga.tenant_id
        AND operation.resource_uid = saga.resource_uid
        AND operation.replay_key = saga.replay_key
        AND operation.fingerprint = saga.fingerprint
        AND operation.target_space = saga.target_space
        AND operation.target_api_version = saga.target_api_version
        AND operation.target_kind = saga.target_kind
        AND operation.target_name = saga.target_name
        AND operation.accepted_uid IS saga.accepted_uid
        AND operation.accepted_generation IS saga.accepted_generation
        AND operation.accepted_revision IS saga.accepted_revision
        AND operation.phase = 'committing'
        AND operation.terminal_json IS NULL
    )
) THEN 1 ELSE 0 END;

DELETE FROM tf_operation_commit_guards
WHERE token = 'migration_0036_provider_repair';

-- Every dispatched saga now has one exact durable Host command. Keep both
-- halves readable until a receipt or definitive failure terminalizes them.
UPDATE tf_provider_mutation_sagas
SET expires_at = 253402300799999
WHERE phase = 'planned'
  AND receipt_json IS NULL
  AND execution_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM tf_deferred_operations AS operation
    WHERE operation.id = tf_provider_mutation_sagas.operation_id
      AND operation.tenant_id = tf_provider_mutation_sagas.tenant_id
      AND operation.resource_uid = tf_provider_mutation_sagas.resource_uid
      AND operation.replay_key = tf_provider_mutation_sagas.replay_key
      AND operation.fingerprint = tf_provider_mutation_sagas.fingerprint
      AND operation.target_space = tf_provider_mutation_sagas.target_space
      AND operation.target_api_version = tf_provider_mutation_sagas.target_api_version
      AND operation.target_kind = tf_provider_mutation_sagas.target_kind
      AND operation.target_name = tf_provider_mutation_sagas.target_name
      AND operation.accepted_uid IS tf_provider_mutation_sagas.accepted_uid
      AND operation.accepted_generation IS tf_provider_mutation_sagas.accepted_generation
      AND operation.accepted_revision IS tf_provider_mutation_sagas.accepted_revision
      AND operation.phase = 'committing'
      AND operation.terminal_json IS NULL
  );

UPDATE tf_deferred_operations
SET expires_at = 253402300799999
WHERE phase = 'committing'
  AND EXISTS (
    SELECT 1 FROM tf_provider_mutation_sagas AS saga
    WHERE saga.operation_id = tf_deferred_operations.id
      AND saga.tenant_id = tf_deferred_operations.tenant_id
      AND saga.resource_uid = tf_deferred_operations.resource_uid
      AND saga.replay_key = tf_deferred_operations.replay_key
      AND saga.fingerprint = tf_deferred_operations.fingerprint
      AND saga.target_space = tf_deferred_operations.target_space
      AND saga.target_api_version = tf_deferred_operations.target_api_version
      AND saga.target_kind = tf_deferred_operations.target_kind
      AND saga.target_name = tf_deferred_operations.target_name
      AND saga.accepted_uid IS tf_deferred_operations.accepted_uid
      AND saga.accepted_generation IS tf_deferred_operations.accepted_generation
      AND saga.accepted_revision IS tf_deferred_operations.accepted_revision
      AND saga.phase = 'planned' AND saga.receipt_json IS NULL
      AND saga.execution_started_at IS NOT NULL
  );

-- The gateway Cron Trigger API replaces the complete set. Route rows remain
-- desired authority; this row versions that set, serializes the external PUT,
-- and records only a generation whose exact provider readback completed.
CREATE TABLE cloudflare_managed_worker_schedule_reconciliation (
  provider_id TEXT PRIMARY KEY NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  desired_generation INTEGER NOT NULL CHECK (desired_generation > 0),
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    applied_generation >= 0 AND applied_generation <= desired_generation
  ),
  applied_digest TEXT CHECK (
    (applied_generation = 0 AND applied_digest IS NULL) OR
    (
      applied_generation > 0 AND
      applied_digest IS NOT NULL AND
      substr(applied_digest, 1, 7) = 'sha256:' AND length(applied_digest) = 71 AND
      substr(applied_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reconciliation_state TEXT NOT NULL DEFAULT 'idle' CHECK (
    reconciliation_state IN ('idle', 'leased', 'operator_reconciliation_required')
  ),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 3 AND 128),
  lease_started_at INTEGER CHECK (lease_started_at IS NULL OR lease_started_at >= 0),
  lease_until INTEGER CHECK (lease_until IS NULL OR lease_until >= 0),
  ambiguous_generation INTEGER CHECK (
    ambiguous_generation IS NULL OR
    (ambiguous_generation > 0 AND ambiguous_generation <= desired_generation)
  ),
  ambiguity_reason TEXT CHECK (
    ambiguity_reason IS NULL OR
    ambiguity_reason IN ('lease_expired', 'mutation_indeterminate')
  ),
  CHECK (
    (
      reconciliation_state = 'idle' AND
      lease_token IS NULL AND lease_started_at IS NULL AND lease_until IS NULL AND
      ambiguous_generation IS NULL AND ambiguity_reason IS NULL
    ) OR
    (
      reconciliation_state = 'leased' AND
      lease_token IS NOT NULL AND lease_started_at IS NOT NULL AND lease_until IS NOT NULL AND
      lease_started_at < lease_until AND
      ambiguous_generation IS NULL AND ambiguity_reason IS NULL
    ) OR
    (
      reconciliation_state = 'operator_reconciliation_required' AND
      lease_token IS NOT NULL AND lease_started_at IS NOT NULL AND lease_until IS NOT NULL AND
      lease_started_at < lease_until AND
      ambiguous_generation IS NOT NULL AND ambiguity_reason IS NOT NULL
    )
  )
);

INSERT INTO cloudflare_managed_worker_schedule_reconciliation (
  provider_id, desired_generation, applied_generation, applied_digest
)
SELECT DISTINCT provider_id, 1, 0, NULL
FROM cloudflare_managed_worker_routes
WHERE route_kind = 'schedule';

CREATE TRIGGER cloudflare_managed_worker_schedule_route_insert
AFTER INSERT ON cloudflare_managed_worker_routes
WHEN NEW.route_kind = 'schedule'
BEGIN
  INSERT INTO cloudflare_managed_worker_schedule_reconciliation (
    provider_id, desired_generation, applied_generation, applied_digest
  ) VALUES (NEW.provider_id, 1, 0, NULL)
  ON CONFLICT (provider_id) DO UPDATE SET
    desired_generation = desired_generation + 1;
END;

CREATE TRIGGER cloudflare_managed_worker_schedule_route_update
AFTER UPDATE ON cloudflare_managed_worker_routes
WHEN NEW.route_kind = 'schedule'
BEGIN
  INSERT INTO cloudflare_managed_worker_schedule_reconciliation (
    provider_id, desired_generation, applied_generation, applied_digest
  ) VALUES (NEW.provider_id, 1, 0, NULL)
  ON CONFLICT (provider_id) DO UPDATE SET
    desired_generation = desired_generation + 1;
END;
