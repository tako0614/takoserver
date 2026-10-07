import { canonicalJson } from "../json.ts";
import type { WorkerdWorkerRuntimeOwner } from "../workerd-worker-runtime-owner.ts";
import { referencesForWorkerEndpoint } from "./forms/worker-references.ts";
import {
  parseWorkerEndpointSpec,
  validateWorkerEndpointUpdate,
  WORKER_ENDPOINT_FORM_URL,
  WorkerFormValidationError,
} from "./forms/worker-specs.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";
import { exactV2WorkerPublicationIdentity } from "./worker-deployment-backend.ts";
import type {
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
} from "./worker-publication-state.ts";

/** Internal only: route publication and frontend TLS are not yet composed. */
export const WORKER_ENDPOINT_BACKEND_ID = "selfhost-v2-worker-endpoint-owner-v1";

type PublicationState = {
  resolve(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<V2WorkerPublicationResolution>;
};
type RuntimeOwner = Pick<WorkerdWorkerRuntimeOwner, "workerResourceUid" | "execute">;
type AssignedAddress = { readonly hostname: string; readonly url: string };

/** A trusted HTTPS frontend check, not an application health request. */
export interface V2EndpointTlsObservation {
  readonly endpointUid: string;
  readonly workerUid: string;
  readonly hostname: string;
  readonly url: string;
  readonly ready: boolean;
}

const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

const unknown = (): V2BackendResult => ({
  kind: "unknown",
  code: "worker_endpoint_unconfirmed",
  message: "The assigned HTTPS endpoint or route is not yet confirmed",
});

function assignedAddress(hostname: unknown): AssignedAddress | null {
  if (typeof hostname !== "string" || !hostnamePattern.test(hostname)) return null;
  const url = `https://${hostname}/`;
  return url.length <= 262 ? { hostname, url } : null;
}

function acceptedAddress(snapshot: V2WorkerPublicationSnapshot): AssignedAddress | null {
  const address = snapshot.acceptedEndpointOutput;
  const parsed = assignedAddress(address?.hostname);
  return parsed && address?.url === parsed.url ? parsed : null;
}

function matchesExecution(snapshot: V2WorkerPublicationSnapshot, execution: V2Execution): boolean {
  if (
    snapshot.sourceOperationId !== execution.operationId ||
    snapshot.worker.principal !== execution.principal ||
    snapshot.worker.space !== execution.space ||
    !snapshot.deployment ||
    !acceptedAddress(snapshot)
  )
    return false;
  let spec: ReturnType<typeof parseWorkerEndpointSpec>;
  try {
    spec = parseWorkerEndpointSpec(execution.spec);
  } catch {
    return false;
  }
  if (snapshot.worker.uid !== spec.worker.resourceUid) return false;
  if (execution.action === "delete") return snapshot.endpoint === null;
  return (
    snapshot.endpoint !== null &&
    snapshot.endpoint.uid === execution.resourceUid &&
    snapshot.endpoint.generation === execution.generation &&
    canonicalJson(snapshot.endpoint.spec) === canonicalJson(spec) &&
    canonicalJson(snapshot.endpoint.output) === canonicalJson(snapshot.acceptedEndpointOutput)
  );
}

/**
 * An internal v2 Endpoint lifecycle adapter. `assignHostname` is pure Host
 * authority called only inside the Resource/Operation acceptance batch;
 * neither caller spec nor runtime discovery can rename this Resource.
 */
export function createWorkerEndpointForm(options: {
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  readonly ownerForWorker: (workerUid: string) => RuntimeOwner | Promise<RuntimeOwner>;
  readonly assignHostname: (input: {
    readonly resourceUid: string;
    readonly space: string;
    readonly name: string;
  }) => string;
  readonly observeTls: (input: {
    readonly endpointUid: string;
    readonly workerUid: string;
    readonly hostname: string;
    readonly url: string;
  }) => Promise<V2EndpointTlsObservation>;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");

  async function run(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_ENDPOINT_FORM_URL ||
      execution.backendId !== WORKER_ENDPOINT_BACKEND_ID ||
      execution.targetKey !== options.targetKey ||
      (execution.action !== "create" &&
        execution.action !== "update" &&
        execution.action !== "delete")
    )
      return unknown();
    let spec: ReturnType<typeof parseWorkerEndpointSpec>;
    try {
      spec = parseWorkerEndpointSpec(execution.spec);
    } catch {
      return unknown();
    }
    // The SQL reader owns the exact Operation/lease/backendKey, immutable UID,
    // sealed reference, accepted output, and complete active Worker graph.
    const before = await options.publicationState.resolve({ execution });
    if (before.kind !== "ready" || !matchesExecution(before.snapshot, execution)) return unknown();
    if (!(await before.stillCurrent())) return unknown();
    const address = acceptedAddress(before.snapshot);
    if (!address) return unknown();

    let owner: RuntimeOwner;
    try {
      owner = await options.ownerForWorker(spec.worker.resourceUid);
    } catch {
      return unknown();
    }
    if (owner.workerResourceUid !== spec.worker.resourceUid || !(await before.stillCurrent()))
      return unknown();
    let result: Awaited<ReturnType<RuntimeOwner["execute"]>>;
    try {
      result = await owner.execute(execution);
    } catch {
      return unknown();
    }
    // `not_dispatched` only describes this invocation, never earlier effects.
    if (result.kind !== "confirmed" || result.identity === null) return unknown();

    // Endpoint DELETE still has an active Deployment: a null Worker identity
    // would be a Deployment teardown, not proof that one hostname was detached.
    const after = await options.publicationState.resolve({
      execution,
      incumbentSourceOperationId: execution.operationId,
    });
    if (
      after.kind !== "ready" ||
      !matchesExecution(after.snapshot, execution) ||
      canonicalJson(acceptedAddress(after.snapshot)) !== canonicalJson(address) ||
      !(await before.stillCurrent()) ||
      !(await after.stillCurrent()) ||
      !(await exactV2WorkerPublicationIdentity(
        result.identity,
        after.snapshot,
        execution.operationId,
      )) ||
      !(await after.stillCurrent())
    )
      return unknown();

    if (execution.action === "delete") {
      // The native identity has no hostname but retains the exact weighted
      // Deployment. A shared wildcard certificate may remain; do not infer
      // TLS absence from route detachment.
      return { kind: "complete", observed: { activeDeploymentRouteReady: false }, output: address };
    }

    let tls: V2EndpointTlsObservation;
    try {
      tls = await options.observeTls({
        endpointUid: execution.resourceUid,
        workerUid: spec.worker.resourceUid,
        ...address,
      });
    } catch {
      return unknown();
    }
    if (
      tls.ready !== true ||
      tls.endpointUid !== execution.resourceUid ||
      tls.workerUid !== spec.worker.resourceUid ||
      tls.hostname !== address.hostname ||
      tls.url !== address.url ||
      !(await after.stillCurrent())
    )
      return unknown();
    return {
      kind: "complete",
      observed: { tlsReady: true, activeDeploymentRouteReady: true },
      output: address,
    };
  }

  return {
    validateCreate(spec) {
      try {
        parseWorkerEndpointSpec(spec);
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateWorkerEndpointUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    initialOutput(input) {
      const address = assignedAddress(options.assignHostname(input));
      if (!address) throw new TypeError("Host-assigned Endpoint hostname is invalid");
      return address;
    },
    references(spec) {
      try {
        return referencesForWorkerEndpoint(parseWorkerEndpointSpec(spec));
      } catch (error) {
        if (error instanceof WorkerFormValidationError) throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_ENDPOINT_BACKEND_ID,
      targetKey: options.targetKey,
      execute: run,
      reconcile: run,
    },
  };
}
