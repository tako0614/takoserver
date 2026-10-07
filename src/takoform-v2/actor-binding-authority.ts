import { bytesDigest, canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { createSelfhostActorExecutionHost } from "../selfhost-actor-execution-host.ts";
import type { ActorGraphAuthority } from "../selfhost-actor-graph-authority.ts";
import { V2_ACTOR_NAMESPACE_BACKEND_ID } from "./actor-namespace-backend.ts";
import { ACTOR_NAMESPACE_FORM_URL, parseActorNamespaceSpec } from "./forms/actor-namespace.ts";
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./forms/worker-version-observed.ts";

/** Immutable publication identity, never a tenant-supplied credential. */
export interface V2ActorBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface V2ActorBindingResolution {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly className: string;
  readonly runtimeClassRef: NonNullable<
    Awaited<ReturnType<ActorGraphAuthority["readGraph"]>>
  >["runtimeClassRef"];
  readonly vector: string;
}

/** V2 SQL and physical namespace proof; no v1 Version store or ResourceDeployment. */
export function createV2ActorBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly namespaceGraph: Pick<ActorGraphAuthority, "readGraph">;
  readonly physical: Pick<ReturnType<typeof createSelfhostActorExecutionHost>, "hasNamespace">;
}) {
  if (!options.sql || !options.targetKey || !options.namespaceGraph || !options.physical)
    throw new TypeError("Actor binding authority is required");

  const captureVersion = async (claim: V2ActorBindingClaim) => {
    const rows = await options.sql.query(
      `SELECT r.uid, r.generation, r.last_operation, r.spec_json, r.observed_json,
              op.id AS operation_id, op.generation AS operation_generation
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.action IN ('create','update')
         AND op.status = 'succeeded' AND op.effect = 'complete'
         AND op.accepted_spec_json = r.spec_json AND op.id = ? LIMIT 2`,
      [
        claim.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
        claim.workerVersionOperationId,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      typeof row.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.generation !== "number" ||
      row.last_operation !== claim.workerVersionOperationId ||
      row.operation_generation !== row.generation
    )
      return null;
    const spec = parseWorkerVersionSpec(JSON.parse(row.spec_json));
    if (
      !isReadyWorkerVersionObservation(JSON.parse(row.observed_json), spec.bundle !== undefined) ||
      spec.worker.resourceUid !== claim.workerUid ||
      canonicalJson(
        spec.actorBindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resource.resourceUid,
        })),
      ) !== canonicalJson(claim.bindings)
    )
      return null;
    const digest = await bytesDigest(
      new TextEncoder().encode(`${claim.workerVersionUid}\u0000${row.generation}`),
    );
    if (claim.nativeVersionId !== `v2-${digest.slice("sha256:".length)}`) return null;
    const expected = referencesForWorkerVersion(spec);
    const sealed = await options.sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [claim.workerVersionOperationId],
    );
    if (sealed.length !== 1 || sealed[0]?.sealed !== 1) return null;
    const refs = await options.sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [claim.workerVersionOperationId],
    );
    const edges = await options.sql.query(
      `SELECT target_uid FROM tf_v2_resource_references
       WHERE referrer_uid = ? ORDER BY target_uid`,
      [claim.workerVersionUid],
    );
    if (
      refs.length !== expected.length ||
      edges.length !== expected.length ||
      expected.some((requirement, index) => {
        const ref = refs[index];
        return (
          ref?.target_uid !== requirement.resourceUid ||
          ref.form_url !== requirement.formUrl ||
          ref.readiness !== requirement.readiness ||
          ref.target_spec_path !==
            (requirement.targetSpecMatch
              ? `$.${requirement.targetSpecMatch.path.join(".")}`
              : null) ||
          ref.target_spec_equals !== (requirement.targetSpecMatch?.equals ?? null) ||
          edges[index]?.target_uid !== requirement.resourceUid
        );
      })
    )
      return null;
    return canonicalJson([row, refs, edges]);
  };

  async function resolveCurrentBinding(
    source: V2ActorBindingClaim,
    bindingName: string,
  ): Promise<V2ActorBindingResolution | null> {
    try {
      // Capture every caller-controlled scalar before the first SQL/native await.
      const claim: V2ActorBindingClaim = {
        principal: source.principal,
        space: source.space,
        targetKey: source.targetKey,
        workerUid: source.workerUid,
        workerVersionUid: source.workerVersionUid,
        workerVersionOperationId: source.workerVersionOperationId,
        nativeVersionId: source.nativeVersionId,
        bindings: source.bindings.map((binding) => ({
          name: binding.name,
          resourceUid: binding.resourceUid,
        })),
      };
      const name = bindingName;
      if (claim.targetKey !== options.targetKey || !name) return null;
      const selected = claim.bindings.filter((binding) => binding.name === name);
      if (selected.length !== 1 || !selected[0]) return null;
      const beforeVersion = await captureVersion(claim);
      if (!beforeVersion) return null;
      const scope = { tenantId: claim.principal, namespaceResourceUid: selected[0].resourceUid };
      const namespaceRows = await options.sql.query(
        `SELECT uid, spec_json, backend_id FROM tf_v2_resources
         WHERE uid = ? AND form_url = ? AND principal = ? AND space = ?
           AND target_key = ? AND deleted_at IS NULL LIMIT 2`,
        [
          scope.namespaceResourceUid,
          ACTOR_NAMESPACE_FORM_URL,
          claim.principal,
          claim.space,
          claim.targetKey,
        ],
      );
      const namespace = namespaceRows.length === 1 ? namespaceRows[0] : null;
      if (
        !namespace ||
        namespace.backend_id !== V2_ACTOR_NAMESPACE_BACKEND_ID ||
        typeof namespace.spec_json !== "string" ||
        parseActorNamespaceSpec(JSON.parse(namespace.spec_json)).worker.resourceUid !==
          claim.workerUid
      )
        return null;
      const beforeGraph = await options.namespaceGraph.readGraph(
        scope,
        AbortSignal.timeout(30_000),
      );
      if (
        !beforeGraph ||
        beforeGraph.workerUid !== claim.workerUid ||
        beforeGraph.scope.tenantId !== claim.principal ||
        beforeGraph.scope.namespaceResourceUid !== scope.namespaceResourceUid ||
        !(await options.physical.hasNamespace(scope))
      )
        return null;
      const afterVersion = await captureVersion(claim);
      const afterGraph = await options.namespaceGraph.readGraph(scope, AbortSignal.timeout(30_000));
      if (
        !afterVersion ||
        afterVersion !== beforeVersion ||
        !afterGraph ||
        afterGraph.authorityKey !== beforeGraph.authorityKey
      )
        return null;
      return {
        tenantId: claim.principal,
        namespaceResourceUid: scope.namespaceResourceUid,
        className: beforeGraph.className,
        runtimeClassRef: beforeGraph.runtimeClassRef,
        vector: canonicalJson([beforeVersion, beforeGraph.authorityKey]),
      };
    } catch {
      return null;
    }
  }

  return Object.freeze({ resolveCurrentBinding });
}
