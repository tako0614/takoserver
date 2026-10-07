-- Source-only QueueConsumer acceptance constraints. The v2 Resource/Operation
-- tables remain the sole attachment authority; no second Consumer ledger is
-- introduced. Existing live duplicates fail this migration rather than being
-- silently adopted or deleted.
CREATE UNIQUE INDEX tf_v2_queue_consumer_live_queue
ON tf_v2_resources(json_extract(spec_json, '$.queue.resourceUid'))
WHERE form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND deleted_at IS NULL;

-- A second attachment must fail in the same acceptance transaction, including
-- when concurrent Host handles both passed their earlier read-only preflight.
CREATE TRIGGER tf_v2_queue_consumer_unique_create
BEFORE INSERT ON tf_v2_resources
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND EXISTS (
    SELECT 1 FROM tf_v2_resources existing
    WHERE existing.form_url = NEW.form_url AND existing.deleted_at IS NULL
      AND json_extract(existing.spec_json, '$.queue.resourceUid') =
          json_extract(NEW.spec_json, '$.queue.resourceUid')
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

-- A batch execution is subordinate to the accepted Consumer and its 0082
-- message claims. It reserves maxConcurrency across *all* generations of a
-- Consumer UID. Sent executions have no time-based release: only trusted
-- native handler+waitUntil completion or physical incarnation absence may
-- retire one. This is not another Resource or message authority.
CREATE TABLE queue_v2_batch_executions (
  batch_id TEXT PRIMARY KEY CHECK (length(CAST(batch_id AS BLOB)) BETWEEN 1 AND 256),
  reservation_token TEXT NOT NULL CHECK (length(reservation_token) BETWEEN 1 AND 128),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  queue_id TEXT NOT NULL CHECK (length(queue_id) BETWEEN 1 AND 512),
  consumer_uid TEXT NOT NULL CHECK (length(consumer_uid) BETWEEN 1 AND 128),
  consumer_generation INTEGER NOT NULL CHECK (consumer_generation BETWEEN 1 AND 9007199254740991),
  worker_uid TEXT NOT NULL CHECK (length(worker_uid) BETWEEN 1 AND 128),
  consumer_spec_json TEXT NOT NULL CHECK (json_valid(consumer_spec_json)),
  serving_source_operation_id TEXT NOT NULL CHECK (length(serving_source_operation_id) BETWEEN 1 AND 128),
  selected_versions_json TEXT NOT NULL CHECK (json_valid(selected_versions_json)),
  principal TEXT NOT NULL, space TEXT NOT NULL, target_key TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 250),
  reserved_at_ms INTEGER NOT NULL CHECK (reserved_at_ms > 0),
  reservation_until_ms INTEGER NOT NULL CHECK (reservation_until_ms > reserved_at_ms),
  state TEXT NOT NULL CHECK (state IN ('reserved','registered','send_authorized','pre_effect_refused','retired')),
  message_count INTEGER CHECK (message_count IS NULL OR message_count BETWEEN 1 AND 100),
  worker_version_uid TEXT, worker_version_generation INTEGER,
  incarnation_operation_id TEXT, send_authorized_at_ms INTEGER,
  retired_at_ms INTEGER, retirement_kind TEXT, retirement_receipt_digest TEXT,
  CHECK (reservation_until_ms = reserved_at_ms + 120000),
  CHECK (
    (state = 'reserved' AND message_count IS NULL AND worker_version_uid IS NULL
      AND worker_version_generation IS NULL AND incarnation_operation_id IS NULL
      AND send_authorized_at_ms IS NULL AND retired_at_ms IS NULL
      AND retirement_kind IS NULL AND retirement_receipt_digest IS NULL) OR
    (state = 'registered' AND lease_token IS NOT NULL AND message_count BETWEEN 1 AND 100
      AND worker_version_uid IS NULL AND worker_version_generation IS NULL
      AND incarnation_operation_id IS NULL AND send_authorized_at_ms IS NULL
      AND retired_at_ms IS NULL AND retirement_kind IS NULL
      AND retirement_receipt_digest IS NULL) OR
    (state = 'pre_effect_refused' AND worker_version_uid IS NULL
      AND worker_version_generation IS NULL AND incarnation_operation_id IS NULL
      AND send_authorized_at_ms IS NULL AND retired_at_ms IS NULL
      AND retirement_kind IS NULL AND retirement_receipt_digest IS NULL) OR
    (state = 'send_authorized' AND lease_token IS NOT NULL AND message_count BETWEEN 1 AND 100
      AND worker_version_uid IS NOT NULL AND worker_version_generation > 0
      AND incarnation_operation_id IS NOT NULL AND send_authorized_at_ms >= reserved_at_ms
      AND retired_at_ms IS NULL AND retirement_kind IS NULL
      AND retirement_receipt_digest IS NULL) OR
    (state = 'retired' AND lease_token IS NOT NULL AND message_count BETWEEN 1 AND 100
      AND worker_version_uid IS NOT NULL AND worker_version_generation > 0
      AND incarnation_operation_id IS NOT NULL AND send_authorized_at_ms >= reserved_at_ms
      AND retired_at_ms >= send_authorized_at_ms
      AND retirement_kind IN ('handler_and_wait_until','incarnation_absent')
      AND retirement_receipt_digest IS NOT NULL)
  )
);
CREATE INDEX queue_v2_batch_executions_open_consumer
  ON queue_v2_batch_executions(consumer_uid, state);
