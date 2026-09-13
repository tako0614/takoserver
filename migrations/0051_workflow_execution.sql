-- Execution ownership and durable step state for the worker.workflow runtime.
--
-- The instance row remains the public execution fence.  These columns add an
-- internal run lease and wake-up cursor without changing the 0050 identity or
-- retention contract.  Steps refer to that fence by both execution id and the
-- immutable creation timestamp so an id reused after retention cannot inherit
-- an older execution's journal.

ALTER TABLE tf_workflow_instances
  ADD COLUMN run_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (run_epoch >= 0);

ALTER TABLE tf_workflow_instances
  ADD COLUMN run_owner TEXT
  CHECK (
    run_owner IS NULL OR
    length(CAST(run_owner AS BLOB)) BETWEEN 1 AND 4096
  );

ALTER TABLE tf_workflow_instances
  ADD COLUMN run_lease_until INTEGER
  CHECK (
    (run_owner IS NULL AND run_lease_until IS NULL) OR
    (run_owner IS NOT NULL AND run_lease_until IS NOT NULL AND run_lease_until >= 0)
  );

ALTER TABLE tf_workflow_instances
  ADD COLUMN wake_at INTEGER
  CHECK (wake_at IS NULL OR wake_at >= 0);

ALTER TABLE tf_workflow_instances
  ADD COLUMN pending_step_name TEXT
  CHECK (
    pending_step_name IS NULL OR
    length(CAST(pending_step_name AS BLOB)) BETWEEN 1 AND 4096
  );

CREATE UNIQUE INDEX tf_workflow_instances_execution_created
  ON tf_workflow_instances (execution_id, created_at);

CREATE TABLE tf_workflow_steps (
  tenant_id TEXT NOT NULL,
  workflow_resource_uid TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  execution_created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  retry_progress_json TEXT,
  config_json TEXT,
  wait_type TEXT,
  wake_at INTEGER,
  timeout_at INTEGER,
  result_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (execution_id, execution_created_at, name),
  FOREIGN KEY (execution_id, execution_created_at)
    REFERENCES tf_workflow_instances (execution_id, created_at)
    ON DELETE CASCADE,
  CHECK (length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(workflow_resource_uid AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(execution_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (
    wait_type IS NULL OR
    length(CAST(wait_type AS BLOB)) BETWEEN 1 AND 4096
  ),
  CHECK (kind IN ('do', 'sleep', 'wait')),
  CHECK (state IN ('pending', 'retry_wait', 'waiting', 'complete', 'errored')),
  CHECK (
    retry_progress_json IS NULL OR
    length(CAST(retry_progress_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (
    config_json IS NULL OR
    length(CAST(config_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (wake_at IS NULL OR wake_at >= 0),
  CHECK (timeout_at IS NULL OR timeout_at >= 0),
  CHECK (
    result_json IS NULL OR
    length(CAST(result_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (
    error_json IS NULL OR
    length(CAST(error_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (execution_created_at >= 0),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (revision >= 1),
  CHECK (kind = 'wait' OR (wait_type IS NULL AND timeout_at IS NULL))
);
