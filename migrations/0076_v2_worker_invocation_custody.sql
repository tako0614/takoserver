-- One accepted HTTP invocation identity, linearized against the current v2
-- Worker/hostname publication rows. This is not native execution completion.
-- Existing rows and migration ceilings are unchanged until an owner applies it.
CREATE TABLE tf_v2_worker_invocations (
  invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND 255),
  custody_token TEXT NOT NULL CHECK (length(custody_token) BETWEEN 16 AND 255),
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  worker_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  deployment_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  deployment_generation INTEGER NOT NULL CHECK (deployment_generation > 0),
  source_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  endpoint_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  endpoint_generation INTEGER NOT NULL CHECK (endpoint_generation > 0),
  version_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  version_generation INTEGER NOT NULL CHECK (version_generation > 0),
  version_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  native_identity TEXT NOT NULL,
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:'
    AND substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  confirmed_receipt TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL CHECK (admitted_at_ms >= 0),
  phase TEXT NOT NULL DEFAULT 'admitted' CHECK (phase IN ('admitted', 'send_authorized', 'pre_effect_refused')),
  send_authorized_at_ms INTEGER,
  body_state TEXT CHECK (body_state IN ('finished', 'canceled')),
  body_observed_at_ms INTEGER,
  refused_at_ms INTEGER,
  CHECK (
    (phase = 'admitted' AND send_authorized_at_ms IS NULL AND refused_at_ms IS NULL) OR
    (phase = 'send_authorized' AND send_authorized_at_ms >= admitted_at_ms AND refused_at_ms IS NULL) OR
    (phase = 'pre_effect_refused' AND send_authorized_at_ms IS NULL AND refused_at_ms >= admitted_at_ms)
  ),
  CHECK ((body_state IS NULL) = (body_observed_at_ms IS NULL)),
  CHECK (body_state IS NULL OR phase = 'send_authorized')
);
CREATE INDEX tf_v2_worker_invocations_deployment_open
  ON tf_v2_worker_invocations(deployment_uid, phase, invocation_id);
CREATE INDEX tf_v2_worker_invocations_version_open
  ON tf_v2_worker_invocations(version_uid, phase, invocation_id);

CREATE TRIGGER tf_v2_worker_invocations_identity_immutable
BEFORE UPDATE ON tf_v2_worker_invocations
WHEN NEW.invocation_id IS NOT OLD.invocation_id OR
  NEW.custody_token IS NOT OLD.custody_token OR
  NEW.backend_id IS NOT OLD.backend_id OR NEW.target_key IS NOT OLD.target_key OR
  NEW.principal IS NOT OLD.principal OR NEW.space IS NOT OLD.space OR
  NEW.worker_uid IS NOT OLD.worker_uid OR NEW.deployment_uid IS NOT OLD.deployment_uid OR
  NEW.deployment_generation IS NOT OLD.deployment_generation OR
  NEW.source_operation_id IS NOT OLD.source_operation_id OR
  NEW.endpoint_uid IS NOT OLD.endpoint_uid OR
  NEW.endpoint_generation IS NOT OLD.endpoint_generation OR
  NEW.version_uid IS NOT OLD.version_uid OR
  NEW.version_generation IS NOT OLD.version_generation OR
  NEW.version_operation_id IS NOT OLD.version_operation_id OR
  NEW.native_identity IS NOT OLD.native_identity OR
  NEW.closure_digest IS NOT OLD.closure_digest OR
  NEW.confirmed_receipt IS NOT OLD.confirmed_receipt OR
  NEW.admitted_at_ms IS NOT OLD.admitted_at_ms OR
  (OLD.phase <> 'admitted' AND NEW.phase IS NOT OLD.phase) OR
  (OLD.phase = 'admitted' AND NEW.phase NOT IN ('admitted', 'send_authorized', 'pre_effect_refused')) OR
  (OLD.send_authorized_at_ms IS NOT NULL AND NEW.send_authorized_at_ms IS NOT OLD.send_authorized_at_ms) OR
  (OLD.refused_at_ms IS NOT NULL AND NEW.refused_at_ms IS NOT OLD.refused_at_ms) OR
  (OLD.body_state IS NOT NULL AND NEW.body_state IS NOT OLD.body_state) OR
  (OLD.body_observed_at_ms IS NOT NULL AND NEW.body_observed_at_ms IS NOT OLD.body_observed_at_ms)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_immutable');
END;

CREATE TRIGGER tf_v2_worker_invocations_no_delete
BEFORE DELETE ON tf_v2_worker_invocations
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_immutable');
END;

-- The public Resource reference set drops old weights after an UPDATE. An
-- outstanding invocation is an additional live reference to its exact Version.
CREATE TRIGGER tf_v2_worker_invocation_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE i.version_uid = NEW.resource_uid AND i.phase <> 'pre_effect_refused'
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;
