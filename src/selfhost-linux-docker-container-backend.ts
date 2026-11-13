import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "./container-contract.ts";
import { isJsonObject } from "./json.ts";
import type { Clock, JsonObject, Sql } from "./ports.ts";
import {
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "./providers/docker-container-configured-inputs.ts";
import type { DockerContainerAcceptedExecution } from "./providers/docker-container-core-owner.ts";
import type { DockerHttpRevision } from "./providers/docker-http-revision.ts";
import {
  createSelfhostLinuxDockerCore,
  type SelfhostLinuxDockerCoreSelection,
} from "./selfhost-linux-docker-core.ts";
import type { V2HostAcceptance } from "./takoform-v2/host-acceptance.ts";
import type { V2BackendResult, V2Execution, V2Form } from "./takoform-v2/types.ts";

export interface SelfhostLinuxDockerContainerBackend {
  readonly formUrl: typeof V2_CONTAINER_F2_FORM;
  /** Internal candidate only; this creator does not register public Form support. */
  readonly retainedForm: V2Form;
  readonly acceptance: V2HostAcceptance;
  close(): Promise<void>;
}

/** Compose the normal V2 execution protocol around the genuine owned runtime.
 * No owner, verification/ready callback, runtime or complete DTO is injectable.
 * Operation completion follows native reconciliation and fresh original same-Sql
 * publication. Raw accounting and public/native qualification are separate work;
 * kernel skb counters are not silently converted into Form billing units.
 */
export function createSelfhostLinuxDockerContainerBackend(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxDockerCoreSelection;
}): SelfhostLinuxDockerContainerBackend {
  const core = createSelfhostLinuxDockerCore(input);
  if (!core) throw new TypeError("selfhost_linux_docker_container_backend_selection_required");
  const { backendId, targetKey } = input.selection;
  const capacity = Object.freeze({
    memoryBytes: input.selection.docker.maxMemoryBytes,
    nanoCpus: input.selection.docker.maxNanoCpus,
  });
  const unknown = (): V2BackendResult => ({ kind: "unknown" });
  function request(accepted: DockerContainerAcceptedExecution): DockerHttpRevision {
    // The original owner has already validated this accepted public spec. These
    // checks project its actual values into the existing native request type.
    const { image, httpPort, healthPath, environment = {} } = accepted.spec;
    if (
      typeof image !== "string" ||
      typeof httpPort !== "number" ||
      typeof healthPath !== "string" ||
      !isJsonObject(environment)
    )
      throw new TypeError("accepted Container request unavailable");
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
      if (typeof value !== "string") throw new TypeError("accepted Container request unavailable");
      values[name] = value;
    }
    return {
      resourceUid: accepted.resourceUid,
      incarnationId: accepted.incarnationId,
      revision: accepted.revision,
      image,
      port: httpPort,
      healthPath,
      environment: values,
      ...capacity,
    };
  }
  const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
    try {
      // Choose the original scope without evaluating a caller accessor. The
      // original owner still validates the full execution and exact live lease.
      const action = Object.getOwnPropertyDescriptor(execution, "action");
      if (!action || !Object.hasOwn(action, "value")) return unknown();
      if (action.value === "delete") {
        await core.retireAccepted(execution);
        return { kind: "complete", observed: {}, output: {} };
      }
      const reconciled = await core.withAcceptedRevision(
        execution,
        async ({ accepted, docker }) => {
          const desired = request(accepted);
          const observed = await docker.reconcile(desired);
          return observed.state === "ready"
            ? { nativeId: observed.nativeId, image: desired.image }
            : null;
        },
      );
      if (!reconciled) return unknown();
      // The pre-effect accepted snapshot and HTTP health alone are insufficient.
      // This is a second, original guarded read AFTER native publishServing.
      return await core.withAcceptedRevision(
        execution,
        async ({ accepted }): Promise<V2BackendResult> => {
          const current = accepted.retained.find(
            ({ record }) => record.intent.policy.generation === accepted.generation,
          );
          if (
            accepted.servingConfirmedAtMs === null ||
            !current ||
            current.record.state !== "bound" ||
            current.record.nativeId !== reconciled.nativeId ||
            current.removedAtMs !== null ||
            current.record.intent.incarnationId !== accepted.incarnationId ||
            current.record.intent.revision !== accepted.revision ||
            accepted.spec.image !== reconciled.image
          )
            return unknown();
          const fields = CONTAINER_CONTRACT.fields;
          return {
            kind: "complete",
            observed: {
              [fields.ready]: true,
              [fields.servingGeneration]: accepted.generation,
              [fields.imageDigest]: reconciled.image.slice(reconciled.image.lastIndexOf("@") + 1),
            },
            output: {},
          };
        },
      );
    } catch {
      // Preserve uncertainty without exposing native diagnostics or secret input.
      return unknown();
    }
  };
  const validate = (spec: JsonObject) => {
    validateDockerContainerSpec(spec);
  };
  const form: V2Form = Object.freeze({
    validateCreate: validate,
    validateUpdate(_previous: JsonObject, spec: JsonObject) {
      validate(spec);
    },
    privateInputs: Object.freeze({
      validateCreate(spec: JsonObject, values: V2Execution["privateInputs"]) {
        validateDockerContainerPrivateInputs(
          validateDockerContainerSpec(spec).requiredSensitiveVars,
          values,
        );
      },
      validateUpdate(
        _previous: JsonObject,
        spec: JsonObject,
        values: V2Execution["privateInputs"],
      ) {
        const names = validateDockerContainerSpec(spec).requiredSensitiveVars;
        if (values !== undefined) validateDockerContainerPrivateInputs(names, values);
      },
      prepareCreate: core.configuredInputs.prepareCreate,
      prepareUpdate: core.configuredInputs.prepareUpdate,
    }),
    rejectDeleteWhileReferenced: true,
    backend: Object.freeze({ id: backendId, targetKey, execute: dispatch, reconcile: dispatch }),
  });
  return Object.freeze({
    formUrl: V2_CONTAINER_F2_FORM,
    retainedForm: form,
    acceptance: core.acceptance,
    close: core.close,
  });
}
