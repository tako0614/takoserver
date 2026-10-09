import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type {
  ActorExecutionGraph,
  ActorExecutionRealization,
  ActorGraphAuthority,
  ActorIncarnationRetirement,
} from "../selfhost-actor-graph-authority.ts";
import { selectSelfhostWeightedVersion } from "../selfhost-weighted-deployment.ts";
import type { WorkerdWorkerRuntimeOwner } from "../workerd-worker-runtime-owner.ts";
import { createV2ActorNamespaceSqlGraphReader } from "./actor-namespace-sql-graph.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "./forms/actor-namespace.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "./forms/worker-specs.ts";

type Scope = ActorExecutionGraph["scope"];
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

/** App SQL authority for withdrawing one exact resident Actor incarnation. */
export async function hasAcceptedV2ActorIncarnationWithdrawal(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly input: ActorIncarnationRetirement;
  readonly scope: { readonly tenantId: string; readonly namespaceResourceUid: string };
}): Promise<boolean> {
  const { sql, targetKey, input, scope } = options;
  if (input.targetKey !== targetKey) return false;
  const rows = await sql.query(
    `SELECT 1 AS authorized
     FROM tf_v2_operations AS source_op
     JOIN tf_v2_resources AS source_resource ON source_resource.uid = source_op.resource_uid
     JOIN tf_v2_operations AS retirement_op ON retirement_op.id = ?
     JOIN tf_v2_resources AS retirement_resource
       ON retirement_resource.uid = retirement_op.resource_uid
     JOIN tf_v2_resources AS namespace ON namespace.uid = ?
     JOIN tf_v2_resources AS worker ON worker.uid = ?
     WHERE source_op.id = ?
       AND source_op.principal = ? AND source_op.target_key = ?
       AND source_op.status = 'succeeded' AND source_op.effect = 'complete'
       AND source_op.acceptance_order > 0
       AND source_resource.form_url IN (?, ?)
       AND source_resource.principal = source_op.principal
       AND source_resource.target_key = source_op.target_key
       AND json_extract(source_op.accepted_spec_json, '$.worker.resourceUid') = ?
       AND retirement_op.principal = source_op.principal
       AND retirement_op.target_key = source_op.target_key
       AND retirement_op.acceptance_order > source_op.acceptance_order
       AND retirement_op.action IN ('create', 'update', 'delete')
       AND (
         (retirement_op.status = 'succeeded' AND retirement_op.effect = 'complete')
         OR (retirement_op.status IN ('running', 'reconciling')
             AND retirement_op.lease_token IS NOT NULL
             AND retirement_op.lease_until_ms > ${DB_NOW_MS}
             AND retirement_resource.busy_operation = retirement_op.id
             AND retirement_resource.last_operation = retirement_op.id
             AND (? IS NULL OR retirement_op.lease_token = ?))
       )
       AND retirement_resource.form_url IN (?, ?)
       AND retirement_resource.principal = retirement_op.principal
       AND retirement_resource.target_key = retirement_op.target_key
       AND retirement_resource.space = source_resource.space
       AND json_extract(retirement_op.accepted_spec_json, '$.worker.resourceUid') = ?
       AND namespace.form_url = ? AND namespace.principal = ?
       AND namespace.space = source_resource.space AND namespace.target_key = ?
       AND json_extract(namespace.spec_json, '$.worker.resourceUid') = ?
       AND worker.form_url = ? AND worker.principal = source_op.principal
       AND worker.space = source_resource.space AND worker.target_key = ?
     LIMIT 2`,
    [
      input.retirementOperationId,
      scope.namespaceResourceUid,
      input.workerResourceUid,
      input.sourceOperationId,
      scope.tenantId,
      targetKey,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      input.workerResourceUid,
      input.retirementLeaseToken ?? null,
      input.retirementLeaseToken ?? null,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      input.workerResourceUid,
      ACTOR_NAMESPACE_FORM_URL,
      scope.tenantId,
      targetKey,
      input.workerResourceUid,
      MODULE_WORKER_FORM_URL,
      targetKey,
    ],
  );
  return rows.length === 1;
}

