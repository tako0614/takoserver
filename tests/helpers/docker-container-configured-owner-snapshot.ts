import { isJsonObject } from "../../src/json.ts";
import type { JsonObject } from "../../src/ports.ts";
import {
  createDockerContainerRuntimePreparation,
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimeLease,
  type DockerContainerRuntimePolicy,
} from "../../src/providers/docker-container-runtime-preparation.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevisionOptions,
} from "../../src/providers/docker-http-revision.ts";
import { V2_CONTAINER_F2_FORM } from "../../src/takoform-v2/container-owner-schema.ts";
import type { V2BackendResult, V2Execution } from "../../src/takoform-v2/types.ts";
import {
  dockerSourceFixture,
  SOURCE_SELECTION,
} from "./docker-container-configured-source-selection.ts";

/**
 * Substrate of these tests, stated once:
 * - in-memory bun:sqlite with the current audited Core migrations, the
 *   UNREGISTERED additive UPDATE-custody DDL (additiveV2ConfiguredUpdateInputsDDL)
 *   and the owner migration candidate (v2ContainerOwnerMigrationCandidate), applied
 *   by dockerSourceFixture; no schema, migration or source is changed here;
 * - the real Core engine, the real Docker Core owner (acceptance hooks, claim,
 *   bind, start claim) and the real configured-input codec, all on one Sql (the
 *   source-selection helper's Sql proxy, a pass-through unless a row is hidden);
 * - the real production create-custody, runtime preparation and DockerHTTP
 *   revision runtime.
 * Test-side stand-ins, none of which grants Core owner authority or currentness:
 * - the Docker Engine HTTP API, the health fetch and the runtime preparation's
 *   physical enforcement readback (firewall/meter lease, whose claimStart passes
 *   straight to the real owner, which does the identity and policy checks);
 * - Core request authorization (`authorize: async () => true`), the synthetic
 *   keyring and policy digest, and the F2 Form registration (src has no production
 *   registration of the Docker F2 consumer yet);
 * - serving: the plain runtime preparation has no production caller of the owner's
 *   publishServing, so the backend calls the owner's method itself.
 */

const NETWORK = "synthetic-docker-network";
const NETWORK_ID = "b".repeat(64);

