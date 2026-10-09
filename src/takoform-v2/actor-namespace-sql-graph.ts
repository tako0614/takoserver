import { ACTOR_ABI_INTERFACE_REFS } from "../actor-abi-ref.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { ACTOR_NAMESPACE_FORM_URL, parseActorNamespaceSpec } from "./forms/actor-namespace.ts";
import { MODULE_WORKER_FORM_URL, WORKER_DEPLOYMENT_FORM_URL } from "./forms/worker-specs.ts";

export interface V2ActorAcceptedSqlScope {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
}

export interface V2ActorAcceptedSqlGraph {
  readonly scope: V2ActorAcceptedSqlScope;
  readonly space: string;
  readonly workerUid: string;
  readonly className: string;
  readonly namespaceOperationId: string;
  readonly workerOperationId: string;
  readonly runtimeClassRef?: unknown;
  readonly authorityKey: string;
}

export interface V2ActorNamespaceSqlGraphReader {
  readGraph(scope: V2ActorAcceptedSqlScope): Promise<V2ActorAcceptedSqlGraph | null>;
  readAcceptedOperationGraph(
    scope: V2ActorAcceptedSqlScope,
    operation: { readonly operationId: string; readonly leaseToken: string },
  ): Promise<V2ActorAcceptedSqlGraph | null>;
  hasNamespaceAuthority(scope: V2ActorAcceptedSqlScope): Promise<boolean>;
  hasActiveDeployment(
    graph: Pick<V2ActorAcceptedSqlGraph, "scope" | "authorityKey" | "workerUid">,
  ): Promise<boolean>;
  stillCurrent(graph: Pick<V2ActorAcceptedSqlGraph, "scope" | "authorityKey">): Promise<boolean>;
}

type Scope = V2ActorAcceptedSqlScope;
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

interface NamespaceRow {
  readonly uid: unknown;
  readonly principal: unknown;
  readonly space: unknown;
  readonly backend_id: unknown;
  readonly target_key: unknown;
  readonly generation: unknown;
  readonly observed_generation: unknown;
  readonly phase: unknown;
  readonly spec_json: unknown;
  readonly last_operation: unknown;
  readonly busy_operation: unknown;
  readonly deleted_at: unknown;
  readonly action: unknown;
  readonly status: unknown;
  readonly effect: unknown;
  readonly op_resource_uid: unknown;
  readonly op_principal: unknown;
  readonly op_backend_id: unknown;
  readonly op_target_key: unknown;
  readonly op_generation: unknown;
  readonly accepted_spec_json: unknown;
  readonly op_lease_token: unknown;
  readonly op_dispatch_possible: unknown;
  readonly op_lease_live: unknown;
  readonly worker_form_url: unknown;
  readonly worker_uid: unknown;
  readonly worker_principal: unknown;
  readonly worker_space: unknown;
  readonly worker_backend_id: unknown;
  readonly worker_target_key: unknown;
  readonly worker_deleted_at: unknown;
  readonly worker_busy_operation: unknown;
  readonly worker_phase: unknown;
  readonly worker_generation: unknown;
  readonly worker_observed_generation: unknown;
  readonly worker_last_operation: unknown;
  readonly worker_op_status: unknown;
  readonly worker_op_effect: unknown;
  readonly worker_op_action: unknown;
  readonly worker_op_resource_uid: unknown;
  readonly worker_op_principal: unknown;
  readonly worker_op_backend_id: unknown;
  readonly worker_op_target_key: unknown;
  readonly worker_op_generation: unknown;
  readonly worker_spec_json: unknown;
  readonly worker_accepted_spec_json: unknown;
}

/**
 * Exact accepted v2 Namespace/Worker SQL graph reader. It neither observes
 * native publication nor grants event delivery; callers fence after awaits.
 */
