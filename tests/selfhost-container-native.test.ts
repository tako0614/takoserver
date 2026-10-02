import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { createDockerHttpRevisionRuntime } from "../src/providers/docker-http-revision.ts";
import { createSelfhostContainerRuntime } from "../src/providers/selfhost-container-runtime.ts";

const IMAGE_A = "TAKOSERVER_NATIVE_CONTAINER_IMAGE_A";
const IMAGE_B = "TAKOSERVER_NATIVE_CONTAINER_IMAGE_B";
const PROVENANCE_LABEL_A = "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_A";
const PROVENANCE_LABEL_B = "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_B";
const PROVENANCE_VALUE_A = "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_A";
const PROVENANCE_VALUE_B = "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_B";
const VERSION_A = "TAKOSERVER_NATIVE_CONTAINER_VERSION_A";
const VERSION_B = "TAKOSERVER_NATIVE_CONTAINER_VERSION_B";
const SERVER_A = "TAKOSERVER_NATIVE_CONTAINER_SERVER_A";
const SERVER_B = "TAKOSERVER_NATIVE_CONTAINER_SERVER_B";
const PORT = "TAKOSERVER_NATIVE_CONTAINER_PORT";

interface FixtureConfig {
  readonly port: number;
  readonly variants: {
    readonly A: {
      readonly image: string;
      readonly provenanceLabel: string;
      readonly provenanceValue: string;
      readonly version: string;
      readonly server: string;
    };
    readonly B: {
      readonly image: string;
      readonly provenanceLabel: string;
      readonly provenanceValue: string;
      readonly version: string;
      readonly server: string;
    };
  };
}

interface LocalImageEvidence {
  readonly id: string;
  readonly os: string;
  readonly architecture: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly version: string;
  readonly exposedPorts: Readonly<Record<string, unknown>>;
  readonly repoDigests: readonly string[];
}

const NETWORK_RUN_LABEL = "takoserver.native-container-test.run";