/** A Docker Engine API double with the same shape as tests/docker-http-revision.test.ts. */
export function engineDouble() {
  const containers = new Map<string, JsonObject>();
  const calls: { method: string; path: string; body?: JsonObject }[] = [];
  let sequence = 0;
  const engine: NonNullable<DockerHttpRevisionOptions["engine"]> = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const url = new URL(path, "http://docker.invalid");
    if (method === "GET" && url.pathname === `/networks/${NETWORK}`) {
      return {
        status: 200,
        body: JSON.stringify({
          Id: NETWORK_ID,
          Name: NETWORK,
          Driver: "bridge",
          Scope: "local",
          Internal: true,
          Ingress: false,
          Attachable: false,
          Labels: { "takoserver.installation": SOURCE_SELECTION.providerInstallationId },
        }),
      };
    }
    if (method === "GET" && url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) {
      const image = decodeURIComponent(url.pathname.slice(8, -5));
      const digest = image.slice(image.lastIndexOf("@") + 1);
      return {
        status: 200,
        body: JSON.stringify({
          Id: digest,
          Os: "linux",
          Architecture: "amd64",
          Descriptor: { digest, mediaType: "application/vnd.oci.image.manifest.v1+json" },
        }),
      };
    }
    if (url.pathname === "/images/create") return { status: 200, body: '{"status":"done"}\n' };
    if (url.pathname === "/containers/create" && body) {
      const name = url.searchParams.get("name");
      if (!name || body.Image === undefined || body.Labels === undefined)
        throw new Error("Invalid Docker create request");
      if (containers.has(name)) return { status: 409, body: "" };
      const Id = (++sequence).toString(16).padStart(64, "0");
      const endpoints = isJsonObject(body.NetworkingConfig)
        ? body.NetworkingConfig.EndpointsConfig
        : null;
      const configured = isJsonObject(endpoints) ? endpoints[NETWORK] : null;
      containers.set(name, {
        Id,
        Image: String(body.Image).split("@")[1] ?? "",
        Config: {
          Image: body.Image,
          Labels: body.Labels,
          Env: body.Env ?? [],
          ExposedPorts: body.ExposedPorts ?? {},
        },
        HostConfig: body.HostConfig ?? {},
        Mounts: [],
        State: { Running: false },
        NetworkSettings: {
          Networks: {
            [NETWORK]: {
              IPAddress: "",
              ...(isJsonObject(configured) && typeof configured.NetworkID === "string"
                ? { NetworkID: configured.NetworkID }
                : {}),
            },
          },
        },
      });
      return { status: 201, body: JSON.stringify({ Id }) };
    }
    const [nameOrId, operation] = url.pathname.slice("/containers/".length).split("/");
    const match = [...containers.entries()].find(
      ([name, value]) => name === nameOrId || value.Id === nameOrId,
    );
    if (!match) return { status: 404, body: "" };
    const [name, current] = match;
    if (operation === "json") return { status: 200, body: JSON.stringify(current) };
    if (operation === "start") {
      const settings = current.NetworkSettings;
      const networks = isJsonObject(settings) ? settings.Networks : null;
      const configured = isJsonObject(networks) ? networks[NETWORK] : null;
      containers.set(name, {
        ...current,
        State: { Running: true },
        NetworkSettings: {
          Networks: {
            [NETWORK]: {
              ...(isJsonObject(configured) ? configured : {}),
              IPAddress: "172.22.0.2",
            },
          },
        },
      });
      return { status: 204, body: "" };
    }
    if (operation === "stop") {
      containers.set(name, { ...current, State: { Running: false } });
      return { status: 204, body: "" };
    }
    if (method === "DELETE") {
      containers.delete(name);
      return { status: 204, body: "" };
    }
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
  };
  return {
    engine,
    containers,
    calls,
    /** Container create requests, with the Env entries that carry loaned values. */
    creates: () => calls.filter((call) => call.path.startsWith("/containers/create")),
    starts: () => calls.filter((call) => call.path.endsWith("/start")),
  };
}

export interface Failure {
  readonly at: "readAcceptedExecution" | "runtime";
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  /** Function names of the first frames, diagnostic only (never asserted on). */
  readonly frames: readonly string[];
}

function describe(error: unknown, at: Failure["at"]): Failure {
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return {
    at,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "code" in error
      ? { code: String((error as { code: unknown }).code) }
      : {}),
    frames: [...stack.matchAll(/^\s+at (?:async )?([\w$.]+) \(/gmu)]
      .slice(0, 4)
      .map((m) => m[1] ?? ""),
  };
}

/**
 * Wires Core -> Docker Core owner -> production create-custody -> DockerHTTP
 * revision runtime for each execution the Core engine hands to the Form backend.
 * The backend is the production sequence: owner.withExecution registers the
 * engine's own execution object, readAcceptedExecution reads the accepted
 * evidence, and the runtime builds the custody target, claims, binds, claims the
 * start and observes health. The owner issues every claim and loan.
 */