export function createV2ActorNamespaceSqlGraphReader(options: {
  readonly sql: Sql;
  readonly targetKey: string;
}): V2ActorNamespaceSqlGraphReader {
  if (!options.targetKey) throw new TypeError("Actor targetKey is required");

  const namespaceRow = async (scope: Scope): Promise<NamespaceRow | null> => {
    const rows = (await options.sql.query(
      `SELECT namespace.uid, namespace.principal, namespace.space,
              namespace.backend_id,
              namespace.target_key, namespace.generation,
              namespace.observed_generation, namespace.phase,
              namespace.spec_json, namespace.last_operation,
              namespace.busy_operation, namespace.deleted_at,
              op.action, op.status, op.effect,
              op.resource_uid AS op_resource_uid,
              op.principal AS op_principal,
              op.backend_id AS op_backend_id,
              op.target_key AS op_target_key,
              op.generation AS op_generation,
              op.accepted_spec_json,
              op.lease_token AS op_lease_token,
              op.dispatch_possible AS op_dispatch_possible,
              CASE WHEN op.lease_until_ms > ${DB_NOW_MS} THEN 1 ELSE 0 END
                AS op_lease_live,
              worker.uid AS worker_uid,
              worker.form_url AS worker_form_url,
              worker.principal AS worker_principal,
              worker.space AS worker_space,
              worker.backend_id AS worker_backend_id,
              worker.target_key AS worker_target_key,
              worker.deleted_at AS worker_deleted_at,
              worker.busy_operation AS worker_busy_operation,
              worker.phase AS worker_phase,
              worker.generation AS worker_generation,
              worker.observed_generation AS worker_observed_generation,
              worker.last_operation AS worker_last_operation,
              worker_op.status AS worker_op_status,
              worker_op.effect AS worker_op_effect,
              worker_op.action AS worker_op_action,
              worker_op.resource_uid AS worker_op_resource_uid,
              worker_op.principal AS worker_op_principal,
              worker_op.backend_id AS worker_op_backend_id,
              worker_op.target_key AS worker_op_target_key,
              worker_op.generation AS worker_op_generation,
              worker.spec_json AS worker_spec_json,
              worker_op.accepted_spec_json AS worker_accepted_spec_json
       FROM tf_v2_resources namespace
       JOIN tf_v2_operations op ON op.id = namespace.last_operation
       JOIN tf_v2_operation_reference_sets reference_set
         ON reference_set.operation_id = op.id AND reference_set.sealed = 1
       JOIN tf_v2_resources worker ON worker.uid =
         json_extract(namespace.spec_json, '$.worker.resourceUid')
       JOIN tf_v2_operation_references reference
         ON reference.operation_id = op.id AND reference.target_uid = worker.uid
        AND reference.form_url = ? AND reference.readiness = 'observed'
        AND reference.target_spec_path IS NULL AND reference.target_spec_equals IS NULL
       JOIN tf_v2_resource_references edge
         ON edge.referrer_uid = namespace.uid AND edge.target_uid = worker.uid
       LEFT JOIN tf_v2_operations worker_op ON worker_op.id = worker.last_operation
       WHERE namespace.uid = ? AND namespace.principal = ?
         AND namespace.form_url = ? AND namespace.target_key = ?
         AND NOT EXISTS (SELECT 1 FROM tf_v2_operation_references extra
           WHERE extra.operation_id = op.id AND extra.target_uid <> worker.uid)
         AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references extra_edge
           WHERE extra_edge.referrer_uid = namespace.uid AND extra_edge.target_uid <> worker.uid)
       LIMIT 2`,
      [
        MODULE_WORKER_FORM_URL,
        scope.namespaceResourceUid,
        scope.tenantId,
        ACTOR_NAMESPACE_FORM_URL,
        options.targetKey,
      ],
    )) as unknown as readonly NamespaceRow[];
    return rows.length === 1 ? (rows[0] ?? null) : null;
  };

  const acceptedGraph = async (
    scope: Scope,
    heldOperation?: { readonly operationId: string; readonly leaseToken: string },
  ): Promise<V2ActorAcceptedSqlGraph | null> => {
    const row = await namespaceRow(scope);
    const held = heldOperation !== undefined;
    if (
      !row ||
      row.uid !== scope.namespaceResourceUid ||
      row.principal !== scope.tenantId ||
      typeof row.space !== "string" ||
      row.target_key !== options.targetKey ||
      row.deleted_at !== null ||
      (heldOperation
        ? row.busy_operation !== heldOperation.operationId ||
          row.last_operation !== heldOperation.operationId ||
          row.op_lease_token !== heldOperation.leaseToken ||
          row.op_dispatch_possible !== 1 ||
          row.op_lease_live !== 1
        : row.busy_operation !== null ||
          row.phase !== "idle" ||
          row.generation !== row.observed_generation) ||
      typeof row.last_operation !== "string" ||
      row.action === "delete" ||
      (row.action !== "create" && row.action !== "update") ||
      row.status !== (held ? "reconciling" : "succeeded") ||
      (!held && row.effect !== "complete") ||
      row.op_resource_uid !== row.uid ||
      row.op_principal !== row.principal ||
      row.op_backend_id !== row.backend_id ||
      row.op_target_key !== row.target_key ||
      row.op_generation !== row.generation ||
      row.accepted_spec_json !== row.spec_json ||
      typeof row.spec_json !== "string" ||
      row.worker_form_url !== MODULE_WORKER_FORM_URL ||
      row.worker_principal !== scope.tenantId ||
      row.worker_space !== row.space ||
      row.worker_target_key !== options.targetKey ||
      row.worker_deleted_at !== null ||
      row.worker_busy_operation !== null ||
      row.worker_phase !== "idle" ||
      row.worker_generation !== row.worker_observed_generation ||
      typeof row.worker_last_operation !== "string" ||
      row.worker_op_status !== "succeeded" ||
      row.worker_op_effect !== "complete" ||
      (row.worker_op_action !== "create" && row.worker_op_action !== "update") ||
      row.worker_op_resource_uid !== row.worker_uid ||
      row.worker_op_principal !== row.worker_principal ||
      row.worker_op_backend_id !== row.worker_backend_id ||
      row.worker_op_target_key !== row.worker_target_key ||
      row.worker_op_generation !== row.worker_generation ||
      row.worker_spec_json !== row.worker_accepted_spec_json
    )
      return null;
    let spec: ReturnType<typeof parseActorNamespaceSpec>;
    try {
      spec = parseActorNamespaceSpec(JSON.parse(row.spec_json));
    } catch {
      return null;
    }
    const authorityKey = canonicalJson({
      namespaceUid: row.uid,
      principal: row.principal,
      space: row.space,
      targetKey: row.target_key,
      generation: row.generation,
      operationId: row.last_operation,
      specJson: row.spec_json,
      workerUid: spec.worker.resourceUid,
      workerGeneration: row.worker_generation,
      workerOperationId: row.worker_last_operation,
      workerSpecJson: row.worker_spec_json,
    });
    return {
      scope: { ...scope },
      space: row.space,
      workerUid: spec.worker.resourceUid,
      className: spec.className,
      namespaceOperationId: row.last_operation,
      workerOperationId: row.worker_last_operation,
      runtimeClassRef: ACTOR_ABI_INTERFACE_REFS.v2,
      authorityKey,
    };
  };

  const activeDeployment = async (
    graph: Pick<V2ActorAcceptedSqlGraph, "scope" | "authorityKey" | "workerUid">,
  ): Promise<boolean> => {
    if ((await acceptedGraph(graph.scope))?.authorityKey !== graph.authorityKey) return false;
    const row = await namespaceRow(graph.scope);
    if (!row || typeof row.space !== "string") return false;
    const rows = await options.sql.query(
      `SELECT 1 FROM tf_v2_resources deployment
       JOIN tf_v2_operations active_op
         ON active_op.resource_uid = deployment.uid
        AND active_op.generation = deployment.observed_generation
       WHERE deployment.form_url = ? AND deployment.principal = ?
         AND deployment.space = ? AND deployment.target_key = ?
         AND deployment.deleted_at IS NULL AND deployment.observed_generation > 0
         AND NOT EXISTS (
           SELECT 1 FROM tf_v2_operations pending_delete
           WHERE pending_delete.id = deployment.busy_operation
             AND pending_delete.action = 'delete'
         )
         AND active_op.action IN ('create', 'update')
         AND active_op.status = 'succeeded' AND active_op.effect = 'complete'
         AND json_extract(active_op.accepted_spec_json, '$.worker.resourceUid') = ?
         AND json_extract(deployment.observed_json, '$.ready') = 1
         AND json_extract(deployment.observed_json, '$.active') = 1
       LIMIT 2`,
      [
        WORKER_DEPLOYMENT_FORM_URL,
        graph.scope.tenantId,
        row.space,
        options.targetKey,
        graph.workerUid,
      ],
    );
    return rows.length === 1;
  };

  return {
    readGraph: (scope: Scope) => acceptedGraph(scope),
    readAcceptedOperationGraph: (
      scope: Scope,
      operation: { readonly operationId: string; readonly leaseToken: string },
    ) => acceptedGraph(scope, operation),
    async hasNamespaceAuthority(scope: Scope): Promise<boolean> {
      const row = await namespaceRow(scope);
      if (!row || row.deleted_at !== null) return false;
      return !(row.busy_operation === row.last_operation && row.action === "delete");
    },
    hasActiveDeployment: activeDeployment,
    async stillCurrent(
      graph: Pick<V2ActorAcceptedSqlGraph, "scope" | "authorityKey">,
    ): Promise<boolean> {
      return (await acceptedGraph(graph.scope))?.authorityKey === graph.authorityKey;
    },
  };
}
