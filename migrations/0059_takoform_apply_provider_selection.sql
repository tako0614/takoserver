-- Prospective apply recovery keeps the exact provider selection accepted before
-- the first provider-visible callback. Historical sagas remain NULL: the Host
-- cannot reconstruct yesterday's destination from today's catalog.
ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN selection_json TEXT
  CHECK (
    selection_json IS NULL OR (
      length(CAST(selection_json AS BLOB)) BETWEEN 2 AND 131072 AND
      json_valid(selection_json) AND json_type(selection_json) = 'object'
    )
  );

-- This is intentionally lease-scoped rather than part of the immutable
-- snapshot. Every executor must re-verify the retained selection against the
-- current available composition before it may cross the dispatch marker.
ALTER TABLE tf_provider_mutation_sagas
  ADD COLUMN selection_verified_lease_token TEXT
  CHECK (
    selection_verified_lease_token IS NULL OR
    length(selection_verified_lease_token) BETWEEN 3 AND 128
  );

CREATE TRIGGER tf_provider_mutation_selection_immutable
BEFORE UPDATE OF selection_json ON tf_provider_mutation_sagas
WHEN OLD.selection_json IS NOT NULL AND NEW.selection_json IS NOT OLD.selection_json
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_selection_immutable');
END;

-- A binary which knows the column but did not verify it under its newly
-- acquired lease cannot dispatch. NULL historical rows are deliberately not
-- upgraded or reinterpreted by this trigger.
CREATE TRIGGER tf_provider_mutation_selection_dispatch_verified
BEFORE UPDATE OF execution_started_at ON tf_provider_mutation_sagas
WHEN NEW.selection_json IS NOT NULL AND (
  NEW.selection_verified_lease_token IS NULL OR
  NEW.selection_verified_lease_token IS NOT NEW.execution_lease_token
)
BEGIN
  SELECT RAISE(ABORT, 'takoform_provider_mutation_selection_unverified_constraint');
END;
