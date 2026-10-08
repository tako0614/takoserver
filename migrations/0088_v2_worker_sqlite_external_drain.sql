-- Source-only SQLite external-use fence. The marker closes old custody and
-- deletion statements during a non-transactional D1 migration apply.
CREATE TABLE tf_v2_worker_invocations_next (migration_marker INTEGER);

ALTER TABLE tf_v2_worker_invocations ADD COLUMN sqlite_drain_state TEXT
  CHECK (sqlite_drain_state IS NULL OR sqlite_drain_state IN ('pending', 'drained'));
ALTER TABLE tf_v2_worker_invocations ADD COLUMN sqlite_drain_receipt_digest TEXT
  CHECK (sqlite_drain_receipt_digest IS NULL OR (
    length(sqlite_drain_receipt_digest) = 71 AND
    substr(sqlite_drain_receipt_digest, 1, 7) = 'sha256:' AND
    substr(sqlite_drain_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ));

CREATE TRIGGER tf_v2_worker_invocations_no_sqlite_drain_insert
BEFORE INSERT ON tf_v2_worker_invocations
WHEN NEW.sqlite_drain_state IS NOT NULL OR NEW.sqlite_drain_receipt_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_sqlite_drain_requires_send');
END;

CREATE TRIGGER tf_v2_worker_invocations_sqlite_drain_monotonic
BEFORE UPDATE OF sqlite_drain_state, sqlite_drain_receipt_digest
ON tf_v2_worker_invocations
WHEN NEW.sqlite_drain_state IS NOT OLD.sqlite_drain_state OR
  NEW.sqlite_drain_receipt_digest IS NOT OLD.sqlite_drain_receipt_digest
BEGIN
  SELECT CASE WHEN NOT (
    OLD.phase = 'send_authorized' AND NEW.phase = 'send_authorized' AND
    OLD.send_authorized_at_ms IS NOT NULL AND
    OLD.no_native_dispatch_at_ms IS NULL AND
    NEW.no_native_dispatch_at_ms IS NULL AND (
      (OLD.sqlite_drain_state IS NULL AND OLD.sqlite_drain_receipt_digest IS NULL AND
       OLD.retired_at_ms IS NULL AND OLD.retirement_receipt_digest IS NULL AND
       NEW.sqlite_drain_state = 'pending' AND NEW.sqlite_drain_receipt_digest IS NULL) OR
      (OLD.sqlite_drain_state = 'pending' AND OLD.sqlite_drain_receipt_digest IS NULL AND
       OLD.retired_at_ms IS NOT NULL AND OLD.retirement_receipt_digest IS NOT NULL AND
       NEW.sqlite_drain_state = 'drained' AND NEW.sqlite_drain_receipt_digest IS NOT NULL)
    )
  ) THEN RAISE(ABORT, 'tf_v2_worker_invocation_sqlite_drain_immutable') END;
END;

CREATE TRIGGER tf_v2_worker_invocations_sqlite_drain_no_dispatch_guard
BEFORE UPDATE OF no_native_dispatch_at_ms ON tf_v2_worker_invocations
WHEN NEW.no_native_dispatch_at_ms IS NOT OLD.no_native_dispatch_at_ms
  AND OLD.sqlite_drain_state IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_sqlite_drain_dispatched');
END;

-- Pending external SQL survives Tail retirement. Neither a new Version nor
-- Deployment DELETE, nor native deletion grant/absence, may infer absence.
CREATE TRIGGER tf_v2_worker_invocation_sqlite_drain_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE (i.version_uid = NEW.resource_uid OR
    (i.ingress_kind = 'service' AND i.service_caller_version_uid = NEW.resource_uid))
    AND i.sqlite_drain_state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;

CREATE TRIGGER tf_v2_worker_invocation_sqlite_drain_deployment_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE i.deployment_uid = NEW.resource_uid
    AND i.sqlite_drain_state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;

CREATE TRIGGER tf_v2_worker_native_deletion_sqlite_drain_send_guard
BEFORE UPDATE OF grant_lease_token, granted_at_ms, predelete_source_receipt
ON tf_v2_worker_native_deletions
WHEN (NEW.grant_lease_token IS NOT OLD.grant_lease_token OR
  NEW.granted_at_ms IS NOT OLD.granted_at_ms OR
  NEW.predelete_source_receipt IS NOT OLD.predelete_source_receipt)
  AND EXISTS (
    SELECT 1 FROM tf_v2_worker_invocations i
    WHERE (i.version_uid = OLD.resource_uid OR
      (i.ingress_kind = 'service' AND i.service_caller_version_uid = OLD.resource_uid))
      AND i.sqlite_drain_state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_sqlite_drain_pending');
END;

CREATE TRIGGER tf_v2_worker_native_deletion_sqlite_drain_absence_guard
BEFORE UPDATE OF confirmed_absence_receipt ON tf_v2_worker_native_deletions
WHEN NEW.confirmed_absence_receipt IS NOT OLD.confirmed_absence_receipt
  AND EXISTS (
    SELECT 1 FROM tf_v2_worker_invocations i
    WHERE (i.version_uid = OLD.resource_uid OR
      (i.ingress_kind = 'service' AND i.service_caller_version_uid = OLD.resource_uid))
      AND i.sqlite_drain_state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_deletion_sqlite_drain_pending');
END;

DROP TABLE tf_v2_worker_invocations_next;
