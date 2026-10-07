-- A provider-origin terminal execution receipt belongs to the existing
-- admitted invocation, not to a second desired-state or Operation ledger.
-- Historical sent rows remain unresolved until their own positive receipt.
ALTER TABLE tf_v2_worker_invocations ADD COLUMN retired_at_ms INTEGER
  CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0);
ALTER TABLE tf_v2_worker_invocations ADD COLUMN retirement_receipt_digest TEXT
  CHECK (retirement_receipt_digest IS NULL OR (
    length(retirement_receipt_digest) = 71 AND
    substr(retirement_receipt_digest, 1, 7) = 'sha256:' AND
    substr(retirement_receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ));
CREATE UNIQUE INDEX tf_v2_worker_invocations_retirement_receipt
  ON tf_v2_worker_invocations(retirement_receipt_digest)
  WHERE retirement_receipt_digest IS NOT NULL;
CREATE INDEX tf_v2_worker_invocations_deployment_unresolved
  ON tf_v2_worker_invocations(deployment_uid, invocation_id)
  WHERE phase <> 'pre_effect_refused' AND retired_at_ms IS NULL;

CREATE TRIGGER tf_v2_worker_invocations_no_retired_insert
BEFORE INSERT ON tf_v2_worker_invocations
WHEN NEW.retired_at_ms IS NOT NULL OR NEW.retirement_receipt_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_retirement_requires_send');
END;

CREATE TRIGGER tf_v2_worker_invocations_retirement_monotonic
BEFORE UPDATE OF retired_at_ms, retirement_receipt_digest ON tf_v2_worker_invocations
WHEN NEW.retired_at_ms IS NOT OLD.retired_at_ms OR
  NEW.retirement_receipt_digest IS NOT OLD.retirement_receipt_digest
BEGIN
  SELECT CASE WHEN OLD.retired_at_ms IS NOT NULL OR
    OLD.retirement_receipt_digest IS NOT NULL OR
    OLD.phase <> 'send_authorized' OR NEW.phase <> 'send_authorized' OR
    OLD.send_authorized_at_ms IS NULL OR
    NEW.retired_at_ms IS NULL OR NEW.retirement_receipt_digest IS NULL OR
    NEW.retired_at_ms < OLD.send_authorized_at_ms
  THEN RAISE(ABORT, 'tf_v2_worker_invocation_retirement_immutable') END;
END;

-- 0076 conservatively held every sent invocation forever. Replace only its
-- accepted-Version delete predicate; the original migration bytes stay fixed.
DROP TRIGGER tf_v2_worker_invocation_version_delete_guard;
CREATE TRIGGER tf_v2_worker_invocation_version_delete_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.action = 'delete' AND EXISTS (
  SELECT 1 FROM tf_v2_worker_invocations i
  WHERE i.version_uid = NEW.resource_uid
    AND i.phase <> 'pre_effect_refused' AND i.retired_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_invocation_live_reference');
END;
