-- Additive external-use fence for the existing 0083 execution row. The marker
-- makes partial, non-transactional migration application unavailable to new
-- SQLite queue traffic; no historical execution is rewritten.
CREATE TABLE queue_v2_batch_executions_next (migration_marker INTEGER);

ALTER TABLE queue_v2_batch_executions ADD COLUMN sqlite_drain_state TEXT
  CHECK (sqlite_drain_state IS NULL OR sqlite_drain_state IN ('pending', 'drained'));
ALTER TABLE queue_v2_batch_executions ADD COLUMN sqlite_drain_receipt_digest TEXT
  CHECK (sqlite_drain_receipt_digest IS NULL OR (
    length(sqlite_drain_receipt_digest) = 71 AND
    substr(sqlite_drain_receipt_digest, 1, 7) = 'sha256:' AND
    substr(sqlite_drain_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE queue_v2_batch_executions ADD COLUMN terminal_kind TEXT
  CHECK (terminal_kind IS NULL OR terminal_kind IN ('handler_and_wait_until', 'incarnation_absent'));
ALTER TABLE queue_v2_batch_executions ADD COLUMN terminal_receipt_digest TEXT
  CHECK (terminal_receipt_digest IS NULL OR (
    length(terminal_receipt_digest) = 64 AND
    terminal_receipt_digest NOT GLOB '*[^0-9a-f]*'
  ));

-- The 0083 immutable trigger must allow only the same-state custody writes.
-- Identity, send selection, and retirement receipts remain immutable.
DROP TRIGGER queue_v2_batch_execution_immutable;
CREATE TRIGGER queue_v2_batch_execution_immutable
BEFORE UPDATE ON queue_v2_batch_executions
WHEN OLD.batch_id IS NOT NEW.batch_id OR OLD.reservation_token IS NOT NEW.reservation_token OR
  (OLD.lease_token IS NOT NULL AND OLD.lease_token IS NOT NEW.lease_token) OR
  OLD.queue_id IS NOT NEW.queue_id OR OLD.consumer_uid IS NOT NEW.consumer_uid OR
  OLD.consumer_generation IS NOT NEW.consumer_generation OR OLD.worker_uid IS NOT NEW.worker_uid OR
  OLD.consumer_spec_json IS NOT NEW.consumer_spec_json OR
  OLD.serving_source_operation_id IS NOT NEW.serving_source_operation_id OR
  OLD.selected_versions_json IS NOT NEW.selected_versions_json OR
  OLD.principal IS NOT NEW.principal OR OLD.space IS NOT NEW.space OR
  OLD.target_key IS NOT NEW.target_key OR OLD.max_concurrency IS NOT NEW.max_concurrency OR
  OLD.reserved_at_ms IS NOT NEW.reserved_at_ms OR
  OLD.reservation_until_ms IS NOT NEW.reservation_until_ms OR
  (OLD.message_count IS NOT NULL AND OLD.message_count IS NOT NEW.message_count) OR
  (OLD.worker_version_uid IS NOT NULL AND (
    OLD.worker_version_uid IS NOT NEW.worker_version_uid OR
    OLD.worker_version_generation IS NOT NEW.worker_version_generation OR
    OLD.incarnation_operation_id IS NOT NEW.incarnation_operation_id OR
    OLD.send_authorized_at_ms IS NOT NEW.send_authorized_at_ms)) OR
  (OLD.retirement_receipt_digest IS NOT NULL AND (
    OLD.retirement_receipt_digest IS NOT NEW.retirement_receipt_digest OR
    OLD.retirement_kind IS NOT NEW.retirement_kind OR OLD.retired_at_ms IS NOT NEW.retired_at_ms)) OR
  NOT ((OLD.state = 'reserved' AND NEW.state = 'reserved' AND
         OLD.lease_token IS NULL AND NEW.lease_token IS NOT NULL) OR
       (OLD.state = 'reserved' AND NEW.state IN ('registered','pre_effect_refused')) OR
       (OLD.state = 'registered' AND NEW.state IN ('send_authorized','pre_effect_refused')) OR
       (OLD.state = 'send_authorized' AND NEW.state IN ('send_authorized','retired')))
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_immutable');
END;

CREATE TRIGGER queue_v2_batch_execution_sqlite_no_insert
BEFORE INSERT ON queue_v2_batch_executions
WHEN NEW.sqlite_drain_state IS NOT NULL OR NEW.sqlite_drain_receipt_digest IS NOT NULL OR
  NEW.terminal_kind IS NOT NULL OR NEW.terminal_receipt_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_sqlite_requires_send');
END;

-- The sole legal external-use sequence is arm, trusted terminal, drain. In
-- particular a terminal marker is not a substitute for draining external SQL.
CREATE TRIGGER queue_v2_batch_execution_sqlite_monotonic
BEFORE UPDATE ON queue_v2_batch_executions
WHEN NEW.sqlite_drain_state IS NOT OLD.sqlite_drain_state OR
  NEW.sqlite_drain_receipt_digest IS NOT OLD.sqlite_drain_receipt_digest OR
  NEW.terminal_kind IS NOT OLD.terminal_kind OR
  NEW.terminal_receipt_digest IS NOT OLD.terminal_receipt_digest
BEGIN
  SELECT CASE WHEN NOT (
    OLD.state = 'send_authorized' AND NEW.state = 'send_authorized' AND
    OLD.retired_at_ms IS NULL AND NEW.retired_at_ms IS NULL AND
    OLD.retirement_kind IS NULL AND NEW.retirement_kind IS NULL AND
    OLD.retirement_receipt_digest IS NULL AND NEW.retirement_receipt_digest IS NULL AND
    (
      (OLD.sqlite_drain_state IS NULL AND OLD.sqlite_drain_receipt_digest IS NULL AND
       OLD.terminal_kind IS NULL AND OLD.terminal_receipt_digest IS NULL AND
       NEW.sqlite_drain_state = 'pending' AND NEW.sqlite_drain_receipt_digest IS NULL AND
       NEW.terminal_kind IS NULL AND NEW.terminal_receipt_digest IS NULL) OR
      (OLD.sqlite_drain_state = 'pending' AND OLD.sqlite_drain_receipt_digest IS NULL AND
       OLD.terminal_kind IS NULL AND OLD.terminal_receipt_digest IS NULL AND
       NEW.sqlite_drain_state = 'pending' AND NEW.sqlite_drain_receipt_digest IS NULL AND
       NEW.terminal_kind IS NOT NULL AND NEW.terminal_receipt_digest IS NOT NULL) OR
      (OLD.sqlite_drain_state = 'pending' AND OLD.sqlite_drain_receipt_digest IS NULL AND
       OLD.terminal_kind IS NOT NULL AND OLD.terminal_receipt_digest IS NOT NULL AND
       NEW.sqlite_drain_state = 'drained' AND NEW.sqlite_drain_receipt_digest IS NOT NULL AND
       NEW.terminal_kind IS OLD.terminal_kind AND
       NEW.terminal_receipt_digest IS OLD.terminal_receipt_digest)
    )
  ) THEN RAISE(ABORT, 'queue_v2_batch_execution_sqlite_immutable') END;
END;

-- An old 0083 writer still has the old retirement UPDATE. This trigger is
-- the database boundary that prevents its use on an armed execution.
CREATE TRIGGER queue_v2_batch_execution_sqlite_retirement_guard
BEFORE UPDATE OF state ON queue_v2_batch_executions
WHEN NEW.state = 'retired' AND OLD.sqlite_drain_state IS NOT NULL AND NOT (
  OLD.state = 'send_authorized' AND OLD.sqlite_drain_state = 'drained' AND
  OLD.sqlite_drain_receipt_digest IS NOT NULL AND OLD.terminal_kind IS NOT NULL AND
  OLD.terminal_receipt_digest IS NOT NULL AND
  NEW.sqlite_drain_state IS OLD.sqlite_drain_state AND
  NEW.sqlite_drain_receipt_digest IS OLD.sqlite_drain_receipt_digest AND
  NEW.terminal_kind IS OLD.terminal_kind AND
  NEW.terminal_receipt_digest IS OLD.terminal_receipt_digest AND
  NEW.retirement_kind IS OLD.terminal_kind AND
  NEW.retirement_receipt_digest IS OLD.terminal_receipt_digest
)
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_sqlite_pending');
END;

DROP TABLE queue_v2_batch_executions_next;
