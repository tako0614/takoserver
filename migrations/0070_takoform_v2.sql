-- Independent v2 authority. The v1 tables and their existing records remain intact.
CREATE TABLE tf_v2_resources (
  uid TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  form_url TEXT NOT NULL,
  space TEXT NOT NULL,
  name TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  active_name TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  observed_generation INTEGER NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
  observed_at TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'idle', 'deleting', 'error')),
  spec_json TEXT NOT NULL,
  observed_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  last_operation TEXT NOT NULL,
  busy_operation TEXT,
  deleted_at TEXT,
  CHECK (observed_generation <= generation),
  CHECK ((active_name IS NULL) = (deleted_at IS NOT NULL)),
  CHECK (active_name IS NULL OR active_name = name)
);
CREATE UNIQUE INDEX tf_v2_resources_active_name ON tf_v2_resources(space, active_name);
CREATE INDEX tf_v2_resources_principal_uid ON tf_v2_resources(principal, uid)
  WHERE deleted_at IS NULL;
CREATE INDEX tf_v2_resources_principal_space_uid ON tf_v2_resources(principal, space, uid)
  WHERE deleted_at IS NULL;
CREATE INDEX tf_v2_resources_principal_name_uid ON tf_v2_resources(principal, name, uid)
  WHERE deleted_at IS NULL;
CREATE INDEX tf_v2_resources_principal_form_uid ON tf_v2_resources(principal, form_url, uid)
  WHERE deleted_at IS NULL;

CREATE TABLE tf_v2_operations (
  id TEXT PRIMARY KEY,
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_input', 'reconciling', 'succeeded', 'failed')),
  effect TEXT NOT NULL CHECK (effect IN ('none', 'unknown', 'partial', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  backend_key TEXT NOT NULL UNIQUE,
  accepted_spec_json TEXT NOT NULL,
  dispatch_possible INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_possible IN (0, 1)),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at_ms >= 0),
  lease_token TEXT,
  lease_until_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  result_observed_json TEXT,
  result_output_json TEXT,
  UNIQUE(principal, replay_key),
  CHECK ((status = 'succeeded' AND effect = 'complete' AND error_code IS NULL AND error_message IS NULL) OR
         (status = 'failed' AND effect IN ('none', 'partial') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
         (status = 'reconciling' AND effect = 'unknown' AND
           ((error_code IS NULL AND error_message IS NULL) OR
            (error_code IS NOT NULL AND error_message IS NOT NULL))) OR
         (status IN ('queued', 'running', 'waiting_input') AND effect = 'none' AND
           error_code IS NULL AND error_message IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_until_ms IS NULL))
);
CREATE INDEX tf_v2_operations_work ON tf_v2_operations(status, lease_until_ms, created_at);
CREATE INDEX tf_v2_operations_due ON tf_v2_operations(next_attempt_at_ms, created_at, id)
  WHERE status IN ('queued', 'running', 'reconciling');
CREATE INDEX tf_v2_operations_resource ON tf_v2_operations(resource_uid, created_at);

CREATE TRIGGER tf_v2_resource_identity_immutable BEFORE UPDATE ON tf_v2_resources
WHEN NEW.uid IS NOT OLD.uid OR NEW.principal IS NOT OLD.principal OR
  NEW.form_url IS NOT OLD.form_url OR NEW.space IS NOT OLD.space OR
  NEW.name IS NOT OLD.name OR NEW.backend_id IS NOT OLD.backend_id OR
  NEW.target_key IS NOT OLD.target_key
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_resource_identity_immutable');
END;

CREATE TRIGGER tf_v2_operation_identity_immutable BEFORE UPDATE ON tf_v2_operations
WHEN NEW.id IS NOT OLD.id OR NEW.resource_uid IS NOT OLD.resource_uid OR
  NEW.principal IS NOT OLD.principal OR NEW.replay_key IS NOT OLD.replay_key OR
  NEW.request_fingerprint IS NOT OLD.request_fingerprint OR
  NEW.action IS NOT OLD.action OR NEW.generation IS NOT OLD.generation OR
  NEW.created_at IS NOT OLD.created_at OR NEW.backend_id IS NOT OLD.backend_id OR
  NEW.target_key IS NOT OLD.target_key OR NEW.backend_key IS NOT OLD.backend_key OR
  NEW.accepted_spec_json IS NOT OLD.accepted_spec_json
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_identity_immutable');
END;

CREATE TRIGGER tf_v2_operation_transition BEFORE UPDATE OF status ON tf_v2_operations
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status = 'running') OR
  (OLD.status = 'running' AND NEW.status IN ('running', 'reconciling')) OR
  (OLD.status = 'reconciling' AND NEW.status IN ('reconciling', 'succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_operation_invalid_transition');
END;

CREATE TRIGGER tf_v2_terminal_guard BEFORE UPDATE OF status ON tf_v2_operations
WHEN NEW.status IN ('succeeded', 'failed') AND OLD.status NOT IN ('succeeded', 'failed')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tf_v2_resources r WHERE r.uid = NEW.resource_uid
      AND r.generation = NEW.generation AND r.busy_operation = NEW.id
      AND r.last_operation = NEW.id
  ) THEN RAISE(ABORT, 'tf_v2_terminal_resource_mismatch') END;
END;

CREATE TRIGGER tf_v2_terminal_project AFTER UPDATE OF status ON tf_v2_operations
WHEN NEW.status IN ('succeeded', 'failed') AND OLD.status NOT IN ('succeeded', 'failed')
BEGIN
  UPDATE tf_v2_resources SET
    phase = CASE WHEN NEW.status = 'failed' THEN 'error' ELSE 'idle' END,
    observed_generation = CASE WHEN NEW.status = 'succeeded' THEN NEW.generation ELSE observed_generation END,
    observed_at = CASE WHEN NEW.result_observed_json IS NOT NULL THEN NEW.updated_at ELSE observed_at END,
    observed_json = COALESCE(NEW.result_observed_json, observed_json),
    output_json = COALESCE(NEW.result_output_json, output_json),
    active_name = CASE WHEN NEW.status = 'succeeded' AND NEW.action = 'delete' THEN NULL ELSE active_name END,
    deleted_at = CASE WHEN NEW.status = 'succeeded' AND NEW.action = 'delete' THEN NEW.updated_at ELSE deleted_at END,
    busy_operation = NULL
  WHERE uid = NEW.resource_uid;
END;
