-- Extend the single invocation ledger to endpoint-free Service calls. This is
-- source-only: no apply ceiling is raised by adding this forward migration.
-- Rebuild is required because 0076 made endpoint_uid/generation NOT NULL.
CREATE TABLE tf_v2_worker_invocations_next (
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
  ingress_kind TEXT NOT NULL DEFAULT 'endpoint' CHECK (ingress_kind IN ('endpoint', 'service')),
  endpoint_uid TEXT REFERENCES tf_v2_resources(uid),
  endpoint_generation INTEGER CHECK (endpoint_generation > 0),
  service_caller_worker_uid TEXT REFERENCES tf_v2_resources(uid),
  service_caller_version_uid TEXT REFERENCES tf_v2_resources(uid),
  service_caller_version_generation INTEGER CHECK (service_caller_version_generation > 0),
  service_caller_version_operation_id TEXT REFERENCES tf_v2_operations(id),
  service_binding_name TEXT,
  service_caller_execution_ref TEXT,
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
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
  retirement_receipt_digest TEXT CHECK (retirement_receipt_digest IS NULL OR (
    length(retirement_receipt_digest) = 71 AND
    substr(retirement_receipt_digest, 1, 7) = 'sha256:' AND
    substr(retirement_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )),
  no_native_dispatch_at_ms INTEGER CHECK (no_native_dispatch_at_ms IS NULL OR (
    typeof(no_native_dispatch_at_ms) = 'integer' AND
    no_native_dispatch_at_ms BETWEEN 0 AND 9007199254740991 AND
    phase = 'send_authorized' AND send_authorized_at_ms IS NOT NULL AND
    no_native_dispatch_at_ms >= send_authorized_at_ms AND
    body_state IS NULL AND body_observed_at_ms IS NULL AND
    retired_at_ms IS NULL AND retirement_receipt_digest IS NULL
  )),
  CHECK (
    (ingress_kind = 'endpoint' AND endpoint_uid IS NOT NULL AND endpoint_generation IS NOT NULL
      AND service_caller_worker_uid IS NULL AND service_caller_version_uid IS NULL
      AND service_caller_version_generation IS NULL AND service_caller_version_operation_id IS NULL
      AND service_binding_name IS NULL AND service_caller_execution_ref IS NULL) OR
    (ingress_kind = 'service' AND endpoint_uid IS NULL AND endpoint_generation IS NULL
      AND service_caller_worker_uid IS NOT NULL AND length(service_caller_worker_uid) BETWEEN 1 AND 255
      AND service_caller_version_uid IS NOT NULL AND length(service_caller_version_uid) BETWEEN 1 AND 255
      AND service_caller_version_generation IS NOT NULL
      AND service_caller_version_operation_id IS NOT NULL AND length(service_caller_version_operation_id) BETWEEN 1 AND 255
      AND service_binding_name IS NOT NULL AND length(service_binding_name) BETWEEN 1 AND 255
      AND service_caller_execution_ref IS NOT NULL AND length(service_caller_execution_ref) BETWEEN 1 AND 255)
  ),
  CHECK (
    (phase = 'admitted' AND send_authorized_at_ms IS NULL AND refused_at_ms IS NULL) OR
    (phase = 'send_authorized' AND send_authorized_at_ms >= admitted_at_ms AND refused_at_ms IS NULL) OR
    (phase = 'pre_effect_refused' AND send_authorized_at_ms IS NULL AND refused_at_ms >= admitted_at_ms)
  ),
  CHECK ((body_state IS NULL) = (body_observed_at_ms IS NULL)),
  CHECK (body_state IS NULL OR phase = 'send_authorized')
);

INSERT INTO tf_v2_worker_invocations_next (
  invocation_id, custody_token, backend_id, target_key, principal, space,
  worker_uid, deployment_uid, deployment_generation, source_operation_id,
  ingress_kind, endpoint_uid, endpoint_generation, version_uid, version_generation,
  version_operation_id, native_identity, closure_digest, confirmed_receipt,
  admitted_at_ms, phase, send_authorized_at_ms, body_state, body_observed_at_ms,
  refused_at_ms, retired_at_ms, retirement_receipt_digest, no_native_dispatch_at_ms
)
SELECT invocation_id, custody_token, backend_id, target_key, principal, space,
  worker_uid, deployment_uid, deployment_generation, source_operation_id,
  'endpoint', endpoint_uid, endpoint_generation, version_uid, version_generation,
  version_operation_id, native_identity, closure_digest, confirmed_receipt,
  admitted_at_ms, phase, send_authorized_at_ms, body_state, body_observed_at_ms,
  refused_at_ms, retired_at_ms, retirement_receipt_digest, no_native_dispatch_at_ms
FROM tf_v2_worker_invocations;

DROP TRIGGER tf_v2_worker_invocation_version_delete_guard;
DROP TRIGGER tf_v2_worker_native_deletion_send_guard;
DROP TRIGGER tf_v2_worker_native_deletion_presend_absence_guard;
DROP TABLE tf_v2_worker_invocations;
-- Avoid ALTER TABLE RENAME: D1's SQLite re-parses unrelated deep triggers
-- (notably the cron match guard) and can exceed its expression-depth limit.
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
  ingress_kind TEXT NOT NULL DEFAULT 'endpoint' CHECK (ingress_kind IN ('endpoint', 'service')),
  endpoint_uid TEXT REFERENCES tf_v2_resources(uid),
  endpoint_generation INTEGER CHECK (endpoint_generation > 0),
  service_caller_worker_uid TEXT REFERENCES tf_v2_resources(uid),
  service_caller_version_uid TEXT REFERENCES tf_v2_resources(uid),
  service_caller_version_generation INTEGER CHECK (service_caller_version_generation > 0),
  service_caller_version_operation_id TEXT REFERENCES tf_v2_operations(id),
  service_binding_name TEXT,
  service_caller_execution_ref TEXT,
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
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
  retirement_receipt_digest TEXT CHECK (retirement_receipt_digest IS NULL OR (
    length(retirement_receipt_digest) = 71 AND
    substr(retirement_receipt_digest, 1, 7) = 'sha256:' AND
    substr(retirement_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )),
  no_native_dispatch_at_ms INTEGER CHECK (no_native_dispatch_at_ms IS NULL OR (
    typeof(no_native_dispatch_at_ms) = 'integer' AND
    no_native_dispatch_at_ms BETWEEN 0 AND 9007199254740991 AND
    phase = 'send_authorized' AND send_authorized_at_ms IS NOT NULL AND
    no_native_dispatch_at_ms >= send_authorized_at_ms AND
    body_state IS NULL AND body_observed_at_ms IS NULL AND
    retired_at_ms IS NULL AND retirement_receipt_digest IS NULL
  )),
  CHECK (
    (ingress_kind = 'endpoint' AND endpoint_uid IS NOT NULL AND endpoint_generation IS NOT NULL
      AND service_caller_worker_uid IS NULL AND service_caller_version_uid IS NULL
      AND service_caller_version_generation IS NULL AND service_caller_version_operation_id IS NULL
      AND service_binding_name IS NULL AND service_caller_execution_ref IS NULL) OR
    (ingress_kind = 'service' AND endpoint_uid IS NULL AND endpoint_generation IS NULL
      AND service_caller_worker_uid IS NOT NULL AND length(service_caller_worker_uid) BETWEEN 1 AND 255
      AND service_caller_version_uid IS NOT NULL AND length(service_caller_version_uid) BETWEEN 1 AND 255
      AND service_caller_version_generation IS NOT NULL
      AND service_caller_version_operation_id IS NOT NULL AND length(service_caller_version_operation_id) BETWEEN 1 AND 255
      AND service_binding_name IS NOT NULL AND length(service_binding_name) BETWEEN 1 AND 255
      AND service_caller_execution_ref IS NOT NULL AND length(service_caller_execution_ref) BETWEEN 1 AND 255)
  ),
  CHECK (
    (phase = 'admitted' AND send_authorized_at_ms IS NULL AND refused_at_ms IS NULL) OR
    (phase = 'send_authorized' AND send_authorized_at_ms >= admitted_at_ms AND refused_at_ms IS NULL) OR
    (phase = 'pre_effect_refused' AND send_authorized_at_ms IS NULL AND refused_at_ms >= admitted_at_ms)
  ),
  CHECK ((body_state IS NULL) = (body_observed_at_ms IS NULL)),
  CHECK (body_state IS NULL OR phase = 'send_authorized')
);
INSERT INTO tf_v2_worker_invocations SELECT * FROM tf_v2_worker_invocations_next;
DROP TABLE tf_v2_worker_invocations_next;
CREATE INDEX tf_v2_worker_invocations_deployment_open
  ON tf_v2_worker_invocations(deployment_uid, phase, invocation_id);
CREATE INDEX tf_v2_worker_invocations_version_open
  ON tf_v2_worker_invocations(version_uid, phase, invocation_id);
CREATE INDEX tf_v2_worker_invocations_service_caller_version_unresolved
  ON tf_v2_worker_invocations(service_caller_version_uid, invocation_id)
  WHERE ingress_kind = 'service' AND phase <> 'pre_effect_refused'
    AND retired_at_ms IS NULL AND no_native_dispatch_at_ms IS NULL;
CREATE UNIQUE INDEX tf_v2_worker_invocations_retirement_receipt
  ON tf_v2_worker_invocations(retirement_receipt_digest)
  WHERE retirement_receipt_digest IS NOT NULL;
CREATE INDEX tf_v2_worker_invocations_deployment_unresolved
  ON tf_v2_worker_invocations(deployment_uid, invocation_id)
  WHERE phase <> 'pre_effect_refused' AND retired_at_ms IS NULL
    AND no_native_dispatch_at_ms IS NULL;

CREATE TRIGGER tf_v2_worker_invocations_identity_immutable
BEFORE UPDATE ON tf_v2_worker_invocations
WHEN NEW.invocation_id IS NOT OLD.invocation_id OR
  NEW.custody_token IS NOT OLD.custody_token OR
  NEW.backend_id IS NOT OLD.backend_id OR NEW.target_key IS NOT OLD.target_key OR
  NEW.principal IS NOT OLD.principal OR NEW.space IS NOT OLD.space OR
  NEW.worker_uid IS NOT OLD.worker_uid OR NEW.deployment_uid IS NOT OLD.deployment_uid OR
  NEW.deployment_generation IS NOT OLD.deployment_generation OR
  NEW.source_operation_id IS NOT OLD.source_operation_id OR
  NEW.ingress_kind IS NOT OLD.ingress_kind OR
  NEW.endpoint_uid IS NOT OLD.endpoint_uid OR
  NEW.endpoint_generation IS NOT OLD.endpoint_generation OR
  NEW.service_caller_worker_uid IS NOT OLD.service_caller_worker_uid OR
  NEW.service_caller_version_uid IS NOT OLD.service_caller_version_uid OR
  NEW.service_caller_version_generation IS NOT OLD.service_caller_version_generation OR
  NEW.service_caller_version_operation_id IS NOT OLD.service_caller_version_operation_id OR
  NEW.service_binding_name IS NOT OLD.service_binding_name OR
  NEW.service_caller_execution_ref IS NOT OLD.service_caller_execution_ref OR
  NEW.version_uid IS NOT OLD.version_uid OR NEW.version_generation IS NOT OLD.version_generation OR
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
CREATE TRIGGER tf_v2_worker_invocations_no_retired_insert
BEFORE INSERT ON tf_v2_worker_invocations
WHEN NEW.retired_at_ms IS NOT NULL OR NEW.retirement_receipt_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_retirement_requires_send');
END;
CREATE TRIGGER tf_v2_worker_invocations_retirement_monotonic
BEFORE UPDATE OF retired_at_ms, retirement_receipt_digest ON tf_v2_worker_invocations
WHEN NEW.retired_at_ms IS NOT OLD.retired_at_ms OR
  NEW.retirement_receipt_digest IS NOT OLD.retirement_receipt_digest
BEGIN
  SELECT CASE WHEN OLD.retired_at_ms IS NOT NULL OR
    OLD.retirement_receipt_digest IS NOT NULL OR
    OLD.phase <> 'send_authorized' OR NEW.phase <> 'send_authorized' OR
    OLD.send_authorized_at_ms IS NULL OR
    NEW.retired_at_ms IS NULL OR NEW.retirement_receipt_digest IS NULL OR
    NEW.retired_at_ms < OLD.send_authorized_at_ms
  THEN RAISE(ABORT, 'tf_v2_worker_invocation_retirement_immutable') END;
END;
CREATE TRIGGER tf_v2_worker_invocations_no_dispatch_insert
BEFORE INSERT ON tf_v2_worker_invocations
WHEN NEW.no_native_dispatch_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_no_dispatch_requires_send');
END;
CREATE TRIGGER tf_v2_worker_invocations_no_dispatch_monotonic
BEFORE UPDATE OF no_native_dispatch_at_ms ON tf_v2_worker_invocations
WHEN NEW.no_native_dispatch_at_ms IS NOT OLD.no_native_dispatch_at_ms
BEGIN
  SELECT CASE WHEN OLD.no_native_dispatch_at_ms IS NOT NULL OR
    NEW.no_native_dispatch_at_ms IS NULL OR
    OLD.phase <> 'send_authorized' OR NEW.phase <> 'send_authorized' OR
    OLD.send_authorized_at_ms IS NULL OR
    OLD.body_state IS NOT NULL OR OLD.body_observed_at_ms IS NOT NULL OR
    OLD.retired_at_ms IS NOT NULL OR OLD.retirement_receipt_digest IS NOT NULL OR
    NEW.no_native_dispatch_at_ms < OLD.send_authorized_at_ms
  THEN RAISE(ABORT, 'tf_v2_worker_invocation_no_dispatch_immutable') END;
END;

-- Trigger on Operations is not owned by the invocation table and therefore
-- survives the rebuild; explicitly re-establish its 0084 predicate anyway.
CREATE TRIGGER tf_v2_worker_invocation_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE (i.version_uid = NEW.resource_uid OR
    (i.ingress_kind = 'service' AND i.service_caller_version_uid = NEW.resource_uid))
    AND i.phase <> 'pre_effect_refused' AND i.retired_at_ms IS NULL
    AND i.no_native_dispatch_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;

-- Reinstall the current 0084 native deletion fences verbatim after the table
-- swap. These triggers belong to the deletion table, not the rebuilt ledger.
CREATE TRIGGER tf_v2_worker_native_deletion_send_guard
BEFORE UPDATE OF grant_lease_token, granted_at_ms, predelete_source_receipt
ON tf_v2_worker_native_deletions
WHEN NEW.grant_lease_token IS NOT OLD.grant_lease_token OR
  NEW.granted_at_ms IS NOT OLD.granted_at_ms OR
  NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt
BEGIN
  SELECT CASE WHEN OLD.grant_lease_token IS NOT NULL OR
    OLD.granted_at_ms IS NOT NULL OR NEW.grant_lease_token IS NULL OR
    NEW.granted_at_ms IS NULL OR OLD.confirmed_absence_receipt IS NOT NULL OR
    NEW.predelete_source_receipt IS NULL OR
    (NEW.predelete_source_receipt IS NOT OLD.upload_receipt AND
      NEW.predelete_source_receipt IS NOT OLD.qualified_source_receipt) OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.resource_uid = OLD.resource_uid
        AND deletion.principal = OLD.principal
        AND deletion.backend_id = OLD.backend_id AND deletion.target_key = OLD.target_key
        AND deletion.generation = OLD.delete_generation
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.grant_lease_token
        AND deletion.lease_until_ms > NEW.granted_at_ms
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.uid = OLD.resource_uid AND version.principal = OLD.principal
        AND version.space = OLD.space
        AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        AND version.backend_id = OLD.backend_id AND version.target_key = OLD.target_key
        AND version.generation = OLD.delete_generation
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND version.spec_json = deletion.accepted_spec_json
    ) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions later
      WHERE later.delete_operation_id = OLD.delete_operation_id
        AND later.native_identity = OLD.native_identity
        AND later.source_generation > OLD.source_generation) OR
    EXISTS (SELECT 1 FROM tf_v2_resource_references reference
      JOIN tf_v2_resources referrer ON referrer.uid = reference.referrer_uid
      WHERE reference.target_uid = OLD.resource_uid AND referrer.deleted_at IS NULL) OR
    EXISTS (
      SELECT 1 FROM tf_v2_worker_invocations invocation
      WHERE invocation.version_uid = OLD.resource_uid
        AND invocation.phase <> 'pre_effect_refused'
        AND invocation.no_native_dispatch_at_ms IS NULL
        AND (invocation.retired_at_ms IS NULL OR invocation.retirement_receipt_digest IS NULL)
    ) OR
    EXISTS (
      SELECT 1 FROM tf_v2_worker_native_effects effect
      WHERE effect.resource_uid = OLD.resource_uid
        AND NOT EXISTS (
          SELECT 1 FROM tf_v2_worker_native_deletions item
          WHERE item.delete_operation_id = OLD.delete_operation_id
            AND item.source_operation_id = effect.operation_id
            AND item.native_identity = effect.native_identity
            AND item.closure_digest = effect.closure_digest
            AND (item.upload_receipt IS effect.confirmed_receipt OR
              item.qualified_source_receipt = effect.confirmed_receipt)
            AND (item.upload_receipt IS NOT NULL OR item.qualified_source_receipt IS NOT NULL)
        )
    ) OR
    EXISTS (
      SELECT 1 FROM tf_v2_operations source
      WHERE source.resource_uid = OLD.resource_uid
        AND source.action IN ('create', 'update')
        AND source.status = 'succeeded' AND source.effect = 'complete'
        AND NOT EXISTS (
          SELECT 1 FROM tf_v2_worker_native_effects effect
          WHERE effect.operation_id = source.id
        )
    )
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_send_unqualified') END;
END;
CREATE TRIGGER tf_v2_worker_native_deletion_presend_absence_guard
BEFORE UPDATE OF confirmed_absence_receipt ON tf_v2_worker_native_deletions
WHEN NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt
  AND OLD.grant_lease_token IS NULL
