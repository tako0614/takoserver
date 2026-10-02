-- Ordinary additive source inventory for future, explicitly instrumented
-- Cloudflare provider invocations. The initial epoch is deliberately closed;
-- adding this schema does not activate instrumentation or claim writer drain.

CREATE TABLE tf_cloudflare_provider_invocation_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch_id TEXT CHECK (epoch_id IS NULL OR length(epoch_id) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK (state IN ('closed', 'open')),
  opened_at_ms INTEGER CHECK (opened_at_ms IS NULL OR opened_at_ms >= 0),
  closed_at_ms INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= 0),
  CHECK (
    (state = 'open' AND epoch_id IS NOT NULL AND opened_at_ms IS NOT NULL AND closed_at_ms IS NULL) OR
    (state = 'closed' AND (
      (epoch_id IS NULL AND opened_at_ms IS NULL AND closed_at_ms IS NULL) OR
      (epoch_id IS NOT NULL AND opened_at_ms IS NOT NULL AND closed_at_ms IS NOT NULL)
    ))
  )
);

INSERT INTO tf_cloudflare_provider_invocation_epoch (
  singleton, epoch_id, state, opened_at_ms, closed_at_ms
) VALUES (1, NULL, 'closed', NULL, NULL);

CREATE TRIGGER tf_cloudflare_provider_invocation_epoch_transition
BEFORE UPDATE ON tf_cloudflare_provider_invocation_epoch
WHEN NOT (
  (
    OLD.state = 'closed' AND NEW.state = 'open' AND
    (OLD.epoch_id IS NULL OR NEW.epoch_id <> OLD.epoch_id) AND
    NEW.opened_at_ms IS NOT NULL AND NEW.closed_at_ms IS NULL
  ) OR (
    OLD.state = 'open' AND NEW.state = 'closed' AND
    NEW.epoch_id = OLD.epoch_id AND NEW.opened_at_ms = OLD.opened_at_ms AND
    NEW.closed_at_ms IS NOT NULL AND NEW.closed_at_ms >= OLD.opened_at_ms
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_epoch_transition_invalid');
END;

CREATE TRIGGER tf_cloudflare_provider_invocation_epoch_immutable_delete
BEFORE DELETE ON tf_cloudflare_provider_invocation_epoch
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_provider_invocation_epoch_immutable');
END;

CREATE TABLE tf_cloudflare_provider_invocations (
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
    terminal_proof IS NULL OR terminal_proof IN ('pre_effect_refusal', 'version_receipt_committed')
  ),
  CHECK (
    (phase = 'admitted' AND effect_started_at_ms IS NULL AND terminal_at_ms IS NULL AND terminal_proof IS NULL) OR
    (phase = 'effect_started' AND effect_started_at_ms IS NOT NULL AND
      effect_started_at_ms >= created_at_ms AND terminal_at_ms IS NULL AND terminal_proof IS NULL) OR
    (phase = 'terminal' AND terminal_at_ms IS NOT NULL AND terminal_proof IS NOT NULL AND
      terminal_at_ms >= created_at_ms AND (
        (terminal_proof = 'pre_effect_refusal' AND effect_started_at_ms IS NULL) OR
        (terminal_proof = 'version_receipt_committed' AND effect_started_at_ms IS NOT NULL AND
          terminal_at_ms >= effect_started_at_ms)
      ))
  )
);

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
  NEW.created_at_ms IS NOT OLD.created_at_ms
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