CREATE UNIQUE INDEX queue_v2_batch_executions_lease
  ON queue_v2_batch_executions(queue_id,consumer_uid,consumer_generation,lease_token)
  WHERE lease_token IS NOT NULL;
CREATE UNIQUE INDEX queue_v2_batch_executions_retirement_receipt
  ON queue_v2_batch_executions(retirement_receipt_digest)
  WHERE retirement_receipt_digest IS NOT NULL;

-- Nullable only for the pre-existing internal 0082 registration API. New
-- reserved executions supply it so wrong/missing reservations ABORT the same
-- Sql.batch that inserts the message receipts.
ALTER TABLE queue_v2_batch_settlements
  ADD COLUMN execution_reservation_token TEXT
    CHECK (execution_reservation_token IS NULL OR
      length(execution_reservation_token) BETWEEN 1 AND 128);
CREATE TRIGGER queue_v2_batch_execution_token_immutable
BEFORE UPDATE OF execution_reservation_token ON queue_v2_batch_settlements
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_immutable');
END;

CREATE TRIGGER queue_v2_batch_execution_reserve_guard
BEFORE INSERT ON queue_v2_batch_executions
WHEN NEW.state <> 'reserved' OR NEW.reservation_until_ms <=
  (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)) OR
  NOT EXISTS (
    SELECT 1 FROM tf_v2_resources consumer
    JOIN tf_v2_operations op ON op.id = consumer.last_operation
    JOIN queue_consumer_custody custody ON custody.queue_id = NEW.queue_id
    JOIN tf_v2_operations source_op ON source_op.id = NEW.serving_source_operation_id
    JOIN tf_v2_resources source ON source.uid = source_op.resource_uid
    WHERE consumer.uid = NEW.consumer_uid AND consumer.form_url =
      'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
      AND consumer.principal = NEW.principal AND consumer.space = NEW.space
      AND consumer.target_key = NEW.target_key AND consumer.deleted_at IS NULL
      AND consumer.phase = 'idle' AND consumer.busy_operation IS NULL
      AND consumer.generation = consumer.observed_generation
      AND consumer.spec_json = NEW.consumer_spec_json
      AND op.resource_uid = consumer.uid AND op.status = 'succeeded'
      AND op.effect = 'complete' AND op.accepted_spec_json = consumer.spec_json
      AND json_extract(consumer.observed_json, '$.consumerAttached') = 1
      AND json_extract(consumer.spec_json, '$.queue.resourceUid') = substr(NEW.queue_id, 19)
      AND json_extract(consumer.spec_json, '$.worker.resourceUid') = NEW.worker_uid
      AND json_extract(consumer.spec_json, '$.maxConcurrency') = NEW.max_concurrency
      AND custody.consumer_id = consumer.uid AND custody.generation = NEW.consumer_generation
      AND custody.state = 'active'
      AND source_op.status = 'succeeded' AND source_op.effect = 'complete'
      AND ((source_op.action IN ('create','update') AND source.deleted_at IS NULL) OR
        (source_op.action = 'delete' AND source.form_url =
          'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
          AND source.deleted_at IS NOT NULL))
      AND source.phase = 'idle'
      AND source.busy_operation IS NULL AND source.last_operation = source_op.id
      AND source.generation = source.observed_generation
      AND source.observed_generation = source_op.generation
      AND source_op.accepted_spec_json = source.spec_json
      AND source.form_url IN (
        'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/',
        'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
      ) AND source.principal = NEW.principal AND source.space = NEW.space
      AND source.target_key = NEW.target_key
      AND json_extract(source_op.accepted_spec_json, '$.worker.resourceUid') = NEW.worker_uid
      AND NOT EXISTS (SELECT 1 FROM tf_v2_resources newer
        JOIN tf_v2_operations newer_op ON newer_op.id = newer.last_operation
        WHERE newer.form_url IN (
          'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/',
          'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
        ) AND newer.principal = NEW.principal AND newer.space = NEW.space
          AND newer.target_key = NEW.target_key AND newer.busy_operation IS NULL
          AND newer.observed_generation = newer_op.generation
          AND newer_op.status = 'succeeded' AND newer_op.effect = 'complete'
          AND json_extract(newer_op.accepted_spec_json, '$.worker.resourceUid') = NEW.worker_uid
          AND newer_op.acceptance_order > source_op.acceptance_order)
  ) OR EXISTS (SELECT 1 FROM tf_v2_resources competing
    WHERE competing.form_url IN (
      'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/',
      'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
    ) AND competing.principal = NEW.principal AND competing.space = NEW.space
      AND competing.target_key = NEW.target_key AND competing.deleted_at IS NULL
      AND competing.busy_operation IS NOT NULL
      AND json_extract(competing.spec_json, '$.worker.resourceUid') = NEW.worker_uid
  ) OR (SELECT count(*) FROM queue_v2_batch_executions prior
    WHERE prior.consumer_uid = NEW.consumer_uid
      AND prior.state IN ('reserved','registered','send_authorized')) >= NEW.max_concurrency
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_capacity_unavailable');
END;

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
       (OLD.state = 'send_authorized' AND NEW.state = 'retired'))
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_immutable');
END;
CREATE TRIGGER queue_v2_batch_execution_bind_lease_guard
BEFORE UPDATE OF lease_token ON queue_v2_batch_executions
WHEN OLD.state <> 'reserved' OR OLD.lease_token IS NOT NULL OR
  NEW.lease_token IS NULL OR OLD.reservation_until_ms <=
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_lease_unavailable');
END;
CREATE TRIGGER queue_v2_batch_execution_no_delete
BEFORE DELETE ON queue_v2_batch_executions
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_immutable');
END;

