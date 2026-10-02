import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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

afterEach(async () => {
  if (hostProcess) {
    hostProcess.kill("SIGKILL");
    await hostProcess.exited;
    hostProcess = undefined;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
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
  expect(typeof imageInfo.Id).toBe("string");
  expect(exposed?.["8080/tcp"]).toBeDefined();
  // Deliberately do not inspect or print the image's environment metadata.
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
    return { baseUrl: `http://127.0.0.1:${port}`, process: child };
  }
}

async function stopHost(processHandle: ReturnType<typeof Bun.spawn>): Promise<void> {
  processHandle.kill("SIGKILL");
  const exitCode = await processHandle.exited;
  if (hostProcess === processHandle) hostProcess = undefined;
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

async function apiAndDiscardAcknowledgement(
  baseUrl: string,
  method: string,
  path: string,
  expectedStatus: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const status = response.status;
  await response.arrayBuffer();
  if (status !== expectedStatus) {
    throw new Error(
      `Host effect did not reach its acknowledgement boundary (${expectedStatus}/${status})`,
    );
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
        scopes: ["reseller:write", "catalog:read", "wallet:read", "resources:read"],
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
    const createHeaders = {
      ...provisionToken,
      "idempotency-key": "native-container-create-1",
      "if-none-match": "*",
    };
    await apiAndDiscardAcknowledgement(
      firstHost.baseUrl,
      "PUT",
      createPath,
      201,
      createBody,
      createHeaders,
    );
    await stopHost(firstHost.process);

    const secondHost = await startHost(root);
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
    const resourcePath = `${createPath}?${new URLSearchParams({
      space: "tenant_container_native",
      definitionVersion: FORM_REF.definitionVersion,
      schemaDigest: FORM_REF.schemaDigest,
    })}`;
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

    const deletePath = resourcePath;
    const deleteHeaders = {
      ...manager,
      "idempotency-key": "native-container-delete-1",
      "takoform-expected-generation": "2",
    };
    await apiAndDiscardAcknowledgement(
      secondHost.baseUrl,
      "DELETE",
      deletePath,
      204,
      undefined,
      deleteHeaders,
    );
    await stopHost(secondHost.process);

    const thirdHost = await startHost(root);
    const replayedDelete = await api(
      thirdHost.baseUrl,
      "DELETE",
      deletePath,
      204,
      undefined,
      deleteHeaders,
    );
    expect(replayedDelete).toEqual({});
    const gone = await api(thirdHost.baseUrl, "GET", resourcePath, 404, undefined, manager);
    expect(gone).toMatchObject({ error: { code: "resource_not_found" } });
    const residualPath = `/v1/organizations/${organizationId}/resources/${encodeURIComponent(
      created.metadata.uid,
    )}/native-residual?${new URLSearchParams({ space: "tenant_container_native", name: "service" })}`;
    const residual = await api(thirdHost.baseUrl, "GET", residualPath, 200, undefined, apiKey);
    expect(residual).toMatchObject({ residual: { status: "absent", source: "provider" } });
    await assertOwnedInternalNetwork(socketPath, networkName);
    await stopHost(thirdHost.process);
  },
);
