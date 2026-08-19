-- Relations are host-owned identity pins, not desired state and not provider
-- outputs. Keeping the complete set in the Resource row makes the optimistic
-- Resource CAS and relation replacement one atomic D1 statement.
ALTER TABLE tf_resources
  ADD COLUMN relations_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(relations_json) AND
    json_type(relations_json) = 'array' AND
    length(relations_json) BETWEEN 2 AND 1048576
  );
