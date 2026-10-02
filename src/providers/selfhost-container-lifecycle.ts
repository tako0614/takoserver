import { isJsonObject, type JsonObject } from "../json.ts";
import {
  type ApplyInput,
  failed,
  failedWithoutProviderMutation,
  type ProviderMutationExecutionContext,
  type ProviderTicket,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import { DockerHttpRevisionError } from "./docker-http-revision.ts";
import {
  type createSelfhostContainerRuntime,
  SelfhostContainerError,
  type SelfhostContainerIdentity,
  type SelfhostContainerObservation,
  type SelfhostContainerRevision,
} from "./selfhost-container-runtime.ts";

export type SelfhostContainerRuntimeHandle = Awaited<
  ReturnType<typeof createSelfhostContainerRuntime>
>;

export interface SelfhostContainerCapacityProfile {
  readonly id: "selfhost.container.http.standard";
  /** Per-revision memory ceiling shared by the Host Offering and Docker. */
  readonly memoryBytes: number;
  /** Per-revision CPU ceiling shared by the Host Offering and Docker. */
  readonly nanoCpus: number;
  /** Per-container process ceiling. */
  readonly pidsLimit: number;
}

export interface SelfhostContainerCapability {
  readonly runtime: SelfhostContainerRuntimeHandle;
  readonly capacityProfile: SelfhostContainerCapacityProfile;
}

const nativePrefix = "selfhost-container:";

function incarnation(
  identity: ResourceIdentity,
  context?: ProviderMutationExecutionContext,
): SelfhostContainerIdentity | null {
  const resourceUid = identity.uid;
  const incarnationId = identity.incarnationId ?? context?.prospectiveDeploymentId;
  if (!resourceUid || !incarnationId || resourceUid.length > 256 || incarnationId.length > 256)
    return null;
  return { resourceUid, incarnationId };
}

function nativeId(identity: SelfhostContainerIdentity): string {
  return `${nativePrefix}${Buffer.from(JSON.stringify([identity.resourceUid, identity.incarnationId])).toString("base64url")}`;
}

function parseNativeId(value: string): SelfhostContainerIdentity | null {
  if (
    !value.startsWith(nativePrefix) ||
    value.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/u.test(value.slice(nativePrefix.length))
  )
    return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(nativePrefix.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded.some((item) => typeof item !== "string" || item.length < 1 || item.length > 256)
    )
      return null;
    const [resourceUid, incarnationId] = decoded as [string, string];
    const identity = { resourceUid, incarnationId };
    return nativeId(identity) === value ? identity : null;
  } catch {
    return null;
  }
}

export function selfhostContainerNativeIdentity(value: string): SelfhostContainerIdentity | null {
  return parseNativeId(value);
}

function sameIdentity(left: SelfhostContainerIdentity, right: SelfhostContainerIdentity): boolean {
  return left.resourceUid === right.resourceUid && left.incarnationId === right.incarnationId;
}

function generation(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function revisionFor(
  identity: SelfhostContainerIdentity,
  desiredGeneration: string | undefined,
  spec: JsonObject,
  profile: SelfhostContainerCapacityProfile,
): SelfhostContainerRevision | null {
  const desired = generation(desiredGeneration);
  if (
    desired === null ||
    typeof spec.image !== "string" ||
    typeof spec.httpPort !== "number" ||
    typeof spec.healthPath !== "string" ||
    typeof spec.workloadRevision !== "string" ||
    (spec.environment !== undefined && !isJsonObject(spec.environment)) ||
    (spec.outboundInternet !== undefined && spec.outboundInternet !== false) ||
    (spec.requiredSensitiveVars !== undefined &&
      (!Array.isArray(spec.requiredSensitiveVars) || spec.requiredSensitiveVars.length !== 0))
  )
    return null;
  const environment: Record<string, string> = {};
  const declaredEnvironment = (spec.environment ?? {}) as JsonObject;
  if (Object.entries(declaredEnvironment).length > 64) return null;
  for (const [key, value] of Object.entries(declaredEnvironment)) {
    if (
      !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key) ||
      typeof value !== "string" ||
      value.length > 4096
    )
      return null;
    environment[key] = value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(spec.workloadRevision)) return null;
  return {
    ...identity,
    generation: desired,
    revision: spec.workloadRevision,
    image: spec.image,
    port: spec.httpPort,
    healthPath: spec.healthPath,
    memoryBytes: profile.memoryBytes,
    nanoCpus: profile.nanoCpus,
    environment,
  };
}

function ticket(
  identity: SelfhostContainerIdentity,
  observation: SelfhostContainerObservation,
  desiredGeneration: number,
): ProviderTicket {
  if (observation.state !== "ready" || observation.servingGeneration !== desiredGeneration)
    return failed(
      "unavailable",
      "the Container service is not healthy at the desired generation",
      true,
    );
  return succeeded({
    nativeId: nativeId(identity),
    observed: { ready: true, servingGeneration: String(desiredGeneration) },
    outputs: {},
  });
}