-- The registration UPDATE is the last statement of the same Sql.batch as all
-- 0082 rows. A failed time/claim check must ABORT that whole transaction,
-- never leave registered messages without an execution reservation.
CREATE TRIGGER queue_v2_batch_execution_register_guard
BEFORE UPDATE OF state ON queue_v2_batch_executions
WHEN NEW.state = 'registered' AND (
  OLD.state <> 'reserved' OR OLD.reservation_until_ms <=
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)) OR
  NEW.message_count <> (SELECT count(*) FROM queue_v2_batch_settlements receipt
    WHERE receipt.batch_id = OLD.batch_id AND receipt.queue_id = OLD.queue_id
      AND receipt.consumer_id = OLD.consumer_uid
      AND receipt.generation = OLD.consumer_generation
      AND receipt.lease_token = OLD.lease_token)
)
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_registration_unavailable');
END;

CREATE TRIGGER queue_v2_batch_execution_send_guard
BEFORE UPDATE OF state ON queue_v2_batch_executions
WHEN NEW.state = 'send_authorized' AND (
  OLD.state <> 'registered' OR OLD.reservation_until_ms <=
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)) OR
  NOT EXISTS (SELECT 1 FROM tf_v2_resources consumer
    JOIN queue_consumer_custody custody ON custody.queue_id = OLD.queue_id
    WHERE consumer.uid = OLD.consumer_uid AND consumer.deleted_at IS NULL
      AND consumer.phase = 'idle' AND consumer.busy_operation IS NULL
      AND consumer.generation = consumer.observed_generation
      AND consumer.spec_json = OLD.consumer_spec_json
      AND custody.consumer_id = consumer.uid AND custody.state = 'active'
      AND custody.generation = OLD.consumer_generation) OR
  NOT EXISTS (SELECT 1 FROM tf_v2_operations source_op
    JOIN tf_v2_resources source ON source.uid = source_op.resource_uid
    WHERE source_op.id = OLD.serving_source_operation_id
      AND source_op.status = 'succeeded' AND source_op.effect = 'complete'
      AND source_op.principal = OLD.principal AND source_op.target_key = OLD.target_key
      AND ((source_op.action IN ('create','update') AND source.deleted_at IS NULL) OR
        (source_op.action = 'delete' AND source.form_url =
          'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
          AND source.deleted_at IS NOT NULL))
      AND source.principal = OLD.principal
      AND source.space = OLD.space AND source.target_key = OLD.target_key
      AND source.phase = 'idle' AND source.busy_operation IS NULL
      AND source.last_operation = source_op.id
      AND source.generation = source.observed_generation
      AND source.observed_generation = source_op.generation
      AND source.spec_json = source_op.accepted_spec_json
      AND NOT EXISTS (SELECT 1 FROM tf_v2_resources newer
        JOIN tf_v2_operations newer_op ON newer_op.id = newer.last_operation
        WHERE newer.form_url IN (
          'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/',
          'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
        ) AND newer.principal = OLD.principal AND newer.space = OLD.space
          AND newer.target_key = OLD.target_key AND newer.busy_operation IS NULL
          AND newer.observed_generation = newer_op.generation
          AND newer_op.status = 'succeeded' AND newer_op.effect = 'complete'
          AND json_extract(newer_op.accepted_spec_json, '$.worker.resourceUid') = OLD.worker_uid
          AND newer_op.acceptance_order > source_op.acceptance_order)) OR
  EXISTS (SELECT 1 FROM tf_v2_resources competing
    WHERE competing.form_url IN (
      'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/',
      'https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/'
    ) AND competing.principal = OLD.principal AND competing.space = OLD.space
      AND competing.target_key = OLD.target_key AND competing.deleted_at IS NULL
      AND competing.busy_operation IS NOT NULL
      AND json_extract(competing.spec_json, '$.worker.resourceUid') = OLD.worker_uid) OR
  NOT EXISTS (SELECT 1 FROM tf_v2_resources version
    JOIN tf_v2_operations op ON op.id = version.last_operation
    WHERE version.uid = NEW.worker_version_uid
      AND version.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
      AND version.principal = OLD.principal AND version.space = OLD.space
      AND version.target_key = OLD.target_key AND version.deleted_at IS NULL
      AND version.phase = 'idle' AND version.busy_operation IS NULL
      AND version.generation = NEW.worker_version_generation
      AND version.observed_generation = version.generation
      AND json_extract(version.spec_json, '$.worker.resourceUid') = OLD.worker_uid
      AND json_extract(version.observed_json, '$.ready') = 1
      AND op.resource_uid = version.uid AND op.generation = version.generation
      AND op.status = 'succeeded' AND op.effect = 'complete'
      AND op.accepted_spec_json = version.spec_json)
  OR NOT EXISTS (SELECT 1 FROM json_each(OLD.selected_versions_json) selected
    WHERE json_extract(selected.value, '$.workerVersionUid') = NEW.worker_version_uid
      AND json_extract(selected.value, '$.generation') = NEW.worker_version_generation
      AND json_extract(selected.value, '$.weight') BETWEEN 1 AND 10000)
)
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_send_unavailable');
END;

