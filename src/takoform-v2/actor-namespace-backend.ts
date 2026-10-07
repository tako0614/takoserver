import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { createSelfhostActorExecutionHost } from "../selfhost-actor-execution-host.ts";
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
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";

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

type PhysicalActorHost = Pick<
  ReturnType<typeof createSelfhostActorExecutionHost>,
  "registerNamespace" | "namespaceEmpty" | "forgetNamespace" | "namespaceAbsent"
>;

/**
 * Not a FormSupport registration. With an active Deployment this backend
 * deliberately cannot complete until native Actor counts/socket/alarm readback
 * and selected-Version env capability are connected.
 */
export function createV2ActorNamespaceForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly bundleCustody: Pick<WorkerBundleCustody, "readHeldVerified">;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectActorClass">;
  readonly physical: PhysicalActorHost;
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
      if (
        !(await v2ActorDeploymentsAbsent({
          sql: options.sql,
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
        }))
      )
        return UNKNOWN;
      await options.physical.registerNamespace(scope);
      if (!(await options.physical.namespaceEmpty(scope))) return UNKNOWN;
      if (
        !(await ownsClaim(execution)) ||
        !(await v2ActorDeploymentsAbsent({
          sql: options.sql,
          principal: execution.principal,
          space: execution.space,
          targetKey: execution.targetKey,
          workerUid: spec.worker.resourceUid,
        })) ||
        !(await options.physical.namespaceEmpty(scope)) ||
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