export async function dockerOwnerFixture() {
  const fx = await dockerSourceFixture();
  const docker = engineDouble();
  const outcomes: {
    operationId: string;
    observation?: unknown;
    failure?: Failure;
  }[] = [];
  const claimedViaOwner: string[] = [];
  const dispatch = async (input: V2Execution): Promise<V2BackendResult> =>
    fx.owner.withExecution(input, async () => {
      let accepted: Awaited<ReturnType<typeof fx.owner.readAcceptedExecution>>;
      try {
        accepted = await fx.owner.readAcceptedExecution(input);
      } catch (error) {
        outcomes.push({
          operationId: input.operationId,
          failure: describe(error, "readAcceptedExecution"),
        });
        return { kind: "unknown" };
      }
      const policy: DockerContainerRuntimePolicy = {
        tenantRef: accepted.principal,
        generation: accepted.generation,
        policyDigest: `sha256:${"c".repeat(64)}`,
        outboundInternet: accepted.outboundInternet,
      };
      let lastNative: DockerContainerNativeIdentity | undefined;
      const lease = (native: DockerContainerNativeIdentity): DockerContainerRuntimeLease => ({
        revocation: new AbortController().signal,
        stillCurrent: async () => true,
        readback: async () => {
          lastNative = native;
          return {
            native,
            policy,
            installed: true,
            topology: {
              networkId: native.networkId,
              rulesetDigest: `sha256:${"d".repeat(64)}`,
              meterId: "synthetic-meter",
            },
            coverage: {
              ipv4: true,
              ipv6: true,
              tcp: true,
              udp: true,
              hostInput: true,
              forwardedTraffic: true,
              tenantIsolation: true,
              privateAddressDeny: true,
              metadataDeny: true,
              tcp25Deny: true,
              connectionLimit: true,
              bandwidthLimit: true,
              rawEgressMeter: true,
              killSwitch: true,
              denyAllOutbound: !policy.outboundInternet,
              publicInternet: policy.outboundInternet,
            },
          };
        },
        // The durable start claim is the real owner's.
        claimStart: async (native, claimPolicy) => {
          claimedViaOwner.push(native.nativeId);
          return fx.owner.owner.claimStart(native, claimPolicy);
        },
      });
      const preparation = createDockerContainerRuntimePreparation({
        policy,
        createCustody: fx.owner.createCustody(policy, accepted.requiredSecretNames),
        requiredSecretNames: accepted.requiredSecretNames,
        readStartClaim: (native, claimPolicy) => fx.owner.owner.readStartClaim(native, claimPolicy),
        prepare: async (native) => lease(native),
        recover: async (native) => lease(native),
      });
      const runtime = createDockerHttpRevisionRuntime({
        socketPath: "/var/run/docker.sock",
        installationId: SOURCE_SELECTION.providerInstallationId,
        network: NETWORK,
        maxMemoryBytes: 1024 * 1024 * 1024,
        maxNanoCpus: 2_000_000_000,
        pidsLimit: 128,
        engine: docker.engine,
        healthFetch: async (request) =>
          new Response(request.url.endsWith("/health") ? "ok" : "missing", {
            status: request.url.endsWith("/health") ? 200 : 404,
          }),
        runtimePreparation: preparation,
      });
      try {
        const observation = await runtime.reconcile({
          resourceUid: accepted.resourceUid,
          incarnationId: accepted.incarnationId,
          revision: accepted.revision,
          image: String(accepted.spec.image),
          port: Number(accepted.spec.httpPort),
          healthPath: String(accepted.spec.healthPath),
          memoryBytes: 256 * 1024 * 1024,
          nanoCpus: 500_000_000,
          environment: accepted.spec.environment as Record<string, string>,
        });
        if (observation.state === "ready" && lastNative !== undefined) {
          // The plain runtime preparation has no production caller for publishServing (only the
          // Linux physical one does). The owner's own method is called inside a real reconcile
          // authority, with the record the owner itself persisted and the original runtime instance.
          const retained = (await fx.owner.readAcceptedExecution(input)).retained.find(
            (item) => item.record.intent.policy.generation === accepted.generation,
          );
          if (!retained) throw new Error("owner kept no claim for the served generation");
          const native = lastNative;
          await fx.owner.owner.withAuthority(retained.record, "reconcile", async () => {
            await fx.owner.owner.publishServing(retained.record, native, policy, preparation);
          });
        }
        outcomes.push({ operationId: input.operationId, observation });
        return observation.state === "ready"
          ? { kind: "complete", observed: {}, output: {} }
          : { kind: "unknown" };
      } catch (error) {
        outcomes.push({ operationId: input.operationId, failure: describe(error, "runtime") });
        // A refusal before any effect is not a Form-level verdict about the secret.
        return { kind: "unknown" };
      }
    });
  return { fx, docker, outcomes, claimedViaOwner, dispatch, formUrl: V2_CONTAINER_F2_FORM };
}
