import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  validateModuleWorkerUpdate,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
  WorkerFormValidationError,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";
import type { V2WorkerVersionResolution } from "./worker-publication-state.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";

export const MODULE_WORKER_LIFECYCLE_BACKEND_ID = "selfhost-v2-module-worker-identity-v1";
export const WORKER_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-static-worker-version-v1";

type VersionState = {
  resolveVersion(input: { execution: V2Execution }): Promise<V2WorkerVersionResolution>;
};

/** Exact runtime owner identity; a Deployment receipt for one incarnation is insufficient. */
export interface V2WorkerRetirementTarget {
  readonly kind: "worker" | "version";
  readonly workerUid: string;
  readonly versionUid: string | null;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly backendId: string;
  readonly backendKey: string;
  readonly generation: number;
}

export interface V2WorkerRetirementProof {
  readonly kind: "retired";
  readonly target: V2WorkerRetirementTarget;
  readonly scope: "all_incarnations_and_contexts";
  readonly receipt: string;
}

export interface V2WorkerRetirementReader {
  /** Read-only proof across every active/draining incarnation; never infer absence from timeout. */
  observeRetired(
    target: V2WorkerRetirementTarget,
  ): Promise<V2WorkerRetirementProof | { readonly kind: "unknown" }>;
}

const unresolved = (): V2BackendResult => ({ kind: "unknown" });

const DB_LEASE_FENCE = "(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000";

async function currentClaim(sql: Sql, execution: V2Execution): Promise<boolean> {
  const rows = await sql.query(
    `SELECT op.id FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
     WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
       AND op.action = ? AND op.generation = ? AND op.backend_key = ?
       AND op.backend_id = ? AND op.target_key = ? AND op.accepted_spec_json = ?
       AND op.status = 'reconciling' AND op.dispatch_possible = 1
       AND op.lease_token = ? AND op.lease_until_ms > ${DB_LEASE_FENCE}
       AND r.uid = ? AND r.principal = ? AND r.form_url = ? AND r.space = ?
       AND r.name = ? AND r.backend_id = ? AND r.target_key = ?
       AND r.generation = op.generation AND r.last_operation = op.id
       AND r.busy_operation = op.id AND r.deleted_at IS NULL
       AND r.spec_json = op.accepted_spec_json LIMIT 1`,
    [
      execution.operationId,
      execution.resourceUid,
      execution.principal,
      execution.action,
      execution.generation,
      execution.backendKey,
      execution.backendId,
      execution.targetKey,
      canonicalJson(execution.spec),
      execution.leaseToken,
      execution.resourceUid,
      execution.principal,
      execution.form,
      execution.space,
      execution.name,
      execution.backendId,
      execution.targetKey,
    ],
  );
  return rows.length === 1;
}

async function noInboundReferences(sql: Sql, uid: string): Promise<boolean> {
  return (
    (
      await sql.query(
        "SELECT target_uid FROM tf_v2_resource_references WHERE target_uid = ? LIMIT 1",
        [uid],
      )
    ).length === 0
  );
}

async function retired(
  sql: Sql,
  observeRetired: V2WorkerRetirementReader["observeRetired"],
  execution: V2Execution,
  workerUid: string,
  kind: V2WorkerRetirementTarget["kind"],
): Promise<boolean> {
  if (
    !(await currentClaim(sql, execution)) ||
    !(await noInboundReferences(sql, execution.resourceUid))
  ) {
    return false;
  }
  const target: V2WorkerRetirementTarget = Object.freeze({
    kind,
    workerUid,
    versionUid: kind === "version" ? execution.resourceUid : null,
    operationId: execution.operationId,
    resourceUid: execution.resourceUid,
    principal: execution.principal,
    space: execution.space,
    targetKey: execution.targetKey,
    backendId: execution.backendId,
    backendKey: execution.backendKey,
    generation: execution.generation,
  });
  const expectedTarget = canonicalJson(target);
  const proof = await observeRetired(target);
  return (
    proof.kind === "retired" &&
    proof.scope === "all_incarnations_and_contexts" &&
    typeof proof.receipt === "string" &&
    proof.receipt.length > 0 &&
    canonicalJson(proof.target) === expectedTarget &&
    (await currentClaim(sql, execution)) &&
    (await noInboundReferences(sql, execution.resourceUid))
  );
}

