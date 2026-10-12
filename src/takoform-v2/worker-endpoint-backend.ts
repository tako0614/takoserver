import { canonicalJson } from "../json.ts";
import type { WorkerdWorkerRuntimeOwner } from "../workerd-worker-runtime-owner.ts";
import { referencesForWorkerEndpoint } from "./forms/worker-references.ts";
import {
  parseWorkerEndpointSpec,
  validateWorkerEndpointUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WorkerFormValidationError,
} from "./forms/worker-specs.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2BackendResult,
  type V2Execution,
  type V2Form,
} from "./types.ts";
import { exactV2WorkerPublicationIdentity } from "./worker-deployment-backend.ts";
import type {
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
} from "./worker-publication-state.ts";
import { MAX_FAILED_TAIL } from "./worker-publication-state.ts";

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

/**
 * Trusted frontend readback: `absent` means this Endpoint's route and assigned
 * Attachment are released. A shared TLS certificate may remain installed.
 */
export interface V2EndpointRouteAbsenceObservation {
  readonly endpointUid: string;
  readonly workerUid: string;
  readonly hostname: string;
  readonly url: string;
  readonly absent: boolean;
}

const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

const unknown = (): V2BackendResult => ({
  kind: "unknown",
  code: "worker_endpoint_unconfirmed",
  message: "The assigned HTTPS endpoint or route is not yet confirmed",
});

/**
 * Form-defined refusals, settled `failed` with effect `none`. The SQL reader
 * returns them only before any native send could be made for this Operation
 * (see V2WorkerPublicationResolution), so nothing it published can arrive.
 */
const refusals = {
  deployment_missing: {
    kind: "no_effect",
    code: "worker_deployment_missing",
    message:
      "The Worker has no active WorkerDeployment, so nothing was published. Create the WorkerDeployment, then re-apply or re-create this WorkerEndpoint.",
  },
  fetch_unavailable: {
    kind: "no_effect",
    code: "worker_fetch_handler_missing",
    message:
      "Every weighted Worker Version of the active WorkerDeployment must declare fetch or serve assets; nothing was published.",
  },
} as const satisfies Record<string, V2BackendResult>;

const admissionDetail =
  "A WorkerEndpoint needs its Worker's active WorkerDeployment, not being deleted, whose every weighted WorkerVersion declares fetch or serves assets, and no other WorkerEndpoint on that Worker. Create the WorkerDeployment first, then send this request again.";

/**
 * WorkerEndpoint 0.3.0 verifies before any effect that the Worker's active
 * Deployment answers HTTP and that the Worker has no other Endpoint. The
 * serving spec comes from the successful observed-generation Operation, not
 * from a newer desired spec left by a failed update. This predicate runs
 * inside the Resource/Operation acceptance statement, so a
 * refused request stores nothing and an Endpoint is never queued ahead of its
 * Worker's Deployment. Execution re-checks the exact graph under its claim.
 */
