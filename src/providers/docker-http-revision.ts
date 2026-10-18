import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import {
  DockerContainerCreateCustodyError,
  type DockerContainerCreateDriver,
  type DockerContainerCreateSession,
} from "./docker-container-create-custody.ts";
import {
  DockerImageAcquisition,
  type DockerImageAcquisitionTarget,
} from "./docker-container-image-acquisition.ts";
import {
  type DockerContainerNativeIdentity,
  DockerContainerRuntimePreparation,
  DockerContainerRuntimePreparationError,
} from "./docker-container-runtime-preparation.ts";
import { LinuxDockerRuntimePreparation } from "./linux-docker-runtime-preparation.ts";

/** Host-private execution input, not a new Form or an externalServices slot. */
export interface DockerHttpRevision {
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly revision: string;
  /** The application selects the immutable image; the Host selects capacity. */
  readonly image: string;
  readonly port: number;
  readonly healthPath: string;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly environment: Readonly<Record<string, string>>;
}

export type DockerHttpRevisionObservation =
  | { readonly state: "absent" }
  | { readonly state: "stopped" | "starting"; readonly nativeId: string }
  | {
      readonly state: "ready";
      readonly nativeId: string;
      readonly endpoint: string;
      readonly imageDigest?: string;
    };

interface EngineResponse {
  readonly status: number;
  readonly body: string;
}

const CREATE_CLAIM_LABEL = "takoserver.create-claim";

export interface DockerHttpRevisionOptions {
  readonly socketPath: string;
  /** One operator-owned installation and isolated Docker network. */
  readonly installationId: string;
  readonly network: string;
  readonly maxMemoryBytes: number;
  readonly maxNanoCpus: number;
  readonly pidsLimit: number;
  readonly timeoutMs?: number;
  /** External Docker/HTTP boundaries, injectable without replacing lifecycle logic. */
  readonly engine?: (
    method: string,
    path: string,
    body?: JsonObject,
    signal?: AbortSignal,
  ) => Promise<EngineResponse>;
  readonly healthFetch?: (request: Request) => Promise<Response>;
  /** Host-only opt-in; absent keeps the existing owned internal network profile. */
  readonly runtimePreparation?: DockerContainerRuntimePreparation | LinuxDockerRuntimePreparation;
  /** Host archive mode; original held custody is mandatory. No registry pull fallback. */
  readonly imageAcquisition?: DockerImageAcquisition;
  /** Host-owned ordered numeric resolver override, required for Internet-capable
   * preparation. This pins Engine configuration, not destination permission.
   */
  readonly dnsServers?: readonly string[];
}

export class DockerHttpRevisionError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "unavailable") {
    super(code);
    this.name = "DockerHttpRevisionError";
  }
}

/**
 * One Docker-backed immutable HTTP revision. Docker's exact name and labels
 * are recovery evidence, not a second serving/deployment ledger. The caller
 * still owns admission, desired revision, traffic cutover and old-revision
 * retirement. Neither observe nor reconcile changes that traffic authority.
 * This backend alone does not advertise a Container Form or public Offering.
 */
