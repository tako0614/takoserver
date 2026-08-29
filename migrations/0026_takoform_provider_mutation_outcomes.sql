-- A provider dispatch may be accepted without an acknowledgement. Keep its
-- opaque handle and outcome beside the durable saga so a later executor polls
-- or repairs the same mutation instead of issuing a second write.
ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN provider_handle TEXT
  CHECK (
    provider_handle IS NULL OR
    length(provider_handle) BETWEEN 1 AND 4096
  );

ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN provider_outcome TEXT NOT NULL DEFAULT 'planned'
  CHECK (provider_outcome IN ('planned', 'running', 'indeterminate'));

-- 0024 could only remember that dispatch started. Those rows have no receipt
-- or provider handle, so retain them as explicit indeterminate recovery rather
-- than allowing a later build to treat them as fresh plans.
UPDATE tf_provider_mutation_sagas
SET provider_outcome = 'indeterminate'
WHERE phase = 'planned' AND execution_started_at IS NOT NULL;

CREATE INDEX tf_provider_mutation_sagas_provider_outcome
  ON tf_provider_mutation_sagas (phase, provider_outcome, execution_lease_until);