function endpointAdmission(input: {
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
  readonly spec: unknown;
}): V2AdmissionPredicate {
  const workerUid = parseWorkerEndpointSpec(input.spec).worker.resourceUid;
  return {
    sql: `EXISTS (SELECT 1 FROM tf_v2_resources deployment
        JOIN tf_v2_operations serving
          ON serving.resource_uid = deployment.uid
          AND serving.generation = deployment.observed_generation
        WHERE deployment.form_url = ? AND deployment.principal = ? AND deployment.space = ?
          AND deployment.deleted_at IS NULL AND deployment.phase <> 'deleting'
          AND deployment.busy_operation IS NULL
          AND deployment.observed_generation >= 1
          AND serving.principal = deployment.principal
          AND serving.backend_id = deployment.backend_id
          AND serving.target_key = deployment.target_key
          AND serving.status = 'succeeded' AND serving.effect = 'complete'
          AND serving.action IN ('create', 'update')
          AND serving.result_observed_json = deployment.observed_json
          AND ((deployment.generation = deployment.observed_generation
                AND deployment.phase = 'idle' AND deployment.last_operation = serving.id
                AND deployment.spec_json = serving.accepted_spec_json)
            OR (deployment.generation > deployment.observed_generation
                AND deployment.phase = 'error'
                AND EXISTS (SELECT 1 FROM tf_v2_operations last
                  WHERE last.id = deployment.last_operation
                    AND last.resource_uid = deployment.uid
                    AND last.generation = deployment.generation
                    AND last.status = 'failed' AND last.effect = 'none')
                AND (SELECT COUNT(*) FROM tf_v2_operations tail
                  WHERE tail.resource_uid = deployment.uid
                    AND tail.generation > deployment.observed_generation
                    AND tail.generation <= deployment.generation) =
                  deployment.generation - deployment.observed_generation
                AND deployment.generation - deployment.observed_generation <= ${MAX_FAILED_TAIL}
                AND NOT EXISTS (SELECT 1 FROM tf_v2_operations tail
                  WHERE tail.resource_uid = deployment.uid
                    AND tail.generation > deployment.observed_generation
                    AND tail.generation <= deployment.generation
                    AND (tail.status <> 'failed' OR tail.effect <> 'none'
                      OR tail.principal <> deployment.principal
                      OR tail.backend_id <> deployment.backend_id
                      OR tail.target_key <> deployment.target_key))))
          AND json_extract(serving.accepted_spec_json, '$.worker.resourceUid') = ?
          AND json_extract(deployment.observed_json, '$.active') = 1
          AND json_extract(deployment.observed_json, '$.ready') = 1
          AND NOT EXISTS (SELECT 1 FROM json_each(serving.accepted_spec_json, '$.versions') selected
            WHERE NOT EXISTS (SELECT 1 FROM tf_v2_resources version
              WHERE version.uid = json_extract(selected.value, '$.workerVersion.resourceUid')
                AND version.form_url = ? AND version.principal = deployment.principal
                AND version.space = deployment.space AND version.deleted_at IS NULL
                AND (EXISTS (SELECT 1 FROM json_each(version.spec_json, '$.handlers') handler
                      WHERE handler.value = 'fetch')
                  OR json_type(version.spec_json, '$.assets') = 'object'))))
      AND NOT EXISTS (SELECT 1 FROM tf_v2_resources other
        WHERE other.form_url = ? AND other.principal = ? AND other.space = ?
          AND other.deleted_at IS NULL AND other.uid <> ?
          AND json_extract(other.spec_json, '$.worker.resourceUid') = ?)`,
    params: [
      WORKER_DEPLOYMENT_FORM_URL,
      input.principal,
      input.space,
      workerUid,
      WORKER_VERSION_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      input.principal,
      input.space,
      input.resourceUid,
      workerUid,
    ],
    detail: admissionDetail,
  };
}

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
    (execution.action !== "delete" && !snapshot.deployment) ||
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
  /** Private Host observer receives the accepted current lease, never Form output. */
  readonly observeTls: (
    input: {
      readonly endpointUid: string;
      readonly workerUid: string;
      readonly hostname: string;
      readonly url: string;
    },
    execution: V2Execution,
  ) => Promise<V2EndpointTlsObservation>;
  readonly observeRouteAbsent?: (
    input: {
      readonly endpointUid: string;
      readonly workerUid: string;
      readonly hostname: string;
      readonly url: string;
    },
    execution: V2Execution,
  ) => Promise<V2EndpointRouteAbsenceObservation>;
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
    if (before.kind !== "ready") {
      // An Endpoint accepted without an HTTP-serving Deployment (before this
      // was refused at acceptance, or across a race) settles without effect,
      // so it no longer holds the Worker's publication queue. DELETE has no
      // such precondition: it removes the route with or without a Deployment.
      if (
        execution.action !== "delete" &&
        (before.code === "deployment_missing" || before.code === "fetch_unavailable")
      )
        return refusals[before.code];
      return unknown();
    }
    if (!matchesExecution(before.snapshot, execution)) return unknown();
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
    if (result.kind === "abandoned_before_activation") {
      // The owner proved this Operation's only incarnation never served and
      // retired it; nothing it published can still arrive. Settle with no
      // effect: the Endpoint stays as of its last committed generation and a
      // re-apply (or a re-issued DELETE) can retry. An Endpoint DELETE that
      // still has a Deployment publishes its hostname-less graph through a
      // candidate exactly like an update, so it settles the same way; the
      // committed incarnation keeps its hostname.
      if (result.operationId !== execution.operationId || !(await before.stillCurrent()))
        return unknown();
      return {
        kind: "no_effect",
        code: "worker_incarnation_retired_before_activation",
        message:
          "This publication's Worker incarnation was retired before it was activated; nothing it published served. Re-apply to retry.",
      };
    }
    // `not_dispatched` describes this invocation only, never earlier effects.
    // `confirmed` identity:null is Deployment teardown, not Endpoint proof.
    const after = await options.publicationState.resolve({
      execution,
      incumbentSourceOperationId: execution.operationId,
    });
    if (
      after.kind !== "ready" ||
      !matchesExecution(after.snapshot, execution) ||
      canonicalJson(acceptedAddress(after.snapshot)) !== canonicalJson(address) ||
      !(await before.stillCurrent()) ||
      !(await after.stillCurrent())
    )
      return unknown();

    if (result.kind === "confirmed_route_absent") {
      if (
        execution.action !== "delete" ||
        before.snapshot.deployment !== null ||
        after.snapshot.deployment !== null ||
        result.sourceOperationId !== execution.operationId ||
        result.endpointResourceUid !== execution.resourceUid ||
        result.workerResourceUid !== spec.worker.resourceUid ||
        result.targetKey !== execution.targetKey ||
        result.assignedHostname !== address.hostname
      )
        return unknown();
    } else if (
      result.kind !== "confirmed" ||
      result.identity === null ||
      !(await exactV2WorkerPublicationIdentity(
        result.identity,
        after.snapshot,
        execution.operationId,
      ))
    )
      return unknown();
    if (!(await after.stillCurrent())) return unknown();

    if (execution.action === "delete") {
      // A caller without exact frontend readback can create/update internally,
      // but cannot truthfully settle DELETE from native evidence alone.
      if (!options.observeRouteAbsent) return unknown();
      let route: V2EndpointRouteAbsenceObservation;
      try {
        route = await options.observeRouteAbsent(
          {
            endpointUid: execution.resourceUid,
            workerUid: spec.worker.resourceUid,
            ...address,
          },
          execution,
        );
      } catch {
        return unknown();
      }
      if (
        route.absent !== true ||
        route.endpointUid !== execution.resourceUid ||
        route.workerUid !== spec.worker.resourceUid ||
        route.hostname !== address.hostname ||
        route.url !== address.url ||
        !(await after.stillCurrent())
      )
        return unknown();
      // Attachment and route are absent. Shared TLS infrastructure may remain;
      // do not infer tlsReady:false or certificate deletion.
      return { kind: "complete", observed: { activeDeploymentRouteReady: false }, output: address };
    }

    let tls: V2EndpointTlsObservation;
    try {
      tls = await options.observeTls(
        {
          endpointUid: execution.resourceUid,
          workerUid: spec.worker.resourceUid,
          ...address,
        },
        execution,
      );
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
    async prepareAdmission(input) {
      try {
        return endpointAdmission(input);
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