BEGIN
  SELECT CASE WHEN OLD.confirmed_absence_receipt IS NOT NULL OR
    NEW.confirmed_absence_receipt IS NULL OR OLD.upload_receipt IS NULL OR
    NEW.absence_lease_token IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.resource_uid = OLD.resource_uid
        AND deletion.principal = OLD.principal AND version.principal = OLD.principal
        AND version.space = OLD.space
        AND deletion.backend_id = OLD.backend_id AND version.backend_id = OLD.backend_id
        AND deletion.target_key = OLD.target_key AND version.target_key = OLD.target_key
        AND deletion.generation = OLD.delete_generation
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.absence_lease_token
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        AND version.generation = OLD.delete_generation
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.spec_json = deletion.accepted_spec_json
    ) OR
    EXISTS (SELECT 1 FROM tf_v2_resource_references reference
      JOIN tf_v2_resources referrer ON referrer.uid = reference.referrer_uid
      WHERE reference.target_uid = OLD.resource_uid AND referrer.deleted_at IS NULL) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_invocations invocation
      WHERE invocation.version_uid = OLD.resource_uid
        AND invocation.phase <> 'pre_effect_refused'
        AND invocation.no_native_dispatch_at_ms IS NULL
        AND (invocation.retired_at_ms IS NULL OR invocation.retirement_receipt_digest IS NULL)) OR
    EXISTS (SELECT 1 FROM tf_v2_worker_native_effects effect
      WHERE effect.resource_uid = OLD.resource_uid AND NOT EXISTS (
        SELECT 1 FROM tf_v2_worker_native_deletions item
        WHERE item.delete_operation_id = OLD.delete_operation_id
          AND item.source_operation_id = effect.operation_id
          AND item.native_identity = effect.native_identity
          AND item.closure_digest = effect.closure_digest
          AND (item.upload_receipt IS effect.confirmed_receipt OR
            item.qualified_source_receipt = effect.confirmed_receipt))) OR
    EXISTS (SELECT 1 FROM tf_v2_operations source
      WHERE source.resource_uid = OLD.resource_uid
        AND source.action IN ('create','update')
        AND source.status = 'succeeded' AND source.effect = 'complete'
        AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_effects effect
          WHERE effect.operation_id = source.id))
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_presend_absence_unqualified') END;
END;