function failure(error: unknown): ProviderTicket {
  if (error instanceof SelfhostContainerError || error instanceof DockerHttpRevisionError) {
    if (error.code === "invalid_request")
      return failed("invalid_spec", "the Container service declaration is invalid");
    if (error.code === "conflict" || error.code === "corrupt")
      return failed(
        "conflict",
        "the Container service native identity conflicts with recorded state",
      );
    return failed("unavailable", "the local Container runtime is unavailable", true);
  }
  return failed("unavailable", "the local Container runtime is unavailable", true);
}

/** Host-to-local-runtime translation; the Host remains the sole Resource/Deployment ledger. */
export function createSelfhostContainerLifecycle(capability: SelfhostContainerCapability) {
  const { runtime, capacityProfile } = capability;
  return {
    async apply(
      input: ApplyInput,
      context?: ProviderMutationExecutionContext,
    ): Promise<ProviderTicket> {
      const identity = incarnation(input.identity, context);
      if (!identity || !input.desiredGeneration)
        return failedWithoutProviderMutation(
          input.operationId,
          "invalid_spec",
          "the Container service requires exact Host identity and generation",
        );
      if (input.previous && input.previous.nativeId !== nativeId(identity))
        return failedWithoutProviderMutation(
          input.operationId,
          "conflict",
          "the Container service Deployment incarnation changed",
        );
      const revision = revisionFor(identity, input.desiredGeneration, input.spec, capacityProfile);
      if (!revision)
        return failedWithoutProviderMutation(
          input.operationId,
          "invalid_spec",
          "the Container service declaration is unsupported",
        );
      try {
        return ticket(identity, await runtime.reconcile(revision), revision.generation);
      } catch (error) {
        return failure(error);
      }
    },
    async observe(input: {
      readonly nativeId: string;
      readonly identity: ResourceIdentity;
      readonly spec: JsonObject;
    }): Promise<ProviderTicket> {
      const expected = parseNativeId(input.nativeId);
      const identity = incarnation(input.identity);
      if (!expected || !identity || !sameIdentity(expected, identity))
        return failed("conflict", "the Container service Deployment incarnation changed");
      const desired = generation(input.identity.generation);
      if (desired === null)
        return failed("invalid_spec", "the Container service requires an exact generation");
      try {
        const observation = await runtime.observe(identity);
        // An uncommitted successor can be unhealthy while the incumbent
        // generation remains healthy and serving. Host read/observe of the
        // incumbent must reflect that surviving service, not the pending one.
        if (observation.state === "updating" && observation.servingGeneration === desired)
          return succeeded({
            nativeId: input.nativeId,
            observed: { ready: true, servingGeneration: String(desired) },
            outputs: {},
          });
        return ticket(identity, observation, desired);
      } catch (error) {
        return failure(error);
      }
    },
    async delete(input: {
      readonly nativeId: string;
      readonly identity: ResourceIdentity;
    }): Promise<ProviderTicket> {
      const expected = parseNativeId(input.nativeId);
      const identity = incarnation(input.identity);
      if (!expected || !identity || !sameIdentity(expected, identity))
        return failed("conflict", "the Container service Deployment incarnation changed");
      try {
        const observation = await runtime.remove(identity);
        // A missing provider journal is not evidence that Docker has no
        // object: the journal may have been lost after the Host committed its
        // Deployment. Only a retained deletion tombstone whose backend
        // readback proved every exact revision absent may complete deletion.
        if (observation.state !== "deleted")
          return failed("unavailable", "the Container service has not proved native absence", true);
        return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      } catch (error) {
        return failure(error);
      }
    },
    async recoverDelete(input: {
      readonly nativeId: string;
      readonly identity: ResourceIdentity;
    }): Promise<ProviderTicket> {
      const expected = parseNativeId(input.nativeId);
      const identity = incarnation(input.identity);
      if (!expected || !identity || !sameIdentity(expected, identity))
        return failed("conflict", "the Container service Deployment incarnation changed");
      try {
        const observation = await runtime.observe(identity);
        return observation.state === "deleted"
          ? succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} })
          : failed("unavailable", "the Container service delete outcome is not yet proven", true);
      } catch (error) {
        return failure(error);
      }
    },
    async absence(identity: SelfhostContainerIdentity): Promise<"absent" | "present" | "unknown"> {
      try {
        const observation = await runtime.observe(identity);
        if (observation.state === "deleted") return "absent";
        if (observation.state === "absent") return "unknown";
        return "present";
      } catch {
        return "unknown";
      }
    },
  };
}
