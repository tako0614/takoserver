-- Accepted apply authority is a closed, future-only admission record.  The
-- summary is nullable only for rows written before this migration; those rows
-- retain the old exact-head recovery behavior and are never backfilled.
ALTER TABLE tf_deferred_operations_selection_v1
  ADD COLUMN accepted_authority_json TEXT
  CHECK (
    accepted_authority_json IS NULL OR (
      length(CAST(accepted_authority_json AS BLOB)) BETWEEN 2 AND 8192 AND
      json_valid(accepted_authority_json) AND
      json_type(accepted_authority_json) = 'object'
    )
  );

-- The accepted summary is immutable.  In particular, a historical NULL row
-- cannot be upgraded after the fact with guessed authority provenance.
CREATE TRIGGER tf_deferred_operations_selection_v1_accepted_authority_immutable
BEFORE UPDATE OF accepted_authority_json ON tf_deferred_operations_selection_v1
WHEN NEW.accepted_authority_json IS NOT OLD.accepted_authority_json
BEGIN
  SELECT RAISE(ABORT, 'takoform_accepted_authority_immutable');
END;

-- The pre-0061 writer did not persist an accepted apply summary.  Once this
-- migration is installed it must stop at admission rather than create a row
-- that cannot be safely continued.  Import/delete do not carry this authority.
CREATE TRIGGER tf_deferred_operations_selection_v1_apply_acceptance_requires_authority_summary
BEFORE INSERT ON tf_deferred_operations_selection_v1
WHEN NEW.operation = 'apply' AND NEW.accepted_authority_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'takoform_apply_acceptance_requires_authority_summary');
END;
