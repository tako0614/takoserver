import type {
  ActorExecutionGraph,
  ActorExecutionRealization,
} from "../actor-execution-contract.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import {
  prepareV2ActorNamespaceAdmission,
  v2ActorDeploymentsAbsent,
} from "./actor-namespace-admission.ts";
import {
  createV2ActorNamespaceSqlGraphReader,
  type V2ActorAcceptedDeleteClaim,
} from "./actor-namespace-sql-graph.ts";
import type { V2FormFrontFace } from "./form-frontface.ts";
import {
  ACTOR_NAMESPACE_FORM_URL,
  ActorNamespaceValidationError,
  parseActorNamespaceSpec,
  referencesForActorNamespace,
  validateActorNamespaceUpdate,
} from "./forms/actor-namespace.ts";
import type { WorkerBundleCustody } from "./forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "./forms/worker-specs.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2BackendResult,
  type V2Execution,
  type V2Form,
} from "./types.ts";

export const V2_ACTOR_NAMESPACE_BACKEND_ID = "selfhost-v2-actor-namespace-sql-v1";

/** The exact synchronous Form policy, without SQL admission or physical ownership. */
export function createV2ActorNamespaceFormFrontFace(): V2FormFrontFace {
  return {
    validateCreate(spec) {
      try {
        parseActorNamespaceSpec(spec);
      } catch (error) {
        if (error instanceof ActorNamespaceValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateActorNamespaceUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof ActorNamespaceValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    references: referencesForActorNamespace,
    rejectDeleteWhileReferenced: true,
  };
}

const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";
const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const UNKNOWN: V2BackendResult = {
  kind: "unknown",
  code: "outcome_unconfirmed",
  message: "Actor namespace outcome is not yet confirmed",
};
const EMPTY_OBSERVED = {
  ready: false,
  activeActorCount: 0,
  pendingAlarmCount: 0,
  openSocketCount: 0,
} as const;

export type V2ActorNamespaceScope = ActorExecutionGraph["scope"];

/** Exact held native target. This is not an accepted-SQL or delivery grant. */
export interface V2ActorNamespaceRuntimeTarget {
  readonly workerUid: string;
  readonly className: string;
  readonly sourceOperationId: string;
  readonly incarnationId: string;
  readonly generationKey: string;
  readonly versions: readonly {
    readonly versionId: string;
    readonly workerVersionUid: string;
    readonly weight: number;
  }[];
}

export type V2ActorNamespaceRuntimeObservation =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "confirmed";
      readonly epoch: string;
      readonly observedAt: number;
      readonly activeActorCount: number;
      readonly pendingAlarmCount: number;
      readonly openSocketCount: number;
    };

export interface V2ActorNamespaceWarmCandidate {
  readonly graph: ActorExecutionGraph;
  readonly realization: ActorExecutionRealization;
  readonly expected: V2ActorNamespaceRuntimeTarget;
  readonly stillAuthorized: (signal: AbortSignal) => Promise<boolean>;
}

/** Host-private, exact native Worker publication. No Workerd site or socket is inferred. */
export interface V2ActorNamespaceNativeSnapshot {
  readonly scope: V2ActorNamespaceScope;
  readonly workerUid: string;
  readonly className: string;
  readonly targetKey: string;
  readonly sourceOperationId: string;
  readonly incarnationId: string;
  readonly generation: string;
  readonly generationKey: string;
  readonly hostnames: readonly string[];
  readonly versions: V2ActorNamespaceRuntimeTarget["versions"];
}

/** Provider owns its native code/graph readback; Core owns accepted SQL and fences. */
export interface V2ActorNamespaceProviderPort {
  observeNativeForAcceptedOperation(input: {
    readonly scope: V2ActorNamespaceScope;
    /** Held Namespace Operation, distinct from the native Worker publisher. */
    readonly operation: { readonly operationId: string; readonly leaseToken: string };
    readonly workerUid: string;
    readonly className: string;
    readonly targetKey: string;
    readonly sourceOperationId: string;
  }): Promise<
    | { readonly kind: "unknown" }
    | { readonly kind: "ready"; readonly snapshot: V2ActorNamespaceNativeSnapshot }
  >;
  observeNamespaceRuntimeForAcceptedOperation(
    scope: V2ActorNamespaceScope,
    snapshot: V2ActorNamespaceNativeSnapshot,
    signal: AbortSignal,
  ): Promise<V2ActorNamespaceRuntimeObservation>;
  warmNamespaceForAcceptedOperation(
    scope: V2ActorNamespaceScope,
    candidate: {
      readonly graph: ActorExecutionGraph;
      readonly snapshot: V2ActorNamespaceNativeSnapshot;
      readonly stillAuthorized: (signal: AbortSignal) => Promise<boolean>;
    },
    signal: AbortSignal,
  ): Promise<V2ActorNamespaceRuntimeObservation>;
}

/** Physical ownership/readback port; the backend retains SQL and claim authority. */
export interface V2ActorNamespacePhysicalPort {
  registerNamespace(
    scope: V2ActorNamespaceScope,
    operation: { readonly operationId: string; readonly leaseToken: string },
  ): Promise<void>;
  namespaceEmpty(scope: V2ActorNamespaceScope): Promise<boolean>;
  forgetNamespace(scope: V2ActorNamespaceScope, claim: V2ActorAcceptedDeleteClaim): Promise<void>;
  namespaceAbsent(
    scope: V2ActorNamespaceScope,
    claim: V2ActorAcceptedDeleteClaim,
  ): Promise<boolean>;
  observeNamespaceRuntimeForAcceptedOperation?(
    scope: V2ActorNamespaceScope,
    expected: V2ActorNamespaceRuntimeTarget,
    signal: AbortSignal,
  ): Promise<V2ActorNamespaceRuntimeObservation>;
  warmNamespaceForAcceptedOperation?(
    scope: V2ActorNamespaceScope,
    candidate: V2ActorNamespaceWarmCandidate,
    signal: AbortSignal,
  ): Promise<V2ActorNamespaceRuntimeObservation>;
}

export type V2ActorAcceptedOperationRuntimeObserver = Required<
  Pick<
    V2ActorNamespacePhysicalPort,
    "observeNamespaceRuntimeForAcceptedOperation" | "warmNamespaceForAcceptedOperation"
  >
>;

interface ActorOwner {
  readonly workerResourceUid: string;
  observeServing(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
  }): Promise<
    | { readonly kind: "unknown" }
    | {
        readonly kind: "serving";
        readonly sourceOperationId: string;
        readonly generation: string;
        readonly hostnames: readonly string[];
        readonly versions: readonly {
          readonly workerVersionUid: string;
          readonly weight: number;
        }[];
      }
  >;
  observeActorGraphForAcceptedOperation?(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
    readonly sourceOperationId: string;
  }): Promise<
    | { readonly kind: "unknown" }
    | {
        readonly kind: "ready";
        readonly sourceOperationId: string;
        readonly incarnationId: string;
        readonly script: string;
        readonly identity: {
          readonly workerResourceUid: string;
          readonly generation: string;
          readonly hostnames: readonly string[];
          readonly versions: readonly {
            readonly versionId: string;
            readonly workerVersionUid: string;
            readonly weight: number;
          }[];
        };
        readonly graph: ActorExecutionRealization["graph"];
        readonly actorForwardSockets: NonNullable<ActorExecutionRealization["actorForwardSockets"]>;
      }
  >;
}

