-- Extend future invocation custody with a typed, receipt-backed WorkerVersion
-- delete acknowledgement. Existing 0068 rows retain their original values;
-- this source successor neither opens the epoch nor authorizes an apply wave.

CREATE TABLE tf_cloudflare_provider_invocations_forward_0069 (
  invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND 255),
  epoch_id TEXT NOT NULL CHECK (length(epoch_id) BETWEEN 1 AND 255),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 1024),
  method TEXT NOT NULL CHECK (length(method) BETWEEN 1 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 255),
  resource_uid TEXT NOT NULL CHECK (length(resource_uid) BETWEEN 1 AND 1024),
  host_fingerprint TEXT NOT NULL CHECK (
    substr(host_fingerprint, 1, 7) = 'sha256:' AND length(host_fingerprint) = 71 AND
    substr(host_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  execution_lease_token TEXT NOT NULL CHECK (length(execution_lease_token) BETWEEN 1 AND 1024),
  logical_intent_digest TEXT NOT NULL CHECK (
    substr(logical_intent_digest, 1, 7) = 'sha256:' AND length(logical_intent_digest) = 71 AND
    substr(logical_intent_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  phase TEXT NOT NULL DEFAULT 'admitted' CHECK (phase IN ('admitted', 'effect_started', 'terminal')),
  effect_started_at_ms INTEGER CHECK (effect_started_at_ms IS NULL OR effect_started_at_ms >= 0),
  terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= 0),
  terminal_proof TEXT CHECK (
    terminal_proof IS NULL OR terminal_proof IN (
      'pre_effect_refusal', 'version_receipt_committed', 'version_delete_acknowledged'
    )
  ),
  delete_native_id TEXT CHECK (
    delete_native_id IS NULL OR length(delete_native_id) BETWEEN 1 AND 1024
  ),
  prior_release_operation_id TEXT CHECK (
    prior_release_operation_id IS NULL OR length(prior_release_operation_id) BETWEEN 1 AND 1024
  ),
  prior_descriptor_digest TEXT CHECK (
    prior_descriptor_digest IS NULL OR (
      substr(prior_descriptor_digest, 1, 7) = 'sha256:' AND
      length(prior_descriptor_digest) = 71 AND
      substr(prior_descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  prior_provider_etag TEXT CHECK (
    prior_provider_etag IS NULL OR length(prior_provider_etag) BETWEEN 1 AND 4096
  ),
  CHECK (
    (delete_native_id IS NULL AND prior_release_operation_id IS NULL AND
      prior_descriptor_digest IS NULL AND prior_provider_etag IS NULL) OR
    (method = 'delete' AND delete_native_id IS NOT NULL AND
      prior_release_operation_id IS NOT NULL AND prior_descriptor_digest IS NOT NULL AND
      prior_provider_etag IS NOT NULL)
  ),
  CHECK (
    (phase = 'admitted' AND effect_started_at_ms IS NULL AND terminal_at_ms IS NULL AND terminal_proof IS NULL) OR
    (phase = 'effect_started' AND effect_started_at_ms IS NOT NULL AND
      effect_started_at_ms >= created_at_ms AND terminal_at_ms IS NULL AND terminal_proof IS NULL) OR
    (phase = 'terminal' AND terminal_at_ms IS NOT NULL AND terminal_proof IS NOT NULL AND
      terminal_at_ms >= created_at_ms AND (
        (terminal_proof = 'pre_effect_refusal' AND effect_started_at_ms IS NULL) OR
        (terminal_proof = 'version_receipt_committed' AND effect_started_at_ms IS NOT NULL AND
          terminal_at_ms >= effect_started_at_ms) OR
        (terminal_proof = 'version_delete_acknowledged' AND method = 'delete' AND
          delete_native_id IS NOT NULL AND prior_release_operation_id IS NOT NULL AND
          prior_descriptor_digest IS NOT NULL AND prior_provider_etag IS NOT NULL AND
          effect_started_at_ms IS NOT NULL AND terminal_at_ms >= effect_started_at_ms)
      ))
  )
);

INSERT INTO tf_cloudflare_provider_invocations_forward_0069 (
  invocation_id, epoch_id, provider_id, installation_id, method, operation_id,
  tenant_id, resource_uid, host_fingerprint, execution_lease_token,
  logical_intent_digest, created_at_ms, phase, effect_started_at_ms,
  terminal_at_ms, terminal_proof, delete_native_id, prior_release_operation_id,
  prior_descriptor_digest, prior_provider_etag
)
SELECT
  invocation_id, epoch_id, provider_id, installation_id, method, operation_id,
  tenant_id, resource_uid, host_fingerprint, execution_lease_token,
  logical_intent_digest, created_at_ms, phase, effect_started_at_ms,
  terminal_at_ms, terminal_proof, NULL, NULL, NULL, NULL
FROM tf_cloudflare_provider_invocations;

DROP TABLE tf_cloudflare_provider_invocations;

ALTER TABLE tf_cloudflare_provider_invocations_forward_0069
  RENAME TO tf_cloudflare_provider_invocations;

CREATE INDEX tf_cloudflare_provider_invocations_epoch_phase
  ON tf_cloudflare_provider_invocations (epoch_id, phase);

CREATE TRIGGER tf_cloudflare_provider_invocations_open_epoch_admission
BEFORE INSERT ON tf_cloudflare_provider_invocations
WHEN NEW.phase <> 'admitted' OR NOT EXISTS (
  SELECT 1
  FROM tf_cloudflare_provider_invocation_epoch AS epoch
  WHERE epoch.singleton = 1 AND epoch.state = 'open' AND
    epoch.epoch_id = NEW.epoch_id AND epoch.opened_at_ms <= NEW.created_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_epoch_not_open');
END;

CREATE TRIGGER tf_cloudflare_provider_invocations_delete_admission
BEFORE INSERT ON tf_cloudflare_provider_invocations
WHEN NEW.method = 'delete' AND NOT (
  NEW.phase = 'admitted' AND
  NEW.delete_native_id IS NOT NULL AND
  NEW.prior_release_operation_id IS NOT NULL AND
  NEW.prior_descriptor_digest IS NOT NULL AND
  NEW.prior_provider_etag IS NOT NULL AND
  EXISTS (
    SELECT 1
    FROM tf_cloudflare_provider_executor_operations AS operation
    JOIN cloudflare_managed_worker_receipts AS receipt
      ON receipt.provider_id = NEW.provider_id
     AND receipt.resource_uid = NEW.resource_uid
    WHERE operation.operation_id = NEW.operation_id AND
      operation.tenant_id = NEW.tenant_id AND
      operation.resource_uid = NEW.resource_uid AND
      operation.host_fingerprint = NEW.host_fingerprint AND
      operation.mutation_kind = 'delete' AND
      operation.logical_intent_digest = NEW.logical_intent_digest AND
      receipt.native_id = NEW.delete_native_id AND
      receipt.kind = 'version' AND receipt.state = 'committed' AND
      receipt.operation_id = NEW.prior_release_operation_id AND
      receipt.descriptor_digest = NEW.prior_descriptor_digest AND
      receipt.provider_etag = NEW.prior_provider_etag AND
      json_type(receipt.observed_json, '$.executionMaterial') IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_delete_invocation_admission_invalid');
END;

CREATE TRIGGER tf_cloudflare_provider_invocations_immutable_identity
BEFORE UPDATE ON tf_cloudflare_provider_invocations
WHEN NEW.invocation_id IS NOT OLD.invocation_id OR
  NEW.epoch_id IS NOT OLD.epoch_id OR
  NEW.provider_id IS NOT OLD.provider_id OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.method IS NOT OLD.method OR
  NEW.operation_id IS NOT OLD.operation_id OR
  NEW.tenant_id IS NOT OLD.tenant_id OR
  NEW.resource_uid IS NOT OLD.resource_uid OR
  NEW.host_fingerprint IS NOT OLD.host_fingerprint OR
  NEW.execution_lease_token IS NOT OLD.execution_lease_token OR
  NEW.logical_intent_digest IS NOT OLD.logical_intent_digest OR
  NEW.created_at_ms IS NOT OLD.created_at_ms OR
  NEW.delete_native_id IS NOT OLD.delete_native_id OR
  NEW.prior_release_operation_id IS NOT OLD.prior_release_operation_id OR
  NEW.prior_descriptor_digest IS NOT OLD.prior_descriptor_digest OR
  NEW.prior_provider_etag IS NOT OLD.prior_provider_etag
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_identity_immutable');
END;

CREATE TRIGGER tf_cloudflare_provider_invocations_phase_transition
BEFORE UPDATE ON tf_cloudflare_provider_invocations
WHEN NOT (
  (
    OLD.phase = 'admitted' AND NEW.phase = 'effect_started' AND
    NEW.effect_started_at_ms IS NOT NULL AND NEW.effect_started_at_ms >= OLD.created_at_ms AND
    NEW.terminal_at_ms IS NULL AND NEW.terminal_proof IS NULL
  ) OR (
    OLD.phase = 'admitted' AND NEW.phase = 'terminal' AND
    OLD.effect_started_at_ms IS NULL AND NEW.effect_started_at_ms IS NULL AND
    NEW.terminal_at_ms IS NOT NULL AND NEW.terminal_at_ms >= OLD.created_at_ms AND
    NEW.terminal_proof = 'pre_effect_refusal'
  ) OR (
    OLD.phase = 'effect_started' AND NEW.phase = 'terminal' AND
    OLD.effect_started_at_ms IS NOT NULL AND
    NEW.effect_started_at_ms = OLD.effect_started_at_ms AND
    NEW.terminal_at_ms IS NOT NULL AND NEW.terminal_at_ms >= OLD.effect_started_at_ms AND
    OLD.method = 'applyWithExecutionContextV1' AND
    NEW.terminal_proof = 'version_receipt_committed' AND EXISTS (
      SELECT 1
      FROM cloudflare_managed_worker_receipts AS receipt
      WHERE receipt.provider_id = OLD.provider_id AND
        receipt.resource_uid = OLD.resource_uid AND
        receipt.operation_id = OLD.operation_id AND
        receipt.kind = 'version' AND receipt.state = 'committed'
    )
  ) OR (
    OLD.phase = 'effect_started' AND NEW.phase = 'terminal' AND
    OLD.effect_started_at_ms IS NOT NULL AND
    NEW.effect_started_at_ms = OLD.effect_started_at_ms AND
    NEW.terminal_at_ms IS NOT NULL AND NEW.terminal_at_ms >= OLD.effect_started_at_ms AND
    OLD.method = 'delete' AND NEW.terminal_proof = 'version_delete_acknowledged' AND
    EXISTS (
      SELECT 1
      FROM cloudflare_managed_worker_receipts AS receipt
      WHERE receipt.provider_id = OLD.provider_id AND
        receipt.resource_uid = OLD.resource_uid AND
        receipt.operation_id = OLD.operation_id AND
        receipt.kind = 'version' AND receipt.state = 'deleted' AND
        receipt.native_id = OLD.delete_native_id AND
        receipt.descriptor_digest = OLD.prior_descriptor_digest AND
        json_type(receipt.observed_json) = 'object' AND
        json_type(receipt.observed_json, '$.deleted') = 'true' AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof') = 'object' AND
        (SELECT count(*) FROM json_each(receipt.observed_json)) = 2 AND
        (SELECT count(*) FROM json_each(receipt.observed_json, '$.workerVersionDeleteProof')) = 9 AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.schema') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.schema') =
          'takoserver.cloudflare-managed-worker-version-delete-proof@v1' AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.deleteOperationId') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.deleteOperationId') =
          OLD.operation_id AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.priorReleaseOperationId') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.priorReleaseOperationId') =
          OLD.prior_release_operation_id AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.nativeId') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.nativeId') =
          OLD.delete_native_id AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.scriptName') = 'text' AND
        length(json_extract(receipt.observed_json, '$.workerVersionDeleteProof.scriptName')) BETWEEN 1 AND 1024 AND
        instr(json_extract(receipt.observed_json, '$.workerVersionDeleteProof.scriptName'), ':') = 0 AND
        receipt.native_id = 'version:' || receipt.logical_worker_id || ':' ||
          json_extract(receipt.observed_json, '$.workerVersionDeleteProof.scriptName') AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.priorDescriptorDigest') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.priorDescriptorDigest') =
          OLD.prior_descriptor_digest AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.priorProviderEtag') = 'text' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.priorProviderEtag') =
          OLD.prior_provider_etag AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.nativeDeleteStatus') = 'integer' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.nativeDeleteStatus') IN (200, 204) AND
        json_type(receipt.observed_json, '$.workerVersionDeleteProof.postDeleteAbsent') = 'true' AND
        json_extract(receipt.observed_json, '$.workerVersionDeleteProof.postDeleteAbsent') = 1
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_phase_transition_invalid');
END;

CREATE TRIGGER tf_cloudflare_provider_invocations_immutable_delete
BEFORE DELETE ON tf_cloudflare_provider_invocations
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_immutable');
END;
