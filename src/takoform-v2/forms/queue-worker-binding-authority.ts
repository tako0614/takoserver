import { bytesDigest, canonicalJson } from "../../json.ts";
import type { Sql } from "../../ports.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL, parseAtLeastOnceQueueSpec } from "./at-least-once-queue.ts";
import { referencesForWorkerVersion } from "./worker-references.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./worker-version-observed.ts";

// The backend's private ID is rechecked at use-time; the Form URL alone is not authority.
const V2_QUEUE_BACKEND_ID = "selfhost-v2-at-least-once-queue-sql-v1";

/** Core-only proof for one accepted WorkerVersion Queue producer Binding. */
export interface QueueWorkerBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface QueueWorkerBindingResolution {
  readonly identity: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly resourceUid: string;
  };
  readonly target: {
    readonly queueId: string;
    readonly messageRetentionSeconds: number;
    readonly deliveryDelaySeconds: number;
  };
  readonly vector: string;
}

/** Read-only current graph proof. The custody INSERT repeats the critical predicates atomically. */
export function createQueueWorkerBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
}) {
  if (!options?.sql || !options.targetKey)
    throw new TypeError("Queue binding authority is required");

  async function resolveCurrentBinding(
    claim: QueueWorkerBindingClaim,
    binding: string,
  ): Promise<QueueWorkerBindingResolution | null> {
    if (claim.targetKey !== options.targetKey) return null;
    const selected = claim.bindings.find((item) => item.name === binding);
    if (!selected) return null;
    const rows = await options.sql.query(
      `SELECT r.*, op.id AS operation_id, op.action, op.status, op.effect,
              op.generation AS operation_generation, op.accepted_spec_json
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create','update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        claim.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
      ],
    );
    const version = rows.length === 1 ? rows[0] : null;
    if (
      !version ||
      typeof version.spec_json !== "string" ||
      typeof version.observed_json !== "string" ||
      typeof version.output_json !== "string" ||
      typeof version.backend_id !== "string" ||
      typeof version.operation_id !== "string" ||
      typeof version.generation !== "number"
    )
      return null;
    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
      if (
        !isReadyWorkerVersionObservation(
          JSON.parse(version.observed_json),
          spec.bundle !== undefined,
        )
      )
        return null;
    } catch {
      return null;
    }
    const bindings = spec.queueProducerBindings.map((item) => ({
      name: item.name,
      resourceUid: item.resource.resourceUid,
    }));
    if (
      spec.worker.resourceUid !== claim.workerUid ||
      canonicalJson(bindings) !== canonicalJson(claim.bindings) ||
      !bindings.some((item) => item.name === binding && item.resourceUid === selected.resourceUid)
    )
      return null;

    const sourceRows = await options.sql.query(
      `SELECT generation FROM tf_v2_operations
       WHERE id = ? AND resource_uid = ? AND principal = ? AND target_key = ?
         AND backend_id = ? AND action IN ('create','update')
         AND status = 'succeeded' AND effect = 'complete' AND accepted_spec_json = ?`,
      [
        claim.workerVersionOperationId,
        claim.workerVersionUid,
        claim.principal,
        claim.targetKey,
        version.backend_id,
        version.spec_json,
      ],
    );
    const source = sourceRows.length === 1 ? sourceRows[0] : null;
    if (
      !source ||
      typeof source.generation !== "number" ||
      !Number.isSafeInteger(source.generation) ||
      source.generation < 1 ||
      source.generation > version.generation
    )
      return null;
    const digest = await bytesDigest(
      new TextEncoder().encode(`${claim.workerVersionUid}\u0000${source.generation}`),
    );
    if (claim.nativeVersionId !== `v2-${digest.slice("sha256:".length)}`) return null;

    const expected = referencesForWorkerVersion(spec);
    const sets = await options.sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [version.operation_id],
    );
    if (sets.length !== 1 || sets[0]?.sealed !== 1) return null;
    const refs = await options.sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [version.operation_id],
    );
    if (
      refs.length !== expected.length ||
      expected.some((requirement, index) => {
        const row = refs[index];
        return (
          row?.target_uid !== requirement.resourceUid ||
          row.form_url !== requirement.formUrl ||
          row.readiness !== requirement.readiness ||
          row.target_spec_path !==
            (requirement.targetSpecMatch
              ? `$.${requirement.targetSpecMatch.path.join(".")}`
              : null) ||
          row.target_spec_equals !== (requirement.targetSpecMatch?.equals ?? null)
        );
      })
    )
      return null;
    const edges = await options.sql.query(
      "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
      [claim.workerVersionUid],
    );
    if (
      edges.length !== expected.length ||
      expected.some((ref, i) => edges[i]?.target_uid !== ref.resourceUid)
    )
      return null;

    const targetRows = await options.sql.query(
      `SELECT r.*, op.id AS operation_id, op.action, op.status, op.effect,
              op.generation AS operation_generation, op.accepted_spec_json
       FROM tf_v2_operation_references ref
       JOIN tf_v2_resources r ON r.uid = ref.target_uid
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE ref.operation_id = ? ORDER BY r.uid`,
      [version.operation_id],
    );
    if (targetRows.length !== expected.length) return null;
    let queueSpec: ReturnType<typeof parseAtLeastOnceQueueSpec> | null = null;
    let queueVector: readonly unknown[] | null = null;
    for (let index = 0; index < expected.length; index += 1) {
      const requirement = expected[index];
      const target = targetRows[index];
      if (
        !requirement ||
        !target ||
        target.uid !== requirement.resourceUid ||
        target.form_url !== requirement.formUrl ||
        target.principal !== claim.principal ||
        target.space !== claim.space ||
        target.target_key !== claim.targetKey ||
        target.deleted_at !== null ||
        target.busy_operation !== null ||
        target.phase !== "idle" ||
        target.observed_generation !== target.generation ||
        target.operation_id !== target.last_operation ||
        target.operation_generation !== target.generation ||
        target.status !== "succeeded" ||
        target.effect !== "complete" ||
        target.accepted_spec_json !== target.spec_json ||
        (target.action !== "create" && target.action !== "update")
      )
        return null;
      if (target.uid === selected.resourceUid) {
        try {
          if (
            requirement.formUrl !== AT_LEAST_ONCE_QUEUE_FORM_URL ||
            target.backend_id !== V2_QUEUE_BACKEND_ID ||
            canonicalJson(JSON.parse(target.observed_json as string)) !==
              canonicalJson({ queueExists: true }) ||
            canonicalJson(JSON.parse(target.output_json as string)) !== "{}"
          )
            return null;
          queueSpec = parseAtLeastOnceQueueSpec(JSON.parse(target.spec_json as string));
          queueVector = [
            target.uid,
            target.generation,
            target.operation_id,
            target.spec_json,
            target.observed_json,
            target.output_json,
          ];
        } catch {
          return null;
        }
      }
    }
    if (!queueSpec || !queueVector) return null;
    return {
      identity: {
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        resourceUid: selected.resourceUid,
      },
      target: {
        queueId: `takoform-v2-queue:${selected.resourceUid}`,
        messageRetentionSeconds: queueSpec.messageRetentionSeconds,
        deliveryDelaySeconds: queueSpec.deliveryDelaySeconds,
      },
      vector: canonicalJson([
        version.uid,
        version.generation,
        version.operation_id,
        version.spec_json,
        version.observed_json,
        version.output_json,
        source.generation,
        queueVector,
      ]),
    };
  }

  return Object.freeze({ resolveCurrentBinding });
}
