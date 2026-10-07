-- A trusted physical owner can prove that an authorized send never crossed
-- the native fetch boundary. Preserve the 0076 phase and every historical row;
-- neither body cancellation nor a timeout constitutes this proof.
ALTER TABLE tf_v2_worker_invocations ADD COLUMN no_native_dispatch_at_ms INTEGER
  CHECK (no_native_dispatch_at_ms IS NULL OR (
    typeof(no_native_dispatch_at_ms) = 'integer' AND
    no_native_dispatch_at_ms BETWEEN 0 AND 9007199254740991 AND
    phase = 'send_authorized' AND send_authorized_at_ms IS NOT NULL AND
    no_native_dispatch_at_ms >= send_authorized_at_ms AND
    body_state IS NULL AND body_observed_at_ms IS NULL AND
    retired_at_ms IS NULL AND retirement_receipt_digest IS NULL
  ));

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

-- Replace only the unresolved projection and exact historical delete fences.
-- Old sent rows have a NULL marker and remain conservative.
DROP INDEX tf_v2_worker_invocations_deployment_unresolved;
CREATE INDEX tf_v2_worker_invocations_deployment_unresolved
  ON tf_v2_worker_invocations(deployment_uid, invocation_id)
  WHERE phase <> 'pre_effect_refused' AND retired_at_ms IS NULL
    AND no_native_dispatch_at_ms IS NULL;

DROP TRIGGER tf_v2_worker_invocation_version_delete_guard;
CREATE TRIGGER tf_v2_worker_invocation_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE i.version_uid = NEW.resource_uid
    AND i.phase <> 'pre_effect_refused' AND i.retired_at_ms IS NULL
    AND i.no_native_dispatch_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;

DROP TRIGGER tf_v2_worker_native_deletion_send_guard;
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

DROP TRIGGER tf_v2_worker_native_deletion_presend_absence_guard;
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
