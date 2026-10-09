-- Forward-only replacement for the already-applied 0080 Cron match guard.
-- The exact predicates and their order are unchanged; balanced AND grouping
-- keeps SQLite's compiled expression tree within D1's depth limit.
DROP TRIGGER tf_v2_worker_cron_match_insert_guard;

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
  WHERE (((((trigger_resource.uid = NEW.trigger_uid
    AND (trigger_resource.principal = NEW.principal
    AND trigger_resource.space = NEW.space))
    AND ((trigger_resource.target_key = NEW.target_key
    AND trigger_resource.form_url = 'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/')
    AND (trigger_resource.deleted_at IS NULL
    AND trigger_resource.phase = 'idle')))
    AND ((trigger_resource.busy_operation IS NULL
    AND (trigger_resource.generation = NEW.trigger_generation
    AND trigger_resource.observed_generation = trigger_resource.generation))
    AND ((trigger_resource.last_operation = NEW.trigger_operation_id
    AND trigger_operation.resource_uid = trigger_resource.uid)
    AND (trigger_operation.principal = NEW.principal
    AND trigger_operation.target_key = NEW.target_key))))
    AND (((trigger_operation.action IN ('create', 'update')
    AND (trigger_operation.status = 'succeeded'
    AND trigger_operation.generation = NEW.trigger_generation))
    AND ((trigger_operation.accepted_spec_json = trigger_resource.spec_json
    AND trigger_operation.updated_at = NEW.trigger_settled_at)
    AND (NEW.trigger_settled_at <= strftime(
      '%Y-%m-%dT%H:%M:%fZ', NEW.scheduled_time_ms / 1000.0, 'unixepoch'
    )
    AND json_extract(trigger_resource.spec_json, '$.worker.resourceUid') = NEW.worker_uid)))
    AND ((json_extract(trigger_resource.spec_json, '$.cron') = NEW.cron
    AND (worker.principal = NEW.principal
    AND worker.space = NEW.space))
    AND ((worker.target_key = NEW.target_key
    AND worker.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/')
    AND (worker.deleted_at IS NULL
    AND worker.phase = 'idle')))))
    AND ((((worker.busy_operation IS NULL
    AND (worker.generation = worker.observed_generation
    AND json_type(worker.observed_json, '$.ready') = 'true'))
    AND ((json_type(worker.observed_json, '$.activeDeploymentUid') = 'text'
    AND deployment.principal = NEW.principal)
    AND (deployment.space = NEW.space
    AND deployment.target_key = NEW.target_key)))
    AND ((deployment.form_url = 'https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/'
    AND (deployment.deleted_at IS NULL
    AND deployment.phase = 'idle'))
    AND ((deployment.busy_operation IS NULL
    AND deployment.generation = deployment.observed_generation)
    AND (deployment_operation.resource_uid = deployment.uid
    AND deployment_operation.principal = NEW.principal))))
    AND (((deployment_operation.target_key = NEW.target_key
    AND (deployment_operation.action IN ('create', 'update')
    AND deployment_operation.status = 'succeeded'))
    AND ((deployment_operation.generation = deployment.generation
    AND deployment_operation.accepted_spec_json = deployment.spec_json)
    AND (json_extract(deployment.spec_json, '$.worker.resourceUid') = worker.uid
    AND json_type(deployment.observed_json, '$.ready') = 'true')))
    AND (((json_extract(deployment.observed_json, '$.active') = 1
    AND json_type(deployment.observed_json, '$.selectedVersions') = 'array')
    AND (json_array_length(json_extract(deployment.observed_json, '$.selectedVersions')) =
      json_array_length(json_extract(deployment.spec_json, '$.versions'))
    AND EXISTS (
      SELECT 1 FROM tf_v2_operation_references deployment_worker_ref
      WHERE deployment_worker_ref.operation_id = deployment_operation.id
        AND deployment_worker_ref.target_uid = worker.uid
        AND deployment_worker_ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
        AND deployment_worker_ref.readiness = 'observed'
    )))
    AND ((EXISTS (
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
    ))
    AND (NOT EXISTS (
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
      WHERE ((((version.uid IS NULL
        OR version_ref_set.operation_id IS NULL)
        OR (version.principal IS NOT NEW.principal
        OR (version.space IS NOT NEW.space
        OR version.target_key IS NOT NEW.target_key)))
        OR ((version.form_url <> 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
        OR (version.deleted_at IS NOT NULL
        OR version.phase <> 'idle'))
        OR (version.busy_operation IS NOT NULL
        OR (version.generation <> version.observed_generation
        OR COALESCE(json_type(version.observed_json, '$.ready'), '') <> 'true'))))
        OR (((json_extract(version.spec_json, '$.worker.resourceUid') IS NOT worker.uid
        OR (NOT EXISTS (
          SELECT 1 FROM json_each(version.spec_json, '$.handlers') handler
          WHERE handler.value = 'scheduled'
        )
        OR version.last_operation IS NOT version_operation.id))
        OR (version_operation.resource_uid IS NOT version.uid
        OR (version_operation.principal IS NOT NEW.principal
        OR version_operation.target_key IS NOT NEW.target_key)))
        OR ((version_operation.action NOT IN ('create', 'update')
        OR (version_operation.status IS NOT 'succeeded'
        OR version_operation.generation IS NOT version.generation))
        OR (version_operation.accepted_spec_json IS NOT version.spec_json
        OR (NOT EXISTS (
          SELECT 1 FROM tf_v2_operation_references worker_ref
          WHERE worker_ref.operation_id = version_operation.id
            AND worker_ref.target_uid = worker.uid
            AND worker_ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
            AND worker_ref.readiness = 'observed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM tf_v2_resource_references edge
          WHERE edge.target_uid = worker.uid AND edge.referrer_uid = version.uid
        ))))))
    )))))))
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_cron_match_constraint_unavailable');
END;
