-- A durable cross-Resource order for newly accepted v2 Operations. Historical
-- Operations remain unordered; no wall-clock or implicit rowid backfill is safe.
ALTER TABLE tf_v2_operations ADD COLUMN acceptance_order INTEGER
  CHECK (acceptance_order IS NULL OR acceptance_order > 0);
CREATE UNIQUE INDEX tf_v2_operations_acceptance_order
  ON tf_v2_operations(acceptance_order) WHERE acceptance_order IS NOT NULL;

CREATE TABLE tf_v2_operation_acceptance_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_order INTEGER NOT NULL CHECK (last_order >= 0),
  last_operation_id TEXT REFERENCES tf_v2_operations(id),
  CHECK ((last_order = 0 AND last_operation_id IS NULL) OR
         (last_order > 0 AND last_operation_id IS NOT NULL))
);
INSERT INTO tf_v2_operation_acceptance_counter (id, last_order, last_operation_id)
VALUES (1, 0, NULL);

CREATE TRIGGER tf_v2_operation_acceptance_order_insert_guard
BEFORE INSERT ON tf_v2_operations
WHEN NEW.acceptance_order IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_acceptance_order_supplied');
END;

CREATE TRIGGER tf_v2_operation_acceptance_order_assign
AFTER INSERT ON tf_v2_operations
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM tf_v2_operation_acceptance_counter
    WHERE id = 1 AND last_order BETWEEN 0 AND 9223372036854775806
  ) <> 1 THEN RAISE(ABORT, 'tf_v2_operation_acceptance_counter_unavailable') END;
  UPDATE tf_v2_operation_acceptance_counter
    SET last_order = last_order + 1, last_operation_id = NEW.id WHERE id = 1;
  UPDATE tf_v2_operations SET acceptance_order = (
    SELECT last_order FROM tf_v2_operation_acceptance_counter WHERE id = 1
  ) WHERE id = NEW.id AND acceptance_order IS NULL;
END;

CREATE TRIGGER tf_v2_operation_acceptance_order_immutable
BEFORE UPDATE OF acceptance_order ON tf_v2_operations
WHEN OLD.acceptance_order IS NOT NULL OR NEW.acceptance_order IS NULL OR
  NEW.acceptance_order IS NOT (SELECT last_order FROM tf_v2_operation_acceptance_counter WHERE id = 1) OR
  NEW.id IS NOT (SELECT last_operation_id FROM tf_v2_operation_acceptance_counter WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_acceptance_order_immutable');
END;