export function createDockerHttpRevisionRuntime(configuration: DockerHttpRevisionOptions) {
  const options = { ...configuration };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const preparation = options.runtimePreparation;
  const linuxPreparation =
    preparation instanceof LinuxDockerRuntimePreparation ? preparation : null;
  const custody = preparation?.createCustody;
  const imageAcquisition = options.imageAcquisition;
  const dnsServers = dnsSnapshot(options.dnsServers);
  if (
    !options.socketPath.startsWith("/") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.installationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.network) ||
    ["host", "bridge", "none"].includes(options.network) ||
    !positive(options.maxMemoryBytes) ||
    !positive(options.maxNanoCpus) ||
    !positive(options.pidsLimit) ||
    !positive(timeoutMs) ||
    (preparation !== undefined &&
      !(preparation instanceof DockerContainerRuntimePreparation) &&
      !linuxPreparation) ||
    (imageAcquisition !== undefined &&
      (!(imageAcquisition instanceof DockerImageAcquisition) || !custody)) ||
    (preparation?.policy.outboundInternet === true && dnsServers === undefined) ||
    (linuxPreparation && !sameStringSet(dnsServers ?? [], linuxPreparation.dnsServers))
  )
    throw new DockerHttpRevisionError("invalid_request");
  const engine = options.engine ?? dockerEngine(options.socketPath, timeoutMs);
  const healthFetch = options.healthFetch ?? ((request: Request) => fetch(request));

  async function desired(request: DockerHttpRevision) {
    const input = structuredClone(request);
    if (
      [input.resourceUid, input.incarnationId, input.revision].some(
        (value) => typeof value !== "string" || value.length < 1 || value.length > 256,
      ) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(input.image) ||
      input.image.length > 512 ||
      !positive(input.port) ||
      input.port > 65535 ||
      !/^\/(?!\/)[^\s#]*$/u.test(input.healthPath) ||
      input.healthPath.includes("\\") ||
      input.healthPath.length > 2048 ||
      !positive(input.memoryBytes) ||
      input.memoryBytes > options.maxMemoryBytes ||
      !positive(input.nanoCpus) ||
      input.nanoCpus > options.maxNanoCpus ||
      !isJsonObject(input.environment) ||
      custody?.requiredSecretNames.some((name) => Object.hasOwn(input.environment, name)) ||
      Object.keys(input.environment).length > 128 ||
      Object.entries(input.environment).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9._-]*$/u.test(key) ||
          typeof value !== "string" ||
          value.includes("\0") ||
          value.length > 8192,
      )
    )
      throw new DockerHttpRevisionError("invalid_request");
    const identity = await canonicalDigest({
      installation: options.installationId,
      resource: input.resourceUid,
      incarnation: input.incarnationId,
      revision: input.revision,
    });
    const name = `takoserver-${identity.slice(7)}`;
    const body: JsonObject = {
      Image: input.image,
      Env: Object.entries(input.environment)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`),
      ExposedPorts: { [`${input.port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: linuxPreparation ? "none" : options.network,
        Memory: input.memoryBytes,
        MemorySwap: input.memoryBytes,
        NanoCpus: input.nanoCpus,
        PidsLimit: options.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        PublishAllPorts: false,
        // Moby's Go DNS/DNSOptions/DNSSearch fields use these exact JSON keys.
        ...(dnsServers ? { Dns: [...dnsServers], DnsOptions: [], DnsSearch: [] } : {}),
        ...(preparation ? { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } } : {}),
      },
    };
    const fingerprint = await canonicalDigest({
      body,
      healthPath: input.healthPath,
      ...(preparation ? { runtimePolicy: { ...preparation.policy } } : {}),
      ...(custody ? { requiredSecretNames: custody.requiredSecretNames } : {}),
    });
    const labels = { "takoserver.identity": identity, "takoserver.revision": fingerprint };
    const fullBody: JsonObject = { ...body, Labels: labels };
    return { input: structuredClone(input), name, body: fullBody, labels };
  }

  type Desired = Awaited<ReturnType<typeof desired>>;

  /** Preserve the original digest-pinned root, including a verified index. */
  function imageTarget(target: Desired): DockerImageAcquisitionTarget {
    return {
      image: target.input.image,
      installationId: options.installationId,
      resourceUid: target.input.resourceUid,
      incarnationId: target.input.incarnationId,
      revision: target.input.revision,
      identityLabel: target.labels["takoserver.identity"],
      revisionLabel: target.labels["takoserver.revision"],
    };
  }

  async function verifyImage(
    target: Desired,
    signal?: AbortSignal,
    claimId?: string,
  ): Promise<string> {
    if (imageAcquisition) {
      if (!claimId) throw new DockerHttpRevisionError("unavailable");
      return imageAcquisition.inspect(imageTarget(target), claimId, signal);
    }
    const response = await engine(
      "GET",
      `/images/${encodeURIComponent(target.input.image)}/json`,
      undefined,
      signal,
    );
    if (response.status !== 200) throw new DockerHttpRevisionError("unavailable");
    let image: unknown;
    try {
      image = JSON.parse(response.body);
    } catch {
      throw new DockerHttpRevisionError("unavailable");
    }
    const digest = target.input.image.slice(target.input.image.lastIndexOf("@") + 1);
    if (
      !isJsonObject(image) ||
      typeof image.Id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
      image.Os !== "linux" ||
      image.Architecture !== "amd64" ||
      !isJsonObject(image.Descriptor) ||
      image.Descriptor.digest !== digest ||
      ![
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(String(image.Descriptor.mediaType))
    )
      throw new DockerHttpRevisionError("conflict");
    return image.Id;
  }

  async function inspect(
    target: Desired,
    held?: {
      readonly nativeId: string | null;
      readonly claimId: string;
      readonly signal: AbortSignal;
    },
  ): Promise<JsonObject | null> {
    const response = await engine(
      "GET",
      `/containers/${held?.nativeId ?? target.name}/json`,
      undefined,
      held?.signal,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) throw new DockerHttpRevisionError("unavailable");
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new DockerHttpRevisionError("unavailable");
    }
    if (!isJsonObject(value) || typeof value.Id !== "string" || !/^[a-f0-9]{64}$/u.test(value.Id)) {
      throw new DockerHttpRevisionError("unavailable");
    }
    const config = value.Config;
    const labels = isJsonObject(config) ? config.Labels : null;
    if (!isJsonObject(config) || !isJsonObject(labels))
      throw new DockerHttpRevisionError("conflict");
    if (
      (held?.nativeId !== undefined && held.nativeId !== null && value.Id !== held.nativeId) ||
      (held
        ? labels[CREATE_CLAIM_LABEL] !== held.claimId
        : labels[CREATE_CLAIM_LABEL] !== undefined) ||
      (!imageAcquisition && config.Image !== target.input.image) ||
      Object.entries(target.labels).some(([key, label]) => labels[key] !== label)
    )
      throw new DockerHttpRevisionError("conflict");
    const imageId = await verifyImage(target, held?.signal, held?.claimId);
    if (value.Image !== imageId || (imageAcquisition && config.Image !== imageId))
      throw new DockerHttpRevisionError("conflict");
    const hostConfig = value.HostConfig;
    const expectedHostConfig = target.body.HostConfig;
    if (
      !isJsonObject(hostConfig) ||
      !isJsonObject(expectedHostConfig) ||
      hostConfig.NetworkMode !== expectedHostConfig.NetworkMode ||
      hostConfig.Memory !== expectedHostConfig.Memory ||
      hostConfig.MemorySwap !== expectedHostConfig.MemorySwap ||
      hostConfig.NanoCpus !== expectedHostConfig.NanoCpus ||
      hostConfig.PidsLimit !== expectedHostConfig.PidsLimit ||
      hostConfig.Privileged !== expectedHostConfig.Privileged ||
      hostConfig.PublishAllPorts !== expectedHostConfig.PublishAllPorts ||
      !sameStringSet(hostConfig.CapDrop, expectedHostConfig.CapDrop) ||
      !sameStringSet(hostConfig.SecurityOpt, expectedHostConfig.SecurityOpt) ||
      !matchesPinnedDns(hostConfig, dnsServers) ||
      !envContainsExpected(config.Env, target.body.Env) ||
      !exposesPort(config.ExposedPorts, target.input.port) ||
      !mountsAreEmpty(value.Mounts, hostConfig) ||
      !hasNoAdditionalHostAuthority(hostConfig) ||
      (preparation &&
        (!isJsonObject(hostConfig.RestartPolicy) ||
          hostConfig.RestartPolicy.Name !== "no" ||
          hostConfig.RestartPolicy.MaximumRetryCount !== 0)) ||
      !(
        attachedOnlyToNetwork(value.NetworkSettings, options.network) ||
        (linuxPreparation && quarantineNetworkSettings(value.NetworkSettings))
      )
    ) {
      throw new DockerHttpRevisionError("conflict");
    }
    return value;
  }

  /** A name alone does not establish that a Docker network is private or ours. */
  async function requireOwnedNetwork(signal?: AbortSignal): Promise<string | null> {
    const response = await engine(
      "GET",
      `/networks/${encodeURIComponent(options.network)}`,
      undefined,
      signal,
    );
    if (response.status !== 200) throw new DockerHttpRevisionError("unavailable");
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new DockerHttpRevisionError("unavailable");
    }
    if (
      !isJsonObject(value) ||
      value.Name !== options.network ||
      value.Driver !== "bridge" ||
      value.Scope !== "local" ||
      (linuxPreparation
        ? typeof value.Internal !== "boolean" ||
          (linuxPreparation.policy.outboundInternet && value.Internal)
        : value.Internal !== !(preparation?.policy.outboundInternet ?? false)) ||
      value.Ingress !== false ||
      value.Attachable !== false ||
      !isJsonObject(value.Labels) ||
      value.Labels["takoserver.installation"] !== options.installationId ||
      (preparation && (typeof value.Id !== "string" || !/^[a-f0-9]{64}$/u.test(value.Id)))
    ) {
      throw new DockerHttpRevisionError("conflict");
    }
    return typeof value.Id === "string" ? value.Id : null;
  }

  function nativeIdentity(
    target: Desired,
    current: JsonObject,
    networkId: string | null,
  ): DockerContainerNativeIdentity {
    if (
      networkId === null ||
      !isJsonObject(current.State) ||
      typeof current.State.Running !== "boolean"
    )
      throw new DockerHttpRevisionError("unavailable");
    const networks = isJsonObject(current.NetworkSettings)
      ? current.NetworkSettings.Networks
      : null;
    const attachment = isJsonObject(networks) ? networks[options.network] : null;
    // Bind the daemon-recorded configuration to the owned immutable network ID.
    // A stopped object's endpoint/sandbox may not exist yet; this is not proof
    // of a physical attachment or installed filtering on that endpoint.
    if (
      !(linuxPreparation && quarantineNetworkSettings(current.NetworkSettings)) &&
      (!isJsonObject(attachment) ||
        typeof attachment.NetworkID !== "string" ||
        !/^[a-f0-9]{64}$/u.test(attachment.NetworkID) ||
        attachment.NetworkID !== networkId)
    )
      throw new DockerHttpRevisionError("conflict");
    return Object.freeze({
      backend: "docker",
      installationId: options.installationId,
      resourceUid: target.input.resourceUid,
      incarnationId: target.input.incarnationId,
      revision: target.input.revision,
      nativeId: current.Id as string,
      network: options.network,
      // Quarantine binds owned immutable network configuration, not attachment.
      networkId,
      image: target.input.image,
      imageId: current.Image as string,
      identityLabel: target.labels["takoserver.identity"],
      revisionLabel: target.labels["takoserver.revision"],
    });
  }

  async function prepared<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new DockerHttpRevisionError(
        error instanceof DockerContainerRuntimePreparationError ||
          error instanceof DockerContainerCreateCustodyError
          ? error.code
          : "unavailable",
      );
    }
  }

  async function createStopped(
    target: Desired,
    transient?: {
      readonly claimId: string;
      readonly overrides: Readonly<Record<string, string>>;
      readonly signal: AbortSignal;
      readonly guard: () => Promise<void>;
      readonly session?: DockerContainerCreateSession;
      readonly importedImage?: string;
    },
  ): Promise<string | null> {
    const signal = transient?.signal;
    await requireOwnedNetwork(signal);
    // Network readback awaits Engine I/O. Current-only revocation must refuse
    // image acquisition before it can change daemon/registry state.
    if (transient) await transient.guard();
    let importedImage: string | undefined;
    if (imageAcquisition) {
      if (!transient?.session || !transient.importedImage)
        throw new DockerHttpRevisionError("unavailable");
      importedImage = transient.importedImage;
    } else {
      const pull = await engine(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(target.input.image)}&platform=linux%2Famd64`,
        undefined,
        signal,
      );
      if (pull.status !== 200) throw new DockerHttpRevisionError("unavailable");
      for (const line of pull.body.split("\n")) {
        if (!line.trim()) continue;
        let progress: unknown;
        try {
          progress = JSON.parse(line);
        } catch {
          throw new DockerHttpRevisionError("unavailable");
        }
        if (
          !isJsonObject(progress) ||
          progress.error !== undefined ||
          progress.errorDetail !== undefined
        )
          throw new DockerHttpRevisionError("unavailable");
      }
    }
    if (!imageAcquisition) await verifyImage(target, signal, transient?.claimId);
    let creationBody = importedImage ? { ...target.body, Image: importedImage } : target.body;
    if (preparation) {
      const networkId = await requireOwnedNetwork(signal);
      if (networkId === null) throw new DockerHttpRevisionError("unavailable");
      // This pins configuration, not a kernel endpoint or installed filtering.
      creationBody = {
        ...creationBody,
        NetworkingConfig: { EndpointsConfig: { [options.network]: { NetworkID: networkId } } },
      };
    }
    if (transient) {
      // These values exist only in this scoped native request. They never enter
      // target.body, immutable fingerprints, serving state or custody records.
      creationBody = {
        ...creationBody,
        Env: [
          ...(target.body.Env as string[]),
          ...Object.entries(transient.overrides).map(([name, value]) => `${name}=${value}`),
        ],
        Labels: { ...target.labels, [CREATE_CLAIM_LABEL]: transient.claimId },
      };
    }
    // Image/network checks await native I/O. Current-only expiry during those
    // checks must be refused before Env can be sent, even without an abort.
    if (transient) await transient.guard();
    const created = await engine(
      "POST",
      `/containers/create?name=${target.name}&platform=linux%2Famd64`,
      creationBody,
      signal,
    );
    if (!transient) {
      if (created.status !== 201 && created.status !== 409)
        throw new DockerHttpRevisionError("unavailable");
      return null;
    }
    if (created.status !== 201) throw new DockerHttpRevisionError("unavailable");
    let receipt: unknown;
    try {
      receipt = JSON.parse(created.body);
    } catch {
      throw new DockerHttpRevisionError("unavailable");
    }
    if (
      !isJsonObject(receipt) ||
      typeof receipt.Id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(receipt.Id)
    )
      throw new DockerHttpRevisionError("unavailable");
    return receipt.Id;
  }

  async function observeHealth(
    target: Desired,
    nativeId: string,
    ip: unknown,
    guard?: () => Promise<void>,
    signal?: AbortSignal,
    verifiedManifestDigest?: string,
  ): Promise<DockerHttpRevisionObservation> {
    if (imageAcquisition && !/^sha256:[a-f0-9]{64}$/u.test(verifiedManifestDigest ?? ""))
      throw new DockerHttpRevisionError("unavailable");
    if (typeof ip !== "string" || isIP(ip) !== 4) return { state: "starting", nativeId };
    const endpoint = `http://${ip}:${target.input.port}`;
    let ready = false;
    try {
      const health = await healthFetch(
        new Request(`${endpoint}${target.input.healthPath}`, {
          redirect: "manual",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        }),
      );
      ready = health.ok;
      await health.body?.cancel();
    } catch {
      ready = false;
    }
    if (guard) await prepared(guard);
    return ready
      ? {
          state: "ready",
          nativeId,
          endpoint,
          ...(verifiedManifestDigest === undefined ? {} : { imageDigest: verifiedManifestDigest }),
        }
      : { state: "starting", nativeId };
  }

  /** Every secret-mode native read/create and health observation stays within
   * the producer's held authority. Only safe native/IP projections leave the
   * transient Env inspection callback; Docker daemon Env retention is real.
   */
  async function withCreation<T>(
    target: Desired,
    phase: "reconcile" | "observe" | "remove",
    use: (session: DockerContainerCreateSession, ips: ReadonlyMap<string, unknown>) => Promise<T>,
    operationSignal?: AbortSignal,
  ): Promise<T> {
    if (!custody) throw new DockerHttpRevisionError("unavailable");
    const ips = new Map<string, unknown>();
    let creationGuard: (() => Promise<void>) | null = null;
    let creationSession: DockerContainerCreateSession | null = null;
    let creationImage: string | undefined;
    const driver: DockerContainerCreateDriver = {
      async inspect(record, signal) {
        const current = await inspect(target, {
          nativeId: record.nativeId,
          claimId: record.claimId,
          signal,
        });
        if (!current) return null;
        const native = nativeIdentity(target, current, await requireOwnedNetwork(signal));
        const config = current.Config;
        const state = current.State;
        if (
          !isJsonObject(config) ||
          !Array.isArray(config.Env) ||
          !config.Env.every((value) => typeof value === "string") ||
          !isJsonObject(state) ||
          typeof state.Running !== "boolean"
        )
          throw new DockerHttpRevisionError("conflict");
        const networks = isJsonObject(current.NetworkSettings)
          ? current.NetworkSettings.Networks
          : null;
        const network = isJsonObject(networks) ? networks[options.network] : null;
        ips.set(native.nativeId, isJsonObject(network) ? network.IPAddress : null);
        return {
          native,
          state: state.Running ? "running" : "stopped",
          claimId: record.claimId,
          environment: config.Env as string[],
        };
      },
      async create(record, overrides, signal) {
        const guard = creationGuard;
        if (!guard) throw new DockerHttpRevisionError("unavailable");
        const nativeId = await createStopped(target, {
          claimId: record.claimId,
          overrides,
          signal,
          guard,
          ...(creationSession === null ? {} : { session: creationSession }),
          ...(creationImage === undefined ? {} : { importedImage: creationImage }),
        });
        if (nativeId === null) throw new DockerHttpRevisionError("unavailable");
        return nativeId;
      },
      async remove(_record, nativeId, signal) {
        const stopped = await engine("POST", `/containers/${nativeId}/stop?t=0`, undefined, signal);
        if (![204, 304, 404].includes(stopped.status))
          throw new DockerHttpRevisionError("unavailable");
        const removed = await engine("DELETE", `/containers/${nativeId}?v=true`, undefined, signal);
        if (removed.status !== 204 && removed.status !== 404)
          throw new DockerHttpRevisionError("unavailable");
        return removed.status === 204 ? "deleted" : "not-found";
      },
    };
    return prepared(() =>
      custody.withAuthority(
        {
          installationId: options.installationId,
          resourceUid: target.input.resourceUid,
          incarnationId: target.input.incarnationId,
          revision: target.input.revision,
          nativeName: target.name,
          identityLabel: target.labels["takoserver.identity"],
          revisionLabel: target.labels["takoserver.revision"],
        },
        phase,
        driver,
        async (session) => {
          creationGuard = () => session.guard();
          creationSession = session;
          try {
            // Image bytes are acquired before ensureCreated opens the original
            // secret environment loan. Observe/remove never import an image.
            if (imageAcquisition && phase === "reconcile" && !(await session.inspect())) {
              await requireOwnedNetwork(session.signal);
              await session.guard();
              creationImage = await imageAcquisition.acquire(session, imageTarget(target));
            }
            return await use(session, ips);
          } finally {
            creationGuard = null;
            creationSession = null;
            creationImage = undefined;
          }
        },
        operationSignal,
      ),
    );
  }

  async function creationObservation(
    target: Desired,
    session: DockerContainerCreateSession,
    ips: ReadonlyMap<string, unknown>,
  ): Promise<DockerHttpRevisionObservation> {
    const current = await session.inspect();
    if (!current) throw new DockerHttpRevisionError("unavailable");
    await session.guard();
    const nativeId = current.native.nativeId;
    if (current.state === "stopped") return { state: "stopped", nativeId };
    if (!preparation) throw new DockerHttpRevisionError("unavailable");
    const enforcerGuard = await prepared(() => preparation.verifyExisting(current.native));
    return observeHealth(
      target,
      nativeId,
      ips.get(nativeId),
      async () => {
        await enforcerGuard();
        await session.guard();
      },
      session.signal,
      // Archive inspect verified the original retained archive.manifestDigest
      // against both native image readback and the exact container binding.
      imageAcquisition ? current.native.imageId : undefined,
    );
  }

  async function observation(target: Desired): Promise<DockerHttpRevisionObservation> {
    const current = await inspect(target);
    if (!current) return { state: "absent" };
    const nativeId = current.Id as string;
    if (!isJsonObject(current.State) || typeof current.State.Running !== "boolean") {
      throw new DockerHttpRevisionError("unavailable");
    }
    if (!current.State.Running) return { state: "stopped", nativeId };
    let authorityGuard: (() => Promise<void>) | null = null;
    if (preparation) {
      const networkId = await requireOwnedNetwork();
      authorityGuard = await prepared(() =>
        preparation.verifyExisting(nativeIdentity(target, current, networkId)),
      );
    }
    const networks = isJsonObject(current.NetworkSettings)
      ? current.NetworkSettings.Networks
      : null;
    const network = isJsonObject(networks) ? networks[options.network] : null;
    const ip = isJsonObject(network) ? network.IPAddress : null;
    return observeHealth(target, nativeId, ip, authorityGuard ?? undefined);
  }

  return {
    async reconcile(input: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      const target = await desired(input);
      if (linuxPreparation) {
        // Close the initial pending CREATE lease before physical START/health.
        // Only the safe bound projection escapes; no Env or borrowed session.
        const created = await withCreation(target, "reconcile", async (session) => {
          const current = await session.ensureCreated();
          if (!current) throw new DockerHttpRevisionError("unavailable");
          await session.guard();
          return Object.freeze({
            native: Object.freeze(structuredClone(current.native)),
            state: current.state,
          });
        });
        if (created.state === "stopped")
          await prepared(() => linuxPreparation.ensureRunning(created.native));
        return withCreation(target, "reconcile", async (session, ips) => {
          const observed = await creationObservation(target, session, ips);
          if (observed.state === "ready") {
            const current = await session.inspect();
            if (!current || current.native.nativeId !== created.native.nativeId)
              throw new DockerHttpRevisionError("conflict");
            await session.guard();
            await prepared(() => linuxPreparation.publishServing(current.native));
            await session.guard();
          }
          return observed;
        });
      }
      if (custody) {
        return withCreation(target, "reconcile", async (session, ips) => {
          const current = await session.ensureCreated();
          if (!current || !preparation) throw new DockerHttpRevisionError("unavailable");
          if (current.state === "stopped") {
            if (!(preparation instanceof DockerContainerRuntimePreparation))
              throw new DockerHttpRevisionError("unavailable");
            await prepared(() =>
              preparation.authorizeStart(
                { native: current.native, state: "stopped" },
                async (guard) => {
                  const latest = await session.inspect();
                  if (
                    latest?.state !== "stopped" ||
                    latest.native.nativeId !== current.native.nativeId ||
                    latest.native.networkId !== current.native.networkId
                  )
                    throw new DockerHttpRevisionError("conflict");
                  await guard();
                  await session.guard();
                  const started = await engine(
                    "POST",
                    `/containers/${current.native.nativeId}/start`,
                    undefined,
                    session.signal,
                  );
                  if (started.status !== 204 && started.status !== 304)
                    throw new DockerHttpRevisionError("unavailable");
                },
              ),
            );
          }
          return creationObservation(target, session, ips);
        });
      }
      if (!(await inspect(target))) await createStopped(target);
      // Read back even after an ambiguous create/another reconciler winning.
      // Never start a same-name object whose immutable identity differs.
      const current = await inspect(target);
      if (!current) throw new DockerHttpRevisionError("unavailable");
      if (!isJsonObject(current.State) || current.State.Running !== true) {
        const networkId = await requireOwnedNetwork();
        if (preparation) {
          if (!(preparation instanceof DockerContainerRuntimePreparation))
            throw new DockerHttpRevisionError("unavailable");
          const native = nativeIdentity(target, current, networkId);
          await prepared(() =>
            preparation.authorizeStart({ native, state: "stopped" }, async (guard) => {
              // Native creation is stopped/restart-disabled. Install and readback
              // happen outside the image before this sole start claim is spent.
              const latest = await inspect(target);
              if (
                !latest ||
                latest.Id !== native.nativeId ||
                !isJsonObject(latest.State) ||
                latest.State.Running !== false
              )
                throw new DockerHttpRevisionError("conflict");
              const latestNative = nativeIdentity(target, latest, await requireOwnedNetwork());
              if (latestNative.networkId !== native.networkId)
                throw new DockerHttpRevisionError("conflict");
              await guard();
              const started = await engine("POST", `/containers/${native.nativeId}/start`);
              if (started.status !== 204 && started.status !== 304)
                throw new DockerHttpRevisionError("unavailable");
            }),
          );
        } else {
          const started = await engine("POST", `/containers/${current.Id}/start`);
          if (started.status !== 204 && started.status !== 304)
            throw new DockerHttpRevisionError("unavailable");
        }
      }
      return await observation(target);
    },
    async observe(input: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      const target = await desired(input);
      return custody
        ? withCreation(target, "observe", (session, ips) =>
            creationObservation(target, session, ips),
          )
        : observation(target);
    },
    /**
     * Deferred retirement supplies the native ID it observed before draining.
     * A recreated instance of the same logical revision is not that retirement's
     * target. Omitting the pin is reserved for authoritative logical removal.
     */
    async remove(
      input: DockerHttpRevision,
      expectedNativeId?: string,
      signal?: AbortSignal,
    ): Promise<void> {
      if (signal !== undefined && (!(signal instanceof AbortSignal) || !custody))
        throw new DockerHttpRevisionError("invalid_request");
      if (signal?.aborted) throw new DockerHttpRevisionError("unavailable");
      if (expectedNativeId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedNativeId)) {
        throw new DockerHttpRevisionError("invalid_request");
      }
      const target = await desired(input);
      if (custody) {
        return withCreation(
          target,
          "remove",
          async (session) => {
            if (expectedNativeId !== undefined && session.record.nativeId !== expectedNativeId)
              throw new DockerHttpRevisionError("conflict");
            // A committed removal can be retried without reopening secret Env.
            // The custody session verifies exact-ID absence under cleanup authority.
            const nativeId =
              session.record.nativeId ?? (await session.inspect())?.native.nativeId ?? null;
            if (nativeId === null) throw new DockerHttpRevisionError("unavailable");
            await session.remove(nativeId);
          },
          signal,
        );
      }
      const current = await inspect(target);
      if (!current) return;
      if (expectedNativeId !== undefined && current.Id !== expectedNativeId) {
        throw new DockerHttpRevisionError("conflict");
      }
      const stopped = await engine("POST", `/containers/${current.Id}/stop?t=0`);
      if (![204, 304, 404].includes(stopped.status))
        throw new DockerHttpRevisionError("unavailable");
      const removed = await engine("DELETE", `/containers/${current.Id}?v=true`);
      if (removed.status !== 204 && removed.status !== 404)
        throw new DockerHttpRevisionError("unavailable");
      if (await inspect(target)) throw new DockerHttpRevisionError("conflict");
    },
  };
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as readonly string[])
    : null;
}

