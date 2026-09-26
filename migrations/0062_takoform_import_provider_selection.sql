-- A pre-0062 writer may have admitted an import and projected dependencies
-- before it reached dispatch. Do not alter that database in place: without an
-- explicit protocol marker the row cannot be safely resumed or refused. This
-- transient primary-key guard aborts the migration before the first ALTER and
-- is rolled back with it when any planned import is present. Executed receipts
-- are intentionally allowed through and remain historical evidence.
CREATE TABLE tf_provider_mutation_import_selection_migration_guard (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 0)
);

CREATE TRIGGER tf_provider_mutation_import_selection_migration_guard_abort
BEFORE INSERT ON tf_provider_mutation_import_selection_migration_guard
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_migration_requires_quiescence');
END;

INSERT INTO tf_provider_mutation_import_selection_migration_guard (singleton)
SELECT 0
FROM tf_provider_mutation_sagas_selection_v1
WHERE protocol_generation = 1
  AND operation_kind = 'import'
  AND phase = 'planned'
  AND receipt_json IS NULL
LIMIT 1;

DROP TRIGGER tf_provider_mutation_import_selection_migration_guard_abort;
DROP TABLE tf_provider_mutation_import_selection_migration_guard;

-- Import recovery needs the same bounded, immutable provider selection proof as
-- apply recovery. Historical rows remain NULL: an older writer did not retain
-- this evidence and cannot be backfilled after the provider handoff.
ALTER TABLE tf_provider_mutation_sagas_selection_v1
  ADD COLUMN import_selection_json TEXT
  CHECK (
    import_selection_json IS NULL OR (
      operation_kind = 'import' AND
      length(CAST(import_selection_json AS BLOB)) BETWEEN 2 AND 131072 AND
      json_valid(import_selection_json) AND
      json_type(import_selection_json) = 'object'
    )
  );

ALTER TABLE tf_provider_mutation_sagas_selection_v1
  ADD COLUMN import_selection_protocol INTEGER
  CHECK (
    import_selection_protocol IS NULL OR (
      operation_kind = 'import' AND import_selection_protocol = 1
    )
  );

ALTER TABLE tf_provider_mutation_sagas_selection_v1
  ADD COLUMN import_selection_verified_lease_token TEXT
  CHECK (
    import_selection_verified_lease_token IS NULL OR (
      operation_kind = 'import' AND
      import_selection_json IS NOT NULL AND
      length(import_selection_verified_lease_token) BETWEEN 3 AND 128
    )
  );

-- Selection is also the reservation for a native destination. Keep it through
-- executed-but-uncommitted receipts; Host commit publishes the Deployment and
-- retires its saga atomically. Intrinsic imports have no provider destination.
CREATE UNIQUE INDEX tf_provider_mutation_import_native_destination
  ON tf_provider_mutation_sagas_selection_v1 (
    json_extract(import_selection_json, '$.providerInstallationRef'),
    json_extract(import_selection_json, '$.nativeId')
  )
  WHERE operation_kind = 'import' AND import_selection_json IS NOT NULL
    AND json_extract(import_selection_json, '$.kind') = 'provider';

-- A new import must identify the protocol generation at insertion. Historical
-- rows are the only rows allowed to retain NULL after this migration; the
-- migration guard above ensures they are already terminal.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_import_protocol_required
BEFORE INSERT ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.operation_kind = 'import' AND NEW.import_selection_protocol IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_protocol_required');
END;

CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_import_protocol_immutable
BEFORE UPDATE OF import_selection_protocol ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.import_selection_protocol IS NOT OLD.import_selection_protocol
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_protocol_immutable');
END;

-- Import selection is immutable after its first bind, including against a
-- late NULL-to-snapshot recovery write after dispatch.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_import_selection_immutable
BEFORE UPDATE OF import_selection_json ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.import_selection_json IS NOT OLD.import_selection_json AND (
  OLD.import_selection_json IS NOT NULL OR
  OLD.execution_started_at IS NOT NULL OR
  NEW.execution_started_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_immutable');
END;

-- An import may cross the provider boundary only with its retained snapshot
-- and a verification token equal to the lease that owns this dispatch.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_import_dispatch_verified
BEFORE UPDATE OF execution_started_at ON tf_provider_mutation_sagas_selection_v1
WHEN NEW.operation_kind = 'import' AND (
  NEW.import_selection_json IS NULL OR
  NEW.import_selection_verified_lease_token IS NULL OR
  NEW.import_selection_verified_lease_token IS NOT NEW.execution_lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_unverified_constraint');
END;

-- Older binaries must not erase a new bound import when their dispatch is
-- refused. Verified post-dispatch idle settlement and executed receipt commit
-- still own their existing terminal deletion paths.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_import_selection_retained
BEFORE DELETE ON tf_provider_mutation_sagas_selection_v1
WHEN OLD.operation_kind = 'import'
  AND OLD.import_selection_json IS NOT NULL
  AND OLD.phase = 'planned' AND OLD.receipt_json IS NULL
  AND (
    OLD.execution_started_at IS NULL OR
    OLD.import_selection_verified_lease_token IS NOT OLD.execution_lease_token
  )
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_import_selection_retained_constraint');
END;

-- Historical NULL protocol rows are terminal evidence, not disposable plans.
-- Keep a direct old-writer/refusal cleanup from erasing the only record of the
-- pre-0062 admission. New rows carry protocol=1 and use the existing cleanup
-- paths above/below.
CREATE TRIGGER tf_provider_mutation_sagas_selection_v1_historical_import_retained
BEFORE DELETE ON tf_provider_mutation_sagas_selection_v1
WHEN OLD.operation_kind = 'import'
  AND OLD.import_selection_protocol IS NULL
  AND OLD.phase = 'planned' AND OLD.receipt_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_historical_import_retained_constraint');
END;