function validated<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof WorkerFormValidationError) {
      throw new TakoformV2Error(error.code, 422);
    }
    throw error;
  }
}

/**
 * Internal identity-only management backend. No runtime is allocated by a
 * ModuleWorker CREATE. Once other Resources refer to it, this backend cannot
 * re-derive active serving state from a bare Worker Operation and stays unknown
 * instead of refreshing a previous observation as if it were current.
 */
export function createInternalV2ModuleWorkerForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly retirement: V2WorkerRetirementReader;
}): V2Form {
  if (!options.targetKey || !options.retirement?.observeRetired) {
    throw new TypeError("ModuleWorker requires targetKey and exact retirement reader");
  }
  const { sql, targetKey } = options;
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== MODULE_WORKER_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== MODULE_WORKER_LIFECYCLE_BACKEND_ID
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        return (await retired(sql, observeRetired, execution, execution.resourceUid, "worker"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      parseModuleWorkerSpec(execution.spec);
      if (!(await currentClaim(sql, execution))) return unresolved();
      if (!(await noInboundReferences(sql, execution.resourceUid))) return unresolved();
      if (!(await currentClaim(sql, execution))) return unresolved();
      // A current accepted Worker operation keeps the target busy, preventing
      // a new inbound observed reference from attaching before settlement.
      return {
        kind: "complete",
        observed: { activeDeploymentUid: null, ready: false },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      validated(() => parseModuleWorkerSpec(spec));
    },
    validateUpdate(previous, spec) {
      validated(() => validateModuleWorkerUpdate(previous, spec));
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: MODULE_WORKER_LIFECYCLE_BACKEND_ID,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

function staticOnly(spec: WorkerVersionSpec): WorkerVersionSpec {
  // The code projection currently cannot produce a publishable Host entrypoint
  // or the complete Binding/private-input/event ABI. Do not accept a pending
  // Operation that can never become eligible on this internal backend.
  if (spec.bundle !== undefined) throw new TakoformV2Error("capability_required", 422);
  return spec;
}

/**
 * Internal static-only Version eligibility. This does not publish a Deployment
 * or make a Form support claim. The resolver owns accepted SQL references and
 * held-byte custody; the projection checks the asset serving snapshot.
 */
export function createInternalV2StaticWorkerVersionForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
}): V2Form {
  if (
    !options.targetKey ||
    !options.publicationState?.resolveVersion ||
    !options.retirement?.observeRetired
  ) {
    throw new TypeError(
      "WorkerVersion requires targetKey, publication state and exact retirement reader",
    );
  }
  const { sql, targetKey } = options;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== WORKER_VERSION_LIFECYCLE_BACKEND_ID
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = parseWorkerVersionSpec(execution.spec);
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = staticOnly(parseWorkerVersionSpec(execution.spec));
      const resolution = await resolveVersion({ execution });
      if (resolution.kind !== "ready") return unresolved();
      const { snapshot } = resolution;
      if (
        snapshot.sourceOperationId !== execution.operationId ||
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        snapshot.version.uid !== execution.resourceUid ||
        snapshot.version.generation !== execution.generation ||
        canonicalJson(snapshot.version.spec) !== canonicalJson(spec)
      ) {
        return unresolved();
      }
      const readMaterials = resolution.readMaterials.bind(resolution);
      const stillCurrent = resolution.stillCurrent.bind(resolution);
      const materials = await readMaterials();
      await projectV2StaticWorkerVersion({
        identity: {
          directory: snapshot.worker.uid,
          hostnames: [],
          generation: execution.operationId,
          workerResourceUid: snapshot.worker.uid,
          workerVersionUid: snapshot.version.uid,
          versionId: snapshot.version.uid,
          weight: 10_000,
        },
        spec: snapshot.version.spec,
        materials,
      });
      if (!(await stillCurrent())) return unresolved();
      return {
        kind: "complete",
        observed: { ready: true, resolvedBindings: true },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      staticOnly(validated(() => parseWorkerVersionSpec(spec)));
    },
    validateUpdate(previous, spec) {
      staticOnly(validated(() => validateWorkerVersionUpdate(previous, spec)));
    },
    references(spec) {
      return referencesForWorkerVersion(staticOnly(validated(() => parseWorkerVersionSpec(spec))));
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_VERSION_LIFECYCLE_BACKEND_ID,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}
