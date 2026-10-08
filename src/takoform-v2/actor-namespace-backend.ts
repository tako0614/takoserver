import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { createSelfhostActorExecutionHost } from "../selfhost-actor-execution-host.ts";
import type {
  ActorExecutionGraph,
  ActorExecutionRealization,
} from "../selfhost-actor-graph-authority.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import {
  prepareV2ActorNamespaceAdmission,
  v2ActorDeploymentsAbsent,
} from "./actor-namespace-admission.ts";
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
  WORKER_DEPLOYMENT_FORM_URL,
} from "./forms/worker-specs.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2BackendResult,
  type V2Execution,
  type V2Form,
} from "./types.ts";

export const V2_ACTOR_NAMESPACE_BACKEND_ID = "selfhost-v2-actor-namespace-sql-v1";
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";
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

export type V2ActorAcceptedOperationRuntimeObserver = Pick<
  ReturnType<typeof createSelfhostActorExecutionHost>,
  "observeNamespaceRuntimeForAcceptedOperation" | "warmNamespaceForAcceptedOperation"
>;

type PhysicalActorHost = Pick<
  ReturnType<typeof createSelfhostActorExecutionHost>,
  "registerNamespace" | "namespaceEmpty" | "forgetNamespace" | "namespaceAbsent"
> &
  Partial<V2ActorAcceptedOperationRuntimeObserver>;

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
 * Internal Form only, not a public FormSupport registration. Active completion
 * requires physically observed native counts under an exact accepted graph.
 * A missing Session may only be warmed under this backend's held Operation;
 * ordinary event delivery retains the strict settled graph reader.
 */
export function createV2ActorNamespaceForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly bundleCustody: Pick<WorkerBundleCustody, "readHeldVerified">;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectActorClass">;
  readonly physical: PhysicalActorHost;
  readonly ownerForWorker?: (workerUid: string) => Promise<ActorOwner | null>;
  readonly acceptedGraph?: {
    readAcceptedOperationGraph(
      scope: ActorExecutionGraph["scope"],
      operation: { readonly operationId: string; readonly leaseToken: string },
    ): Promise<ActorExecutionGraph | null>;
    acceptedOperationRealization(
      native: Extract<
        Awaited<ReturnType<NonNullable<ActorOwner["observeActorGraphForAcceptedOperation"]>>>,
        { readonly kind: "ready" }
      >,
    ): ActorExecutionRealization;
  };
}): V2Form {
  if (!options.targetKey) throw new TypeError("Actor targetKey is required");

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
      return {
        sourceOperationId: row.id,
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
    if (!observe || !warm || !options.ownerForWorker || !options.acceptedGraph) return UNKNOWN;
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
    const owner = await options.ownerForWorker(spec.worker.resourceUid);
    if (!owner || owner.workerResourceUid !== spec.worker.resourceUid) return UNKNOWN;
    const serving = await owner.observeServing({
      workerResourceUid: spec.worker.resourceUid,
      targetKey: options.targetKey,
    });
    if (
      serving.kind !== "serving" ||
      serving.sourceOperationId !== sourceOperationId ||
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
        )?.authorityKey !== accepted.authorityKey
      )
        return false;
      const currentServing = await owner.observeServing({
        workerResourceUid: spec.worker.resourceUid,
        targetKey: options.targetKey,
      });
      if (
        currentServing.kind !== "serving" ||
        currentServing.sourceOperationId !== sourceOperationId ||
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
        )?.authorityKey === accepted.authorityKey
      );
    };
    const signal = AbortSignal.timeout(30_000);
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    await options.physical.registerNamespace(scope);
    if (!(await stillAuthorized(signal))) return UNKNOWN;
    let first = await observe(scope, expected, signal);
    if (first.kind !== "confirmed") {
      first = await warm(
        scope,
        {
          graph: accepted,
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
    const scope = { tenantId: execution.principal, namespaceResourceUid: execution.resourceUid };
    try {
      if (!(await ownsClaim(execution))) return UNKNOWN;
      if (execution.action === "delete") {
        await options.physical.forgetNamespace(scope);
        if (!(await options.physical.namespaceAbsent(scope)) || !(await ownsClaim(execution)))
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
      await options.physical.registerNamespace(scope);
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
