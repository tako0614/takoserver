import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  installLocalContainerEndpointCandidateForTest,
  loadVerifiedLocalContainerEndpointCandidate,
  SELFHOST_CONTAINER_ENDPOINT_FORM_REF,
} from "./fixtures/selfhost-container-endpoint-authority.ts";
import {
  installLocalContainerCandidateForTest,
  loadVerifiedLocalContainerCandidate,
} from "./fixtures/selfhost-container-host-authority.ts";
import {
  captureAndIssueManagement,
  createResellerProvision,
  type HostJsonPost,
} from "./fixtures/selfhost-container-host-reseller-requests.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const ENABLED = nativeEvidenceBinary("container-host-lifecycle") ?? null;
const FORM_ARTIFACT = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT;
const FORM_ARTIFACT_SHA256 = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256;
const IMAGE_A = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_A;
const IMAGE_B = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_B;
const DOCKER_SOCKET = process.env.TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET;
const NETWORK = process.env.TAKOSERVER_NATIVE_CONTAINER_NETWORK;
const HOST_ID = "https://container-host-native.test";
const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;
const ENDPOINT_REF = SELFHOST_CONTAINER_ENDPOINT_FORM_REF;
const ENDPOINT_SUFFIX = "container.test";

let root: string | undefined;
let hostProcess: ReturnType<typeof Bun.spawn> | undefined;
let hostBaseUrl: string | undefined;
let cleanupContext:
  | {
      organizationId: string;
      apiKey: { authorization: string };
      createPath: string;
      createBody: unknown;
      createHeaders: Record<string, string>;
      resourcePath: string;
      residualPath: string;
      baselineContainerIds: string[];
      ownedContainerIds: string[];
      resourceUid?: string;
      endpointCreatePath?: string;
      endpointCreateBody?: unknown;
      endpointCreateHeaders?: Record<string, string>;
      endpointResourcePath?: string;
      endpointResourceUid?: string;
    }
  | undefined;
let nativeAbsenceConfirmed = false;