export interface V2ActorWorkerOwnerReader {
  ownerForWorker(
    workerUid: string,
  ): Promise<Pick<
    WorkerdWorkerRuntimeOwner,
    | "workerResourceUid"
    | "observeServing"
    | "observeActorGraph"
    | "acquireActorVersionPrivateBindings"
  > | null>;
}

/** Privileged read for one backend-held leased Namespace Operation. */
export interface V2ActorAcceptedOperationGraphAuthority extends ActorGraphAuthority {
  readAcceptedOperationGraph(
    scope: Scope,
    operation: { readonly operationId: string; readonly leaseToken: string },
  ): Promise<ActorExecutionGraph | null>;
  acceptedOperationRealization(
    native: Extract<
      Awaited<ReturnType<WorkerdWorkerRuntimeOwner["observeActorGraph"]>>,
      { readonly kind: "ready" }
    >,
  ): ActorExecutionRealization;
}

/**
 * Reads accepted v2 Namespace/Worker SQL and the exact native owner. No v1
 * ResourceDeployment, package identity, or duplicate Actor ledger is involved.
 * The returned graphs remain Host-private because they contain module env.
 */
export function createV2ActorNamespaceGraphAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly owner: V2ActorWorkerOwnerReader;
}): V2ActorAcceptedOperationGraphAuthority {
  if (!options.targetKey) throw new TypeError("Actor targetKey is required");

  const sqlGraph = createV2ActorNamespaceSqlGraphReader({
    sql: options.sql,
    targetKey: options.targetKey,
  });
  const acceptedGraph = (
    scope: Scope,
    operation?: { readonly operationId: string; readonly leaseToken: string },
  ) =>
    operation ? sqlGraph.readAcceptedOperationGraph(scope, operation) : sqlGraph.readGraph(scope);
  const activeDeployment = sqlGraph.hasActiveDeployment;

  const realizationKey = (native: {
    readonly sourceOperationId: string;
    readonly incarnationId: string;
    readonly identity: {
      readonly versions: readonly {
        readonly versionId: string;
        readonly workerVersionUid: string;
        readonly weight: number;
      }[];
    };
    readonly graph: { readonly generationKey: string };
  }) =>
    canonicalJson({
      sourceOperationId: native.sourceOperationId,
      incarnationId: native.incarnationId,
      generationKey: native.graph.generationKey,
      versions: native.identity.versions,
    });

  const currentNative = async (graph: ActorExecutionGraph) => {
    const owner = await options.owner.ownerForWorker(graph.workerUid);
    if (!owner || owner.workerResourceUid !== graph.workerUid) return null;
    const serving = await owner.observeServing({
      workerResourceUid: graph.workerUid,
      targetKey: options.targetKey,
    });
    if (
      serving.kind !== "serving" ||
      serving.workerResourceUid !== graph.workerUid ||
      serving.targetKey !== options.targetKey
    )
      return null;
    const native = await owner.observeActorGraph({
      workerResourceUid: graph.workerUid,
      targetKey: options.targetKey,
      sourceOperationId: serving.sourceOperationId,
    });
    return native.kind === "ready" &&
      native.sourceOperationId === serving.sourceOperationId &&
      native.graph.workerResourceUid === graph.workerUid &&
      native.identity.workerResourceUid === graph.workerUid &&
      native.graph.generation === native.identity.generation
      ? native
      : null;
  };

  return {
    async hasNamespaceAuthority(scope) {
      return sqlGraph.hasNamespaceAuthority(scope);
    },
    readGraph: (scope) => acceptedGraph(scope),
    /** Own leased Operation only; ordinary delivery keeps the settled graph reader. */
    readAcceptedOperationGraph(
      scope: Scope,
      operation: {
        readonly operationId: string;
        readonly leaseToken: string;
      },
    ) {
      return acceptedGraph(scope, { ...operation });
    },
    acceptedOperationRealization(native) {
      return {
        script: native.script,
        graph: native.graph,
        authorityKey: realizationKey(native),
        actorForwardSockets: native.actorForwardSockets,
        sourceOperationId: native.sourceOperationId,
        incarnationId: native.incarnationId,
      };
    },
    hasRealization: activeDeployment,
    async readRealization(graph, signal) {
      signal.throwIfAborted();
      if ((await acceptedGraph(graph.scope))?.authorityKey !== graph.authorityKey)
        return { kind: "authority_changed" };
      if (!(await activeDeployment(graph))) return { kind: "native_unavailable" };
      const native = await currentNative(graph);
      signal.throwIfAborted();
      if (!native) return { kind: "native_unavailable" };
      if ((await acceptedGraph(graph.scope))?.authorityKey !== graph.authorityKey)
        return { kind: "authority_changed" };
      if (!(await activeDeployment(graph))) return { kind: "native_unavailable" };
      return {
        kind: "ready",
        realization: {
          script: native.script,
          graph: native.graph,
          authorityKey: realizationKey(native),
          actorForwardSockets: native.actorForwardSockets,
          sourceOperationId: native.sourceOperationId,
          incarnationId: native.incarnationId,
        },
      };
    },
    async stillCurrent(graph, realization, signal) {
      signal.throwIfAborted();
      if ((await acceptedGraph(graph.scope))?.authorityKey !== graph.authorityKey) return false;
      if (!(await activeDeployment(graph))) return false;
      const native = await currentNative(graph);
      signal.throwIfAborted();
      return (
        !!native &&
        native.script === realization.script &&
        realizationKey(native) === realization.authorityKey &&
        canonicalJson(native.actorForwardSockets) ===
          canonicalJson(realization.actorForwardSockets ?? []) &&
        (await activeDeployment(graph)) &&
        (await acceptedGraph(graph.scope))?.authorityKey === graph.authorityKey
      );
    },
    async acquireVersionPrivateBindings(graph, realization, version, stillAuthorized, signal) {
      signal.throwIfAborted();
      if (
        !realization.sourceOperationId ||
        !realization.incarnationId ||
        realization.graph.workerResourceUid !== graph.workerUid ||
        !realization.graph.versions.some(
          (entry) =>
            entry.versionId === version.versionId &&
            entry.workerVersionUid === version.workerVersionUid &&
            entry.weight === version.weight,
        ) ||
        !(await stillAuthorized(signal))
      )
        return null;
      const owner = await options.owner.ownerForWorker(graph.workerUid);
      if (!owner || owner.workerResourceUid !== graph.workerUid) return null;
      const acquired = await owner.acquireActorVersionPrivateBindings(
        {
          workerResourceUid: graph.workerUid,
          targetKey: options.targetKey,
          sourceOperationId: realization.sourceOperationId,
          incarnationId: realization.incarnationId,
          generationKey: realization.graph.generationKey,
          versions: realization.graph.versions.map(({ versionId, workerVersionUid, weight }) => ({
            versionId,
            workerVersionUid,
            weight,
          })),
          versionId: version.versionId,
          workerVersionUid: version.workerVersionUid,
        },
        signal,
      );
      // The physical owner only proves its incumbent incarnation. The Actor
      // caller retains this lease before its final accepted-SQL recheck.
      return acquired.kind === "ready" ? acquired : null;
    },
    async selectVersion(_graph, realization: ActorExecutionRealization, basisPoint) {
      const selected = selectSelfhostWeightedVersion(
        realization.graph.versions.map(({ versionId, workerVersionUid, weight }) => ({
          versionId,
          workerVersionUid,
          weight,
        })),
        basisPoint,
      );
      const version = realization.graph.versions.find(
        (entry) =>
          entry.versionId === selected.versionId &&
          entry.workerVersionUid === selected.workerVersionUid &&
          entry.weight === selected.weight,
      );
      return version
        ? {
            generation: realization.graph.generation,
            generationKey: realization.graph.generationKey,
            workerResourceUid: realization.graph.workerResourceUid,
            versionId: version.versionId,
            workerVersionUid: version.workerVersionUid,
            site: structuredClone(version.site),
            modules: structuredClone(version.modules),
            hostModules: structuredClone(version.hostModules),
          }
        : null;
    },
  };
}
