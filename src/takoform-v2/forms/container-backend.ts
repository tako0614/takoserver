import { CONTAINER_CONTRACT as C } from "../../container-contract.ts";
import type { JsonObject } from "../../ports.ts";
import type { V2BackendResult, V2Execution, V2Form } from "../types.ts";
import { parseContainerSpec } from "./container.ts";

const F = C.fields;
export const CONTAINER_DOCKER_BACKEND_ID = "selfhost-v2-container-docker-candidate-1";

/** Neutral execution port; the Form never imports or owns a native adapter. */
export interface ContainerExecutionPort {
  reconcile(input: {
    resourceUid: string;
    incarnationId: string;
    generation: number;
    revision: string;
    image: string;
    port: number;
    healthPath: string;
    environment: Readonly<Record<string, string>>;
    memoryBytes: number;
    nanoCpus: number;
  }): Promise<{ state: string; servingGeneration?: number }>;
  remove(identity: { resourceUid: string; incarnationId: string }): Promise<{ state: string }>;
}

/** Candidate adapter, deliberately absent from the public application Form map. */
export function createContainerDockerForm(options: {
  readonly runtime: ContainerExecutionPort;
  readonly capacityProfile: {
    readonly id: string;
    readonly memoryBytes: number;
    readonly nanoCpus: number;
    readonly pidsLimit: number;
  };
  readonly targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey required");
  const validate = (spec: JsonObject, inputs?: unknown) => {
    parseContainerSpec(spec, inputs);
  };
  const dispatch = async (request: V2Execution): Promise<V2BackendResult> => {
    const input = structuredClone(request);
    if (
      input.form !== C.formUrl ||
      input.backendId !== CONTAINER_DOCKER_BACKEND_ID ||
      input.targetKey !== options.targetKey ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    )
      return { kind: "unknown" };
    const spec = parseContainerSpec(input.spec, input.privateInputs);
    const identity = { resourceUid: input.resourceUid, incarnationId: options.targetKey };
    try {
      if (input.action === "delete") {
        const observation = await options.runtime.remove(identity);
        return observation.state === "deleted"
          ? { kind: "complete", observed: {}, output: {} }
          : { kind: "unknown" };
      }
      const observation = await options.runtime.reconcile({
        ...identity,
        generation: input.generation,
        revision: `${input.generation}-${spec[F.workloadRevision]}`,
        image: spec[F.image],
        port: spec[F.httpPort],
        healthPath: spec[F.healthPath],
        memoryBytes: options.capacityProfile.memoryBytes,
        nanoCpus: options.capacityProfile.nanoCpus,
        environment: spec[F.environment],
      });
      if (observation.state !== "ready" || observation.servingGeneration !== input.generation)
        return { kind: "unknown" };
      return {
        kind: "complete",
        observed: {
          [F.ready]: true,
          [F.servingGeneration]: input.generation,
          [F.imageDigest]: spec[F.image].split("@")[1]!,
        },
        output: {},
      };
    } catch {
      return { kind: "unknown" };
    }
  };
  return {
    validateCreate: validate,
    validateUpdate(_previous, spec) {
      validate(spec);
    },
    privateInputs: {
      validateCreate: validate,
      validateUpdate(_previous, spec, inputs) {
        validate(spec, inputs);
      },
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: CONTAINER_DOCKER_BACKEND_ID,
      targetKey: options.targetKey,
      execute: dispatch,
      reconcile: dispatch,
    },
  };
}
