-- Source-only native cleanup custody for one accepted WorkerVersion DELETE.
-- One immutable row corresponds to one earlier 0074 upload grant. It is not a
-- Resource/Operation ledger and does not prove provider deletion by itself.
CREATE TABLE tf_v2_worker_native_deletions (
  delete_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  source_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  delete_generation INTEGER NOT NULL CHECK (delete_generation > 0),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  native_identity TEXT NOT NULL CHECK (
    length(native_identity) = 52 AND substr(native_identity, 1, 4) = 'v2w-' AND
    substr(native_identity, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:' AND
    substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  upload_receipt TEXT CHECK (upload_receipt IS NULL OR length(upload_receipt) BETWEEN 1 AND 255),
  qualified_source_receipt TEXT CHECK (
    qualified_source_receipt IS NULL OR length(qualified_source_receipt) BETWEEN 1 AND 255
  ),
  qualification_lease_token TEXT,
  stage_lease_token TEXT NOT NULL,
  staged_at_ms INTEGER NOT NULL CHECK (staged_at_ms >= 0),
  grant_lease_token TEXT,
  granted_at_ms INTEGER CHECK (granted_at_ms IS NULL OR granted_at_ms >= staged_at_ms),
  predelete_source_receipt TEXT CHECK (
    predelete_source_receipt IS NULL OR length(predelete_source_receipt) BETWEEN 1 AND 255
  ),
  acknowledged_receipt TEXT CHECK (
    acknowledged_receipt IS NULL OR length(acknowledged_receipt) BETWEEN 1 AND 255
  ),
  confirmed_absence_receipt TEXT CHECK (
    confirmed_absence_receipt IS NULL OR length(confirmed_absence_receipt) BETWEEN 1 AND 255
  ),
  absence_lease_token TEXT,
  PRIMARY KEY (delete_operation_id, source_operation_id),
  CHECK ((qualified_source_receipt IS NULL) = (qualification_lease_token IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (granted_at_ms IS NULL)),
  CHECK ((grant_lease_token IS NULL) = (predelete_source_receipt IS NULL)),
  CHECK (confirmed_absence_receipt IS NULL OR grant_lease_token IS NOT NULL OR
    absence_lease_token IS NOT NULL),
  CHECK (acknowledged_receipt IS NULL OR granted_at_ms IS NOT NULL)
);
CREATE INDEX tf_v2_worker_native_deletions_next
  ON tf_v2_worker_native_deletions(delete_operation_id, source_generation DESC, source_operation_id);
CREATE INDEX tf_v2_worker_native_effects_resource_generation
  ON tf_v2_worker_native_effects(resource_uid, generation, operation_id);

-- The stage row is copied only from one confirmed 0074 source under the live
-- DELETE claim. A later reclaimed lease may continue the same immutable plan.
CREATE TRIGGER tf_v2_worker_native_deletion_stage_guard
BEFORE INSERT ON tf_v2_worker_native_deletions
WHEN NEW.grant_lease_token IS NOT NULL OR NEW.granted_at_ms IS NOT NULL OR
  NEW.qualified_source_receipt IS NOT NULL OR NEW.qualification_lease_token IS NOT NULL OR
  NEW.predelete_source_receipt IS NOT NULL OR NEW.absence_lease_token IS NOT NULL OR
  NEW.acknowledged_receipt IS NOT NULL OR NEW.confirmed_absence_receipt IS NOT NULL OR
  NOT EXISTS (
    SELECT 1 FROM tf_v2_operations deletion
    JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
    JOIN tf_v2_operations source ON source.id = NEW.source_operation_id
    JOIN tf_v2_worker_native_effects effect ON effect.operation_id = source.id
    WHERE deletion.id = NEW.delete_operation_id
      AND deletion.action = 'delete' AND deletion.status = 'reconciling'
      AND deletion.dispatch_possible = 1 AND deletion.lease_token = NEW.stage_lease_token
      AND deletion.lease_until_ms > NEW.staged_at_ms
      AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
      AND deletion.resource_uid = NEW.resource_uid
      AND deletion.principal = NEW.principal
      AND deletion.backend_id = NEW.backend_id
      AND deletion.target_key = NEW.target_key
      AND deletion.generation = NEW.delete_generation
      AND version.principal = NEW.principal AND version.space = NEW.space
      AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
      AND version.backend_id = NEW.backend_id AND version.target_key = NEW.target_key
      AND version.generation = NEW.delete_generation
      AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
      AND version.phase = 'deleting' AND version.deleted_at IS NULL
      AND version.spec_json = deletion.accepted_spec_json
      AND source.resource_uid = version.uid AND source.principal = NEW.principal
      AND source.backend_id = NEW.backend_id AND source.target_key = NEW.target_key
      AND source.action IN ('create', 'update')
      AND source.generation = NEW.source_generation
      AND source.generation < NEW.delete_generation
      AND effect.resource_uid = version.uid AND effect.principal = NEW.principal
      AND effect.space = NEW.space AND effect.backend_id = NEW.backend_id
      AND effect.target_key = NEW.target_key AND effect.generation = NEW.source_generation
      AND effect.native_identity = NEW.native_identity
      AND effect.closure_digest = NEW.closure_digest
      AND effect.confirmed_receipt IS NEW.upload_receipt
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_stage_unqualified');
END;

-- An old upload grant may have lost its ACK and lease. The current DELETE
-- claimant may qualify exact owned native readback without rewriting 0074.
CREATE TRIGGER tf_v2_worker_native_deletion_source_guard
BEFORE UPDATE OF qualified_source_receipt ON tf_v2_worker_native_deletions
WHEN NEW.qualified_source_receipt IS NOT OLD.qualified_source_receipt
BEGIN
  SELECT CASE WHEN OLD.qualified_source_receipt IS NOT NULL OR
    OLD.upload_receipt IS NOT NULL OR
    NEW.qualified_source_receipt IS NULL OR NEW.qualification_lease_token IS NULL OR
    OLD.grant_lease_token IS NOT NULL OR
    NOT EXISTS (
      SELECT 1 FROM tf_v2_operations deletion
      JOIN tf_v2_resources version ON version.uid = deletion.resource_uid
      JOIN tf_v2_worker_native_effects effect
        ON effect.operation_id = OLD.source_operation_id
      WHERE deletion.id = OLD.delete_operation_id
        AND deletion.action = 'delete' AND deletion.status = 'reconciling'
        AND deletion.dispatch_possible = 1
        AND deletion.lease_token = NEW.qualification_lease_token
        AND deletion.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
        AND version.uid = OLD.resource_uid AND version.principal = OLD.principal
        AND version.space = OLD.space AND version.generation = OLD.delete_generation
        AND version.last_operation = deletion.id AND version.busy_operation = deletion.id
        AND version.phase = 'deleting' AND version.deleted_at IS NULL
        AND effect.resource_uid = OLD.resource_uid
        AND effect.native_identity = OLD.native_identity
        AND effect.closure_digest = OLD.closure_digest
        AND (effect.confirmed_receipt IS OLD.upload_receipt OR
          effect.confirmed_receipt = NEW.qualified_source_receipt)
    )
  THEN RAISE(ABORT, 'tf_v2_worker_native_deletion_source_unqualified') END;
END;

-- The first native DELETE may start only after the complete 0074 set is
-- staged and every admitted invocation is positively retired or pre-refused.
-- This is the final database-time admission fence, not provider-side CAS.
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

-- A confirmed 0074 upload may already be absent before this DELETE begins.
-- Exact native absence can finish that item without an unnecessary DELETE send,
-- but only under the current DELETE claim and a complete safe history.
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

CREATE TRIGGER tf_v2_worker_native_deletion_monotonic
BEFORE UPDATE ON tf_v2_worker_native_deletions
WHEN NEW.delete_operation_id IS NOT OLD.delete_operation_id OR
  NEW.source_operation_id IS NOT OLD.source_operation_id OR
  NEW.resource_uid IS NOT OLD.resource_uid OR NEW.principal IS NOT OLD.principal OR
  NEW.space IS NOT OLD.space OR NEW.backend_id IS NOT OLD.backend_id OR
  NEW.target_key IS NOT OLD.target_key OR
  NEW.delete_generation IS NOT OLD.delete_generation OR
  NEW.source_generation IS NOT OLD.source_generation OR
  NEW.native_identity IS NOT OLD.native_identity OR
  NEW.closure_digest IS NOT OLD.closure_digest OR
  NEW.upload_receipt IS NOT OLD.upload_receipt OR
  (OLD.qualified_source_receipt IS NOT NULL AND
    NEW.qualified_source_receipt IS NOT OLD.qualified_source_receipt) OR
  (OLD.qualification_lease_token IS NOT NULL AND
    NEW.qualification_lease_token IS NOT OLD.qualification_lease_token) OR
  NEW.stage_lease_token IS NOT OLD.stage_lease_token OR
  NEW.staged_at_ms IS NOT OLD.staged_at_ms OR
  (OLD.grant_lease_token IS NOT NULL AND NEW.grant_lease_token IS NOT OLD.grant_lease_token) OR
  (OLD.granted_at_ms IS NOT NULL AND NEW.granted_at_ms IS NOT OLD.granted_at_ms) OR
  (OLD.predelete_source_receipt IS NOT NULL AND
    NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt) OR
  (OLD.acknowledged_receipt IS NOT NULL AND
    NEW.acknowledged_receipt IS NOT OLD.acknowledged_receipt) OR
  (OLD.confirmed_absence_receipt IS NOT NULL AND
    NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt) OR
  (OLD.absence_lease_token IS NOT NULL AND
    NEW.absence_lease_token IS NOT OLD.absence_lease_token) OR
  (NEW.acknowledged_receipt IS NOT NULL AND NEW.granted_at_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_immutable');
END;
CREATE TRIGGER tf_v2_worker_native_deletion_no_delete
BEFORE DELETE ON tf_v2_worker_native_deletions
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_immutable');
END;
