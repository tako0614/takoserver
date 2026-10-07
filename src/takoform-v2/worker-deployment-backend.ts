import { bytesDigest, canonicalJson } from "../json.ts";
import type { WorkerdPublicationIdentity } from "../workerd-runtime.ts";
import type { WorkerdWorkerRuntimeOwner } from "../workerd-worker-runtime-owner.ts";
import { referencesForWorkerDeployment } from "./forms/worker-references.ts";
import {
  parseWorkerDeploymentSpec,
  validateWorkerDeploymentUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WorkerFormValidationError,
} from "./forms/worker-specs.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";
import type {
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
} from "./worker-publication-state.ts";

/** This is an internal lifecycle adapter, not a declaration of complete Form support. */
export const WORKER_DEPLOYMENT_BACKEND_ID = "selfhost-v2-worker-deployment-owner-v1";

type PublicationState = {
  resolve(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<V2WorkerPublicationResolution>;
};

type RuntimeOwner = Pick<WorkerdWorkerRuntimeOwner, "workerResourceUid" | "execute">;

const unknown = (): V2BackendResult => ({
  kind: "unknown",
  code: "worker_publication_unconfirmed",
  message: "The Worker publication or retirement is not yet confirmed",
});

/**
 * Connect the accepted v2 Operation to the UID-owned native runtime owner.
 * No other native sender may be installed for the same Worker UID/target.
 * The caller owns that mapping, durable owner lock, and runtime lifecycle.
 */
export function createWorkerDeploymentForm(options: {
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  readonly ownerForWorker: (workerUid: string) => Promise<RuntimeOwner> | RuntimeOwner;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");

  async function run(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_DEPLOYMENT_FORM_URL ||
      execution.backendId !== WORKER_DEPLOYMENT_BACKEND_ID ||
      execution.targetKey !== options.targetKey ||
      (execution.action !== "create" &&
        execution.action !== "update" &&
        execution.action !== "delete")
    )
      return unknown();

    let spec: ReturnType<typeof parseWorkerDeploymentSpec>;
    try {
      spec = parseWorkerDeploymentSpec(execution.spec);
    } catch {
      return unknown();
    }
    // The resolver checks the exact SQL Operation, lease, backend key, owner,
    // Space, accepted spec, sealed references, and current graph. The returned
    // snapshot is never a caller-provided desired-state authority.
    const before = await options.publicationState.resolve({ execution });
    if (before.kind !== "ready" || !matchesExecution(before.snapshot, execution, spec))
      return unknown();
    if (!(await before.stillCurrent())) return unknown();

    let owner: RuntimeOwner;
    try {
      owner = await options.ownerForWorker(spec.worker.resourceUid);
    } catch {
      return unknown();
    }
    if (owner.workerResourceUid !== spec.worker.resourceUid || !(await before.stillCurrent()))
      return unknown();

    // The owner persists the exact Operation's incarnation before the native
    // send and reconciles its own uncertain state. Reconcile deliberately calls
    // that same owner; it never creates another identity or infers no effect.
    let result: Awaited<ReturnType<RuntimeOwner["execute"]>>;
    try {
      result = await owner.execute(execution);
    } catch {
      return unknown();
    }
    if (result.kind !== "confirmed") return unknown();

    // A native acknowledgement is not a Host settlement fence. Re-resolve the
    // entire SQL graph after all owner awaits, including lease expiry. A serving
    // current-operation marker may be used as incumbent only after exact native
    // readback, never as an independent authority for a different Operation.
    const after = await options.publicationState.resolve({
      execution,
      ...(result.identity === null ? {} : { incumbentSourceOperationId: execution.operationId }),
    });
    if (
      after.kind !== "ready" ||
      !matchesExecution(after.snapshot, execution, spec) ||
      !(await before.stillCurrent()) ||
      !(await after.stillCurrent())
    )
      return unknown();

    if (execution.action === "delete") {
      // The owner returns null only after admission closure, invocation
      // cancellation, and physical retirement receipts for every incarnation.
      return result.identity === null
        ? {
            kind: "complete",
            observed: { ready: false, active: false, selectedVersions: [] },
            output: {},
          }
        : unknown();
    }
    if (
      result.identity === null ||
      !(await exactIdentity(result.identity, after.snapshot, execution.operationId)) ||
      !(await after.stillCurrent())
    )
      return unknown();

    return {
      kind: "complete",
      observed: {
        ready: true,
        active: true,
        selectedVersions: spec.versions.map(({ workerVersion, weight }) => ({
          resourceUid: workerVersion.resourceUid,
          weight,
        })),
      },
      output: {},
    };
  }

  return {
    validateCreate(spec) {
      try {
        parseWorkerDeploymentSpec(spec);
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateWorkerDeploymentUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    references(spec) {
      try {
        return referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec));
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_DEPLOYMENT_BACKEND_ID,
      targetKey: options.targetKey,
      execute: run,
      reconcile: run,
    },
  };
}

function matchesExecution(
  snapshot: V2WorkerPublicationSnapshot,
  execution: V2Execution,
  spec: ReturnType<typeof parseWorkerDeploymentSpec>,
): boolean {
  if (
    snapshot.sourceOperationId !== execution.operationId ||
    snapshot.worker.uid !== spec.worker.resourceUid ||
    snapshot.worker.principal !== execution.principal ||
    snapshot.worker.space !== execution.space
  )
    return false;
  if (execution.action === "delete") return snapshot.deployment === null;
  const deployment = snapshot.deployment;
  return (
    deployment !== null &&
    deployment.uid === execution.resourceUid &&
    deployment.generation === execution.generation &&
    canonicalJson(deployment.spec) === canonicalJson(spec) &&
    canonicalJson(deployment.versions.map(({ uid, weight }) => ({ uid, weight }))) ===
      canonicalJson(
        spec.versions.map(({ workerVersion, weight }) => ({
          uid: workerVersion.resourceUid,
          weight,
        })),
      )
  );
}

async function exactIdentity(
  identity: WorkerdPublicationIdentity,
  snapshot: V2WorkerPublicationSnapshot,
  operationId: string,
): Promise<boolean> {
  if (!snapshot.deployment) return false;
  const versions = [];
  for (const version of snapshot.deployment.versions) {
    const digest = await bytesDigest(
      new TextEncoder().encode(`${version.uid}\u0000${version.generation}`),
    );
    versions.push({
      versionId: `v2-${digest.slice("sha256:".length)}`,
      workerVersionUid: version.uid,
      weight: version.weight,
    });
  }
  const expected: WorkerdPublicationIdentity = {
    generation: `takoserver-v2-operation:${operationId}`,
    workerResourceUid: snapshot.worker.uid,
    hostnames: snapshot.endpoint ? [snapshot.endpoint.output.hostname] : [],
    versions,
  };
  return canonicalJson(identity) === canonicalJson(expected);
}