interface NetworkEvidence {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly scope: string;
  readonly internal: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

interface NetworkCleanupIntent {
  readonly name: string;
  readonly token: string;
  readonly createAttempted: boolean;
  readonly acknowledgedId?: string;
}

interface NetworkCleanupOperations {
  inspectById(id: string): Promise<NetworkEvidence | null>;
  inspectByName(name: string): Promise<readonly NetworkEvidence[]>;
  removeById(id: string): Promise<void>;
}

function networkIdFromCreateAck(value: string): string | undefined {
  const id = value.trim();
  return /^[a-f0-9]{64}$/u.test(id) ? id : undefined;
}

function isOwnedNetwork(
  evidence: NetworkEvidence | null | undefined,
  intent: NetworkCleanupIntent,
  expectedId?: string,
): evidence is NetworkEvidence {
  return (
    evidence !== null &&
    evidence !== undefined &&
    /^[a-f0-9]{64}$/u.test(evidence.id) &&
    (expectedId === undefined || evidence.id === expectedId) &&
    evidence.name === intent.name &&
    evidence.driver === "bridge" &&
    evidence.scope === "local" &&
    evidence.internal === true &&
    Object.keys(evidence.labels).length === 1 &&
    evidence.labels[NETWORK_RUN_LABEL] === intent.token
  );
}

async function removeOwnedNetwork(
  intent: NetworkCleanupIntent,
  operations: NetworkCleanupOperations,
): Promise<boolean> {
  if (intent.acknowledgedId !== undefined) {
    const evidence = await operations.inspectById(intent.acknowledgedId);
    if (!isOwnedNetwork(evidence, intent, intent.acknowledgedId)) return false;
    await operations.removeById(intent.acknowledgedId);
    return true;
  }
  if (!intent.createAttempted) return false;

  // A malformed/lost create acknowledgement permits one bounded lookup by the
  // run's unique intent name. Ownership labels and immutable ID are rechecked
  // before removal; a same-name object with different metadata is untouched.
  const matches = await operations.inspectByName(intent.name);
  const candidate = matches[0];
  if (matches.length !== 1 || !isOwnedNetwork(candidate, intent)) return false;
  await operations.removeById(candidate.id);
  return true;
}

function inspectedNetwork(reference: string): NetworkEvidence | null {
  const result = Bun.spawnSync(
    [
      "docker",
      "network",
      "inspect",
      `--format={{.Id}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Internal}}|{{json .Labels}}`,
      reference,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) return null;
  const output = result.stdout.toString("utf8").trim();
  if (output.length > 64 * 1024) return null;
  const fields = output.split("|");
  if (fields.length !== 6) return null;
  let labels: unknown;
  try {
    labels = JSON.parse(fields[5] ?? "null");
  } catch {
    return null;
  }
  if (
    !/^[a-f0-9]{64}$/u.test(fields[0] ?? "") ||
    typeof fields[1] !== "string" ||
    typeof fields[2] !== "string" ||
    typeof fields[3] !== "string" ||
    (fields[4] !== "true" && fields[4] !== "false") ||
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    !Object.values(labels).every((value) => typeof value === "string")
  ) {
    return null;
  }
  const [id, name, driver, scope, internal] = fields;
  if (
    id === undefined ||
    name === undefined ||
    driver === undefined ||
    scope === undefined ||
    internal === undefined
  ) {
    return null;
  }
  return {
    id,
    name,
    driver,
    scope,
    internal: internal === "true",
    labels: labels as Record<string, string>,
  };
}

function liveNetworkCleanupOperations(): NetworkCleanupOperations {
  return {
    async inspectById(id) {
      return inspectedNetwork(id);
    },
    async inspectByName(name) {
      const evidence = inspectedNetwork(name);
      return evidence ? [evidence] : [];
    },
    async removeById(id) {
      docker(["network", "rm", id]);
    },
  };
}

function docker(args: readonly string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args[0] ?? "command"} failed with exit code ${result.exitCode}`);
  }
  const output = result.stdout.toString("utf8");
  if (output.length > 64 * 1024)
    throw new Error("docker returned oversized qualification metadata");
  return output.trim();
}

function localSocketPath(): string {
  const host =
    process.env.DOCKER_HOST ??
    docker(["context", "inspect", "--format={{.Endpoints.docker.Host}}"]);
  if (!host.startsWith("unix://")) {
    throw new Error("native lifecycle qualification requires a local Docker Unix socket");
  }
  const socketPath = host.slice("unix://".length);
  if (!socketPath.startsWith("/")) throw new Error("Docker Unix socket path must be absolute");
  return socketPath;
}

function fixtureConfig(): FixtureConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`native lifecycle opt-in requires ${name}`);
    return value;
  };
  const imageA = required(IMAGE_A);
  const imageB = required(IMAGE_B);
  const provenanceLabelA = required(PROVENANCE_LABEL_A);
  const provenanceLabelB = required(PROVENANCE_LABEL_B);
  const provenanceValueA = required(PROVENANCE_VALUE_A);
  const provenanceValueB = required(PROVENANCE_VALUE_B);
  const versionA = required(VERSION_A);
  const versionB = required(VERSION_B);
  const serverA = required(SERVER_A);
  const serverB = required(SERVER_B);
  const port = Number(required(PORT));
  const digestRef = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u;
  if (!digestRef.test(imageA) || !digestRef.test(imageB) || imageA === imageB) {
    throw new Error(`${IMAGE_A} and ${IMAGE_B} must be distinct immutable repository digests`);
  }
  if (
    [provenanceLabelA, provenanceLabelB, provenanceValueA, provenanceValueB].some(
      (value) => value.length > 512,
    )
  ) {
    throw new Error("native lifecycle provenance values must be bounded");
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${PORT} must be an unprivileged TCP port from 1024 through 65535`);
  }
  return {
    port,
    variants: {
      A: {
        image: imageA,
        provenanceLabel: provenanceLabelA,
        provenanceValue: provenanceValueA,
        version: versionA,
        server: serverA,
      },
      B: {
        image: imageB,
        provenanceLabel: provenanceLabelB,
        provenanceValue: provenanceValueB,
        version: versionB,
        server: serverB,
      },
    },
  };
}

