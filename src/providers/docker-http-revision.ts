import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "../json.ts";

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
  | { readonly state: "ready"; readonly nativeId: string; readonly endpoint: string };

interface EngineResponse {
  readonly status: number;
  readonly body: string;
}

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
  readonly engine?: (method: string, path: string, body?: JsonObject) => Promise<EngineResponse>;
  readonly healthFetch?: (request: Request) => Promise<Response>;
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
  if (
    !options.socketPath.startsWith("/") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.installationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.network) ||
    ["host", "bridge", "none"].includes(options.network) ||
    !positive(options.maxMemoryBytes) ||
    !positive(options.maxNanoCpus) ||
    !positive(options.pidsLimit) ||
    !positive(timeoutMs)
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
      input.healthPath.length > 1024 ||
      !positive(input.memoryBytes) ||
      input.memoryBytes > options.maxMemoryBytes ||
      !positive(input.nanoCpus) ||
      input.nanoCpus > options.maxNanoCpus ||
      !isJsonObject(input.environment) ||
      Object.keys(input.environment).length > 128 ||
      Object.entries(input.environment).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
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
        NetworkMode: options.network,
        Memory: input.memoryBytes,
        MemorySwap: input.memoryBytes,
        NanoCpus: input.nanoCpus,
        PidsLimit: options.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        PublishAllPorts: false,
      },
    };
    const fingerprint = await canonicalDigest({ body, healthPath: input.healthPath });
    const labels = { "takoserver.identity": identity, "takoserver.revision": fingerprint };
    const fullBody: JsonObject = { ...body, Labels: labels };
    return { input: structuredClone(input), name, body: fullBody, labels };
  }

  type Desired = Awaited<ReturnType<typeof desired>>;

  async function inspect(target: Desired): Promise<JsonObject | null> {
    const response = await engine("GET", `/containers/${target.name}/json`);
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
      config.Image !== target.input.image ||
      Object.entries(target.labels).some(([key, label]) => labels[key] !== label)
    )
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
      !envContainsExpected(config.Env, target.body.Env) ||
      !exposesPort(config.ExposedPorts, target.input.port) ||
      !mountsAreEmpty(value.Mounts, hostConfig) ||
      !hasNoAdditionalHostAuthority(hostConfig) ||
      !attachedOnlyToNetwork(value.NetworkSettings, options.network)
    ) {
      throw new DockerHttpRevisionError("conflict");
    }
    return value;
  }

  async function observation(target: Desired): Promise<DockerHttpRevisionObservation> {
    const current = await inspect(target);
    if (!current) return { state: "absent" };
    const nativeId = current.Id as string;
    if (!isJsonObject(current.State) || typeof current.State.Running !== "boolean") {
      throw new DockerHttpRevisionError("unavailable");
    }
    if (!current.State.Running) return { state: "stopped", nativeId };
    const networks = isJsonObject(current.NetworkSettings)
      ? current.NetworkSettings.Networks
      : null;
    const network = isJsonObject(networks) ? networks[options.network] : null;
    const ip = isJsonObject(network) ? network.IPAddress : null;
    if (typeof ip !== "string" || isIP(ip) !== 4) return { state: "starting", nativeId };
    const endpoint = `http://${ip}:${target.input.port}`;
    try {
      const health = await healthFetch(
        new Request(`${endpoint}${target.input.healthPath}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      const ready = health.ok;
      await health.body?.cancel();
      return ready ? { state: "ready", nativeId, endpoint } : { state: "starting", nativeId };
    } catch {
      return { state: "starting", nativeId };
    }
  }

  return {
    async reconcile(input: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      const target = await desired(input);
      if (!(await inspect(target))) {
        const pull = await engine(
          "POST",
          `/images/create?fromImage=${encodeURIComponent(target.input.image)}`,
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
          ) {
            throw new DockerHttpRevisionError("unavailable");
          }
        }
        const created = await engine("POST", `/containers/create?name=${target.name}`, target.body);
        if (created.status !== 201 && created.status !== 409) {
          throw new DockerHttpRevisionError("unavailable");
        }
      }
      // Read back even after an ambiguous create/another reconciler winning.
      // Never start a same-name object whose immutable identity differs.
      const current = await inspect(target);
      if (!current) throw new DockerHttpRevisionError("unavailable");
      if (!isJsonObject(current.State) || current.State.Running !== true) {
        const started = await engine("POST", `/containers/${current.Id}/start`);
        if (started.status !== 204 && started.status !== 304) {
          throw new DockerHttpRevisionError("unavailable");
        }
      }
      return await observation(target);
    },
    async observe(input: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      return await observation(await desired(input));
    },
    /**
     * Deferred retirement supplies the native ID it observed before draining.
     * A recreated instance of the same logical revision is not that retirement's
     * target. Omitting the pin is reserved for authoritative logical removal.
     */
    async remove(input: DockerHttpRevision, expectedNativeId?: string): Promise<void> {
      if (expectedNativeId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedNativeId)) {
        throw new DockerHttpRevisionError("invalid_request");
      }
      const target = await desired(input);
      const current = await inspect(target);
      if (!current) return;
      if (expectedNativeId !== undefined && current.Id !== expectedNativeId) {
        throw new DockerHttpRevisionError("conflict");
      }
      const stopped = await engine("POST", `/containers/${current.Id}/stop?t=10`);
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
  return (method, path, body) =>
    new Promise((resolve, reject) => {
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
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      const deadline = setTimeout(
        () => request.destroy(new DockerHttpRevisionError("unavailable")),
        timeoutMs,
      );
      request.on("close", () => clearTimeout(deadline));
      request.on("error", () => reject(new DockerHttpRevisionError("unavailable")));
      request.end(body === undefined ? undefined : canonicalJson(body));
    });
}