afterEach(async () => {
  let cleanupError: unknown;
  try {
    if (root && cleanupContext && !nativeAbsenceConfirmed) {
      let baseUrl = hostBaseUrl;
      if (!hostProcess) {
        const restarted = await startHost(root);
        baseUrl = restarted.baseUrl;
      }
      if (!baseUrl) throw new Error("cleanup could not establish a Host endpoint");
      const context = cleanupContext;
      if (
        context.endpointCreatePath &&
        context.endpointCreateBody !== undefined &&
        context.endpointCreateHeaders &&
        context.endpointResourcePath
      ) {
        let endpointUid = context.endpointResourceUid;
        if (!endpointUid) {
          const replay = await api(
            baseUrl,
            "PUT",
            context.endpointCreatePath,
            201,
            context.endpointCreateBody,
            context.endpointCreateHeaders,
          );
          endpointUid = String((replay.metadata as { uid?: string } | undefined)?.uid ?? "");
          if (!endpointUid)
            throw new Error("cleanup replay did not recover the exact Endpoint UID");
          context.endpointResourceUid = endpointUid;
        }
        const endpointRead = await fetch(new URL(context.endpointResourcePath, baseUrl), {
          headers: context.apiKey,
        });
        if (endpointRead.status === 200) {
          const endpoint = (await endpointRead.json()) as {
            metadata?: { uid?: string; generation?: string; revision?: string };
          };
          if (
            endpoint.metadata?.uid !== endpointUid ||
            !endpoint.metadata.generation ||
            !endpoint.metadata.revision
          ) {
            throw new Error("cleanup Endpoint identity did not match the exact test UID");
          }
          const deletion = await fetch(new URL(context.endpointResourcePath, baseUrl), {
            method: "DELETE",
            headers: {
              ...context.apiKey,
              "idempotency-key": "native-container-endpoint-cleanup-delete-1",
              "if-match": `"${endpoint.metadata.revision}"`,
              "takoform-expected-generation": endpoint.metadata.generation,
            },
          });
          if (deletion.status !== 204)
            throw new Error("cleanup Endpoint delete was not acknowledged");
          await deletion.arrayBuffer();
        } else if (endpointRead.status !== 404) {
          throw new Error("cleanup Endpoint readback was inconclusive");
        }
      }
      let resourceUid = context.resourceUid;
      let current: Record<string, unknown> | undefined;
      if (!resourceUid) {
        // If the first client/proxy failure happened before Host acceptance,
        // replaying this one test-owned idempotent create may be the first
        // dispatch; it immediately supplies the UID needed for exact cleanup.
        const replay = await api(
          baseUrl,
          "PUT",
          context.createPath,
          201,
          context.createBody,
          context.createHeaders,
        );
        resourceUid = String((replay.metadata as { uid?: string } | undefined)?.uid ?? "");
        if (!resourceUid) throw new Error("cleanup replay did not recover the exact Resource UID");
        context.resourceUid = resourceUid;
        context.residualPath = `/v1/organizations/${context.organizationId}/resources/${encodeURIComponent(
          resourceUid,
        )}/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
      }
      const read = await fetch(new URL(context.resourcePath, baseUrl), {
        headers: context.apiKey,
      });
      if (read.status === 200) current = (await read.json()) as Record<string, unknown>;
      else if (read.status !== 404) throw new Error("cleanup Resource readback was inconclusive");
      if (current) {
        const metadata = current.metadata as
          | { uid?: string; generation?: string; revision?: string }
          | undefined;
        if (metadata?.uid !== resourceUid || !metadata.generation || !metadata.revision) {
          throw new Error("cleanup Resource identity did not match the exact test UID");
        }
        const deletion = await fetch(new URL(context.resourcePath, baseUrl), {
          method: "DELETE",
          headers: {
            ...context.apiKey,
            "idempotency-key": "native-container-cleanup-delete-1",
            "if-match": `"${metadata.revision}"`,
            "takoform-expected-generation": metadata.generation,
          },
        });
        if (deletion.status !== 204) throw new Error("cleanup Host delete was not acknowledged");
        await deletion.arrayBuffer();
      }
      const residualResponse = await fetch(new URL(context.residualPath, baseUrl), {
        headers: context.apiKey,
      });
      if (residualResponse.status !== 200) {
        throw new Error("cleanup native residual readback was unavailable");
      }
      const residual = (await residualResponse.json()) as {
        residual?: { status?: string; source?: string };
      };
      if (residual.residual?.status !== "absent" || residual.residual.source !== "provider") {
        throw new Error("cleanup could not confirm exact native absence");
      }
      const baselineIds = new Set(context.baselineContainerIds);
      const afterCleanup = await listNetworkContainers(DOCKER_SOCKET as string, NETWORK as string);
      const remainingTestContainers = afterCleanup.filter(
        (container) => typeof container.Id === "string" && !baselineIds.has(container.Id),
      );
      if (remainingTestContainers.length > 0) {
        throw new Error("cleanup readback found native objects beyond the baseline inventory");
      }
      for (const containerId of context.ownedContainerIds) {
        const native = await dockerGet(
          DOCKER_SOCKET as string,
          `/containers/${encodeURIComponent(containerId)}/json`,
        );
        if (native.status !== 404) {
          throw new Error("cleanup did not prove absence for an exact test-owned Docker ID");
        }
      }
      nativeAbsenceConfirmed = true;
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    if (hostProcess) {
      hostProcess.kill("SIGKILL");
      await hostProcess.exited;
      hostProcess = undefined;
      hostBaseUrl = undefined;
    }
  }
  if (cleanupError) {
    throw new Error(
      `native cleanup could not confirm exact absence; preserving state at ${root ?? "unknown"}`,
      { cause: cleanupError },
    );
  }
  if (root && (!cleanupContext || nativeAbsenceConfirmed)) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
  cleanupContext = undefined;
  nativeAbsenceConfirmed = false;
});

function dockerGet(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "GET", path }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let body: unknown;
        try {
          body = bytes.byteLength === 0 ? null : JSON.parse(bytes.toString("utf8"));
        } catch {
          reject(new Error("Docker API returned malformed JSON"));
          return;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function assertOwnedInternalNetwork(
  socketPath: string,
  name: string,
): Promise<{ readonly id: string; readonly runLabel: string }> {
  const response = await dockerGet(socketPath, `/networks/${encodeURIComponent(name)}`);
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error("configured Docker network is unavailable");
  }
  const network = response.body as Record<string, unknown>;
  const labels = network.Labels as Record<string, unknown> | undefined;
  const id = network.Id;
  const runLabel = labels?.["takoserver.native-container-host-run"];
  expect(typeof id).toBe("string");
  expect(id).toMatch(/^[a-f0-9]{64}$/u);
  expect(typeof runLabel).toBe("string");
  expect(runLabel).toMatch(/^[a-z0-9-]{1,96}$/u);
  expect({
    name: network.Name,
    driver: network.Driver,
    scope: network.Scope,
    internal: network.Internal,
    ingress: network.Ingress,
    attachable: network.Attachable,
    installation: labels?.["takoserver.installation"],
  }).toEqual({
    name,
    driver: "bridge",
    scope: "local",
    internal: true,
    ingress: false,
    attachable: false,
    installation: "local.primary",
  });
  return { id: id as string, runLabel: runLabel as string };
}

async function assertCachedImmutableImage(socketPath: string, image: string): Promise<void> {
  if (!/^(?:docker\.io\/)?nginxinc\/nginx-unprivileged@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error("native fixture images must be exact Docker Hub nginx-unprivileged digests");
  }
  const response = await dockerGet(socketPath, `/images/${encodeURIComponent(image)}/json`);
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error("configured immutable image is not already present in the local daemon");
  }
  const imageInfo = response.body as Record<string, unknown>;
  const repoDigests = imageInfo.RepoDigests;
  if (!Array.isArray(repoDigests) || !repoDigests.includes(image)) {
    throw new Error("local image inspect did not confirm the configured canonical RepoDigest");
  }
  const config = imageInfo.Config as Record<string, unknown> | undefined;
  const exposed = config?.ExposedPorts as Record<string, unknown> | undefined;
  expect(exposed?.["8080/tcp"]).toBeDefined();
  // Deliberately do not inspect or print the image's environment metadata.
  // This cache precheck is not evidence of zero registry contact: the real
  // runtime still calls Docker's /images/create endpoint for the exact digest.
}

interface DockerContainerSummary {
  readonly Id?: unknown;
  readonly Names?: unknown;
  readonly Image?: unknown;
  readonly Labels?: unknown;
}

function idOf(container: DockerContainerSummary): string {
  if (typeof container.Id !== "string") throw new Error("Docker inventory omitted an ID");
  return container.Id;
}

function newNetworkContainers(
  containers: readonly DockerContainerSummary[],
  baselineIds: ReadonlySet<string>,
): DockerContainerSummary[] {
  return containers.filter((container) => !baselineIds.has(idOf(container)));
}

function assertContainerSummary(container: DockerContainerSummary, expectedImage: string): void {
  const name = Array.isArray(container.Names)
    ? container.Names.find((value): value is string => typeof value === "string")
    : undefined;
  const labels = container.Labels as Record<string, unknown> | undefined;
  expect(typeof name).toBe("string");
  expect(name?.startsWith("/takoserver-")).toBe(true);
  expect(container.Image).toBe(expectedImage);
  expect(Object.keys(labels ?? {}).sort()).toEqual(["takoserver.identity", "takoserver.revision"]);
  expect(labels?.["takoserver.identity"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(labels?.["takoserver.revision"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
}

async function listNetworkContainers(
  socketPath: string,
  networkName: string,
): Promise<DockerContainerSummary[]> {
  const filters = encodeURIComponent(JSON.stringify({ network: [networkName] }));
  const response = await dockerGet(socketPath, `/containers/json?all=1&filters=${filters}`);
  if (response.status !== 200 || !Array.isArray(response.body)) {
    throw new Error("owned internal-network container readback was unavailable");
  }
  return response.body.filter((value): value is DockerContainerSummary => {
    if (typeof value !== "object" || value === null) return false;
    const container = value as DockerContainerSummary;
    return typeof container.Id === "string";
  });
}

async function assertPrivateReadyContainer(
  socketPath: string,
  containerId: string,
  image: string,
  networkName: string,
): Promise<{ readonly id: string; readonly name: string; readonly ip: string }> {
  const response = await dockerGet(
    socketPath,
    `/containers/${encodeURIComponent(containerId)}/json`,
  );
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error("exact Container identity inspection was unavailable");
  }
  const inspected = response.body as Record<string, unknown>;
  const config = inspected.Config as Record<string, unknown> | undefined;
  const labels = config?.Labels as Record<string, unknown> | undefined;
  const exposed = config?.ExposedPorts as Record<string, unknown> | undefined;
  const host = inspected.HostConfig as Record<string, unknown> | undefined;
  const networks = (inspected.NetworkSettings as Record<string, unknown> | undefined)?.Networks as
    | Record<string, unknown>
    | undefined;
  const attached = networks?.[networkName] as Record<string, unknown> | undefined;
  const bindings = host?.PortBindings;
  const portBindingsEmpty =
    bindings === undefined ||
    bindings === null ||
    (typeof bindings === "object" && Object.keys(bindings).length === 0);
  const name = inspected.Name;
  const ip = attached?.IPAddress;
  const ipParts = typeof ip === "string" ? ip.split(".").map(Number) : [];
  const validIpv4 =
    ipParts.length === 4 &&
    ipParts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const firstOctet = ipParts[0];
  const secondOctet = ipParts[1];
  const privateIpv4 =
    validIpv4 &&
    firstOctet !== undefined &&
    secondOctet !== undefined &&
    (firstOctet === 10 ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      (firstOctet === 192 && secondOctet === 168));
  expect(typeof inspected.Id).toBe("string");
  expect(inspected.Id).toBe(containerId);
  expect(typeof name).toBe("string");
  expect((name as string).startsWith("/takoserver-")).toBe(true);
  expect(typeof ip).toBe("string");
  expect((inspected.State as Record<string, unknown> | undefined)?.Running).toBe(true);
  expect(config?.Image).toBe(image);
  expect(exposed?.["8080/tcp"]).toBeDefined();
  expect(labels?.["takoserver.identity"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(labels?.["takoserver.revision"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(host?.NetworkMode).toBe(networkName);
  expect(host?.Memory).toBe(256 * 1024 * 1024);
  expect(host?.MemorySwap).toBe(256 * 1024 * 1024);
  expect(host?.NanoCpus).toBe(500_000_000);
  expect(host?.PidsLimit).toBe(128);
  expect(host?.Privileged).toBe(false);
  expect(host?.PublishAllPorts).toBe(false);
  expect(host?.CapDrop).toEqual(["ALL"]);
  expect(
    Array.isArray(host?.SecurityOpt) && host.SecurityOpt.includes("no-new-privileges:true"),
  ).toBe(true);
  expect(portBindingsEmpty).toBe(true);
  expect(Object.keys(networks ?? {})).toEqual([networkName]);
  expect(privateIpv4).toBe(true);
  return { id: String(inspected.Id), name: name as string, ip: ip as string };
}

async function createEndpointTlsCertificate(rootPath: string): Promise<string> {
  const directory = join(rootPath, "endpoint-tls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const certificatePath = join(directory, "certificate.pem");
  const privateKeyPath = join(directory, "private-key.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-days",
      "2",
      "-subj",
      "/CN=container.test",
      "-addext",
      "subjectAltName=DNS:*.container.test",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
      "-addext",
      "extendedKeyUsage=serverAuth",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await child.exited) !== 0) throw new Error("local Endpoint TLS fixture generation failed");
  chmodSync(certificatePath, 0o600);
  chmodSync(privateKeyPath, 0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(certificatePath).mode & 0o777).toBe(0o600);
  expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);
  return readFileSync(certificatePath, "utf8");
}

function requestEndpointHttps(
  endpointUrl: string,
  certificateAuthority: string,
  suffix = "",
): Promise<{ readonly status: number; readonly body: string; readonly server: string | null }> {
  const endpoint = new URL(endpointUrl);
  if (suffix) endpoint.searchParams.set("probe", suffix);
  const path = `${endpoint.pathname}${endpoint.search}`;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: endpoint.hostname,
        ca: certificateAuthority,
        rejectUnauthorized: true,
        method: "GET",
        path,
        headers: { host: endpoint.host },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const server = response.headers.server;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            server: typeof server === "string" ? server : null,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function startHost(
  rootPath: string,
): Promise<{ baseUrl: string; process: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "tests/fixtures/selfhost-container-host-native/endpoint-server.ts",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        TAKOSERVER_NATIVE_CONTAINER_TEST_ROOT: rootPath,
        TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT: FORM_ARTIFACT as string,
        TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET: DOCKER_SOCKET as string,
        TAKOSERVER_NATIVE_CONTAINER_NETWORK: NETWORK as string,
      },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  hostProcess = child;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error("fresh Host process exited before binding loopback HTTP");
        buffered += decoder.decode(next.value, { stream: true });
        const newline = buffered.indexOf("\n");
        if (newline < 0) continue;
        const line = buffered.slice(0, newline);
        if (!/^READY [0-9]{1,5}$/u.test(line)) {
          throw new Error("fresh Host process emitted an invalid readiness record");
        }
        const port = Number(line.slice("READY ".length));
        return `http://127.0.0.1:${port}`;
      }
    })();
    const baseUrl = await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("fresh Host process startup timed out")),
          15_000,
        );
      }),
    ]);
    hostBaseUrl = baseUrl;
    return { baseUrl, process: child };
  } catch {
    child.kill("SIGKILL");
    await child.exited;
    if (hostProcess === child) hostProcess = undefined;
    throw new Error("fresh Host process did not become ready within the bounded startup window");
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function stopHost(processHandle: ReturnType<typeof Bun.spawn>): Promise<void> {
  processHandle.kill("SIGKILL");
  const exitCode = await processHandle.exited;
  if (hostProcess === processHandle) {
    hostProcess = undefined;
    hostBaseUrl = undefined;
  }
  if (!Number.isInteger(exitCode)) throw new Error("Host process termination was not confirmed");
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    let code = "unavailable";
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string } };
      if (typeof parsed.error?.code === "string") code = parsed.error.code;
    } catch {
      // Keep failure output value-free and bounded.
    }
    throw new Error(
      `Host API returned unexpected HTTP status (${expectedStatus}/${response.status}, ${code})`,
    );
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function postHost(baseUrl: string): HostJsonPost {
  return (path, expectedStatus, body, headers) =>
    api(baseUrl, "POST", path, expectedStatus, body, headers);
}

