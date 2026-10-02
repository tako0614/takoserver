import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  installLocalContainerCandidateForTest,
  loadVerifiedLocalContainerCandidate,
} from "./fixtures/selfhost-container-host-authority.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const ENABLED = nativeEvidenceBinary("container-host-lifecycle") ?? null;
const FORM_ARTIFACT = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT;
const FORM_ARTIFACT_SHA256 = process.env.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256;
const IMAGE_A = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_A;
const IMAGE_B = process.env.TAKOSERVER_NATIVE_CONTAINER_IMAGE_B;
const DOCKER_SOCKET = process.env.TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET;
const NETWORK = process.env.TAKOSERVER_NATIVE_CONTAINER_NETWORK;
const HOST_ID = "http://container-host-native.test";
const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;

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

async function assertOwnedInternalNetwork(socketPath: string, name: string): Promise<void> {
  const response = await dockerGet(socketPath, `/networks/${encodeURIComponent(name)}`);
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error("configured Docker network is unavailable");
  }
  const network = response.body as Record<string, unknown>;
  const labels = network.Labels as Record<string, unknown> | undefined;
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
}

async function assertCachedImmutableImage(socketPath: string, image: string): Promise<void> {
  if (!/^docker\.io\/nginxinc\/nginx-unprivileged@sha256:[a-f0-9]{64}$/u.test(image)) {
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

async function startHost(
  rootPath: string,
): Promise<{ baseUrl: string; process: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "tests/fixtures/selfhost-container-host-native/server.ts"],
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

async function dropAcknowledgementAtLoopbackProxy(
  baseUrl: string,
  method: string,
  path: string,
  expectedStatus: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<void> {
  const target = new URL(path, baseUrl);
  let resolveHostStatus: (status: number) => void = () => undefined;
  let rejectHostStatus: (error: Error) => void = () => undefined;
  const hostStatus = new Promise<number>((resolve, reject) => {
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
        upstreamResponse.on("data", () => undefined);
        upstreamResponse.on("error", () => {
          rejectHostStatus(new Error("Host response stream failed before completion"));
          clientResponse.destroy();
        });
        upstreamResponse.on("end", () => {
          const status = upstreamResponse.statusCode ?? 0;
          resolveHostStatus(status);
          if (status === expectedStatus) {
            // The Host has completed the operation and its HTTP response reached
            // the proxy. Destroy the client-facing connection without forwarding
            // status or body, modeling a lost acknowledgement in transit.
            clientResponse.destroy();
          } else {
            clientResponse.writeHead(status);
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
  let clientObservedResponse = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const clientResponse = fetch(
      `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    )
      .then(async (response) => {
        clientObservedResponse = true;
        await response.arrayBuffer();
        return response.status;
      })
      .catch(() => null);
    const [actualHostStatus, clientStatus] = await Promise.race([
      Promise.all([hostStatus, clientResponse]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("loopback ACK-drop proxy timed out")), 30_000);
      }),
    ]);
    if (actualHostStatus !== expectedStatus) {
      throw new Error(`Host operation returned unexpected status ${actualHostStatus}`);
    }
    if (clientObservedResponse || clientStatus !== null) {
      throw new Error("fault proxy forwarded a Host acknowledgement to the caller");
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

test.skipIf(
  ENABLED === null ||
    FORM_ARTIFACT === undefined ||
    FORM_ARTIFACT_SHA256 === undefined ||
    IMAGE_A === undefined ||
    IMAGE_B === undefined ||
    DOCKER_SOCKET === undefined ||
    NETWORK === undefined,
)(
  "public Host Container CRUD survives real OS-process restart and exact lost-ack replay",
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
    expect(FORM_ARTIFACT_SHA256).toBe(
      "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2",
    );
    await assertOwnedInternalNetwork(socketPath, networkName);
    await assertCachedImmutableImage(socketPath, imageA);
    await assertCachedImmutableImage(socketPath, imageB);
    const baselineContainers = await listNetworkContainers(socketPath, networkName);
    const baselineContainerIds = new Set(baselineContainers.map(idOf));

    root = mkdtempSync(join(tmpdir(), "c-host-"));
    const database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    const objects = createFileObjectStore({ root: join(root, "objects") });
    await installLocalContainerCandidateForTest({
      sql: createSqliteSql(database),
      objects,
      hostId: HOST_ID,
      candidate: localCandidate,
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
    const quote = await api(
      firstHost.baseUrl,
      "POST",
      "/v1/reseller/quotes",
      201,
      {
        tenantRef: "tenant_container_native",
        offeringId: "selfhost.container.http.standard",
        quantity: 1,
      },
      apiKey,
    );
    const reservation = await api(
      firstHost.baseUrl,
      "POST",
      "/v1/reseller/reservations",
      201,
      {
        tenantRef: "tenant_container_native",
        quoteId: String((quote as { quote: { id: string } }).quote.id),
      },
      apiKey,
    );
    const reservationId = String((reservation as { reservation: { id: string } }).reservation.id);
    const provision = await api(
      firstHost.baseUrl,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      201,
      { tenantRef: "tenant_container_native", resourceName: "service", expiresInSeconds: 900 },
      apiKey,
    );
    const provisionToken = {
      authorization: `Bearer ${String((provision as { takoformRunToken: { token: string } }).takoformRunToken.token)}`,
    };
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
    await assertOwnedInternalNetwork(socketPath, networkName);
    const replayedCreate = await api(
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
    const management = await api(
      secondHost.baseUrl,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      201,
      {
        tenantRef: "tenant_container_native",
        resourceName: "service",
        resourceUid: created.metadata.uid,
        expiresInSeconds: 900,
      },
      apiKey,
    );
    const manager = {
      authorization: `Bearer ${String((management as { takoformRunToken: { token: string } }).takoformRunToken.token)}`,
    };
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

    const updatedDesired = {
      ...desired,
      spec: { ...desired.spec, image: imageB, workloadRevision: "native-revision-2" },
    };
    const updatePrepare = await api(
      secondHost.baseUrl,
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
    const updated = await api(
      secondHost.baseUrl,
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
    await assertOwnedInternalNetwork(socketPath, networkName);
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

    const deletePath = resourcePath;
    const deleteHeaders = {
      ...manager,
      "idempotency-key": "native-container-delete-1",
      "takoform-expected-generation": "2",
    };
    await dropAcknowledgementAtLoopbackProxy(
      secondHost.baseUrl,
      "DELETE",
      deletePath,
      204,
      undefined,
      deleteHeaders,
    );
    await stopHost(secondHost.process);

    const thirdHost = await startHost(root);
    expect(thirdHost.process.pid).not.toBe(secondHost.process.pid);
    const replayedDelete = await api(
      thirdHost.baseUrl,
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
    const gone = await api(thirdHost.baseUrl, "GET", resourcePath, 404, undefined, manager);
    expect(gone).toMatchObject({ error: { code: "resource_not_found" } });
    residualPath = `/v1/organizations/${organizationId}/resources/${encodeURIComponent(
      created.metadata.uid,
    )}/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
    cleanupContext.residualPath = residualPath;
    const residual = await api(thirdHost.baseUrl, "GET", residualPath, 200, undefined, apiKey);
    expect(residual).toMatchObject({ residual: { status: "absent", source: "provider" } });
    nativeAbsenceConfirmed = true;
    await assertOwnedInternalNetwork(socketPath, networkName);
    await stopHost(thirdHost.process);
  },
);