function sameStringSet(actual: unknown, expected: unknown): boolean {
  const actualValues = stringArray(actual);
  const expectedValues = stringArray(expected);
  if (!actualValues || !expectedValues) return false;
  const actualSet = new Set(actualValues);
  const expectedSet = new Set(expectedValues);
  return (
    actualSet.size === expectedSet.size && [...expectedSet].every((value) => actualSet.has(value))
  );
}

function envContainsExpected(actual: unknown, expected: unknown): boolean {
  const actualValues = stringArray(actual);
  const expectedValues = stringArray(expected);
  if (!actualValues || !expectedValues) return false;
  const actualByKey = new Map<string, string>();
  for (const entry of actualValues) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return false;
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    const previous = actualByKey.get(key);
    if (previous !== undefined && previous !== value) return false;
    actualByKey.set(key, value);
  }
  for (const entry of expectedValues) {
    const separator = entry.indexOf("=");
    if (
      separator <= 0 ||
      actualByKey.get(entry.slice(0, separator)) !== entry.slice(separator + 1)
    ) {
      return false;
    }
  }
  return true;
}

function exposesPort(actual: unknown, port: number): boolean {
  if (!isJsonObject(actual)) return false;
  return isJsonObject(actual[`${port}/tcp`]);
}

function emptyOptionalList(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function dnsSnapshot(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 3)
    throw new DockerHttpRevisionError("invalid_request");
  const copy = [...value];
  if (
    copy.some(
      (server) => typeof server !== "string" || server.includes("%") || isIP(server) === 0,
    ) ||
    new Set(copy).size !== copy.length
  )
    throw new DockerHttpRevisionError("invalid_request");
  return Object.freeze(copy);
}