const BACKEND_UNAVAILABLE_RETRY_WINDOW_MS = 30_000;
const BACKEND_UNAVAILABLE_MAX_ATTEMPTS = 8;
const ACKNOWLEDGEMENT_BODY_CAPTURE_LIMIT_BYTES = 16 * 1024;

async function isRetryableBackendUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 503 || response.body === null) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = 4096 - responseBytes;
      if (next.value.byteLength > remaining) {
        await reader.cancel();
        return false;
      }
      chunks.push(next.value);
      responseBytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      error?: { code?: unknown };
    };
    return parsed.error?.code === "backend_unavailable";
  } catch {
    return false;
  }
}

function retryAfterMs(value: string | null, attempt: number): number {
  const header = value?.trim();
  if (header && /^[0-9]{1,6}$/u.test(header)) return Number(header) * 1000;
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const upperBound = Math.min(4000, 250 * 2 ** attempt);
  return Math.floor(Math.random() * upperBound);
}

async function waitForBackendRetry(delayMs: number, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || delayMs >= remaining) {
    throw new Error("Host retry deadline elapsed");
  }
  if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function apiWithBackendUnavailableRetry(
  baseUrl: string,
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const deadline = Date.now() + BACKEND_UNAVAILABLE_RETRY_WINDOW_MS;
  for (let attempt = 0; attempt < BACKEND_UNAVAILABLE_MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Host retry deadline elapsed");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...headers,
          ...(bodyText === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(bodyText === undefined ? {} : { body: bodyText }),
        signal: controller.signal,
      });
      if (response.status === expectedStatus) {
        const text = await response.text();
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      const retryAfter = response.headers.get("retry-after");
      const retryable = await isRetryableBackendUnavailable(response);
      if (retryable) {
        await waitForBackendRetry(retryAfterMs(retryAfter, attempt), deadline);
        continue;
      }
      await response.body?.cancel();
      throw new Error(
        `Host API returned unexpected HTTP status (${expectedStatus}/${response.status})`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Host retry attempt limit reached");
}

async function proxySingleAttemptWithAckDrop(
  target: URL,
  method: string,
  expectedStatus: number,
  bodyText: string | undefined,
  headers: Record<string, string>,
  deadline: number,
  captureAcknowledgementBody: boolean,
): Promise<{
  readonly status: number;
  readonly retryAfter: string | null;
  readonly acknowledgementBody?: string;
  readonly acknowledgementBodyExceededLimit?: boolean;
}> {
  let resolveHostStatus: (result: {
    readonly status: number;
    readonly acknowledgementBody?: string;
    readonly acknowledgementBodyExceededLimit?: boolean;
  }) => void = () => undefined;
  let rejectHostStatus: (error: Error) => void = () => undefined;
  const hostStatus = new Promise<{
    readonly status: number;
    readonly acknowledgementBody?: string;
    readonly acknowledgementBodyExceededLimit?: boolean;
  }>((resolve, reject) => {
    resolveHostStatus = resolve;
    rejectHostStatus = reject;
  });
  const proxy = createServer((clientRequest, clientResponse) => {
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: clientRequest.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...clientRequest.headers, host: target.host },
      },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 0;
        const capturedChunks: Uint8Array[] = [];
        let capturedBytes = 0;
        let acknowledgementBodyExceededLimit = false;
        if (status !== expectedStatus) {
          const responseHeaders: Record<string, string> = {};
          const contentType = upstreamResponse.headers["content-type"];
          const retryAfter = upstreamResponse.headers["retry-after"];
          if (typeof contentType === "string") responseHeaders["content-type"] = contentType;
          if (typeof retryAfter === "string") responseHeaders["retry-after"] = retryAfter;
          clientResponse.writeHead(status, responseHeaders);
        }
        upstreamResponse.on("data", (chunk: Uint8Array) => {
          if (status !== expectedStatus) clientResponse.write(chunk);
          else if (captureAcknowledgementBody && !acknowledgementBodyExceededLimit) {
            if (capturedBytes + chunk.byteLength > ACKNOWLEDGEMENT_BODY_CAPTURE_LIMIT_BYTES) {
              capturedChunks.length = 0;
              acknowledgementBodyExceededLimit = true;
            } else {
              capturedChunks.push(chunk);
              capturedBytes += chunk.byteLength;
            }
          }
        });
        upstreamResponse.on("error", () => {
          rejectHostStatus(new Error("Host response stream failed before completion"));
          clientResponse.destroy();
        });
        upstreamResponse.on("end", () => {
          resolveHostStatus({
            status,
            ...(captureAcknowledgementBody && status === expectedStatus
              ? acknowledgementBodyExceededLimit
                ? { acknowledgementBodyExceededLimit: true }
                : { acknowledgementBody: Buffer.concat(capturedChunks).toString("utf8") }
              : {}),
          });
          if (status === expectedStatus) {
            // Do not expose a successful 201/204 to the caller. The separate
            // process-restart assertion replays this exact request later.
            clientResponse.socket?.destroy();
            clientResponse.destroy();
          } else {
            clientResponse.end();
          }
        });
      },
    );
    upstream.on("error", () => {
      rejectHostStatus(new Error("Host upstream connection failed"));
      clientResponse.destroy();
    });
    clientRequest.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("loopback fault proxy did not bind");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("loopback ACK-drop request deadline elapsed");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("loopback ACK-drop request deadline elapsed"));
    }, remaining);
  });
  try {
    const clientResponse = fetch(
      `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
      {
        method,
        headers: {
          ...headers,
          ...(bodyText === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(bodyText === undefined ? {} : { body: bodyText }),
        signal: controller.signal,
      },
    ).catch(() => null);
    const [hostResult, response] = await Promise.race([
      Promise.all([hostStatus, clientResponse]),
      timeoutPromise,
    ]);
    const actualStatus = hostResult.status;
    if (actualStatus === expectedStatus) {
      if (response !== null) {
        await response.body?.cancel();
        throw new Error(
          `fault proxy forwarded a successful Host acknowledgement (client status ${response.status})`,
        );
      }
      return {
        status: actualStatus,
        retryAfter: null,
        ...(hostResult.acknowledgementBody === undefined
          ? {}
          : { acknowledgementBody: hostResult.acknowledgementBody }),
        ...(hostResult.acknowledgementBodyExceededLimit
          ? { acknowledgementBodyExceededLimit: true }
          : {}),
      };
    }
    if (response === null || response.status !== actualStatus) {
      throw new Error(`Host operation returned unexpected status ${actualStatus}`);
    }
    const retryAfter = response.headers.get("retry-after");
    const retryable = await Promise.race([isRetryableBackendUnavailable(response), timeoutPromise]);
    if (!retryable) {
      throw new Error(`Host operation returned unexpected status ${actualStatus}`);
    }
    return { status: actualStatus, retryAfter };
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

async function dropAcknowledgementAtLoopbackProxy(
  baseUrl: string,
  method: string,
  path: string,
  expectedStatus: number,
  body: unknown,
  headers: Record<string, string>,
  captureAcknowledgementBody = false,
): Promise<Record<string, unknown> | undefined> {
  if (captureAcknowledgementBody && expectedStatus !== 201) {
    throw new Error("bounded acknowledgement capture is only available for a 201 create");
  }
  const target = new URL(path, baseUrl);
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const deadline = Date.now() + BACKEND_UNAVAILABLE_RETRY_WINDOW_MS;
  for (let attempt = 0; attempt < BACKEND_UNAVAILABLE_MAX_ATTEMPTS; attempt += 1) {
    const result = await proxySingleAttemptWithAckDrop(
      target,
      method,
      expectedStatus,
      bodyText,
      headers,
      deadline,
      captureAcknowledgementBody,
    );
    if (result.status === expectedStatus) {
      if (!captureAcknowledgementBody) return undefined;
      if (result.acknowledgementBodyExceededLimit || result.acknowledgementBody === undefined) {
        throw new Error("Host create acknowledgement exceeded its bounded capture");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.acknowledgementBody);
      } catch {
        throw new Error("Host create acknowledgement body was malformed");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Host create acknowledgement body was malformed");
      }
      return parsed as Record<string, unknown>;
    }
    if (result.status !== 503) {
      throw new Error(`Host operation returned unexpected status ${result.status}`);
    }
    await waitForBackendRetry(retryAfterMs(result.retryAfter, attempt), deadline);
  }
  throw new Error("Host retry attempt limit reached");
}

test("backend-unavailable retry reuses the exact request before dropping success ACK", async () => {
  const observed: Array<{
    readonly body: string;
    readonly authorization: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly ifNoneMatch: string | undefined;
  }> = [];
  const upstream = createServer((request, response) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      observed.push({
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
        idempotencyKey: Array.isArray(request.headers["idempotency-key"])
          ? request.headers["idempotency-key"].join(",")
          : request.headers["idempotency-key"],
        ifNoneMatch: Array.isArray(request.headers["if-none-match"])
          ? request.headers["if-none-match"].join(",")
          : request.headers["if-none-match"],
      });
      if (observed.length === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ error: { code: "backend_unavailable" } }));
      } else {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("retry test server did not bind");
  const requestBody = { apiVersion: "forms.test/v1", metadata: { name: "stable" } };
  const requestHeaders = {
    authorization: "Bearer synthetic-native-retry-principal",
    "idempotency-key": "native-retry-same-key",
    "if-none-match": "*",
  };
  let capturedAcknowledgement: Record<string, unknown> | undefined;
  try {
    capturedAcknowledgement = await dropAcknowledgementAtLoopbackProxy(
      `http://127.0.0.1:${address.port}`,
      "PUT",
      "/resources/stable",
      201,
      requestBody,
      requestHeaders,
      true,
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  expect(observed).toHaveLength(2);
  expect(observed[0]).toEqual(observed[1]);
  expect(observed[0]).toMatchObject({
    body: JSON.stringify(requestBody),
    authorization: requestHeaders.authorization,
    idempotencyKey: requestHeaders["idempotency-key"],
    ifNoneMatch: "*",
  });
  expect(capturedAcknowledgement).toEqual({ accepted: true });
});

