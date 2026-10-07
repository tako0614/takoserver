import { canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "./forms/at-least-once-queue.ts";
import { parseQueueConsumerSpec } from "./forms/queue-consumer.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./forms/worker-specs.ts";
import type { V2AdmissionPredicate } from "./types.ts";

export interface V2InspectedQueueServingCapability {
  /** The owner confirms SQL current serving and actual boot-inspected queue exports. */
  observeQueueServingCapability(input: {
    readonly workerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): Promise<
    | {
        readonly kind: "confirmed";
        readonly servingSourceOperationId: string;
        readonly deploymentUid: string;
        readonly deploymentGeneration: number;
        readonly versions: readonly {
          readonly workerVersionUid: string;
          readonly generation: number;
          readonly weight: number;
        }[];
        stillCurrent(): Promise<boolean>;
      }
    | { readonly kind: "unknown" }
  >;
}

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Freeze the privileged native/SQL observation before awaiting its recheck.
 * The fixed predicate repeats current-source, all selected Version, and
 * Queue/Worker readiness checks in the same statement as Core acceptance.
 */
export async function prepareV2QueueConsumerAdmission(input: {
  readonly capability: V2InspectedQueueServingCapability;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly spec: JsonObject;
}): Promise<V2AdmissionPredicate | null> {
  const spec = parseQueueConsumerSpec(input.spec);
  const observed = await input.capability.observeQueueServingCapability({
    workerUid: spec.worker.resourceUid,
    principal: input.principal,
    space: input.space,
    targetKey: input.targetKey,
  });
  if (observed.kind !== "confirmed") return null;
  const servingSourceOperationId = observed.servingSourceOperationId;
  const deploymentUid = observed.deploymentUid;
  const deploymentGeneration = observed.deploymentGeneration;
  const versions = observed.versions.map((version) => ({
    uid: version.workerVersionUid,
    generation: version.generation,
    weight: version.weight,
  }));
  if (
    !UID.test(servingSourceOperationId) ||
    !UID.test(deploymentUid) ||
    !Number.isSafeInteger(deploymentGeneration) ||
    deploymentGeneration < 1 ||
    versions.length < 1 ||
    versions.length > 8 ||
    versions.some(
      (version) =>
        !UID.test(version.uid) ||
        !Number.isSafeInteger(version.generation) ||
        version.generation < 1 ||
        !Number.isSafeInteger(version.weight) ||
        version.weight < 1 ||
        version.weight > 10_000,
    ) ||
    new Set(versions.map((version) => version.uid)).size !== versions.length ||
    versions.reduce((sum, version) => sum + version.weight, 0) !== 10_000 ||
    !(await observed.stillCurrent().catch(() => false))
  )
    return null;

  const deploymentSpec = canonicalJson({
    worker: { resourceUid: spec.worker.resourceUid },
    versions: versions.map((version) => ({
      workerVersion: { resourceUid: version.uid },
      weight: version.weight,
    })),
  });
  if (typeof deploymentSpec !== "string") return null;
  const selectedJson = JSON.stringify(versions);
  return {
    sql: `EXISTS (SELECT 1 FROM tf_v2_resources worker
      JOIN tf_v2_operations op ON op.id = worker.last_operation
      WHERE worker.uid = ? AND worker.form_url = ? AND worker.principal = ?
        AND worker.space = ? AND worker.target_key = ? AND worker.deleted_at IS NULL
        AND worker.phase = 'idle' AND worker.busy_operation IS NULL
        AND worker.generation = worker.observed_generation
        AND op.status = 'succeeded' AND op.effect = 'complete'
        AND op.generation = worker.generation AND op.accepted_spec_json = worker.spec_json)
      AND EXISTS (SELECT 1 FROM tf_v2_resources deployment
        JOIN tf_v2_operations op ON op.id = deployment.last_operation
        WHERE deployment.uid = ? AND deployment.form_url = ?
          AND deployment.principal = ? AND deployment.space = ?
          AND deployment.target_key = ? AND deployment.deleted_at IS NULL
          AND deployment.phase = 'idle' AND deployment.busy_operation IS NULL
          AND deployment.generation = ? AND deployment.observed_generation = deployment.generation
          AND deployment.spec_json = ? AND json_extract(deployment.observed_json, '$.active') = 1
          AND op.status = 'succeeded' AND op.effect = 'complete'
          AND op.action IN ('create','update') AND op.generation = deployment.generation
          AND op.accepted_spec_json = deployment.spec_json)
      AND EXISTS (SELECT 1 FROM tf_v2_operations source_op
        JOIN tf_v2_resources source ON source.uid = source_op.resource_uid
        WHERE source_op.id = ? AND source.form_url IN (?, ?)
          AND source.principal = ? AND source.space = ? AND source.target_key = ?
          AND source.phase = 'idle' AND source.busy_operation IS NULL
          AND source.last_operation = source_op.id
          AND source.generation = source.observed_generation
          AND source_op.generation = source.generation
          AND source_op.principal = source.principal AND source_op.target_key = source.target_key
          AND source_op.status = 'succeeded' AND source_op.effect = 'complete'
          AND source_op.accepted_spec_json = source.spec_json
          AND ((source_op.action IN ('create','update') AND source.deleted_at IS NULL)
            OR (source_op.action = 'delete' AND source.form_url = ?
              AND source.deleted_at IS NOT NULL))
          AND json_extract(source_op.accepted_spec_json, '$.worker.resourceUid') = ?
          AND NOT EXISTS (SELECT 1 FROM tf_v2_operations newer_op
            JOIN tf_v2_resources newer ON newer.uid = newer_op.resource_uid
            WHERE newer.form_url IN (?, ?) AND newer.principal = source.principal
              AND newer.space = source.space AND newer.target_key = source.target_key
              AND json_extract(newer_op.accepted_spec_json, '$.worker.resourceUid') = ?
              AND newer_op.acceptance_order > source_op.acceptance_order))
      AND NOT EXISTS (SELECT 1 FROM tf_v2_resources competing
        WHERE competing.form_url IN (?, ?) AND competing.principal = ?
          AND competing.space = ? AND competing.target_key = ?
          AND competing.deleted_at IS NULL AND competing.busy_operation IS NOT NULL
          AND json_extract(competing.spec_json, '$.worker.resourceUid') = ?)
      AND EXISTS (SELECT 1 FROM tf_v2_resources queue
        WHERE queue.uid = ? AND queue.form_url = ? AND queue.principal = ?
          AND queue.space = ? AND queue.target_key = ? AND queue.deleted_at IS NULL
          AND queue.phase = 'idle' AND queue.busy_operation IS NULL
          AND queue.generation = queue.observed_generation
          AND json_extract(queue.observed_json, '$.queueExists') = 1)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM tf_v2_resources dlq
        WHERE dlq.uid = ? AND dlq.form_url = ? AND dlq.principal = ?
          AND dlq.space = ? AND dlq.target_key = ? AND dlq.deleted_at IS NULL
          AND dlq.phase = 'idle' AND dlq.busy_operation IS NULL
          AND dlq.generation = dlq.observed_generation
          AND json_extract(dlq.observed_json, '$.queueExists') = 1))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) selected
        WHERE NOT EXISTS (SELECT 1 FROM tf_v2_resources version
          JOIN tf_v2_operations op ON op.id = version.last_operation
          WHERE version.uid = json_extract(selected.value, '$.uid')
            AND version.form_url = ? AND version.principal = ?
            AND version.space = ? AND version.target_key = ?
            AND version.deleted_at IS NULL AND version.phase = 'idle'
            AND version.busy_operation IS NULL
            AND version.generation = json_extract(selected.value, '$.generation')
            AND version.observed_generation = version.generation
            AND json_extract(version.spec_json, '$.worker.resourceUid') = ?
            AND EXISTS (SELECT 1 FROM json_each(version.spec_json, '$.handlers')
              WHERE value = 'queue')
            AND json_extract(version.observed_json, '$.ready') = 1
            AND json_extract(version.observed_json, '$.resolvedBindings') = 1
            AND json_extract(version.observed_json, '$.bundleVerified') = 1
            AND op.status = 'succeeded' AND op.effect = 'complete'
            AND op.action IN ('create','update') AND op.generation = version.generation
            AND op.accepted_spec_json = version.spec_json))`,
    params: [
      spec.worker.resourceUid,
      MODULE_WORKER_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      deploymentUid,
      WORKER_DEPLOYMENT_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      deploymentGeneration,
      deploymentSpec,
      servingSourceOperationId,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      WORKER_ENDPOINT_FORM_URL,
      spec.worker.resourceUid,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      spec.worker.resourceUid,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      spec.worker.resourceUid,
      spec.queue.resourceUid,
      AT_LEAST_ONCE_QUEUE_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      spec.deadLetterQueue?.resourceUid ?? null,
      spec.deadLetterQueue?.resourceUid ?? null,
      AT_LEAST_ONCE_QUEUE_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      selectedJson,
      WORKER_VERSION_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      spec.worker.resourceUid,
    ],
  };
}
