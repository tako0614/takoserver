-- A planned provider mutation must have exactly one executor at a time. The
-- first executor explicitly marks the handoff to the provider seam; later
-- acquisitions are recovery-only even after a crash. A lease that dies before
-- that mark remains eligible for an initial dispatch. Lease tokens fence stale
-- receipts, while the started timestamp intentionally survives release and
-- expiry after the provider handoff.

ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN execution_lease_token TEXT
  CHECK (
    execution_lease_token IS NULL OR
    length(execution_lease_token) BETWEEN 3 AND 128
  );

ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN execution_lease_until INTEGER
  CHECK (execution_lease_until IS NULL OR execution_lease_until >= 0);

ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN execution_started_at INTEGER
  CHECK (execution_started_at IS NULL OR execution_started_at >= created_at);

CREATE INDEX tf_provider_mutation_sagas_execution_lease
  ON tf_provider_mutation_sagas (phase, execution_lease_until);
