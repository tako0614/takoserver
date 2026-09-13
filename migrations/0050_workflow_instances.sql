-- Runtime state for the INSTANCE surface of the worker.workflow contract.
--
-- A DurableWorkflow resource names a class, not an execution.  These rows are
-- therefore deliberately separate from tf_resources and have no resource UID
-- or generation of their own.  `execution_id` is a private incarnation fence:
-- an author-chosen instance id may be reused only after retention, but old
-- events must never become visible to the replacement execution.
-- All *_at values below are epoch milliseconds from the injected Clock.  The
-- published limits remain seconds and are converted by the domain module.

CREATE TABLE tf_workflow_instances (
  tenant_id TEXT NOT NULL,
  workflow_resource_uid TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  params_json TEXT,
  status TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  retention_until INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workflow_resource_uid, instance_id),
  UNIQUE (execution_id),
  -- SQLite's length(TEXT) stops at an embedded NUL.  IDs and types are
  -- validated as Unicode scalar strings by the domain module, so the schema
  -- only imposes a generous UTF-8 byte bound and does not narrow that grammar.
  CHECK (length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(workflow_resource_uid AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(execution_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (
    params_json IS NULL OR
    length(CAST(params_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (status IN ('queued', 'running', 'sleeping', 'waiting', 'complete', 'errored', 'terminated')),
  CHECK (
    output_json IS NULL OR
    length(CAST(output_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (
    error_json IS NULL OR
    length(CAST(error_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (deadline_at >= created_at),
  -- Early termination starts a fresh terminal-retention window.  A lifetime
  -- expiry instead uses deadline_at + retention; either way retention cannot
  -- precede the instance's creation instant.
  CHECK (retention_until >= created_at),
  CHECK (revision >= 1)
);

CREATE INDEX tf_workflow_instances_retention
  ON tf_workflow_instances (retention_until, tenant_id, workflow_resource_uid, instance_id);

CREATE TABLE tf_workflow_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  workflow_resource_uid TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES tf_workflow_instances (execution_id)
    ON DELETE CASCADE,
  CHECK (length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(workflow_resource_uid AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(execution_id AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (length(CAST(type AS BLOB)) BETWEEN 1 AND 4096),
  CHECK (
    payload_json IS NULL OR
    length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  CHECK (created_at >= 0)
);

CREATE INDEX tf_workflow_events_lookup
  ON tf_workflow_events
    (tenant_id, workflow_resource_uid, instance_id, execution_id, type, event_id);