CREATE TRIGGER queue_v2_batch_execution_receipt_guard
BEFORE INSERT ON queue_v2_batch_settlements
WHEN (NEW.execution_reservation_token IS NOT NULL OR EXISTS (
    SELECT 1 FROM queue_v2_batch_executions execution
    WHERE execution.batch_id = NEW.batch_id)) AND NOT EXISTS (
    SELECT 1 FROM queue_v2_batch_executions execution
    WHERE execution.batch_id = NEW.batch_id AND execution.state = 'reserved'
      AND execution.reservation_token = NEW.execution_reservation_token
      AND execution.lease_token = NEW.lease_token
      AND execution.queue_id = NEW.queue_id
      AND execution.consumer_uid = NEW.consumer_id
      AND execution.consumer_generation = NEW.generation
      AND execution.reservation_until_ms >
        (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))
  )
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_registration_unavailable');
END;

CREATE TRIGGER queue_v2_batch_execution_settlement_guard
BEFORE UPDATE OF state ON queue_v2_batch_settlements
WHEN NEW.state = 'settling' AND EXISTS (
  SELECT 1 FROM queue_v2_batch_executions execution
  WHERE execution.batch_id = OLD.batch_id
) AND NOT EXISTS (
  SELECT 1 FROM queue_v2_batch_executions execution
  WHERE execution.batch_id = OLD.batch_id
    AND execution.reservation_token = OLD.execution_reservation_token
    AND execution.queue_id = OLD.queue_id
    AND execution.consumer_uid = OLD.consumer_id
    AND execution.consumer_generation = OLD.generation
    AND execution.state IN ('send_authorized','retired')
)
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_execution_send_unavailable');
END;