test.skipIf(
  ENABLED === null ||
    FORM_ARTIFACT === undefined ||
    FORM_ARTIFACT_SHA256 === undefined ||
    IMAGE_A === undefined ||
    IMAGE_B === undefined ||
    DOCKER_SOCKET === undefined ||
    NETWORK === undefined,
)(
  "public Host Service and Endpoint CRUD survive OS restarts, HTTPS routing, and exact lost-ack replay",
  async () => {
    if (
      !FORM_ARTIFACT ||
      FORM_ARTIFACT_SHA256 !== "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2" ||
      !IMAGE_A ||
      !IMAGE_B ||
      !DOCKER_SOCKET ||
      !NETWORK
    ) {
      throw new Error("native Container Host inputs failed bounded configuration validation");
    }
    const imageA = IMAGE_A;
    const imageB = IMAGE_B;
    const socketPath = DOCKER_SOCKET;
    const networkName = NETWORK;
    const localCandidate = await loadVerifiedLocalContainerCandidate(FORM_ARTIFACT);
    expect(localCandidate.form.identity.formRef).toEqual(FORM_REF);
    const endpointCandidate = await loadVerifiedLocalContainerEndpointCandidate(
      join(import.meta.dir, "fixtures/selfhost-container-endpoint-candidate.json"),
    );
    expect(endpointCandidate.form.identity.formRef).toEqual(ENDPOINT_REF);
    expect(FORM_ARTIFACT_SHA256).toBe(
      "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2",
    );
    const ownedNetwork = await assertOwnedInternalNetwork(socketPath, networkName);
    await assertCachedImmutableImage(socketPath, imageA);
    await assertCachedImmutableImage(socketPath, imageB);
    const baselineContainers = await listNetworkContainers(socketPath, networkName);
    const baselineContainerIds = new Set(baselineContainers.map(idOf));

    root = mkdtempSync(join(tmpdir(), "c-host-"));
    const endpointCertificateAuthority = await createEndpointTlsCertificate(root);
    const database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    const objects = createFileObjectStore({ root: join(root, "objects") });
    await installLocalContainerCandidateForTest({
      sql: createSqliteSql(database),
      objects,
      hostId: HOST_ID,
      candidate: localCandidate,
    });
    await installLocalContainerEndpointCandidateForTest({
      sql: createSqliteSql(database),
      objects,
      hostId: HOST_ID,
      candidate: endpointCandidate,
    });
    database.close();

    const firstHost = await startHost(root);
    const firstPid = firstHost.process.pid;
    const session = await api(firstHost.baseUrl, "POST", "/v1/sessions", 200, {
      provider: "google",
      assertion: "synthetic-local-native-identity",
    });
    const owner = {
      authorization: `Bearer ${String((session as { sessionToken: string }).sessionToken)}`,
    };
    const organizationResponse = await api(
      firstHost.baseUrl,
      "POST",
      "/v1/organizations",
      201,
      {
        name: "Native Container lifecycle",
      },
      owner,
    );
    const organizationId = String(
      (organizationResponse as { organization: { id: string } }).organization.id,
    );
    const keyResponse = await api(
      firstHost.baseUrl,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      201,
      {
        name: "native-container-lifecycle",
        scopes: [
          "reseller:write",
          "catalog:read",
          "wallet:read",
          "resources:read",
          "resources:write",
        ],
        expiresInSeconds: 3600,
      },
      owner,
    );
    const apiKey = {
      authorization: `Bearer ${String((keyResponse as { secret: string }).secret)}`,
    };
    const catalog = await api(
      firstHost.baseUrl,
      "GET",
      `/v1/catalog?organizationId=${organizationId}`,
      200,
      undefined,
      apiKey,
    );
    expect(
      (catalog as { offerings: { id: string; form: { kind: string } }[] }).offerings.some(
        (offering) =>
          offering.id === "selfhost.container.http.standard" &&
          offering.form.kind === FORM_REF.kind,
      ),
    ).toBe(true);
    expect(
      (catalog as { offerings: { id: string; form: { kind: string } }[] }).offerings.some(
        (offering) =>
          offering.id === "selfhost.container.http.endpoint" &&
          offering.form.kind === ENDPOINT_REF.kind,
      ),
    ).toBe(true);
    const provision = await createResellerProvision(postHost(firstHost.baseUrl), {
      tenantRef: "tenant_container_native",
      offeringId: "selfhost.container.http.standard",
      resourceName: "service",
      quantity: 1,
      tokenExpiresInSeconds: 900,
      apiKey,
    });
    const { reservationId } = provision;
    const provisionToken = provision.provisionAuthorization;
    const desired = {
      apiVersion: FORM_REF.apiVersion,
      kind: FORM_REF.kind,
      form: { formRef: FORM_REF },
      metadata: { space: "tenant_container_native", name: "service" },
      spec: {
        environment: { "APP.MODE": "native-process-restart" },
        healthPath: "/",
        httpPort: 8080,
        image: imageA,
        outboundInternet: false,
        requiredSensitiveVars: [],
        workloadRevision: "native-revision-1",
      },
    };
    const prepared = await api(
      firstHost.baseUrl,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      desired,
      provisionToken,
    );
    const createBody = {
      ...desired,
      review: {
        prepareDigest: String(
          (prepared as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const createPath = `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`;
    const resourcePath = `${createPath}?${new URLSearchParams({
      space: "tenant_container_native",
      definitionVersion: FORM_REF.definitionVersion,
      schemaDigest: FORM_REF.schemaDigest,
    })}`;
    let residualPath = `/v1/organizations/${organizationId}/resources/unknown/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
    const createHeaders = {
      ...provisionToken,
      "idempotency-key": "native-container-create-1",
      "if-none-match": "*",
    };
    cleanupContext = {
      organizationId,
      apiKey,
      createPath,
      createBody,
      createHeaders,
      resourcePath,
      residualPath,
      baselineContainerIds: [...baselineContainerIds],
      ownedContainerIds: [],
    };
    await dropAcknowledgementAtLoopbackProxy(
      firstHost.baseUrl,
      "PUT",
      createPath,
      201,
      createBody,
      createHeaders,
    );
    const afterCreateContainers = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterCreateContainers).toHaveLength(1);
    assertContainerSummary(afterCreateContainers[0] as DockerContainerSummary, imageA);
    const createdPrivateNative = await assertPrivateReadyContainer(
      socketPath,
      idOf(afterCreateContainers[0] as DockerContainerSummary),
      imageA,
      networkName,
    );
    cleanupContext.ownedContainerIds.push(createdPrivateNative.id);
    await stopHost(firstHost.process);

    const secondHost = await startHost(root);
    expect(secondHost.process.pid).not.toBe(firstPid);
    expect(await assertOwnedInternalNetwork(socketPath, networkName)).toEqual(ownedNetwork);
    const replayedCreate = await apiWithBackendUnavailableRetry(
      secondHost.baseUrl,
      "PUT",
      createPath,
      201,
      createBody,
      createHeaders,
    );
    const created = replayedCreate as {
      metadata: { uid: string; generation: string; revision: string };
    };
    cleanupContext.resourceUid = created.metadata.uid;
    cleanupContext.residualPath = `/v1/organizations/${organizationId}/resources/${encodeURIComponent(
      created.metadata.uid,
    )}/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
    const afterCreateReplay = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterCreateReplay.map(idOf)).toEqual([createdPrivateNative.id]);
    assertContainerSummary(afterCreateReplay[0] as DockerContainerSummary, imageA);
    const replayedPrivateNative = await assertPrivateReadyContainer(
      socketPath,
      idOf(afterCreateReplay[0] as DockerContainerSummary),
      imageA,
      networkName,
    );
    expect(replayedPrivateNative).toEqual(createdPrivateNative);
    expect(created.metadata.generation).toBe("1");
    const management = await captureAndIssueManagement(postHost(secondHost.baseUrl), {
      reservationId,
      tenantRef: "tenant_container_native",
      resourceName: "service",
      resourceUid: created.metadata.uid,
      captureQuantity: 1,
      tokenExpiresInSeconds: 900,
      apiKey,
    });
    expect(management.captureStatement).toMatchObject({
      reservationId,
      tenantRef: "tenant_container_native",
      usage: { quantity: 1 },
    });
    const manager = management.managementAuthorization;
    const readAfterRestart = await api(
      secondHost.baseUrl,
      "GET",
      resourcePath,
      200,
      undefined,
      manager,
    );
    expect(readAfterRestart).toMatchObject({
      metadata: { uid: created.metadata.uid, generation: "1" },
    });

    const endpointDesired = {
      apiVersion: ENDPOINT_REF.apiVersion,
      kind: ENDPOINT_REF.kind,
      form: { formRef: ENDPOINT_REF },
      metadata: { space: "tenant_container_native", name: "web" },
      spec: {
        service: {
          apiVersion: FORM_REF.apiVersion,
          kind: FORM_REF.kind,
          name: "service",
        },
      },
    };
    const endpointPrepared = await api(
      secondHost.baseUrl,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      endpointDesired,
      apiKey,
    );
    const endpointCreatePath = `/apis/forms.takoform.com/v1/resources/${ENDPOINT_REF.apiVersion}/${ENDPOINT_REF.kind}/web`;
    const endpointCreateBody = {
      ...endpointDesired,
      review: {
        prepareDigest: String(
          (endpointPrepared as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const endpointCreateHeaders = {
      ...apiKey,
      "idempotency-key": "native-container-endpoint-create-1",
      "if-none-match": "*",
    };
    const endpointResourcePath = `${endpointCreatePath}?${new URLSearchParams({
      space: "tenant_container_native",
      definitionVersion: ENDPOINT_REF.definitionVersion,
      schemaDigest: ENDPOINT_REF.schemaDigest,
    })}`;
    cleanupContext.endpointCreatePath = endpointCreatePath;
    cleanupContext.endpointCreateBody = endpointCreateBody;
    cleanupContext.endpointCreateHeaders = endpointCreateHeaders;
    cleanupContext.endpointResourcePath = endpointResourcePath;
    const originalEndpointCreateAcknowledgement = await dropAcknowledgementAtLoopbackProxy(
      secondHost.baseUrl,
      "PUT",
      endpointCreatePath,
      201,
      endpointCreateBody,
      endpointCreateHeaders,
      true,
    );
    if (!originalEndpointCreateAcknowledgement) {
      throw new Error("Endpoint create acknowledgement capture was unavailable");
    }
    const originalEndpointMetadata = (
      originalEndpointCreateAcknowledgement as {
        metadata: { uid: string; generation: string };
        status: { outputs: { url: string } };
      }
    ).metadata;
    const originalEndpointUrl = String(
      (
        originalEndpointCreateAcknowledgement as {
          status: { outputs: { url: string } };
        }
      ).status.outputs.url,
    );
    cleanupContext.endpointResourceUid = originalEndpointMetadata.uid;
    expect(originalEndpointMetadata.uid).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
    expect(originalEndpointUrl).toMatch(/^https:\/\/ce-[0-9a-f]{40}\.container\.test\/$/u);
    const afterEndpointCreateAckLoss = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterEndpointCreateAckLoss.map(idOf)).toEqual([createdPrivateNative.id]);
    assertContainerSummary(afterEndpointCreateAckLoss[0] as DockerContainerSummary, imageA);

    await stopHost(secondHost.process);
    const thirdHost = await startHost(root);
    expect(thirdHost.process.pid).not.toBe(secondHost.process.pid);
    expect(await assertOwnedInternalNetwork(socketPath, networkName)).toEqual(ownedNetwork);
    const endpointCreated = await apiWithBackendUnavailableRetry(
      thirdHost.baseUrl,
      "PUT",
      endpointCreatePath,
      201,
      endpointCreateBody,
      endpointCreateHeaders,
    );
    const endpointMetadata = (
      endpointCreated as { metadata: { uid: string; generation: string; revision: string } }
    ).metadata;
    cleanupContext.endpointResourceUid = endpointMetadata.uid;
    expect(endpointMetadata.uid).toBe(originalEndpointMetadata.uid);
    expect(endpointMetadata.generation).toBe("1");
    const endpointUrl = String(
      (endpointCreated as { status: { outputs: { url: string } } }).status.outputs.url,
    );
    expect(endpointUrl).toBe(originalEndpointUrl);
    const endpointHostname = new URL(endpointUrl).hostname;
    expect(endpointHostname).toMatch(/^ce-[0-9a-f]{40}\.container\.test$/u);
    expect(endpointHostname.endsWith(`.${ENDPOINT_SUFFIX}`)).toBe(true);
    expect(
      await api(thirdHost.baseUrl, "GET", endpointResourcePath, 200, undefined, apiKey),
    ).toMatchObject({ metadata: { uid: endpointMetadata.uid, generation: "1" } });
    const firstEndpointResponse = await requestEndpointHttps(
      endpointUrl,
      endpointCertificateAuthority,
      "first-process",
    );
    expect(firstEndpointResponse.status).toBe(200);
    expect(firstEndpointResponse.server).toMatch(/^nginx\//u);
    const unassignedHostnameUrl = `https://ce-${"0".repeat(40)}.${ENDPOINT_SUFFIX}/`;
    expect(
      (
        await requestEndpointHttps(
          unassignedHostnameUrl,
          endpointCertificateAuthority,
          "unassigned-hostname",
        )
      ).status,
    ).toBe(404);
    const afterEndpointCreate = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterEndpointCreate.map(idOf)).toEqual([createdPrivateNative.id]);
    assertContainerSummary(afterEndpointCreate[0] as DockerContainerSummary, imageA);
    const endpointAfterOsRestart = await api(
      thirdHost.baseUrl,
      "GET",
      endpointResourcePath,
      200,
      undefined,
      apiKey,
    );
    expect(endpointAfterOsRestart).toMatchObject({
      metadata: { uid: endpointMetadata.uid, generation: "1" },
      status: { outputs: { url: endpointUrl } },
    });
    const endpointAfterRestartResponse = await requestEndpointHttps(
      endpointUrl,
      endpointCertificateAuthority,
      "after-process-restart",
    );
    expect(endpointAfterRestartResponse.status).toBe(200);
    expect(endpointAfterRestartResponse.server).toBe(firstEndpointResponse.server);

    const updatedDesired = {
      ...desired,
      spec: { ...desired.spec, image: imageB, workloadRevision: "native-revision-2" },
    };
    const updatePrepare = await api(
      thirdHost.baseUrl,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      updatedDesired,
      { ...manager, "takoform-expected-generation": "1" },
    );
    const updateBody = {
      ...updatedDesired,
      review: {
        prepareDigest: String(
          (updatePrepare as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const updateHeaders = {
      ...manager,
      "idempotency-key": "native-container-update-1",
      "if-match": `"${created.metadata.revision}"`,
      "takoform-expected-generation": "1",
    };
    const updated = await apiWithBackendUnavailableRetry(
      thirdHost.baseUrl,
      "PUT",
      createPath,
      200,
      updateBody,
      updateHeaders,
    );
    const updatedMetadata = (
      updated as { metadata: { uid: string; generation: string; revision: string } }
    ).metadata;
    expect(updatedMetadata).toMatchObject({ uid: created.metadata.uid, generation: "2" });
    expect(await assertOwnedInternalNetwork(socketPath, networkName)).toEqual(ownedNetwork);
    const afterUpdateContainers = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterUpdateContainers.length).toBeGreaterThanOrEqual(1);
    expect(afterUpdateContainers.length).toBeLessThanOrEqual(2);
    const updatedNativeCandidates = afterUpdateContainers.filter((container) => {
      assertContainerSummary(container, typeof container.Image === "string" ? container.Image : "");
      return container.Image === imageB;
    });
    expect(updatedNativeCandidates).toHaveLength(1);
    const updatedPrivateNative = await assertPrivateReadyContainer(
      socketPath,
      idOf(updatedNativeCandidates[0] as DockerContainerSummary),
      imageB,
      networkName,
    );
    if (!cleanupContext.ownedContainerIds.includes(updatedPrivateNative.id)) {
      cleanupContext.ownedContainerIds.push(updatedPrivateNative.id);
    }
    for (const container of afterUpdateContainers) {
      const expectedImage = container.Image === imageA ? imageA : imageB;
      assertContainerSummary(container, expectedImage);
      const id = idOf(container);
      if (!cleanupContext.ownedContainerIds.includes(id)) cleanupContext.ownedContainerIds.push(id);
    }

    const endpointAfterServiceUpdate = await api(
      thirdHost.baseUrl,
      "GET",
      endpointResourcePath,
      200,
      undefined,
      apiKey,
    );
    expect(endpointAfterServiceUpdate).toMatchObject({
      metadata: { uid: endpointMetadata.uid, generation: "1" },
      status: { outputs: { url: endpointUrl } },
    });
    const updatedEndpointResponse = await requestEndpointHttps(
      endpointUrl,
      endpointCertificateAuthority,
      "after-service-update",
    );
    expect(updatedEndpointResponse.status).toBe(200);
    expect(updatedEndpointResponse.server).toMatch(/^nginx\//u);
    expect(updatedEndpointResponse.server).not.toBe(firstEndpointResponse.server);

    const endpointDeleteHeaders = {
      ...apiKey,
      "idempotency-key": "native-container-endpoint-delete-1",
      "takoform-expected-generation": "1",
    };
    await dropAcknowledgementAtLoopbackProxy(
      thirdHost.baseUrl,
      "DELETE",
      endpointResourcePath,
      204,
      undefined,
      endpointDeleteHeaders,
    );
    expect(
      (await requestEndpointHttps(endpointUrl, endpointCertificateAuthority, "after-delete"))
        .status,
    ).toBe(404);

    await stopHost(thirdHost.process);
    const fourthHost = await startHost(root);
    expect(fourthHost.process.pid).not.toBe(thirdHost.process.pid);
    const replayedEndpointDelete = await apiWithBackendUnavailableRetry(
      fourthHost.baseUrl,
      "DELETE",
      endpointResourcePath,
      204,
      undefined,
      endpointDeleteHeaders,
    );
    expect(replayedEndpointDelete).toEqual({});
    expect(
      await api(fourthHost.baseUrl, "GET", endpointResourcePath, 404, undefined, apiKey),
    ).toMatchObject({ error: { code: "resource_not_found" } });
    expect(
      (
        await requestEndpointHttps(
          endpointUrl,
          endpointCertificateAuthority,
          "after-restart-delete",
        )
      ).status,
    ).toBe(404);

    const replacementPrepared = await api(
      fourthHost.baseUrl,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      endpointDesired,
      apiKey,
    );
    const replacementCreateBody = {
      ...endpointDesired,
      review: {
        prepareDigest: String(
          (replacementPrepared as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const replacementCreateHeaders = {
      ...apiKey,
      "idempotency-key": "native-container-endpoint-create-replacement-1",
      "if-none-match": "*",
    };
    cleanupContext.endpointCreateBody = replacementCreateBody;
    cleanupContext.endpointCreateHeaders = replacementCreateHeaders;
    delete cleanupContext.endpointResourceUid;
    const replacementCreated = await api(
      fourthHost.baseUrl,
      "PUT",
      endpointCreatePath,
      201,
      replacementCreateBody,
      replacementCreateHeaders,
    );
    const replacementMetadata = (
      replacementCreated as { metadata: { uid: string; generation: string; revision: string } }
    ).metadata;
    cleanupContext.endpointResourceUid = replacementMetadata.uid;
    expect(replacementMetadata.uid).not.toBe(endpointMetadata.uid);
    const replacementUrl = String(
      (replacementCreated as { status: { outputs: { url: string } } }).status.outputs.url,
    );
    expect(replacementUrl).not.toBe(endpointUrl);
    expect(
      (await requestEndpointHttps(endpointUrl, endpointCertificateAuthority, "old-hostname"))
        .status,
    ).toBe(404);
    expect(
      (await requestEndpointHttps(replacementUrl, endpointCertificateAuthority, "new-hostname"))
        .status,
    ).toBe(200);
    const replacementRead = await api(
      fourthHost.baseUrl,
      "GET",
      endpointResourcePath,
      200,
      undefined,
      apiKey,
    );
    expect(replacementRead).toMatchObject({
      metadata: { uid: replacementMetadata.uid, generation: "1" },
      status: { outputs: { url: replacementUrl } },
    });
    const replacementDelete = await api(
      fourthHost.baseUrl,
      "DELETE",
      endpointResourcePath,
      204,
      undefined,
      {
        ...apiKey,
        "idempotency-key": "native-container-endpoint-delete-replacement-1",
        "if-match": `"${replacementMetadata.revision}"`,
        "takoform-expected-generation": "1",
      },
    );
    expect(replacementDelete).toEqual({});
    expect(
      (
        await requestEndpointHttps(
          replacementUrl,
          endpointCertificateAuthority,
          "replacement-delete",
        )
      ).status,
    ).toBe(404);

    const deletePath = resourcePath;
    const deleteHeaders = {
      ...manager,
      "idempotency-key": "native-container-delete-1",
      "takoform-expected-generation": "2",
    };
    await dropAcknowledgementAtLoopbackProxy(
      fourthHost.baseUrl,
      "DELETE",
      deletePath,
      204,
      undefined,
      deleteHeaders,
    );
    await stopHost(fourthHost.process);

    const fifthHost = await startHost(root);
    expect(fifthHost.process.pid).not.toBe(fourthHost.process.pid);
    const replayedDelete = await apiWithBackendUnavailableRetry(
      fifthHost.baseUrl,
      "DELETE",
      deletePath,
      204,
      undefined,
      deleteHeaders,
    );
    expect(replayedDelete).toEqual({});
    const afterDeleteContainers = newNetworkContainers(
      await listNetworkContainers(socketPath, networkName),
      baselineContainerIds,
    );
    expect(afterDeleteContainers).toHaveLength(0);
    for (const containerId of cleanupContext.ownedContainerIds) {
      expect(
        (await dockerGet(socketPath, `/containers/${encodeURIComponent(containerId)}/json`)).status,
      ).toBe(404);
    }
    const gone = await api(fifthHost.baseUrl, "GET", resourcePath, 404, undefined, manager);
    expect(gone).toMatchObject({ error: { code: "resource_not_found" } });
    const endpointGone = await api(
      fifthHost.baseUrl,
      "GET",
      endpointResourcePath,
      404,
      undefined,
      apiKey,
    );
    expect(endpointGone).toMatchObject({ error: { code: "resource_not_found" } });
    residualPath = `/v1/organizations/${organizationId}/resources/${encodeURIComponent(
      created.metadata.uid,
    )}/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
    cleanupContext.residualPath = residualPath;
    const residual = await api(fifthHost.baseUrl, "GET", residualPath, 200, undefined, apiKey);
    expect(residual).toMatchObject({ residual: { status: "absent", source: "provider" } });
    nativeAbsenceConfirmed = true;
    expect(await assertOwnedInternalNetwork(socketPath, networkName)).toEqual(ownedNetwork);
    await stopHost(fifthHost.process);
  },
);