function matchesPinnedDns(
  hostConfig: JsonObject,
  expected: readonly string[] | undefined,
): boolean {
  if (expected === undefined) return true;
  const actual = hostConfig.Dns;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((server, index) => server === expected[index]) &&
    emptyOptionalList(hostConfig.DnsOptions) &&
    emptyOptionalList(hostConfig.DnsSearch)
  );
}

function emptyOptionalObject(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isJsonObject(value) && Object.keys(value).length === 0)
  );
}

function mountsAreEmpty(mounts: unknown, hostConfig: JsonObject): boolean {
  return (
    Array.isArray(mounts) &&
    mounts.length === 0 &&
    emptyOptionalList(hostConfig.Binds) &&
    emptyOptionalList(hostConfig.Mounts) &&
    emptyOptionalList(hostConfig.VolumesFrom) &&
    emptyOptionalObject(hostConfig.Tmpfs)
  );
}

function hasNoAdditionalHostAuthority(hostConfig: JsonObject): boolean {
  // CapDrop does not cancel explicit CapAdd. Likewise PublishAllPorts=false
  // does not disable individual port mappings. Verify these independently.
  return (
    emptyOptionalList(hostConfig.CapAdd) &&
    emptyOptionalList(hostConfig.Devices) &&
    emptyOptionalList(hostConfig.DeviceRequests) &&
    emptyOptionalList(hostConfig.DeviceCgroupRules) &&
    emptyOptionalObject(hostConfig.PortBindings) &&
    ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"].every((field) => {
      const mode = hostConfig[field];
      return mode === undefined || mode === "" || mode === "private";
    })
  );
}

