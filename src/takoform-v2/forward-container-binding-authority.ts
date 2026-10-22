import { CONTAINER_CONTRACT as C, type ContainerBindingClaim } from "../container-contract.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { referencesForForwardWorkerVersion } from "./forms/worker-references.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  parseForwardWorkerVersionSpec,
} from "./forms/worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./forms/worker-version-observed.ts";
import {
  hasV2ForwardContainerOperationGenerationIndex,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
} from "./operation-generation-index.ts";
import { MAX_FAILED_TAIL } from "./worker-publication-state.ts";

export interface V2ForwardContainerBindingClaim extends ContainerBindingClaim {
  /** Exact accepted generation that produced the private native Version. */
  readonly workerVersionGeneration: number;
}

/** Detached accepted graph data. This is neither a native grant nor a readiness proof. */
export interface V2ForwardContainerBindingSnapshot {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerVersionUid: string;
  readonly workerVersionFormUrl: typeof FORWARD_WORKER_VERSION_FORM_URL;
  readonly workerVersionGeneration: number;
  readonly sourceOperationId: string;
  readonly targetUid: string;
  readonly targetFormUrl: typeof C.formUrl;
  /** Committed observation, which can predate a pending or failed desired generation. */
  readonly targetGeneration: number;
  readonly targetSourceOperationId: string;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Core's post-acceptance, read-only graph reader for a private Hosted Container
 * owner. The owner separately checks the native Version, Container and caller
 * liveness before it issues or uses any execution authority.
 */
export function createV2ForwardContainerBindingReader(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly workerBackendId: string;
  readonly containerBackendId: string;
  readonly authorize: (principal: string, space: string) => Promise<boolean>;
}) {
  if (
    !options?.sql ||
    typeof options.sql.query !== "function" ||
    !identity(options.targetKey) ||
    !identity(options.workerBackendId) ||
    !identity(options.containerBackendId) ||
    typeof options.authorize !== "function"
  ) {
    throw new TypeError("Forward Container binding reader requires trusted options");
  }
  // Capture trusted construction values; subsequent mutation of the options
  // object cannot retarget this reader.
  const query = options.sql.query.bind(options.sql);
  const indexSql = { query };
  const { targetKey, workerBackendId, containerBackendId, authorize } = options;

  async function exactReferences(
    operationIds: readonly string[],
    versionUid: string,
    spec: ReturnType<typeof parseForwardWorkerVersionSpec>,
  ): Promise<boolean> {
    let expectedUids: readonly string[] | undefined;
    for (const operationId of new Set(operationIds)) {
      const sets = await query(
        "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
        [operationId],
      );
      if (sets.length !== 1 || sets[0]?.sealed !== 1) return false;
      const actual = await query(
        `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
         FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
        [operationId],
      );
      const sealedTargets = actual.map((row) => {
        if (!identity(row.target_uid) || !identity(row.form_url))
          throw new TypeError("invalid sealed reference");
        return { resourceUid: row.target_uid, formUrl: row.form_url };
      });
      const expected = referencesForForwardWorkerVersion(spec, sealedTargets).map((ref) => ({
        target_uid: ref.resourceUid,
        form_url: ref.formUrl,
        readiness: ref.readiness,
        target_spec_path: ref.targetSpecMatch ? `$.${ref.targetSpecMatch.path.join(".")}` : null,
        target_spec_equals: ref.targetSpecMatch?.equals ?? null,
      }));
      if (canonicalJson(actual) !== canonicalJson(expected)) return false;
      const uids = expected.map((ref) => ref.target_uid);
      if (expectedUids && canonicalJson(expectedUids) !== canonicalJson(uids)) return false;
      expectedUids = uids;
    }
    if (!expectedUids) return false;
    const edges = await query(
      "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
      [versionUid],
    );
    return (
      canonicalJson(edges) === canonicalJson(expectedUids.map((target_uid) => ({ target_uid })))
    );
  }

  /** Keep an observed source only through Core states known to have no later effect. */
  async function knownCurrentTail(
    row: Readonly<Record<string, unknown>>,
    observedOperationId: string,
  ): Promise<boolean> {
    if (
      !identity(row.uid) ||
      !identity(row.principal) ||
      !identity(row.target_key) ||
      !identity(row.backend_id) ||
      !identity(row.current_operation_id) ||
      !generation(row.generation) ||
      !generation(row.observed_generation) ||
      row.observed_generation > row.generation ||
      typeof row.observed_json !== "string" ||
      typeof row.source_result_observed_json !== "string" ||
      row.observed_json !== row.source_result_observed_json
    )
      return false;
    if (row.generation === row.observed_generation) {
      return (
        row.current_operation_id === observedOperationId &&
        row.current_action !== "delete" &&
        row.current_status === "succeeded" &&
        row.current_effect === "complete" &&
        row.phase === "idle" &&
        row.busy_operation === null
      );
    }
    if (row.current_action !== "update") return false;
    const pending =
      (row.current_status === "queued" || row.current_status === "waiting_input") &&
      row.current_effect === "none" &&
      row.current_dispatch_possible === 0 &&
      row.current_result_observed_json === null &&
      row.current_result_output_json === null &&
      row.phase === "pending" &&
      row.busy_operation === row.current_operation_id;
    const failedNoEffect =
      row.current_status === "failed" &&
      row.current_effect === "none" &&
      row.current_result_observed_json === null &&
      row.current_result_output_json === null &&
      row.phase === "error" &&
      row.busy_operation === null;
    if (!pending && !failedNoEffect) return false;
    const count = row.generation - row.observed_generation;
    if (count - (pending ? 1 : 0) > MAX_FAILED_TAIL) return false;

    // A later failed/none Operation cannot erase an earlier partial or
    // unknown effect. Count the full generation interval, including the latest
    // Operation, so gaps and duplicate generations also fail closed.
    const tails = await query(
      `SELECT COUNT(*) AS operation_count, COUNT(DISTINCT generation) AS distinct_generations,
              MIN(generation) AS first_generation, MAX(generation) AS last_generation,
              SUM(CASE WHEN generation < ? AND
                (action <> 'update' OR status <> 'failed' OR effect <> 'none'
                 OR principal <> ? OR target_key <> ? OR backend_id <> ?
                 OR result_observed_json IS NOT NULL OR result_output_json IS NOT NULL)
                THEN 1 ELSE 0 END) AS invalid_prior
       FROM tf_v2_operations INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}
       WHERE resource_uid = ? AND generation > ? AND generation <= ?`,
      [
        row.generation,
        row.principal,
        row.target_key,
        row.backend_id,
        row.uid,
        row.observed_generation,
        row.generation,
      ],
    );
    const tail = tails.length === 1 ? tails[0] : null;
    return (
      tail?.operation_count === count &&
      tail.distinct_generations === count &&
      tail.first_generation === row.observed_generation + 1 &&
      tail.last_generation === row.generation &&
      tail.invalid_prior === 0
    );
  }

  return async (
    input: V2ForwardContainerBindingClaim,
  ): Promise<V2ForwardContainerBindingSnapshot | null> => {
    // Read every untrusted caller value before the first await. Callers cannot
    // replace a binding or owner while authorization and SQL are in flight.
    let claim: V2ForwardContainerBindingClaim;
    try {
      claim = {
        principal: input.principal,
        space: input.space,
        workerVersionUid: input.workerVersionUid,
        workerVersionGeneration: input.workerVersionGeneration,
        operationId: input.operationId,
        bindingName: input.bindingName,
        targetUid: input.targetUid,
      };
    } catch {
      return null;
    }
    if (
      !identity(claim.principal) ||
      !identity(claim.space) ||
      !identity(claim.workerVersionUid) ||
      !generation(claim.workerVersionGeneration) ||
      !identity(claim.operationId) ||
      !identity(claim.bindingName) ||
      !identity(claim.targetUid)
    )
      return null;
    try {
      if (!(await authorize(claim.principal, claim.space))) return null;
      if (!(await hasV2ForwardContainerOperationGenerationIndex(indexSql))) return null;
      const versions = await query(
        `SELECT r.uid, r.principal, r.target_key, r.backend_id, r.phase,
                r.busy_operation, r.generation, r.observed_generation, r.spec_json,
                r.observed_json, source.generation AS source_generation,
                source.accepted_spec_json,
                source.result_observed_json AS source_result_observed_json,
                current.id AS current_operation_id, current.action AS current_action,
                current.status AS current_status, current.effect AS current_effect,
                current.dispatch_possible AS current_dispatch_possible,
                current.result_observed_json AS current_result_observed_json,
                current.result_output_json AS current_result_output_json
         FROM tf_v2_resources r
         JOIN tf_v2_operations source ON source.id = ? AND source.resource_uid = r.uid
         JOIN tf_v2_operations current ON current.id = r.last_operation
         WHERE r.uid = ? AND r.principal = ? AND r.space = ? AND r.target_key = ?
           AND r.backend_id = ? AND r.form_url = ? AND r.deleted_at IS NULL
           AND r.phase <> 'deleting'
           AND source.principal = r.principal AND source.target_key = r.target_key
           AND source.backend_id = r.backend_id AND source.generation = ?
           AND source.action IN ('create','update') AND source.status = 'succeeded'
           AND source.effect = 'complete' AND source.accepted_spec_json = r.spec_json
           AND current.resource_uid = r.uid AND current.principal = r.principal
           AND current.target_key = r.target_key AND current.backend_id = r.backend_id
           AND current.generation = r.generation AND current.accepted_spec_json = r.spec_json
         LIMIT 2`,
        [
          claim.operationId,
          claim.workerVersionUid,
          claim.principal,
          claim.space,
          targetKey,
          workerBackendId,
          FORWARD_WORKER_VERSION_FORM_URL,
          claim.workerVersionGeneration,
        ],
      );
      const version = versions.length === 1 ? versions[0] : null;
      if (
        !version ||
        !generation(version.generation) ||
        !generation(version.observed_generation) ||
        version.source_generation !== claim.workerVersionGeneration ||
        version.observed_generation !== claim.workerVersionGeneration ||
        !identity(version.current_operation_id) ||
        typeof version.accepted_spec_json !== "string" ||
        typeof version.observed_json !== "string" ||
        !(await knownCurrentTail(version, claim.operationId))
      )
        return null;
      const spec = parseForwardWorkerVersionSpec(JSON.parse(version.accepted_spec_json));
      if (
        !isReadyWorkerVersionObservation(
          JSON.parse(version.observed_json),
          spec.bundle !== undefined,
        ) ||
        !spec.containerBindings.some(
          (binding) =>
            binding.name === claim.bindingName && binding.resource.resourceUid === claim.targetUid,
        )
      )
        return null;
      if (
        !(await exactReferences(
          [claim.operationId, version.current_operation_id],
          claim.workerVersionUid,
          spec,
        ))
      )
        return null;

      // The Container's committed observation may remain live while a new
      // desired generation is pending or a no-effect update has failed.
      const targets = await query(
        `SELECT r.uid, r.principal, r.target_key, r.backend_id, r.phase,
                r.busy_operation, r.generation, r.observed_generation, r.observed_json,
                observed.id AS observed_operation_id,
                observed.result_observed_json AS source_result_observed_json,
                current.id AS current_operation_id, current.action AS current_action,
                current.status AS current_status, current.effect AS current_effect,
                current.dispatch_possible AS current_dispatch_possible,
                current.result_observed_json AS current_result_observed_json,
                current.result_output_json AS current_result_output_json
         FROM tf_v2_resources r
         JOIN tf_v2_operations observed INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}
           ON observed.resource_uid = r.uid
           AND observed.generation = r.observed_generation
         JOIN tf_v2_operations current ON current.id = r.last_operation
         JOIN tf_v2_resource_references edge ON edge.target_uid = r.uid
         WHERE edge.referrer_uid = ? AND r.uid = ? AND r.principal = ? AND r.space = ?
           AND r.target_key = ? AND r.backend_id = ? AND r.form_url = ?
           AND r.deleted_at IS NULL AND r.phase <> 'deleting'
           AND observed.principal = r.principal AND observed.target_key = r.target_key
           AND observed.backend_id = r.backend_id
           AND observed.action IN ('create','update') AND observed.status = 'succeeded'
           AND observed.effect = 'complete'
           AND current.resource_uid = r.uid AND current.principal = r.principal
           AND current.target_key = r.target_key AND current.backend_id = r.backend_id
           AND current.generation = r.generation AND current.accepted_spec_json = r.spec_json
         LIMIT 2`,
        [
          claim.workerVersionUid,
          claim.targetUid,
          claim.principal,
          claim.space,
          targetKey,
          containerBackendId,
          C.formUrl,
        ],
      );
      const target = targets.length === 1 ? targets[0] : null;
      if (
        !target ||
        !generation(target.observed_generation) ||
        !identity(target.observed_operation_id) ||
        typeof target.observed_json !== "string" ||
        !(await knownCurrentTail(target, target.observed_operation_id))
      )
        return null;
      const observation: unknown = JSON.parse(target.observed_json);
      if (
        !observation ||
        typeof observation !== "object" ||
        Array.isArray(observation) ||
        (observation as Record<string, unknown>)[C.fields.ready] !== true ||
        (observation as Record<string, unknown>)[C.fields.servingGeneration] !==
          target.observed_generation
      )
        return null;
      return {
        principal: claim.principal,
        space: claim.space,
        targetKey,
        workerVersionUid: claim.workerVersionUid,
        workerVersionFormUrl: FORWARD_WORKER_VERSION_FORM_URL,
        workerVersionGeneration: claim.workerVersionGeneration,
        sourceOperationId: claim.operationId,
        targetUid: claim.targetUid,
        targetFormUrl: C.formUrl,
        targetGeneration: target.observed_generation,
        targetSourceOperationId: target.observed_operation_id,
      };
    } catch {
      return null;
    }
  };
}
