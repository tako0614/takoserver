import { parseActorAbiRef } from "../actor-abi-ref.ts";
import type { ActorExecutionGraph, ActorExecutionScope } from "../actor-execution-contract.ts";
import { bytesDigest, canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
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
  readonly runtimeClassRef: ActorExecutionGraph["runtimeClassRef"];
  readonly vector: string;
}

export interface V2ActorBindingTarget {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly namespaceResourceUid: string;
}

export interface V2ActorBindingGraphPort {
  readGraph(
    scope: ActorExecutionScope,
    signal: AbortSignal,
  ): Promise<Pick<
    ActorExecutionGraph,
    "scope" | "workerUid" | "className" | "runtimeClassRef"
  > | null>;
}

export interface V2ActorBindingPhysicalPort {
  hasNamespace(scope: ActorExecutionScope): Promise<boolean>;
}

/** Accepted source scalars used by the Host's native publication identity. */
export interface V2ActorBindingVersionIdentitySource {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly workerVersionGeneration: number;
  readonly actorBindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

/** V2 SQL and physical namespace proof; no v1 Version store or ResourceDeployment. */
export function createV2ActorBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly namespaceGraph: V2ActorBindingGraphPort;
  readonly physical: V2ActorBindingPhysicalPort;
  /** Identity derivation is Host-owned; actual native readback remains the physical adapter's duty. */
  readonly versionIdentity?: (source: V2ActorBindingVersionIdentitySource) => Promise<string>;
}) {
  if (!options.sql || !options.targetKey || !options.namespaceGraph || !options.physical)
    throw new TypeError("Actor binding authority is required");
  const sql = options.sql;
  const targetKey = options.targetKey;
  const readGraph = options.namespaceGraph.readGraph.bind(options.namespaceGraph);
  const hasNamespace = options.physical.hasNamespace.bind(options.physical);
  const versionIdentity =
    options.versionIdentity ??
    (async (source: V2ActorBindingVersionIdentitySource) => {
      const digest = await bytesDigest(
        new TextEncoder().encode(
          `${source.workerVersionUid}\u0000${source.workerVersionGeneration}`,
        ),
      );
      return `v2-${digest.slice("sha256:".length)}`;
    });

  const captureVersion = async (claim: V2ActorBindingClaim) => {
    const rows = await sql.query(
      `SELECT r.uid, r.generation, r.last_operation, r.spec_json, r.observed_json,
              r.backend_id, op.id AS operation_id, op.generation AS operation_generation
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.action IN ('create','update')
         AND op.status = 'succeeded' AND op.effect = 'complete'
         AND op.accepted_spec_json = r.spec_json LIMIT 2`,
      [
        claim.workerVersionUid,
        WORKER_VERSION_FORM_URL,
        claim.principal,
        claim.space,
        claim.targetKey,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      typeof row.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.backend_id !== "string" ||
      typeof row.operation_id !== "string" ||
      typeof row.generation !== "number" ||
      row.last_operation !== row.operation_id ||
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
    // A same-spec PUT advances the current Resource operation while the
    // admitted native Version still names its immutable source operation.
    const sources = await sql.query(
      `SELECT generation FROM tf_v2_operations
       WHERE id = ? AND resource_uid = ? AND principal = ? AND target_key = ?
         AND backend_id = ? AND action IN ('create','update')
         AND status = 'succeeded' AND effect = 'complete'
         AND accepted_spec_json = ? LIMIT 2`,
      [
        claim.workerVersionOperationId,
        claim.workerVersionUid,
        claim.principal,
        claim.targetKey,
        row.backend_id,
        row.spec_json,
      ],
    );
    const source = sources.length === 1 ? sources[0] : null;
    if (
      typeof source?.generation !== "number" ||
      !Number.isSafeInteger(source.generation) ||
      source.generation < 1 ||
      source.generation > row.generation
    )
      return null;
    const expectedIdentity = await versionIdentity(
      Object.freeze({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workerUid: claim.workerUid,
        workerVersionUid: claim.workerVersionUid,
        workerVersionOperationId: claim.workerVersionOperationId,
        workerVersionGeneration: source.generation,
        actorBindings: Object.freeze(
          spec.actorBindings.map((binding) =>
            Object.freeze({ name: binding.name, resourceUid: binding.resource.resourceUid }),
          ),
        ),
      }),
    );
    if (
      typeof expectedIdentity !== "string" ||
      !expectedIdentity ||
      claim.nativeVersionId !== expectedIdentity
    )
      return null;
    const expected = referencesForWorkerVersion(spec);
    const sealed = await sql.query(
      "SELECT operation_id, sealed FROM tf_v2_operation_reference_sets WHERE operation_id IN (?, ?)",
      [row.operation_id, claim.workerVersionOperationId],
    );
    if (
      sealed.length !== (row.operation_id === claim.workerVersionOperationId ? 1 : 2) ||
      sealed.some((entry) => entry.sealed !== 1)
    )
      return null;
    const refs = await sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [row.operation_id],
    );
    const sourceRefs = await sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [claim.workerVersionOperationId],
    );
    const edges = await sql.query(
      `SELECT target_uid FROM tf_v2_resource_references
       WHERE referrer_uid = ? ORDER BY target_uid`,
      [claim.workerVersionUid],
    );
    if (
      refs.length !== expected.length ||
      canonicalJson(sourceRefs) !== canonicalJson(refs) ||
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
    // Only semantic current authority enters the token. Generation/last Op
    // churn from an allowed same-spec PUT cannot invalidate an old invocation.
    return canonicalJson([row.uid, row.spec_json, refs, edges]);
  };

  async function resolveTarget(
    source: V2ActorBindingTarget,
  ): Promise<V2ActorBindingResolution | null> {
    try {
      const target = { ...source };
      if (target.targetKey !== targetKey) return null;
      const scope = {
        tenantId: target.principal,
        namespaceResourceUid: target.namespaceResourceUid,
      };
      const capture = async () => {
        const rows = await sql.query(
          `SELECT uid, spec_json, backend_id FROM tf_v2_resources
           WHERE uid = ? AND form_url = ? AND principal = ? AND space = ?
             AND target_key = ? AND deleted_at IS NULL LIMIT 2`,
          [
            target.namespaceResourceUid,
            ACTOR_NAMESPACE_FORM_URL,
            target.principal,
            target.space,
            target.targetKey,
          ],
        );
        const namespace = rows.length === 1 ? rows[0] : null;
        if (
          !namespace ||
          namespace.backend_id !== V2_ACTOR_NAMESPACE_BACKEND_ID ||
          typeof namespace.spec_json !== "string"
        )
          return null;
        // The caller's Version and the Actor class provider may be different
        // Workers. The Namespace's accepted Worker reference owns class code.
        const namespaceWorkerUid = parseActorNamespaceSpec(JSON.parse(namespace.spec_json)).worker
          .resourceUid;
        const graph = await readGraph(scope, AbortSignal.timeout(30_000));
        if (
          !graph ||
          graph.workerUid !== namespaceWorkerUid ||
          graph.scope.tenantId !== target.principal ||
          graph.scope.namespaceResourceUid !== target.namespaceResourceUid
        )
          return null;
        return {
          graph,
          // The strict graph proves the current sealed Namespace/Worker
          // authority. Its operation/generation key is deliberately not part
          // of an already admitted Version's forwarding credential: an
          // allowed same-spec PUT preserves this namespace ID and class.
          vector: canonicalJson([
            target.principal,
            target.space,
            target.targetKey,
            namespace.uid,
            namespace.spec_json,
            graph.workerUid,
            graph.className,
            graph.runtimeClassRef,
          ]),
        };
      };
      const before = await capture();
      if (!before || !(await hasNamespace(scope))) return null;
      const after = await capture();
      if (!after || after.vector !== before.vector) return null;
      return {
        tenantId: target.principal,
        namespaceResourceUid: target.namespaceResourceUid,
        className: before.graph.className,
        runtimeClassRef: before.graph.runtimeClassRef,
        vector: before.vector,
      };
    } catch {
      return null;
    }
  }

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
      if (claim.targetKey !== targetKey || !name) return null;
      const selected = claim.bindings.filter((binding) => binding.name === name);
      if (selected.length !== 1 || !selected[0]) return null;
      const beforeVersion = await captureVersion(claim);
      if (!beforeVersion) return null;
      const target = await resolveTarget({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workerUid: claim.workerUid,
        namespaceResourceUid: selected[0].resourceUid,
      });
      if (!target) return null;
      const afterVersion = await captureVersion(claim);
      if (!afterVersion || afterVersion !== beforeVersion) return null;
      const finalTarget = await resolveTarget({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workerUid: claim.workerUid,
        namespaceResourceUid: selected[0].resourceUid,
      });
      if (!finalTarget || finalTarget.vector !== target.vector) return null;
      return {
        ...finalTarget,
        vector: canonicalJson([beforeVersion, target.vector]),
      };
    } catch {
      return null;
    }
  }

  /** Recovery-only check for a retained native token. It does not issue a grant. */
  async function recoverableBinding(
    source: V2ActorBindingClaim,
    bindingName: string,
    persisted: {
      readonly tenantId: string;
      readonly namespaceResourceUid: string;
      readonly runtimeClassRef?: unknown;
    },
  ): Promise<boolean> {
    try {
      const claim = structuredClone(source);
      if (
        claim.targetKey !== targetKey ||
        persisted.tenantId !== claim.principal ||
        parseActorAbiRef(persisted.runtimeClassRef)?.kind !== "v2"
      )
        return false;
      const selected = claim.bindings.filter((item) => item.name === bindingName);
      if (selected.length !== 1 || selected[0]?.resourceUid !== persisted.namespaceResourceUid)
        return false;
      const before = await captureVersion(claim);
      if (!before) return false;
      const rows = await sql.query(
        `SELECT r.spec_json, r.backend_id, r.generation, r.observed_generation, r.phase,
                r.busy_operation, r.deleted_at, op.action, op.status, op.effect,
                op.accepted_spec_json
         FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
         WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
           AND r.target_key = ? LIMIT 2`,
        [
          persisted.namespaceResourceUid,
          ACTOR_NAMESPACE_FORM_URL,
          claim.principal,
          claim.space,
          claim.targetKey,
        ],
      );
      const row = rows.length === 1 ? rows[0] : null;
      if (
        !row ||
        row.backend_id !== V2_ACTOR_NAMESPACE_BACKEND_ID ||
        row.deleted_at !== null ||
        row.busy_operation !== null ||
        row.phase !== "idle" ||
        row.observed_generation !== row.generation ||
        row.status !== "succeeded" ||
        row.effect !== "complete" ||
        (row.action !== "create" && row.action !== "update") ||
        typeof row.spec_json !== "string" ||
        row.accepted_spec_json !== row.spec_json ||
        !parseActorNamespaceSpec(JSON.parse(row.spec_json)).className
      )
        return false;
      return (await captureVersion(claim)) === before;
    } catch {
      return false;
    }
  }

  return Object.freeze({ resolveTarget, resolveCurrentBinding, recoverableBinding });
}