function quarantineNetworkSettings(value: unknown): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.Networks)) return false;
  const names = Object.keys(value.Networks);
  return (
    names.length === 0 ||
    (names.length === 1 && names[0] === "none" && isJsonObject(value.Networks.none))
  );
}

function attachedOnlyToNetwork(networkSettings: unknown, networkName: string): boolean {
  if (!isJsonObject(networkSettings) || !isJsonObject(networkSettings.Networks)) return false;
  const networks = networkSettings.Networks;
  const names = Object.keys(networks);
  return names.length === 1 && names[0] === networkName && isJsonObject(networks[networkName]);
}

/** Bounded operator Unix-socket transport; no daemon response reaches callers. */
function dockerEngine(
  socketPath: string,
  timeoutMs: number,
): NonNullable<DockerHttpRevisionOptions["engine"]> {
  return (method, path, body, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DockerHttpRevisionError("unavailable"));
        return;
      }
      const request = httpRequest(
        {
          socketPath,
          path: `/v1.51${path}`,
          method,
          headers: { "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > 8 * 1024 * 1024) request.destroy(new DockerHttpRevisionError("unavailable"));
            else chunks.push(chunk);
          });
          response.on("error", () => reject(new DockerHttpRevisionError("unavailable")));
          response.on("end", () => {
            if (signal?.aborted) reject(new DockerHttpRevisionError("unavailable"));
            else
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
          });
        },
      );
      const deadline = setTimeout(
        () => request.destroy(new DockerHttpRevisionError("unavailable")),
        timeoutMs,
      );
      const abort = () => request.destroy(new DockerHttpRevisionError("unavailable"));
      signal?.addEventListener("abort", abort, { once: true });
      request.on("close", () => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
      });
      request.on("error", () => reject(new DockerHttpRevisionError("unavailable")));
      if (signal?.aborted) abort();
      else request.end(body === undefined ? undefined : canonicalJson(body));
    });
}
