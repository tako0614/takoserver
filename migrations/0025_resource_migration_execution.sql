-- A Resource Migration crosses several external mutation boundaries. Keep one
-- durable executor at a time, remember whether provider dispatch began, and
-- persist acknowledged phase receipts/handles before advancing logical state.
-- Existing in-flight rows are recovery-only because an older build may have
-- reached the provider without recording an acknowledgement.

ALTER TABLE tf_resource_migrations
  ADD COLUMN execution_lease_token TEXT
  CHECK (
    execution_lease_token IS NULL OR
    length(execution_lease_token) BETWEEN 3 AND 128
  );

ALTER TABLE tf_resource_migrations
  ADD COLUMN execution_lease_until INTEGER
  CHECK (execution_lease_until IS NULL OR execution_lease_until >= 0);

ALTER TABLE tf_resource_migrations
  ADD COLUMN execution_started_at INTEGER
  CHECK (execution_started_at IS NULL OR execution_started_at >= 0);

ALTER TABLE tf_resource_migrations
  ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    length(execution_json) BETWEEN 2 AND 1048576
  );

UPDATE tf_resource_migrations
SET execution_started_at = updated_at
WHERE state IN ('provisioning', 'transferring');