/**
 * Active completion requires physically observed native counts under an exact
 * accepted graph.
 * A missing Session may only be warmed under this backend's held Operation;
 * ordinary event delivery retains the strict settled graph reader.
 */
export function createV2ActorNamespaceForm(configuration: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly bundleCustody: Pick<WorkerBundleCustody, "readHeldVerified">;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectActorClass">;
  readonly physical: V2ActorNamespacePhysicalPort;
  readonly ownerForWorker?: (workerUid: string) => Promise<ActorOwner | null>;
  readonly providerNative?: V2ActorNamespaceProviderPort;
  readonly acceptedGraph?: {
    readAcceptedOperationGraph(
      scope: ActorExecutionGraph["scope"],
      operation: { readonly operationId: string; readonly leaseToken: string },
    ): Promise<ActorExecutionGraph | null>;
    acceptedOperationRealization?(
      native: Extract<
        Awaited<ReturnType<NonNullable<ActorOwner["observeActorGraphForAcceptedOperation"]>>>,
        { readonly kind: "ready" }
      >,
    ): ActorExecutionRealization;
  };
}): V2Form {
  // The Host selects this composition once. An awaited provider cannot retarget
  // an in-flight accepted Operation by mutating the factory's option bag.
  const options = Object.freeze({ ...configuration });
  if (!options.targetKey) throw new TypeError("Actor targetKey is required");
  const deleteGraph = createV2ActorNamespaceSqlGraphReader({
    sql: options.sql,
    targetKey: options.targetKey,
  });

  const ownsClaim = async (execution: V2Execution): Promise<boolean> => {
    const rows = await options.sql.query(
      `SELECT 1 FROM tf_v2_operations op
       JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
       WHERE op.id = ? AND op.lease_token = ? AND op.resource_uid = ?
         AND op.principal = ? AND op.backend_id = ? AND op.target_key = ?
         AND op.backend_key = ? AND op.action = ? AND op.generation = ?
         AND op.accepted_spec_json = ? AND op.status = 'reconciling'
         AND op.dispatch_possible = 1 AND op.lease_until_ms > ${DB_NOW_MS}
         AND resource.uid = ? AND resource.principal = ? AND resource.form_url = ?
         AND resource.space = ? AND resource.name = ? AND resource.backend_id = op.backend_id
         AND resource.target_key = op.target_key AND resource.generation = op.generation
         AND resource.spec_json = op.accepted_spec_json
         AND resource.last_operation = op.id AND resource.busy_operation = op.id
         AND resource.deleted_at IS NULL LIMIT 2`,
      [
        execution.operationId,
        execution.leaseToken,
        execution.resourceUid,
        execution.principal,
        execution.backendId,
        execution.targetKey,
        execution.backendKey,
        execution.action,
        execution.generation,
        canonicalJson(execution.spec),
        execution.resourceUid,
        execution.principal,
        ACTOR_NAMESPACE_FORM_URL,
        execution.space,
        execution.name,
      ],
    );
    return rows.length === 1;
  };

  const ownsReference = async (execution: V2Execution, workerUid: string): Promise<boolean> => {
    const rows = await options.sql.query(
      `SELECT 1 FROM tf_v2_operation_reference_sets reference_set
       JOIN tf_v2_operation_references reference
         ON reference.operation_id = reference_set.operation_id
       JOIN tf_v2_resource_references edge
         ON edge.referrer_uid = ? AND edge.target_uid = reference.target_uid
       JOIN tf_v2_resources worker ON worker.uid = reference.target_uid
       WHERE reference_set.operation_id = ? AND reference_set.sealed = 1
         AND reference.target_uid = ? AND reference.form_url = ?
         AND reference.readiness = 'observed'
         AND reference.target_spec_path IS NULL
         AND reference.target_spec_equals IS NULL
         AND worker.uid = ? AND worker.principal = ? AND worker.space = ?
         AND worker.form_url = ? AND worker.target_key = ? AND worker.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tf_v2_operation_references extra
           WHERE extra.operation_id = ? AND extra.target_uid <> ?)
         AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references extra_edge
           WHERE extra_edge.referrer_uid = ? AND extra_edge.target_uid <> ?)
       LIMIT 2`,
      [
        execution.resourceUid,
        execution.operationId,
        workerUid,
        MODULE_WORKER_FORM_URL,
        workerUid,
        execution.principal,
        execution.space,
        MODULE_WORKER_FORM_URL,
        options.targetKey,
        execution.operationId,
        workerUid,
        execution.resourceUid,
        workerUid,
      ],
    );
    return rows.length === 1;
  };

  const admissionCurrent = async (predicate: V2AdmissionPredicate): Promise<boolean> => {
    const rows = await options.sql.query(`SELECT (${predicate.sql}) AS allowed`, predicate.params);
    return rows.length === 1 && rows[0]?.allowed === 1;
  };

  const activeSourceOperation = async (
    execution: V2Execution,
    workerUid: string,
  ): Promise<{
    readonly sourceOperationId: string;
    readonly hostnames: readonly string[];
    readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
  } | null> => {
    const rows = await options.sql.query(
      `SELECT deployment.uid, deployment.principal, deployment.space,
         deployment.backend_id, deployment.target_key, deployment.generation,
         deployment.observed_generation, deployment.phase, deployment.busy_operation,
         deployment.last_operation, deployment.spec_json, deployment.observed_json,
         op.id, op.resource_uid, op.principal AS op_principal,
         op.backend_id AS op_backend_id, op.target_key AS op_target_key,
         op.generation AS op_generation, op.accepted_spec_json,
         op.action, op.status, op.effect
       FROM tf_v2_resources deployment
       JOIN tf_v2_operations op ON op.resource_uid = deployment.uid
         AND op.generation = deployment.observed_generation
       WHERE deployment.form_url = ? AND deployment.principal = ?
         AND deployment.space = ? AND deployment.target_key = ?
         AND deployment.deleted_at IS NULL
         AND json_extract(deployment.observed_json, '$.active') = 1
         AND json_extract(deployment.observed_json, '$.ready') = 1
         AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
       LIMIT 2`,
      [
        WORKER_DEPLOYMENT_FORM_URL,
        execution.principal,
        execution.space,
        options.targetKey,
        workerUid,
      ],
    );
    const row = rows.length === 1 ? rows[0] : undefined;
    if (
      !row ||
      typeof row.id !== "string" ||
      row.principal !== execution.principal ||
      row.space !== execution.space ||
      row.target_key !== options.targetKey ||
      row.phase !== "idle" ||
      row.busy_operation !== null ||
      row.last_operation !== row.id ||
      row.generation !== row.observed_generation ||
      row.resource_uid !== row.uid ||
      row.op_principal !== row.principal ||
      row.op_backend_id !== row.backend_id ||
      row.op_target_key !== row.target_key ||
      row.op_generation !== row.generation ||
      row.accepted_spec_json !== row.spec_json ||
      (row.action !== "create" && row.action !== "update") ||
      row.status !== "succeeded" ||
      row.effect !== "complete"
    )
      return null;
    try {
      const spec = parseWorkerDeploymentSpec(JSON.parse(String(row.spec_json)));
      const observed = JSON.parse(String(row.observed_json)) as Record<string, unknown>;
      const selected = observed.selectedVersions;
      if (
        spec.worker.resourceUid !== workerUid ||
        !Array.isArray(selected) ||
        selected.length !== spec.versions.length ||
        spec.versions.some(
          (weighted) =>
            !selected.some(
              (item: unknown) =>
                item !== null &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                (item as Record<string, unknown>).resourceUid ===
                  weighted.workerVersion.resourceUid &&
                (item as Record<string, unknown>).weight === weighted.weight,
            ),
        )
      )
        return null;
      // A confirmed Endpoint can republish this exact Deployment without
      // changing its weighted Versions. The durable latest accepted publisher,
      // not the Deployment's own Operation or a wall-clock timestamp, owns the
      // current native marker. Do not consult the generic current-serving
      // resolver here: this accepted Namespace PUT is itself a busy Version
      // dependency until the backend confirms its physical observation.
      const publisherRows = await options.sql.query(
        `SELECT r.uid, r.form_url, r.principal, r.space, r.backend_id,
           r.target_key, r.generation, r.observed_generation, r.phase,
           r.busy_operation, r.deleted_at, r.last_operation, r.spec_json,
           r.observed_json, r.output_json,
           source.id, source.resource_uid, source.principal AS op_principal,
           source.backend_id AS op_backend_id, source.target_key AS op_target_key,
           source.generation AS op_generation, source.accepted_spec_json,
           source.action, source.status, source.effect, source.acceptance_order
         FROM tf_v2_resources r
         JOIN tf_v2_operations source ON source.id = r.last_operation
         WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
           AND r.target_key = ?
           AND json_extract(source.accepted_spec_json, '$.worker.resourceUid') = ?
         ORDER BY source.acceptance_order DESC LIMIT 2`,
        [
          WORKER_DEPLOYMENT_FORM_URL,
          WORKER_ENDPOINT_FORM_URL,
          execution.principal,
          execution.space,
          options.targetKey,
          workerUid,
        ],
      );
      const publisher = publisherRows[0];
      if (
        !publisher ||
        typeof publisher.id !== "string" ||
        typeof publisher.acceptance_order !== "number" ||
        !Number.isSafeInteger(publisher.acceptance_order) ||
        publisher.acceptance_order <= 0 ||
        publisher.acceptance_order === publisherRows[1]?.acceptance_order ||
        publisher.last_operation !== publisher.id ||
        publisher.resource_uid !== publisher.uid ||
        publisher.principal !== execution.principal ||
        publisher.space !== execution.space ||
        publisher.target_key !== options.targetKey ||
        publisher.op_principal !== publisher.principal ||
        publisher.op_backend_id !== publisher.backend_id ||
        publisher.op_target_key !== publisher.target_key ||
        publisher.op_generation !== publisher.generation ||
        publisher.observed_generation !== publisher.generation ||
        publisher.phase !== "idle" ||
        publisher.accepted_spec_json !== publisher.spec_json ||
        publisher.status !== "succeeded" ||
        publisher.effect !== "complete" ||
        publisher.busy_operation !== null
      )
        return null;
      const endpointRows = await options.sql.query(
        `SELECT endpoint.uid, endpoint.principal, endpoint.space,
           endpoint.target_key, endpoint.generation, endpoint.observed_generation,
           endpoint.phase, endpoint.busy_operation, endpoint.last_operation,
           endpoint.spec_json, endpoint.observed_json, endpoint.output_json,
           active.id, active.resource_uid, active.principal AS op_principal,
           active.backend_id AS op_backend_id, active.target_key AS op_target_key,
           active.generation AS op_generation, active.accepted_spec_json,
           active.action, active.status, active.effect,
           endpoint.backend_id
         FROM tf_v2_resources endpoint
         JOIN tf_v2_operations active ON active.id = endpoint.last_operation
         WHERE endpoint.form_url = ? AND endpoint.principal = ?
           AND endpoint.space = ? AND endpoint.target_key = ?
           AND endpoint.deleted_at IS NULL
           AND json_extract(endpoint.spec_json, '$.worker.resourceUid') = ?
         LIMIT 2`,
        [
          WORKER_ENDPOINT_FORM_URL,
          execution.principal,
          execution.space,
          options.targetKey,
          workerUid,
        ],
      );
      if (endpointRows.length > 1) return null;
      let hostnames: readonly string[] = [];
      const endpoint = endpointRows[0];
      if (endpoint) {
        if (
          typeof endpoint.uid !== "string" ||
          typeof endpoint.id !== "string" ||
          endpoint.principal !== execution.principal ||
          endpoint.space !== execution.space ||
          endpoint.target_key !== options.targetKey ||
          endpoint.generation !== endpoint.observed_generation ||
          endpoint.phase !== "idle" ||
          endpoint.busy_operation !== null ||
          endpoint.last_operation !== endpoint.id ||
          endpoint.resource_uid !== endpoint.uid ||
          endpoint.op_principal !== endpoint.principal ||
          endpoint.op_backend_id !== endpoint.backend_id ||
          endpoint.op_target_key !== endpoint.target_key ||
          endpoint.op_generation !== endpoint.generation ||
          endpoint.accepted_spec_json !== endpoint.spec_json ||
          (endpoint.action !== "create" && endpoint.action !== "update") ||
          endpoint.status !== "succeeded" ||
          endpoint.effect !== "complete"
        )
          return null;
        const endpointSpec = parseWorkerEndpointSpec(JSON.parse(String(endpoint.spec_json)));
        const endpointObserved = JSON.parse(String(endpoint.observed_json)) as Record<
          string,
          unknown
        >;
        const endpointOutput = JSON.parse(String(endpoint.output_json)) as Record<string, unknown>;
        if (
          endpointSpec.worker.resourceUid !== workerUid ||
          endpointObserved?.tlsReady !== true ||
          endpointObserved.activeDeploymentRouteReady !== true ||
          typeof endpointOutput?.hostname !== "string" ||
          !hostnamePattern.test(endpointOutput.hostname) ||
          Object.keys(endpointOutput).sort().join(",") !== "hostname,url" ||
          endpointOutput.url !== `https://${endpointOutput.hostname}/`
        )
          return null;
        const [edge, sealed] = await Promise.all([
          options.sql.query(
            `SELECT 1 FROM tf_v2_resource_references
             WHERE referrer_uid = ? AND target_uid = ?
               AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references extra
                 WHERE extra.referrer_uid = ? AND extra.target_uid <> ?)
             LIMIT 2`,
            [endpoint.uid, workerUid, endpoint.uid, workerUid],
          ),
          options.sql.query(
            `SELECT reference.target_uid, reference.form_url,
               reference.readiness, reference.target_spec_path,
               reference.target_spec_equals
             FROM tf_v2_operation_reference_sets sealed
             JOIN tf_v2_operation_references reference
               ON reference.operation_id = sealed.operation_id
             WHERE sealed.operation_id = ? AND sealed.sealed = 1 LIMIT 2`,
            [endpoint.id],
          ),
        ]);
        if (
          edge.length !== 1 ||
          sealed.length !== 1 ||
          sealed[0]?.target_uid !== workerUid ||
          sealed[0]?.form_url !== MODULE_WORKER_FORM_URL ||
          sealed[0]?.readiness !== "observed" ||
          sealed[0]?.target_spec_path !== null ||
          sealed[0]?.target_spec_equals !== null
        )
          return null;
        hostnames = [endpointOutput.hostname];
      }
      if (publisher.form_url === WORKER_DEPLOYMENT_FORM_URL) {
        if (
          publisher.id !== row.id ||
          publisher.uid !== row.uid ||
          publisher.deleted_at !== null ||
          publisher.phase !== "idle" ||
          publisher.generation !== publisher.observed_generation ||
          (publisher.action !== "create" && publisher.action !== "update")
        )
          return null;
      } else if (publisher.form_url === WORKER_ENDPOINT_FORM_URL) {
        if (publisher.action === "delete") {
          if (publisher.deleted_at === null || endpoint !== undefined || hostnames.length !== 0)
            return null;
        } else if (
          (publisher.action !== "create" && publisher.action !== "update") ||
          publisher.deleted_at !== null ||
          publisher.phase !== "idle" ||
          publisher.generation !== publisher.observed_generation ||
          publisher.uid !== endpoint?.uid
        ) {
          return null;
        }
      } else {
        return null;
      }
      return {
        sourceOperationId: publisher.id,
        hostnames,
        versions: spec.versions
          .map((weighted) => ({
            workerVersionUid: weighted.workerVersion.resourceUid,
            weight: weighted.weight,
          }))
          .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
      };
    } catch {
      return null;
    }
  };

  const activeObserved = async (
    execution: V2Execution,
    spec: ReturnType<typeof parseActorNamespaceSpec>,
    scope: { readonly tenantId: string; readonly namespaceResourceUid: string },
  ): Promise<V2BackendResult> => {
    const observe = options.physical.observeNamespaceRuntimeForAcceptedOperation;
    const warm = options.physical.warmNamespaceForAcceptedOperation;
    if (!options.acceptedGraph) return UNKNOWN;
    const accepted = await options.acceptedGraph.readAcceptedOperationGraph(scope, {
      operationId: execution.operationId,
      leaseToken: execution.leaseToken,
    });
    if (
      !accepted ||
      accepted.workerUid !== spec.worker.resourceUid ||
      accepted.className !== spec.className
    )
      return UNKNOWN;
    const acceptedAuthorityKey = accepted.authorityKey;
    const heldGraph: ActorExecutionGraph = Object.freeze({
      ...accepted,
      scope: Object.freeze({ ...accepted.scope }),
      authorityKey: acceptedAuthorityKey,
    });
    const admission = await prepareV2ActorNamespaceAdmission({
      sql: options.sql,
      bundleCustody: options.bundleCustody,
      inspector: options.inspector,
      targetKey: options.targetKey,
      principal: execution.principal,
      space: execution.space,
      resourceUid: execution.resourceUid,
      spec: execution.spec,
    });
    if (!admission || !(await admissionCurrent(admission))) return UNKNOWN;
    const source = await activeSourceOperation(execution, spec.worker.resourceUid);
    if (!source) return UNKNOWN;
    const sourceOperationId = source.sourceOperationId;
    if (options.providerNative) {
      const provider = options.providerNative;
      const readSnapshot = () =>
        provider.observeNativeForAcceptedOperation({
          scope,
          operation: Object.freeze({
            operationId: execution.operationId,
            leaseToken: execution.leaseToken,
          }),
          workerUid: spec.worker.resourceUid,
          className: spec.className,
          targetKey: options.targetKey,
          sourceOperationId,
        });
      const read = await readSnapshot();
      if (read.kind !== "ready") return UNKNOWN;
      const captured = structuredClone(read.snapshot);
      const matchingSnapshot = (candidate: V2ActorNamespaceNativeSnapshot): boolean =>
        candidate.scope.tenantId === scope.tenantId &&
        candidate.scope.namespaceResourceUid === scope.namespaceResourceUid &&
        candidate.workerUid === spec.worker.resourceUid &&
        candidate.className === spec.className &&
        candidate.targetKey === options.targetKey &&
        candidate.sourceOperationId === sourceOperationId &&
        candidate.generation === `takoserver-v2-operation:${sourceOperationId}` &&
        typeof candidate.incarnationId === "string" &&
        candidate.incarnationId.length > 0 &&
        typeof candidate.generationKey === "string" &&
        candidate.generationKey.length > 0 &&
        canonicalJson(candidate.hostnames) === canonicalJson(source.hostnames) &&
        Array.isArray(candidate.versions) &&
        candidate.versions.length === source.versions.length &&
        candidate.versions.every(
          (version) =>
            typeof version.versionId === "string" &&
            version.versionId.length > 0 &&
            typeof version.workerVersionUid === "string" &&
            Number.isSafeInteger(version.weight) &&
            version.weight > 0,
        ) &&
        new Set(candidate.versions.map((version) => version.versionId)).size ===
          candidate.versions.length &&
        canonicalJson(
          candidate.versions
            .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
            .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
        ) === canonicalJson(source.versions);
      if (!matchingSnapshot(captured)) return UNKNOWN;
      const snapshot: V2ActorNamespaceNativeSnapshot = Object.freeze({
        scope: Object.freeze({ ...captured.scope }),
        workerUid: captured.workerUid,
        className: captured.className,
        targetKey: captured.targetKey,
        sourceOperationId: captured.sourceOperationId,
        incarnationId: captured.incarnationId,
        generation: captured.generation,
        generationKey: captured.generationKey,
        hostnames: Object.freeze([...captured.hostnames]),
        versions: Object.freeze(captured.versions.map((version) => Object.freeze({ ...version }))),
      });
      const snapshotKey = canonicalJson(snapshot);
      const captureObservation = (
        observed: V2ActorNamespaceRuntimeObservation,
      ): V2ActorNamespaceRuntimeObservation =>
        observed.kind === "confirmed" &&
        typeof observed.epoch === "string" &&
        observed.epoch.length > 0 &&
        Number.isSafeInteger(observed.observedAt) &&
        observed.observedAt >= 0 &&
        [observed.activeActorCount, observed.pendingAlarmCount, observed.openSocketCount].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
          ? Object.freeze({
              kind: "confirmed",
              epoch: observed.epoch,
              observedAt: observed.observedAt,
              activeActorCount: observed.activeActorCount,
              pendingAlarmCount: observed.pendingAlarmCount,
              openSocketCount: observed.openSocketCount,
            })
          : { kind: "unknown" };
      const stillAuthorized = async (signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        if (
          !(await ownsClaim(execution)) ||
          !(await ownsReference(execution, spec.worker.resourceUid)) ||
          !(await admissionCurrent(admission)) ||
          canonicalJson(await activeSourceOperation(execution, spec.worker.resourceUid)) !==
            canonicalJson(source) ||
          (
            await options.acceptedGraph?.readAcceptedOperationGraph(scope, {
              operationId: execution.operationId,
              leaseToken: execution.leaseToken,
            })
          )?.authorityKey !== acceptedAuthorityKey
        )
          return false;
        const current = await readSnapshot();
        signal.throwIfAborted();
        if (
          current.kind !== "ready" ||
          !matchingSnapshot(current.snapshot) ||
          canonicalJson(current.snapshot) !== snapshotKey
        )
          return false;
        return (
          (await ownsClaim(execution)) &&
          (await ownsReference(execution, spec.worker.resourceUid)) &&
          (await admissionCurrent(admission)) &&
          canonicalJson(await activeSourceOperation(execution, spec.worker.resourceUid)) ===
            canonicalJson(source) &&
          (
            await options.acceptedGraph?.readAcceptedOperationGraph(scope, {
              operationId: execution.operationId,
              leaseToken: execution.leaseToken,
            })
          )?.authorityKey === acceptedAuthorityKey
        );
      };
      const signal = AbortSignal.timeout(30_000);
      if (!(await stillAuthorized(signal))) return UNKNOWN;
      await options.physical.registerNamespace(scope, {
        operationId: execution.operationId,
        leaseToken: execution.leaseToken,
      });
      if (!(await stillAuthorized(signal))) return UNKNOWN;
      let first = captureObservation(
        await provider.observeNamespaceRuntimeForAcceptedOperation(scope, snapshot, signal),
      );
      if (first.kind !== "confirmed")
        first = captureObservation(
          await provider.warmNamespaceForAcceptedOperation(
            scope,
            { graph: heldGraph, snapshot, stillAuthorized },
            signal,
          ),
        );
      if (first.kind !== "confirmed" || !first.epoch || !(await stillAuthorized(signal)))
        return UNKNOWN;
      const second = captureObservation(
        await provider.observeNamespaceRuntimeForAcceptedOperation(scope, snapshot, signal),
      );
      if (
        second.kind !== "confirmed" ||
        second.epoch !== first.epoch ||
        !(await stillAuthorized(signal))
      )
        return UNKNOWN;
      return {
        kind: "complete",
        observed: {
          ready: true,
          activeActorCount: second.activeActorCount,
          pendingAlarmCount: second.pendingAlarmCount,
          openSocketCount: second.openSocketCount,
        },
        output: {},
      };
    }
    if (
      !observe ||
      !warm ||
      !options.ownerForWorker ||
      !options.acceptedGraph.acceptedOperationRealization
    )
      return UNKNOWN;
    const owner = await options.ownerForWorker(spec.worker.resourceUid);
    if (!owner || owner.workerResourceUid !== spec.worker.resourceUid) return UNKNOWN;
    const serving = await owner.observeServing({
      workerResourceUid: spec.worker.resourceUid,
      targetKey: options.targetKey,
    });
    if (
      serving.kind !== "serving" ||
      serving.sourceOperationId !== sourceOperationId ||
      serving.generation !== `takoserver-v2-operation:${sourceOperationId}` ||
      canonicalJson(serving.hostnames) !== canonicalJson(source.hostnames) ||
      canonicalJson(
        serving.versions
          .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
          .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
      ) !== canonicalJson(source.versions)
    )
      return UNKNOWN;
    const nativeRead = owner.observeActorGraphForAcceptedOperation;
    if (!nativeRead) return UNKNOWN;
    const native = await nativeRead.call(owner, {
      workerResourceUid: spec.worker.resourceUid,
      targetKey: options.targetKey,
      sourceOperationId,
    });
    if (
      native.kind !== "ready" ||
      native.sourceOperationId !== sourceOperationId ||
      native.identity.workerResourceUid !== spec.worker.resourceUid ||
      native.identity.generation !== serving.generation ||
      canonicalJson(native.identity.hostnames) !== canonicalJson(source.hostnames) ||
      native.graph.workerResourceUid !== spec.worker.resourceUid ||
      native.identity.generation !== native.graph.generation ||
      native.identity.versions.length !== native.graph.versions.length ||
      canonicalJson(
        native.identity.versions
          .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
          .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
      ) !== canonicalJson(source.versions) ||
      native.identity.versions.some(
        (version) =>
          !native.graph.versions.some(
            (entry) =>
              entry.versionId === version.versionId &&
              entry.workerVersionUid === version.workerVersionUid &&
              entry.weight === version.weight,
          ),
      )
    )
      return UNKNOWN;
    const expected = {
      workerUid: spec.worker.resourceUid,
      className: spec.className,
      sourceOperationId,
      incarnationId: native.incarnationId,
      generationKey: native.graph.generationKey,
      versions: native.identity.versions.map(({ versionId, workerVersionUid, weight }) => ({
        versionId,
        workerVersionUid,
        weight,
      })),
    };
    const stillAuthorized = async (signal: AbortSignal): Promise<boolean> => {
      signal.throwIfAborted();
      if (
        !(await ownsClaim(execution)) ||
        !(await ownsReference(execution, spec.worker.resourceUid)) ||
        !(await admissionCurrent(admission)) ||
        canonicalJson(await activeSourceOperation(execution, spec.worker.resourceUid)) !==
          canonicalJson(source) ||
        (
          await options.acceptedGraph?.readAcceptedOperationGraph(scope, {
            operationId: execution.operationId,
            leaseToken: execution.leaseToken,
          })
        )?.authorityKey !== acceptedAuthorityKey
      )
        return false;
      const currentServing = await owner.observeServing({
        workerResourceUid: spec.worker.resourceUid,
        targetKey: options.targetKey,
      });
      if (
        currentServing.kind !== "serving" ||
        currentServing.sourceOperationId !== sourceOperationId ||
        currentServing.generation !== serving.generation ||
        canonicalJson(currentServing.hostnames) !== canonicalJson(source.hostnames) ||
        canonicalJson(currentServing.versions) !== canonicalJson(serving.versions)
      )
        return false;
      const currentNative = await nativeRead.call(owner, {
        workerResourceUid: spec.worker.resourceUid,
        targetKey: options.targetKey,
        sourceOperationId,
      });
      signal.throwIfAborted();
      if (
        currentNative.kind !== "ready" ||
        currentNative.sourceOperationId !== sourceOperationId ||
        currentNative.incarnationId !== native.incarnationId ||
        currentNative.script !== native.script ||
        currentNative.graph.generationKey !== native.graph.generationKey ||
        canonicalJson(currentNative.actorForwardSockets) !==
          canonicalJson(native.actorForwardSockets) ||
        canonicalJson(currentNative.identity) !== canonicalJson(native.identity) ||
        canonicalJson(
          currentNative.graph.versions.map(({ versionId, workerVersionUid, weight }) => ({
            versionId,
            workerVersionUid,
            weight,
          })),
        ) !== canonicalJson(expected.versions)
      )
        return false;
      return (
        (await ownsClaim(execution)) &&
        (await ownsReference(execution, spec.worker.resourceUid)) &&
        (await admissionCurrent(admission)) &&
        canonicalJson(await activeSourceOperation(execution, spec.worker.resourceUid)) ===
          canonicalJson(source) &&
        (
          await options.acceptedGraph?.readAcceptedOperationGraph(scope, {
            operationId: execution.operationId,
            leaseToken: execution.leaseToken,
          })
        )?.authorityKey === acceptedAuthorityKey
      );
    };
    const signal = AbortSignal.timeout(30_000);
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    await options.physical.registerNamespace(scope, {
      operationId: execution.operationId,
      leaseToken: execution.leaseToken,
    });
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    let first = await observe(scope, expected, signal);
    if (first.kind !== "confirmed") {
      first = await warm(
        scope,
        {
          graph: heldGraph,
          realization: options.acceptedGraph.acceptedOperationRealization(native),
          expected,
          stillAuthorized,
        },
        signal,
      );
    }
    if (first.kind !== "confirmed" || !first.epoch) return UNKNOWN;
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    const second = await observe(scope, expected, signal);
    if (
      second.kind !== "confirmed" ||
      second.epoch !== first.epoch ||
      !Number.isSafeInteger(second.observedAt) ||
      second.observedAt < 0 ||
      ![second.activeActorCount, second.pendingAlarmCount, second.openSocketCount].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      return UNKNOWN;
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    return {
      kind: "complete",
      observed: {
        ready: true,
        activeActorCount: second.activeActorCount,
        pendingAlarmCount: second.pendingAlarmCount,
        openSocketCount: second.openSocketCount,
      },
      output: {},
    };
  };

  const run = async (source: V2Execution): Promise<V2BackendResult> => {
    // Capture every scalar before a physical owner or SQL read can await.
    const execution: V2Execution = {
      ...source,
      spec: JSON.parse(canonicalJson(source.spec)),
      previousObserved: JSON.parse(canonicalJson(source.previousObserved)),
      previousOutput: JSON.parse(canonicalJson(source.previousOutput)),
    };
    if (
      execution.form !== ACTOR_NAMESPACE_FORM_URL ||
      execution.backendId !== V2_ACTOR_NAMESPACE_BACKEND_ID ||
      execution.targetKey !== options.targetKey
    )
      return UNKNOWN;
    let spec: ReturnType<typeof parseActorNamespaceSpec>;
    try {
      spec = parseActorNamespaceSpec(execution.spec);
    } catch {
      return UNKNOWN;
    }
    const scope = Object.freeze({
      tenantId: execution.principal,
      namespaceResourceUid: execution.resourceUid,
    });
    try {
      if (!(await ownsClaim(execution))) return UNKNOWN;
      if (execution.action === "delete") {
        const operation = {
          operationId: execution.operationId,
          leaseToken: execution.leaseToken,
        };
        const claim = await deleteGraph.readAcceptedDeleteOperation(scope, operation);
        if (
          !claim ||
          claim.space !== execution.space ||
          claim.backendId !== execution.backendId ||
          claim.generation !== execution.generation ||
          claim.workerUid !== spec.worker.resourceUid ||
          claim.className !== spec.className ||
          !(await ownsClaim(execution))
        )
          return UNKNOWN;
        const authorityKey = claim.authorityKey;
        const physicalScope = Object.freeze({ ...scope });
        const physicalClaim = Object.freeze({ ...claim, scope: Object.freeze({ ...claim.scope }) });
        await options.physical.forgetNamespace(physicalScope, physicalClaim);
        if (
          (await deleteGraph.readAcceptedDeleteOperation(scope, operation))?.authorityKey !==
          authorityKey
        )
          return UNKNOWN;
        if (
          !(await options.physical.namespaceAbsent(physicalScope, physicalClaim)) ||
          (await deleteGraph.readAcceptedDeleteOperation(scope, operation))?.authorityKey !==
            authorityKey ||
          !(await ownsClaim(execution))
        )
          return UNKNOWN;
        return { kind: "complete", observed: EMPTY_OBSERVED, output: {} };
      }
      if (!(await ownsReference(execution, spec.worker.resourceUid))) return UNKNOWN;
      if (
        !(await v2ActorDeploymentsAbsent({
          sql: options.sql,
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
        }))
      ) {
        return await activeObserved(execution, spec, scope);
      }
      await options.physical.registerNamespace(scope, {
        operationId: execution.operationId,
        leaseToken: execution.leaseToken,
      });
      if (!(await options.physical.namespaceEmpty(scope))) return UNKNOWN;
      if (
        !(await ownsClaim(execution)) ||
        !(await ownsReference(execution, spec.worker.resourceUid)) ||
        !(await v2ActorDeploymentsAbsent({
          sql: options.sql,
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
        })) ||
        !(await options.physical.namespaceEmpty(scope)) ||
        !(await ownsReference(execution, spec.worker.resourceUid)) ||
        !(await ownsClaim(execution))
      )
        return UNKNOWN;
      return { kind: "complete", observed: EMPTY_OBSERVED, output: {} };
    } catch {
      return UNKNOWN;
    }
  };

  return {
    ...createV2ActorNamespaceFormFrontFace(),
    prepareAdmission(input) {
      return prepareV2ActorNamespaceAdmission({
        sql: options.sql,
        bundleCustody: options.bundleCustody,
        inspector: options.inspector,
        targetKey: options.targetKey,
        principal: input.principal,
        space: input.space,
        resourceUid: input.resourceUid,
        spec: input.spec,
      });
    },
    backend: {
      id: V2_ACTOR_NAMESPACE_BACKEND_ID,
      targetKey: options.targetKey,
      execute: run,
      reconcile: run,
    },
  };
}
