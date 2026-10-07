-- Durable at-least-once obligations for one exact UTC WorkerCronTrigger match.
-- This is delivery state for v2 Resource operations, not a second Resource or
-- Operation ledger and not the legacy provider scheduler.
CREATE TABLE tf_v2_worker_cron_matches (
  match_id TEXT PRIMARY KEY CHECK (
    length(match_id) = 71 AND substr(match_id, 1, 7) = 'sha256:' AND
    substr(match_id, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  target_key TEXT NOT NULL,
  trigger_generation INTEGER NOT NULL CHECK (trigger_generation > 0),
  trigger_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
  trigger_settled_at TEXT NOT NULL,
  worker_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  cron TEXT NOT NULL CHECK (length(cron) BETWEEN 9 AND 64),
  scheduled_time_ms INTEGER NOT NULL CHECK (scheduled_time_ms >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'resolved', 'rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= created_at_ms),
  lease_token TEXT,
  lease_until_ms INTEGER,
  result_version_uid TEXT REFERENCES tf_v2_resources(uid),
  error_code TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (trigger_uid, cron, scheduled_time_ms),
  CHECK ((state = 'dispatching') = (lease_token IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until_ms IS NULL)),
  CHECK ((state IN ('resolved', 'rejected')) = (result_version_uid IS NOT NULL)),
  CHECK ((state = 'rejected') = (error_code IS NOT NULL))
);
CREATE INDEX tf_v2_worker_cron_matches_due
  ON tf_v2_worker_cron_matches(state, next_attempt_at_ms, lease_until_ms, scheduled_time_ms, match_id);
CREATE INDEX tf_v2_worker_cron_matches_trigger
  ON tf_v2_worker_cron_matches(trigger_uid, state, scheduled_time_ms);

-- Serialize CronTrigger acceptance against a pending Deployment acceptance.
-- Both acceptance paths insert their immutable reference sets in the same
-- database batch as the queued Operation, so this guard closes the interval
-- between a Deployment's attachment snapshot and its native publication.
-- Reuse the existing dependency-conflict classification at the v2 boundary.
CREATE TRIGGER tf_v2_worker_cron_deployment_acceptance_guard
BEFORE INSERT ON tf_v2_operation_references
WHEN NEW.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
  AND (
    SELECT 1
    FROM tf_v2_operations cron_operation
    JOIN tf_v2_resources cron_resource ON cron_resource.uid = cron_operation.resource_uid
    JOIN tf_v2_operations deployment_operation
      ON deployment_operation.principal = cron_operation.principal
    JOIN tf_v2_resources deployment_resource
      ON deployment_resource.uid = deployment_operation.resource_uid
    WHERE cron_operation.id = NEW.operation_id
      AND cron_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/'
      AND cron_operation.action IN ('create', 'update')
      AND cron_operation.status = 'queued'
      AND cron_operation.resource_uid = cron_resource.uid
      AND cron_operation.principal = cron_resource.principal
      AND cron_operation.generation = cron_resource.generation
      AND cron_operation.accepted_spec_json = cron_resource.spec_json
      AND deployment_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/'
      AND deployment_resource.principal = cron_resource.principal
      AND deployment_resource.space = cron_resource.space
      AND deployment_resource.deleted_at IS NULL
      AND deployment_operation.resource_uid = deployment_resource.uid
      AND deployment_operation.action IN ('create', 'update')
      AND deployment_operation.status IN ('queued', 'running', 'waiting_input', 'reconciling')
      AND deployment_operation.target_key = cron_operation.target_key
      AND deployment_operation.generation = deployment_resource.generation
      AND deployment_operation.accepted_spec_json = deployment_resource.spec_json
      AND json_extract(deployment_operation.accepted_spec_json, '$.worker.resourceUid') = NEW.target_uid
      AND json_extract(cron_operation.accepted_spec_json, '$.worker.resourceUid') = NEW.target_uid
  UNION ALL
    SELECT 1
    FROM tf_v2_operations deployment_operation
    JOIN tf_v2_resources deployment_resource ON deployment_resource.uid = deployment_operation.resource_uid
    JOIN tf_v2_operations cron_operation
      ON cron_operation.principal = deployment_operation.principal
    JOIN tf_v2_resources cron_resource ON cron_resource.uid = cron_operation.resource_uid
    WHERE deployment_operation.id = NEW.operation_id
      AND deployment_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/'
      AND deployment_operation.action IN ('create', 'update')
      AND deployment_operation.status = 'queued'
      AND deployment_operation.resource_uid = deployment_resource.uid
      AND deployment_operation.principal = deployment_resource.principal
      AND deployment_operation.generation = deployment_resource.generation
      AND deployment_operation.accepted_spec_json = deployment_resource.spec_json
      AND json_extract(deployment_operation.accepted_spec_json, '$.worker.resourceUid') = NEW.target_uid
      AND cron_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/'
      AND cron_resource.principal = deployment_resource.principal
      AND cron_resource.space = deployment_resource.space
      AND cron_resource.deleted_at IS NULL
      AND cron_operation.resource_uid = cron_resource.uid
      AND cron_operation.action IN ('create', 'update')
      AND cron_operation.status IN ('queued', 'running', 'waiting_input', 'reconciling')
      AND cron_operation.target_key = deployment_operation.target_key
      AND cron_operation.generation = cron_resource.generation
      AND cron_operation.accepted_spec_json = cron_resource.spec_json
      AND json_extract(cron_operation.accepted_spec_json, '$.worker.resourceUid') = NEW.target_uid
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_reference_target_unavailable');
END;

-- A match can only be recorded for the exact currently settled Attachment and
-- an exact settled Worker Deployment whose every selected Version declares the
-- scheduled handler. The complete operation-reference sets and active edges
-- are checked in the same statement that inserts the match.
CREATE TRIGGER tf_v2_worker_cron_match_insert_guard
BEFORE INSERT ON tf_v2_worker_cron_matches
WHEN EXISTS (
  SELECT 1 FROM tf_v2_worker_cron_matches outstanding
  WHERE outstanding.trigger_uid = NEW.trigger_uid
    AND outstanding.scheduled_time_ms < NEW.scheduled_time_ms
    AND outstanding.state NOT IN ('resolved', 'rejected')
) OR NOT EXISTS (
  SELECT 1
  FROM tf_v2_resources trigger_resource
  JOIN tf_v2_operations trigger_operation ON trigger_operation.id = trigger_resource.last_operation
  JOIN tf_v2_operation_reference_sets trigger_ref_set
    ON trigger_ref_set.operation_id = trigger_operation.id AND trigger_ref_set.sealed = 1
  JOIN tf_v2_operation_references trigger_ref
    ON trigger_ref.operation_id = trigger_operation.id
   AND trigger_ref.target_uid = NEW.worker_uid
   AND trigger_ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
   AND trigger_ref.readiness = 'observed'
  JOIN tf_v2_resource_references trigger_edge
    ON trigger_edge.target_uid = NEW.worker_uid AND trigger_edge.referrer_uid = NEW.trigger_uid
  JOIN tf_v2_resources worker ON worker.uid = NEW.worker_uid
  JOIN tf_v2_resources deployment
    ON deployment.uid = json_extract(worker.observed_json, '$.activeDeploymentUid')
  JOIN tf_v2_operations deployment_operation ON deployment_operation.id = deployment.last_operation
  JOIN tf_v2_operation_reference_sets deployment_ref_set
    ON deployment_ref_set.operation_id = deployment_operation.id AND deployment_ref_set.sealed = 1
  WHERE trigger_resource.uid = NEW.trigger_uid
    AND trigger_resource.principal = NEW.principal AND trigger_resource.space = NEW.space
    AND trigger_resource.target_key = NEW.target_key
    AND trigger_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/'
    AND trigger_resource.deleted_at IS NULL AND trigger_resource.phase = 'idle'
    AND trigger_resource.busy_operation IS NULL
    AND trigger_resource.generation = NEW.trigger_generation
    AND trigger_resource.observed_generation = trigger_resource.generation
    AND trigger_resource.last_operation = NEW.trigger_operation_id
    AND trigger_operation.resource_uid = trigger_resource.uid
    AND trigger_operation.principal = NEW.principal
    AND trigger_operation.target_key = NEW.target_key
    AND trigger_operation.action IN ('create', 'update')
    AND trigger_operation.status = 'succeeded'
    AND trigger_operation.generation = NEW.trigger_generation
    AND trigger_operation.accepted_spec_json = trigger_resource.spec_json
    AND trigger_operation.updated_at = NEW.trigger_settled_at
    AND NEW.trigger_settled_at <= strftime(
      '%Y-%m-%dT%H:%M:%fZ', NEW.scheduled_time_ms / 1000.0, 'unixepoch'
    )
    AND json_extract(trigger_resource.spec_json, '$.worker.resourceUid') = NEW.worker_uid
    AND json_extract(trigger_resource.spec_json, '$.cron') = NEW.cron
    AND worker.principal = NEW.principal AND worker.space = NEW.space
    AND worker.target_key = NEW.target_key
    AND worker.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
    AND worker.deleted_at IS NULL AND worker.phase = 'idle' AND worker.busy_operation IS NULL
    AND worker.generation = worker.observed_generation
    AND json_type(worker.observed_json, '$.ready') = 'true'
    AND json_type(worker.observed_json, '$.activeDeploymentUid') = 'text'
    AND deployment.principal = NEW.principal AND deployment.space = NEW.space
    AND deployment.target_key = NEW.target_key
    AND deployment.form_url = 'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/'
    AND deployment.deleted_at IS NULL AND deployment.phase = 'idle' AND deployment.busy_operation IS NULL
    AND deployment.generation = deployment.observed_generation
    AND deployment_operation.resource_uid = deployment.uid
    AND deployment_operation.principal = NEW.principal
    AND deployment_operation.target_key = NEW.target_key
    AND deployment_operation.action IN ('create', 'update')
    AND deployment_operation.status = 'succeeded'
    AND deployment_operation.generation = deployment.generation
    AND deployment_operation.accepted_spec_json = deployment.spec_json
    AND json_extract(deployment.spec_json, '$.worker.resourceUid') = worker.uid
    AND json_type(deployment.observed_json, '$.ready') = 'true'
    AND json_extract(deployment.observed_json, '$.active') = 1
    AND json_type(deployment.observed_json, '$.selectedVersions') = 'array'
    AND json_array_length(json_extract(deployment.observed_json, '$.selectedVersions')) =
      json_array_length(json_extract(deployment.spec_json, '$.versions'))
    AND EXISTS (
      SELECT 1 FROM tf_v2_operation_references deployment_worker_ref
      WHERE deployment_worker_ref.operation_id = deployment_operation.id
        AND deployment_worker_ref.target_uid = worker.uid
        AND deployment_worker_ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
        AND deployment_worker_ref.readiness = 'observed'
    )
    AND EXISTS (
      SELECT 1 FROM tf_v2_resource_references deployment_worker_edge
      WHERE deployment_worker_edge.target_uid = worker.uid
        AND deployment_worker_edge.referrer_uid = deployment.uid
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(deployment.spec_json, '$.versions') desired
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(deployment.observed_json, '$.selectedVersions') selected
        WHERE json_extract(selected.value, '$.resourceUid') =
                json_extract(desired.value, '$.workerVersion.resourceUid')
          AND json_extract(selected.value, '$.weight') = json_extract(desired.value, '$.weight')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(deployment.spec_json, '$.versions') desired
      WHERE NOT EXISTS (
        SELECT 1 FROM tf_v2_operation_references deployment_version_ref
        WHERE deployment_version_ref.operation_id = deployment_operation.id
          AND deployment_version_ref.target_uid =
            json_extract(desired.value, '$.workerVersion.resourceUid')
          AND deployment_version_ref.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
          AND deployment_version_ref.readiness = 'ready'
      ) OR NOT EXISTS (
        SELECT 1 FROM tf_v2_resource_references deployment_version_edge
        WHERE deployment_version_edge.target_uid =
            json_extract(desired.value, '$.workerVersion.resourceUid')
          AND deployment_version_edge.referrer_uid = deployment.uid
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(deployment.spec_json, '$.versions') desired
      LEFT JOIN tf_v2_resources version
        ON version.uid = json_extract(desired.value, '$.workerVersion.resourceUid')
      LEFT JOIN tf_v2_operations version_operation ON version_operation.id = version.last_operation
      LEFT JOIN tf_v2_operation_reference_sets version_ref_set
        ON version_ref_set.operation_id = version_operation.id AND version_ref_set.sealed = 1
      WHERE version.uid IS NULL OR version_ref_set.operation_id IS NULL
        OR version.principal IS NOT NEW.principal OR version.space IS NOT NEW.space
        OR version.target_key IS NOT NEW.target_key
        OR version.form_url <> 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        OR version.deleted_at IS NOT NULL OR version.phase <> 'idle'
        OR version.busy_operation IS NOT NULL OR version.generation <> version.observed_generation
        OR COALESCE(json_type(version.observed_json, '$.ready'), '') <> 'true'
        OR json_extract(version.spec_json, '$.worker.resourceUid') IS NOT worker.uid
        OR NOT EXISTS (
          SELECT 1 FROM json_each(version.spec_json, '$.handlers') handler
          WHERE handler.value = 'scheduled'
        )
        OR version.last_operation IS NOT version_operation.id
        OR version_operation.resource_uid IS NOT version.uid
        OR version_operation.principal IS NOT NEW.principal
        OR version_operation.target_key IS NOT NEW.target_key
        OR version_operation.action NOT IN ('create', 'update')
        OR version_operation.status IS NOT 'succeeded'
        OR version_operation.generation IS NOT version.generation
        OR version_operation.accepted_spec_json IS NOT version.spec_json
        OR NOT EXISTS (
          SELECT 1 FROM tf_v2_operation_references worker_ref
          WHERE worker_ref.operation_id = version_operation.id
            AND worker_ref.target_uid = worker.uid
            AND worker_ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
            AND worker_ref.readiness = 'observed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM tf_v2_resource_references edge
          WHERE edge.target_uid = worker.uid AND edge.referrer_uid = version.uid
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_constraint_unavailable');
END;

CREATE TRIGGER tf_v2_worker_cron_match_identity_immutable
BEFORE UPDATE ON tf_v2_worker_cron_matches
WHEN NEW.match_id IS NOT OLD.match_id OR NEW.trigger_uid IS NOT OLD.trigger_uid OR
  NEW.principal IS NOT OLD.principal OR NEW.space IS NOT OLD.space OR
  NEW.target_key IS NOT OLD.target_key OR
  NEW.trigger_generation IS NOT OLD.trigger_generation OR
  NEW.trigger_operation_id IS NOT OLD.trigger_operation_id OR
  NEW.trigger_settled_at IS NOT OLD.trigger_settled_at OR
  NEW.worker_uid IS NOT OLD.worker_uid OR NEW.cron IS NOT OLD.cron OR
  NEW.scheduled_time_ms IS NOT OLD.scheduled_time_ms OR
  NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_immutable');
END;

CREATE TRIGGER tf_v2_worker_cron_match_transition
BEFORE UPDATE ON tf_v2_worker_cron_matches
WHEN NOT (
  OLD.state = 'pending' AND NEW.state = 'dispatching' AND
    OLD.attempts = NEW.attempts - 1 AND OLD.lease_token IS NULL AND
    NEW.lease_token IS NOT NULL AND NEW.next_attempt_at_ms = OLD.next_attempt_at_ms AND
    NEW.result_version_uid IS NULL AND NEW.error_code IS NULL
  OR OLD.state = 'dispatching' AND NEW.state = 'dispatching' AND
    NEW.attempts = OLD.attempts + 1 AND NEW.lease_token IS NOT OLD.lease_token AND
    OLD.lease_until_ms <= NEW.updated_at_ms AND NEW.lease_until_ms > NEW.updated_at_ms AND
    NEW.next_attempt_at_ms = OLD.next_attempt_at_ms AND
    NEW.result_version_uid IS NULL AND NEW.error_code IS NULL
  OR OLD.state = 'dispatching' AND NEW.state = 'dispatching' AND
    NEW.attempts = OLD.attempts AND NEW.lease_token = OLD.lease_token AND
    NEW.lease_until_ms > OLD.lease_until_ms AND NEW.result_version_uid IS NULL AND NEW.error_code IS NULL
  OR OLD.state = 'dispatching' AND NEW.state = 'pending' AND
    NEW.attempts = OLD.attempts AND NEW.lease_token IS NULL AND NEW.lease_until_ms IS NULL AND
    NEW.next_attempt_at_ms > OLD.next_attempt_at_ms AND
    NEW.result_version_uid IS NULL AND NEW.error_code IS NULL
  OR OLD.state = 'dispatching' AND NEW.state = 'resolved' AND
    NEW.attempts = OLD.attempts AND NEW.lease_token IS NULL AND NEW.lease_until_ms IS NULL AND
    NEW.result_version_uid IS NOT NULL AND NEW.error_code IS NULL AND
    NEW.next_attempt_at_ms = OLD.next_attempt_at_ms
  OR OLD.state = 'dispatching' AND NEW.state = 'rejected' AND
    NEW.attempts = OLD.attempts AND NEW.lease_token IS NULL AND NEW.lease_until_ms IS NULL AND
    NEW.result_version_uid IS NOT NULL AND NEW.error_code IS NOT NULL AND
    NEW.next_attempt_at_ms = OLD.next_attempt_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_transition');
END;

CREATE TRIGGER tf_v2_worker_cron_match_transition_guard
BEFORE UPDATE ON tf_v2_worker_cron_matches
WHEN NEW.state = 'dispatching' AND NEW.lease_token IS NOT OLD.lease_token
  AND NOT EXISTS (
    SELECT 1 FROM tf_v2_resources trigger_resource
    WHERE trigger_resource.uid = OLD.trigger_uid
      AND trigger_resource.principal = OLD.principal AND trigger_resource.space = OLD.space
      AND trigger_resource.target_key = OLD.target_key
      AND trigger_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/'
      AND trigger_resource.generation >= OLD.trigger_generation
      AND trigger_resource.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_claim_unavailable');
END;

CREATE TRIGGER tf_v2_worker_cron_match_no_delete
BEFORE DELETE ON tf_v2_worker_cron_matches
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_immutable');
END;
