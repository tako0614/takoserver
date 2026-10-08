import { bytesDigest, canonicalJson } from "../../json.ts";
import type { Sql } from "../../ports.ts";
import { OBJECT_BUCKET_LIMITS, parseObjectBucketSpec } from "./object-bucket.ts";
import { resolveObjectBucketBackendId } from "./object-bucket-backend.ts";
import { referencesForWorkerVersion } from "./worker-references.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./worker-version-observed.ts";

/** Structural input shared with the Host-private broker without importing its adapter. */
export interface ObjectBucketWorkerBindingClaim {
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

export interface ObjectBucketWorkerBindingResolution {
  readonly identity: {
    readonly targetKey: string;
    readonly principal: string;
    readonly space: string;
    readonly resourceUid: string;
  };
  readonly vector: string;
}

/**
 * Core-owned read authority for one currently selected WorkerVersion binding.
 * It verifies the complete sealed reference declaration and active edges,
 * then returns a vector that changes when the Version or ObjectBucket changes.
 */
export function createObjectBucketWorkerBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  /** Trusted operator-selected identity for this one Bucket supply. */
  readonly backendId?: string;
}) {
  if (!options?.sql || !options.targetKey) {
    throw new TypeError("ObjectBucket Worker binding authority is required");
  }
  const backendId = resolveObjectBucketBackendId(
    options.backendId,
    Object.hasOwn(options, "backendId"),
  );

  async function resolveCurrentBucketBinding(
    grant: ObjectBucketWorkerBindingClaim,
    binding: string,
  ): Promise<ObjectBucketWorkerBindingResolution | null> {
    if (grant.targetKey !== options.targetKey) return null;
    const selected = grant.bindings.find((item) => item.name === binding);
    if (!selected) return null;
    const versionRows = await options.sql.query(
      `SELECT r.uid, r.principal, r.space, r.target_key, r.backend_id, r.generation,
              r.observed_generation, r.phase, r.spec_json, r.observed_json, r.output_json,
              r.last_operation, r.busy_operation, r.deleted_at, op.id AS operation_id,
              op.action, op.status, op.effect, op.generation AS operation_generation,
              op.accepted_spec_json
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create', 'update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        grant.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        grant.principal,
        grant.space,
        grant.targetKey,
      ],
    );
    const version = versionRows.length === 1 ? versionRows[0] : null;
    if (
      !version ||
      typeof version.spec_json !== "string" ||
      typeof version.observed_json !== "string" ||
      typeof version.output_json !== "string"
    ) {
      return null;
    }

    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
      if (!isReadyWorkerVersionObservation(JSON.parse(version.observed_json), true)) return null;
    } catch {
      return null;
    }
    const actualBindings = spec.bucketBindings.map((item) => ({
      name: item.name,
      resourceUid: item.resource.resourceUid,
    }));
    if (
      spec.worker.resourceUid !== grant.workerUid ||
      canonicalJson(actualBindings) !== canonicalJson(grant.bindings) ||
      !actualBindings.some(
        (item) => item.name === binding && item.resourceUid === selected.resourceUid,
      )
    ) {
      return null;
    }

    // The grant names the immutable Version operation that produced the native
    // code version. A same-spec PUT may advance the current Resource operation,
    // so verify the original accepted operation against the current exact
    // immutable spec instead of requiring it to remain last_operation.
    const sourceOperations = await options.sql.query(
      `SELECT id, resource_uid, principal, target_key, backend_id, generation,
              action, status, effect, accepted_spec_json
       FROM tf_v2_operations
       WHERE id = ? AND resource_uid = ? AND principal = ? AND target_key = ?
         AND backend_id = ? AND action IN ('create', 'update')
         AND status = 'succeeded' AND effect = 'complete'
         AND accepted_spec_json = ?`,
      [
        grant.workerVersionOperationId,
        grant.workerVersionUid,
        grant.principal,
        grant.targetKey,
        version.backend_id as string,
        version.spec_json,
      ],
    );
    const sourceOperation = sourceOperations.length === 1 ? sourceOperations[0] : null;
    if (
      !sourceOperation ||
      typeof sourceOperation.generation !== "number" ||
      !Number.isSafeInteger(sourceOperation.generation) ||
      sourceOperation.generation < 1 ||
      typeof version.generation !== "number" ||
      sourceOperation.generation > version.generation
    ) {
      return null;
    }
    const nativeVersionDigest = await bytesDigest(
      new TextEncoder().encode(`${grant.workerVersionUid}\u0000${sourceOperation.generation}`),
    );
    if (grant.nativeVersionId !== `v2-${nativeVersionDigest.slice("sha256:".length)}`) {
      return null;
    }

    const expected = referencesForWorkerVersion(spec);
    const refSet = await options.sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [version.operation_id as string],
    );
    if (refSet.length !== 1 || refSet[0]?.sealed !== 1) return null;
    const references = await options.sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [version.operation_id as string],
    );
    if (
      references.length !== expected.length ||
      expected.some((requirement, index) => {
        const actual = references[index];
        return (
          actual?.target_uid !== requirement.resourceUid ||
          actual.form_url !== requirement.formUrl ||
          actual.readiness !== requirement.readiness ||
          actual.target_spec_path !==
            (requirement.targetSpecMatch
              ? `$.${requirement.targetSpecMatch.path.join(".")}`
              : null) ||
          actual.target_spec_equals !== (requirement.targetSpecMatch?.equals ?? null)
        );
      })
    ) {
      return null;
    }

    const edges = await options.sql.query(
      `SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid`,
      [grant.workerVersionUid],
    );
    if (
      edges.length !== expected.length ||
      expected.some((requirement, index) => edges[index]?.target_uid !== requirement.resourceUid)
    ) {
      return null;
    }

    const targetRows = await options.sql.query(
      `SELECT r.uid, r.principal, r.space, r.target_key, r.backend_id, r.form_url,
              r.generation, r.observed_generation, r.phase, r.spec_json, r.observed_json,
              r.output_json, r.last_operation, r.busy_operation, r.deleted_at,
              op.id AS operation_id, op.action, op.status, op.effect,
              op.generation AS operation_generation, op.accepted_spec_json
       FROM tf_v2_operation_references ref
       JOIN tf_v2_resources r ON r.uid = ref.target_uid
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE ref.operation_id = ? ORDER BY ref.target_uid`,
      [version.operation_id as string],
    );
    if (targetRows.length !== expected.length) return null;
    for (let index = 0; index < expected.length; index += 1) {
      const requirement = expected[index];
      const target = targetRows[index];
      if (
        !requirement ||
        !target ||
        target.uid !== requirement.resourceUid ||
        target.form_url !== requirement.formUrl ||
        target.principal !== grant.principal ||
        target.space !== grant.space ||
        target.target_key !== grant.targetKey ||
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
      ) {
        return null;
      }
      if (target.uid === selected.resourceUid) {
        try {
          parseObjectBucketSpec(JSON.parse(target.spec_json as string));
          const observed = JSON.parse(target.observed_json as string);
          const output = JSON.parse(target.output_json as string);
          if (
            target.backend_id !== backendId ||
            canonicalJson(observed) !==
              canonicalJson({ bucketExists: true, ...OBJECT_BUCKET_LIMITS }) ||
            canonicalJson(output) !== "{}"
          ) {
            return null;
          }
        } catch {
          return null;
        }
      }
    }

    return {
      identity: {
        targetKey: grant.targetKey,
        principal: grant.principal,
        space: grant.space,
        resourceUid: selected.resourceUid,
      },
      vector: canonicalJson([
        version.uid,
        version.generation,
        version.operation_id,
        version.spec_json,
        version.observed_json,
        version.output_json,
        version.operation_generation,
        expected.map((requirement, index) => [
          requirement.resourceUid,
          targetRows[index]?.generation,
          targetRows[index]?.operation_id,
          targetRows[index]?.spec_json,
          targetRows[index]?.observed_json,
          targetRows[index]?.output_json,
        ]),
      ]),
    };
  }

  return Object.freeze({ resolveCurrentBucketBinding });
}