-- A selected Version cannot be deleted while its exact native handler may
-- still be executing, even when every message in the batch was ACKed.
CREATE TRIGGER queue_v2_batch_execution_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM queue_v2_batch_executions execution
  WHERE execution.worker_version_uid = NEW.resource_uid
    AND execution.state = 'send_authorized'
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

-- Core's generic reference guard proves principal/Space/Form. This attachment
-- additionally requires its immutable execution target to match every target
-- UID at the exact Resource acceptance write, not only at backend dispatch.
CREATE TRIGGER tf_v2_queue_consumer_target_create
BEFORE INSERT ON tf_v2_resources
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND (
    NOT EXISTS (
      SELECT 1 FROM tf_v2_resources target
      WHERE target.uid = json_extract(NEW.spec_json, '$.queue.resourceUid')
        AND target.principal = NEW.principal AND target.space = NEW.space
        AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
        AND target.form_url = 'https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/'
    ) OR NOT EXISTS (
      SELECT 1 FROM tf_v2_resources target
      WHERE target.uid = json_extract(NEW.spec_json, '$.worker.resourceUid')
        AND target.principal = NEW.principal AND target.space = NEW.space
        AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
        AND target.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
    ) OR (
      json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tf_v2_resources target
        WHERE target.uid = json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid')
          AND target.principal = NEW.principal AND target.space = NEW.space
          AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
          AND target.form_url = 'https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

CREATE TRIGGER tf_v2_queue_consumer_target_update
BEFORE UPDATE OF spec_json ON tf_v2_resources
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND NEW.deleted_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1 FROM tf_v2_resources target
      WHERE target.uid = json_extract(NEW.spec_json, '$.queue.resourceUid')
        AND target.principal = NEW.principal AND target.space = NEW.space
        AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
        AND target.form_url = 'https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/'
    ) OR NOT EXISTS (
      SELECT 1 FROM tf_v2_resources target
      WHERE target.uid = json_extract(NEW.spec_json, '$.worker.resourceUid')
        AND target.principal = NEW.principal AND target.space = NEW.space
        AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
        AND target.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
    ) OR (
      json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tf_v2_resources target
        WHERE target.uid = json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid')
          AND target.principal = NEW.principal AND target.space = NEW.space
          AND target.target_key = NEW.target_key AND target.deleted_at IS NULL
          AND target.form_url = 'https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

-- Follow accepted desired DLQ edges and the last positively observed edge of
-- each pending/failed update. Retaining both forbids a cycle while either
-- policy may still own an in-flight message. The accepted Resource update and
-- this trigger run under SQLite's same serialized writer transaction.
CREATE TRIGGER tf_v2_queue_consumer_cycle_create
BEFORE INSERT ON tf_v2_resources
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE edges(source_uid, target_uid) AS (
      SELECT json_extract(resource.spec_json, '$.queue.resourceUid'),
             json_extract(resource.spec_json, '$.deadLetterQueue.resourceUid')
      FROM tf_v2_resources resource
      WHERE resource.form_url = NEW.form_url AND resource.deleted_at IS NULL
        AND json_extract(resource.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
      UNION
      SELECT json_extract(operation.accepted_spec_json, '$.queue.resourceUid'),
             json_extract(operation.accepted_spec_json, '$.deadLetterQueue.resourceUid')
      FROM tf_v2_resources resource
      JOIN tf_v2_operations operation ON operation.resource_uid = resource.uid
        AND operation.generation = resource.observed_generation
        AND operation.status = 'succeeded'
      WHERE resource.form_url = NEW.form_url AND resource.deleted_at IS NULL
        AND json_extract(operation.accepted_spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
    ), reach(uid) AS (
      SELECT json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid')
      UNION
      SELECT edges.target_uid FROM edges JOIN reach ON edges.source_uid = reach.uid
    )
    SELECT 1 FROM reach
    WHERE uid = json_extract(NEW.spec_json, '$.queue.resourceUid')
  ) THEN RAISE(ABORT, 'tf_v2_reference_target_unavailable') END;
END;

CREATE TRIGGER tf_v2_queue_consumer_cycle_update
BEFORE UPDATE OF spec_json ON tf_v2_resources
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
  AND NEW.deleted_at IS NULL
  AND json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE edges(source_uid, target_uid) AS (
      SELECT json_extract(resource.spec_json, '$.queue.resourceUid'),
             json_extract(resource.spec_json, '$.deadLetterQueue.resourceUid')
      FROM tf_v2_resources resource
      WHERE resource.form_url = NEW.form_url AND resource.deleted_at IS NULL
        AND resource.uid <> NEW.uid
        AND json_extract(resource.spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
      UNION
      SELECT json_extract(operation.accepted_spec_json, '$.queue.resourceUid'),
             json_extract(operation.accepted_spec_json, '$.deadLetterQueue.resourceUid')
      FROM tf_v2_resources resource
      JOIN tf_v2_operations operation ON operation.resource_uid = resource.uid
        AND operation.generation = resource.observed_generation
        AND operation.status = 'succeeded'
      WHERE resource.form_url = NEW.form_url AND resource.deleted_at IS NULL
        AND resource.uid <> NEW.uid
        AND json_extract(operation.accepted_spec_json, '$.deadLetterQueue.resourceUid') IS NOT NULL
    ), reach(uid) AS (
      SELECT json_extract(NEW.spec_json, '$.deadLetterQueue.resourceUid')
      UNION
      SELECT edges.target_uid FROM edges JOIN reach ON edges.source_uid = reach.uid
    )
    SELECT 1 FROM reach
    WHERE uid = json_extract(NEW.spec_json, '$.queue.resourceUid')
  ) THEN RAISE(ABORT, 'tf_v2_reference_target_unavailable') END;
END;