function inspectImage(variant: "A" | "B", fixture: FixtureConfig): LocalImageEvidence {
  const result = docker([
    "image",
    "inspect",
    `--format={{.Id}}|{{.Os}}|{{.Architecture}}|{{json (index .Config "Labels")}}|{{json (index .Config "ExposedPorts")}}|{{json .RepoDigests}}`,
    fixture.variants[variant].image,
  ]);
  const fields = result.split("|");
  if (fields.length !== 6) throw new Error(`local fixture image ${variant} inspect was incomplete`);
  let labels: unknown;
  let exposedPorts: unknown;
  let repoDigests: unknown;
  try {
    labels = JSON.parse(fields[3] ?? "null");
    exposedPorts = JSON.parse(fields[4] ?? "null");
    repoDigests = JSON.parse(fields[5] ?? "null");
  } catch {
    throw new Error(`local fixture image ${variant} inspect metadata did not return JSON`);
  }
  if (
    typeof fields[0] !== "string" ||
    typeof fields[1] !== "string" ||
    typeof fields[2] !== "string" ||
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    typeof exposedPorts !== "object" ||
    exposedPorts === null ||
    Array.isArray(exposedPorts) ||
    !Array.isArray(repoDigests) ||
    !repoDigests.every((digest) => typeof digest === "string")
  ) {
    throw new Error(`local fixture image ${variant} omitted required provenance metadata`);
  }
  const evidence: LocalImageEvidence = {
    id: fields[0],
    os: fields[1],
    architecture: fields[2],
    labels: labels as Record<string, string>,
    version: String((labels as Record<string, unknown>)["org.opencontainers.image.version"] ?? ""),
    exposedPorts: exposedPorts as Record<string, unknown>,
    repoDigests,
  };
  expect(evidence.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(evidence.os).toBe("linux");
  expect(evidence.architecture).toBe("amd64");
  expect(evidence.labels[fixture.variants[variant].provenanceLabel]).toBe(
    fixture.variants[variant].provenanceValue,
  );
  expect(evidence.version).toBe(fixture.variants[variant].version);
  expect(evidence.exposedPorts).toHaveProperty(`${fixture.port}/tcp`);
  expect(evidence.repoDigests).toContain(fixture.variants[variant].image);
  return evidence;
}

function isPrivateIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function revision(
  token: string,
  variant: "A" | "B",
  generation: number,
  fixture: FixtureConfig,
): {
  resourceUid: string;
  incarnationId: string;
  generation: number;
  revision: string;
  image: string;
  port: number;
  healthPath: string;
  memoryBytes: number;
  nanoCpus: number;
  environment: Record<string, string>;
} {
  return {
    resourceUid: `native-container-${token}`,
    incarnationId: `incarnation-${token}`,
    generation,
    revision: `revision-${variant.toLowerCase()}-${token}`,
    image: fixture.variants[variant].image,
    port: fixture.port,
    healthPath: "/",
    memoryBytes: 256 * 1024 * 1024,
    nanoCpus: 500_000_000,
    environment: {},
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  do {
    last = await read();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`native Docker lifecycle state did not settle within ${timeoutMs} ms`);
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel("native lifecycle response exceeded its fixed bound");
        throw new Error("native lifecycle response exceeded 64 KiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

test("network cleanup recovers a malformed create acknowledgement by owned intent", async () => {
  const token = "run-token";
  const id = "a".repeat(64);
  const malformedAckId = networkIdFromCreateAck("malformed-ack");
  const intent: NetworkCleanupIntent = {
    name: "takoserver-native-run-token",
    token,
    createAttempted: true,
    ...(malformedAckId === undefined ? {} : { acknowledgedId: malformedAckId }),
  };
  const removed: string[] = [];
  const recovered: NetworkEvidence = {
    id,
    name: intent.name,
    driver: "bridge",
    scope: "local",
    internal: true,
    labels: { [NETWORK_RUN_LABEL]: token },
  };
  const result = await removeOwnedNetwork(intent, {
    async inspectById() {
      throw new Error("unexpected ID lookup for malformed acknowledgement");
    },
    async inspectByName(name) {
      expect(name).toBe(intent.name);
      return [recovered];
    },
    async removeById(value) {
      removed.push(value);
    },
  });
  expect(result).toBe(true);
  expect(removed).toEqual([id]);
});

test("network cleanup does not delete a same-name replacement after an ID was acknowledged", async () => {
  const token = "run-token";
  const intent: NetworkCleanupIntent = {
    name: "takoserver-native-run-token",
    token,
    createAttempted: true,
    acknowledgedId: "a".repeat(64),
  };
  const removed: string[] = [];
  let inspectedByName = false;
  const result = await removeOwnedNetwork(intent, {
    async inspectById(id) {
      expect(id).toBe("a".repeat(64));
      return null;
    },
    async inspectByName() {
      inspectedByName = true;
      return [
        {
          id: "b".repeat(64),
          name: intent.name,
          driver: "bridge",
          scope: "local",
          internal: true,
          labels: { [NETWORK_RUN_LABEL]: token },
        },
      ];
    },
    async removeById(id) {
      removed.push(id);
    },
  });
  expect(result).toBe(false);
  expect(inspectedByName).toBe(false);
  expect(removed).toEqual([]);
});

test("network cleanup refuses foreign labels and surfaces removal failures", async () => {
  const token = "run-token";
  const intent: NetworkCleanupIntent = {
    name: "takoserver-native-run-token",
    token,
    createAttempted: true,
  };
  const foreign: NetworkEvidence = {
    id: "c".repeat(64),
    name: intent.name,
    driver: "bridge",
    scope: "local",
    internal: true,
    labels: { [NETWORK_RUN_LABEL]: "another-run" },
  };
  const removed: string[] = [];
  const refused = await removeOwnedNetwork(intent, {
    async inspectById() {
      return null;
    },
    async inspectByName() {
      return [foreign];
    },
    async removeById(id) {
      removed.push(id);
    },
  });
  expect(refused).toBe(false);
  expect(removed).toEqual([]);

  const owned = { ...foreign, labels: { [NETWORK_RUN_LABEL]: token } };
  await expect(
    removeOwnedNetwork(
      { ...intent, acknowledgedId: owned.id },
      {
        async inspectById() {
          return owned;
        },
        async inspectByName() {
          throw new Error("must not fall back to name lookup");
        },
        async removeById() {
          throw new Error("simulated cleanup failure");
        },
      },
    ),
  ).rejects.toThrow("simulated cleanup failure");
});

test.skipIf(process.env.TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE !== "1")(
  "self-host container completes a native Docker lifecycle on an isolated local fixture",
  async () => {
    const fixture = fixtureConfig();
    const socketPath = localSocketPath();
    const daemon = docker([
      "info",
      "--format={{.ServerVersion}}|{{.OSType}}|{{.Architecture}}",
    ]).split("|");
    expect(daemon).toHaveLength(3);
    expect(daemon[1]).toBe("linux");
    expect(daemon[2]).toBe("x86_64");
    const imageA = inspectImage("A", fixture);
    const imageB = inspectImage("B", fixture);
    const token = `${Date.now()}-${randomUUID().replaceAll("-", "")}`;
    const network = `takoserver-native-${token}`;
    let root: string | undefined;
    let networkCreateAttempted = false;
    let networkId: string | undefined;
    let runtime: Awaited<ReturnType<typeof createSelfhostContainerRuntime>> | undefined;
    const identity = {
      resourceUid: `native-container-${token}`,
      incarnationId: `incarnation-${token}`,
    };
    const first = revision(token, "A", 1, fixture);
    const second = revision(token, "B", 2, fixture);
    const backend = createDockerHttpRevisionRuntime({
      socketPath,
      installationId: `native-${token}`,
      network,
      maxMemoryBytes: 512 * 1024 * 1024,
      maxNanoCpus: 1_000_000_000,
      pidsLimit: 128,
      timeoutMs: 10_000,
    });
    let lifecycleFailed = false;
    let lifecycleError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      root = await mkdtemp(join(import.meta.dir, ".selfhost-container-native-"));
      await chmod(root, 0o700);
      networkCreateAttempted = true;
      const createAck = docker([
        "network",
        "create",
        "--driver=bridge",
        "--internal",
        `--label=${NETWORK_RUN_LABEL}=${token}`,
        network,
      ]);
      networkId = networkIdFromCreateAck(createAck);
      if (networkId === undefined) throw new Error("owned Docker network ID was malformed");
      const networkInfo = inspectedNetwork(networkId);
      if (
        !isOwnedNetwork(networkInfo, { name: network, token, createAttempted: true }, networkId)
      ) {
        throw new Error("created Docker network did not retain its owned isolated metadata");
      }
      expect(networkInfo.labels).toEqual({ [NETWORK_RUN_LABEL]: token });

      const options = { root, backend, drainTimeoutMs: 100 };
      runtime = await createSelfhostContainerRuntime(options);
      const createdA = await waitFor(
        () => runtime!.reconcile(first),
        (value) => value.state === "ready",
      );
      expect(createdA).toMatchObject({ state: "ready", servingGeneration: 1 });
      const actualA = await backend.observe(first);
      expect(actualA.state).toBe("ready");
      if (actualA.state !== "ready") throw new Error("container A did not become ready");
      expect(actualA.nativeId).toMatch(/^[a-f0-9]{64}$/u);
      const ipA = new URL(actualA.endpoint).hostname;
      expect(isPrivateIpv4(ipA)).toBe(true);

      const nativeA = docker([
        "container",
        "inspect",
        `--format={{.Id}}|{{.Name}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
        actualA.nativeId,
      ]).split("|");
      expect(nativeA[0]).toBe(actualA.nativeId);
      expect(nativeA[1]).toMatch(/^\/takoserver-/u);
      expect(nativeA[2]).toBe(fixture.variants.A.image);
      expect(nativeA[3]).toBe(network);
      expect(JSON.parse(nativeA[4] ?? "null")).toEqual({});
      expect(nativeA[5]).toBe(ipA);

      const homeA = await runtime.fetch(identity, new Request("http://service.invalid/"));
      expect(homeA.status).toBe(200);
      const serverHeaderA = homeA.headers.get("server") ?? "";
      expect(serverHeaderA).toBe(fixture.variants.A.server);
      const bodyA = await boundedBody(homeA);
      expect(bodyA.byteLength).toBeGreaterThan(0);
      const bodyHashA = createHash("sha256").update(bodyA).digest("hex");
      const responseHashA = createHash("sha256")
        .update(
          JSON.stringify({ status: homeA.status, server: serverHeaderA, bodyHash: bodyHashA }),
        )
        .digest("hex");

      const stateFile = (await readdir(root)).find((name) => name.endsWith(".json"));
      expect(stateFile).toBeDefined();
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      if (stateFile) expect((await stat(join(root, stateFile))).mode & 0o777).toBe(0o600);

      const updated = await waitFor(
        () => runtime!.reconcile(second),
        (value) => value.state === "ready",
      );
      expect(updated).toMatchObject({ state: "ready", desiredGeneration: 2, servingGeneration: 2 });
      const actualB = await backend.observe(second);
      expect(actualB.state).toBe("ready");
      if (actualB.state !== "ready") throw new Error("container B did not become ready");
      expect(actualB.nativeId).not.toBe(actualA.nativeId);
      expect(isPrivateIpv4(new URL(actualB.endpoint).hostname)).toBe(true);
      const homeB = await runtime.fetch(identity, new Request("http://service.invalid/"));
      expect(homeB.status).toBe(200);
      const serverHeaderB = homeB.headers.get("server") ?? "";
      expect(serverHeaderB).toBe(fixture.variants.B.server);
      const bodyB = await boundedBody(homeB);
      expect(bodyB.byteLength).toBeGreaterThan(0);
      const bodyHashB = createHash("sha256").update(bodyB).digest("hex");
      const responseHashB = createHash("sha256")
        .update(
          JSON.stringify({ status: homeB.status, server: serverHeaderB, bodyHash: bodyHashB }),
        )
        .digest("hex");
      expect(serverHeaderB).not.toBe(serverHeaderA);
      expect(responseHashB).not.toBe(responseHashA);
      const nativeB = docker([
        "container",
        "inspect",
        `--format={{.Id}}|{{.Name}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
        actualB.nativeId,
      ]).split("|");
      expect(nativeB[0]).toBe(actualB.nativeId);
      expect(nativeB[1]).toMatch(/^\/takoserver-/u);
      expect(nativeB[2]).toBe(fixture.variants.B.image);
      expect(nativeB[3]).toBe(network);
      expect(JSON.parse(nativeB[4] ?? "null")).toEqual({});
      expect(nativeB[5]).toBe(new URL(actualB.endpoint).hostname);
      await waitFor(
        () => backend.observe(first),
        (value) => value.state === "absent",
      );

      // Closing and opening a new runtime handle re-reads the durable snapshot,
      // but remains inside this Bun process; it is not a process-restart drill.
      await runtime.close();
      runtime = await createSelfhostContainerRuntime(options);
      const observedFresh = await runtime.observe(identity);
      expect(observedFresh).toMatchObject({
        state: "ready",
        desiredGeneration: 2,
        servingGeneration: 2,
      });
      const recovered = await runtime.reconcile(second);
      expect(recovered).toMatchObject({
        state: "ready",
        desiredGeneration: 2,
        servingGeneration: 2,
      });
      const recoveredB = await backend.observe(second);
      expect(recoveredB).toMatchObject({ state: "ready", nativeId: actualB.nativeId });
      const recoveredHome = await runtime.fetch(identity, new Request("http://service.invalid/"));
      expect(recoveredHome.headers.get("server")).toBe(fixture.variants.B.server);
      expect(
        createHash("sha256")
          .update(await boundedBody(recoveredHome))
          .digest("hex"),
      ).toBe(bodyHashB);

      const removed = await runtime.remove(identity);
      expect(removed.state).toMatch(/^(deleted|absent)$/u);
      expect(await backend.observe(first)).toEqual({ state: "absent" });
      expect(await backend.observe(second)).toEqual({ state: "absent" });
      await expect(
        runtime.fetch(identity, new Request("http://service.invalid/marker")),
      ).rejects.toThrow();

      console.info(
        JSON.stringify({
          kind: "takoserver.native-container-lifecycle@v1",
          daemon: daemon[0],
          images: {
            A: { id: imageA.id, digest: fixture.variants.A.image.slice(-71) },
            B: { id: imageB.id, digest: fixture.variants.B.image.slice(-71) },
          },
          provenance: {
            A: {
              label: fixture.variants.A.provenanceLabel,
              value: fixture.variants.A.provenanceValue,
            },
            B: {
              label: fixture.variants.B.provenanceLabel,
              value: fixture.variants.B.provenanceValue,
            },
          },
          network: { id: networkId, name: network, driver: "bridge", internal: true },
          containers: {
            A: { id: nativeA[0], name: nativeA[1], privateIp: ipA },
            B: { id: nativeB[0], name: nativeB[1], privateIp: new URL(actualB.endpoint).hostname },
          },
          responses: {
            A: { server: serverHeaderA, body: bodyHashA, fingerprint: responseHashA },
            B: { server: serverHeaderB, body: bodyHashB, fingerprint: responseHashB },
            changed: responseHashA !== responseHashB,
          },
          outcomes: ["create/start/invoke", "update", "fresh-handle-reconcile", "delete/absence"],
          processRestarted: false,
        }),
      );
    } catch (error) {
      lifecycleFailed = true;
      lifecycleError = error;
    } finally {
      if (runtime) {
        await runtime.remove(identity).catch(() => undefined);
        await runtime.close().catch(() => undefined);
      }
      // Only the two revision identities created by this run are addressed.
      await backend.remove(first).catch(() => undefined);
      await backend.remove(second).catch(() => undefined);
      try {
        await removeOwnedNetwork(
          {
            name: network,
            token,
            createAttempted: networkCreateAttempted,
            ...(networkId === undefined ? {} : { acknowledgedId: networkId }),
          },
          liveNetworkCleanupOperations(),
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (root !== undefined) {
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (lifecycleFailed) {
      if (cleanupErrors.length > 0) {
        console.warn(
          JSON.stringify({
            kind: "takoserver.native-container-cleanup-warning@v1",
            count: cleanupErrors.length,
          }),
        );
      }
      throw lifecycleError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "native lifecycle cleanup failed");
    }
  },
);
