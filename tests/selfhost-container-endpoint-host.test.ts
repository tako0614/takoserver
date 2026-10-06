import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPorts, buildApp } from "../src/app.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createDockerHttpRevisionRuntime } from "../src/providers/docker-http-revision.ts";
import { SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND } from "../src/providers/selfhost-container-endpoint.ts";
import { createSelfhostContainerRuntime } from "../src/providers/selfhost-container-runtime.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { hasExactLocalContainerEndpointCandidatePair } from "../src/selfhost-composition.ts";
import { createSelfhostContainerEndpointIngress } from "../src/selfhost-container-endpoint-ingress.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { SigningKey } from "../src/token.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";
import {
  installLocalContainerEndpointCandidateForTest,
  loadVerifiedLocalContainerEndpointCandidate,
  SELFHOST_CONTAINER_ENDPOINT_FORM_REF,
} from "./fixtures/selfhost-container-endpoint-authority.ts";
import {
  installLocalContainerCandidateForTest,
  loadVerifiedLocalContainerCandidate,
} from "./fixtures/selfhost-container-host-authority.ts";
import { buildHistoricalTakoformApp } from "./helpers/historical-takoform-host.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const ORIGIN = "https://endpoint-host.test";
const SERVICE_FORM = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;
const SERVICE_SPEC = {
  image: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
  httpPort: 8080,
  healthPath: "/health",
  workloadRevision: "revision-1",
  environment: {},
  outboundInternet: false,
  requiredSensitiveVars: [],
};
const QUALIFIED_INGRESS = {
  [SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND]: true,
  configuredSuffix: "container.test",
  publicOrigin: "https://container.test",
  port: 443,
  assertServing() {
    /* Synthetic local test listener; production entry must prove TLS/SNI. */
  },
} as const;

const workerd: WorkerdRuntime = {
  async inspectModule(input) {
    return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
  },
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

test("only a qualified HTTPS ingress and both exact unpublished Forms expose the ContainerEndpoint technical Offering", async () => {
  const service = await loadVerifiedLocalContainerCandidate(
    join(import.meta.dir, "fixtures/selfhost-container-service-candidate.json"),
  );
  const endpoint = await loadVerifiedLocalContainerEndpointCandidate(
    join(import.meta.dir, "fixtures/selfhost-container-endpoint-candidate.json"),
  );
  expect(endpoint.form.identity.formRef).toEqual(SELFHOST_CONTAINER_ENDPOINT_FORM_REF);
  expect(hasExactLocalContainerEndpointCandidatePair(currentTakoformCandidates().forms)).toBe(
    false,
  );
  expect(hasExactLocalContainerEndpointCandidatePair([service.form, endpoint.form])).toBe(true);
  expect(
    hasExactLocalContainerEndpointCandidatePair([
      service.form,
      {
        ...endpoint.form,
        identity: { ...endpoint.form.identity, packageDigest: `sha256:${"0".repeat(64)}` as const },
      },
    ]),
  ).toBe(false);
  const root = mkdtempSync(join(tmpdir(), "cehost-"));
  const backend = createDockerHttpRevisionRuntime({
    socketPath: "/var/run/docker.sock",
    installationId: "local.primary",
    network: "unused-net",
    maxMemoryBytes: 256 * 1024 * 1024,
    maxNanoCpus: 500_000_000,
    pidsLimit: 128,
    async engine() {
      throw new Error("the composition must not call Docker");
    },
  });
  const runtime = await createSelfhostContainerRuntime({ root, backend, drainTimeoutMs: 5_000 });
  try {
    const base = {
      mode: "stable-selfhost" as const,
      stableForms: [service.form, endpoint.form],
      edge: await buildEdgeForms(),
      dataRoot: root,
      runtime: workerd,
      container: {
        runtime,
        capacityProfile: {
          id: "selfhost.container.http.standard" as const,
          memoryBytes: 256 * 1024 * 1024,
          nanoCpus: 500_000_000,
          pidsLimit: 128,
        },
      },
      workerRuntimeAvailable: false,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
      now: new Date("2026-10-02T00:00:00.000Z"),
    };
    const noIngress = createStandaloneProviderComposition(base);
    expect(
      noIngress.providers[0]?.offerings.some(
        (offering) => offering.form.kind === "ContainerEndpoint",
      ),
    ).toBe(false);
    const qualified = createStandaloneProviderComposition({
      ...base,
      containerEndpointIngress: QUALIFIED_INGRESS,
    });
    expect(
      qualified.providers[0]?.offerings
        .filter((offering) => offering.form.kind === "ContainerEndpoint")
        .map((offering) => offering.form),
    ).toEqual([SELFHOST_CONTAINER_ENDPOINT_FORM_REF]);
    expect(qualified.offerings.some((offering) => offering.form.kind === "ContainerEndpoint")).toBe(
      false,
    );
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function request(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.fetch(
    new Request(new URL(path, ORIGIN), {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function dockerBoundary() {
  const containers = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const engine = async (method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(path, "http://docker.invalid");
    if (method === "GET" && url.pathname === "/networks/endpoint-test-net")
      return {
        status: 200,
        body: JSON.stringify({
          Name: "endpoint-test-net",
          Driver: "bridge",
          Scope: "local",
          Internal: true,
          Ingress: false,
          Attachable: false,
          Labels: { "takoserver.installation": "local.primary" },
        }),
      };
    if (url.pathname === "/images/create")
      return { status: 200, body: `${JSON.stringify({ status: "done" })}\n` };
    if (method === "POST" && url.pathname === "/containers/create" && body) {
      const name = url.searchParams.get("name");
      if (!name) throw new Error("Docker name is absent");
      if (containers.has(name)) return { status: 409, body: "" };
      const Id = (++sequence).toString(16).padStart(64, "0");
      containers.set(name, {
        Id,
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
          Networks: { "endpoint-test-net": { IPAddress: `172.25.0.${sequence + 9}` } },
        },
      });
      return { status: 201, body: JSON.stringify({ Id }) };
    }
    const [nameOrId, operation] = url.pathname.slice("/containers/".length).split("/");
    const match = [...containers.entries()].find(
      ([name, container]) => name === nameOrId || container.Id === nameOrId,
    );
    if (!match) return { status: 404, body: "" };
    const [name, container] = match;
    if (operation === "json") return { status: 200, body: JSON.stringify(container) };
    if (operation === "start" || operation === "stop") {
      containers.set(name, { ...container, State: { Running: operation === "start" } });
      return { status: 204, body: "" };
    }
    if (method === "DELETE") {
      containers.delete(name);
      return { status: 204, body: "" };
    }
    throw new Error(`unexpected Docker request ${method} ${path}`);
  };
  return { containers, engine };
}

test("normal public Host creates and reads one exact ContainerEndpoint attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "cehost-"));
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createMemoryObjectStore();
  const docker = dockerBoundary();
  let successorHealthy = false;
  let upstreamCalls = 0;
  const backend = createDockerHttpRevisionRuntime({
    socketPath: "/var/run/docker.sock",
    installationId: "local.primary",
    network: "endpoint-test-net",
    maxMemoryBytes: 256 * 1024 * 1024,
    maxNanoCpus: 500_000_000,
    pidsLimit: 128,
    engine: docker.engine,
    async healthFetch(request) {
      return new Response("ok", {
        status: new URL(request.url).hostname === "172.25.0.11" && !successorHealthy ? 503 : 200,
      });
    },
  });
  const runtime = await createSelfhostContainerRuntime({
    root: join(root, "runtime"),
    backend,
    drainTimeoutMs: 50,
    async fetch(request) {
      upstreamCalls++;
      const url = new URL(request.url);
      if (url.pathname === "/manual-redirect")
        return new Response("move", { status: 302, headers: { location: "/destination" } });
      if (url.pathname === "/response-loss") throw new Error("synthetic upstream response loss");
      return new Response(
        `${request.method} ${url.pathname}${url.search} ${await request.text()}`.trimEnd(),
        { status: 207 },
      );
    },
  });
  try {
    const service = await loadVerifiedLocalContainerCandidate(
      join(import.meta.dir, "fixtures/selfhost-container-service-candidate.json"),
    );
    const endpoint = await loadVerifiedLocalContainerEndpointCandidate(
      join(import.meta.dir, "fixtures/selfhost-container-endpoint-candidate.json"),
    );
    const candidates = currentTakoformCandidates();
    const forms = [...candidates.forms, service.form, endpoint.form];
    const signingPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", signingPair.publicKey);
    await sql.run(
      "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
      ["endpoint-host-test", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }), 0],
    );
    const signingKey: SigningKey = {
      keyId: "endpoint-host-test",
      privateKey: signingPair.privateKey,
    };
    const now = new Date("2026-10-02T00:00:00.000Z");
    const composition = createStandaloneProviderComposition({
      mode: "stable-selfhost",
      stableForms: forms,
      edge: await buildEdgeForms(),
      dataRoot: join(root, "provider"),
      runtime: workerd,
      container: {
        runtime,
        capacityProfile: {
          id: "selfhost.container.http.standard",
          memoryBytes: 256 * 1024 * 1024,
          nanoCpus: 500_000_000,
          pidsLimit: 128,
        },
      },
      containerEndpointIngress: QUALIFIED_INGRESS,
      workerRuntimeAvailable: false,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
      now,
    });
    const endpointIngress = composition.containerEndpointIngress;
    if (!endpointIngress) throw new Error("synthetic Endpoint ingress was not composed");
    const artifacts = createTakoformArtifacts({
      sql,
      objects,
      clock: () => now,
      randomId: () => crypto.randomUUID(),
    });
    const appPorts: AppPorts = {
      v2: TEST_TAKOFORM_V2_CONFIG,
      sql,
      objects,
      publicOrigin: ORIGIN,
      clock: () => now,
      forms,
      bindings: candidates.bindings,
      hostForms: forms,
      hostBindings: candidates.bindings,
      ...composition,
      artifacts,
      signingKey,
      selfhostEndpointIngressFactory: ({ store, deployments }) =>
        createSelfhostContainerEndpointIngress({
          qualification: endpointIngress,
          store,
          deployments,
        }),
      identity: {
        async verify() {
          return {
            providerSubject: "endpoint-owner",
            email: "endpoint-owner@example.test",
            displayName: "Endpoint owner",
          };
        },
      },
      settlement: {
        async verify() {
          throw new Error("local zero-cost Offering must not settle");
        },
      },
    };
    let app = buildHistoricalTakoformApp(appPorts);
    const session = await request(app, "POST", "/v1/sessions", {
      provider: "google",
      assertion: "synthetic-local-identity",
    });
    expect(session.status).toBe(200);
    const owner = {
      authorization: `Bearer ${String((session.body as { sessionToken: string }).sessionToken)}`,
    };
    const org = await request(
      app,
      "POST",
      "/v1/organizations",
      { name: "Endpoint lifecycle" },
      owner,
    );
    expect(org.status).toBe(201);
    const orgId = String((org.body as { organization: { id: string } }).organization.id);
    const keyResult = await request(
      app,
      "POST",
      `/v1/organizations/${orgId}/api-keys`,
      {
        name: "endpoint-owner",
        scopes: [
          "catalog:read",
          "reseller:write",
          "wallet:read",
          "resources:read",
          "resources:write",
        ],
        expiresInSeconds: 3600,
      },
      owner,
    );
    expect(keyResult.status).toBe(201);
    const key = {
      authorization: `Bearer ${String((keyResult.body as { secret: string }).secret)}`,
    };
    await installLocalContainerCandidateForTest({
      sql,
      objects,
      hostId: ORIGIN,
      candidate: service,
    });
    await installLocalContainerEndpointCandidateForTest({
      sql,
      objects,
      hostId: ORIGIN,
      candidate: endpoint,
    });
    app = buildHistoricalTakoformApp(appPorts);
    const catalog = await request(
      app,
      "GET",
      `/v1/catalog?organizationId=${orgId}`,
      undefined,
      key,
    );
    expect(catalog.status).toBe(200);
    expect(
      (catalog.body as { offerings: { id: string }[] }).offerings.some(
        (offering) => offering.id === "selfhost.container.http.standard",
      ),
    ).toBe(true);
    const quote = await request(
      app,
      "POST",
      "/v1/reseller/quotes",
      { tenantRef: "tenant_endpoint", offeringId: "selfhost.container.http.standard", quantity: 1 },
      key,
    );
    expect(quote.status).toBe(201);
    const reservation = await request(
      app,
      "POST",
      "/v1/reseller/reservations",
      {
        tenantRef: "tenant_endpoint",
        quoteId: String((quote.body as { quote: { id: string } }).quote.id),
      },
      key,
    );
    expect(reservation.status).toBe(201);
    const reservationId = String(
      (reservation.body as { reservation: { id: string } }).reservation.id,
    );
    const issued = await request(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      { tenantRef: "tenant_endpoint", resourceName: "service", expiresInSeconds: 600 },
      key,
    );
    expect(issued.status).toBe(201);
    const serviceBearer = {
      authorization: `Bearer ${String((issued.body as { takoformRunToken: { token: string } }).takoformRunToken.token)}`,
    };
    const serviceDesired = {
      apiVersion: SERVICE_FORM.apiVersion,
      kind: SERVICE_FORM.kind,
      form: { formRef: SERVICE_FORM },
      metadata: { space: "tenant_endpoint", name: "service" },
      spec: SERVICE_SPEC,
    };
    const servicePrepared = await request(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      serviceDesired,
      serviceBearer,
    );
    expect(servicePrepared.status).toBe(200);
    const serviceCreate = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SERVICE_FORM.apiVersion}/${SERVICE_FORM.kind}/service`,
      {
        ...serviceDesired,
        review: {
          prepareDigest: String(
            (servicePrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
          ),
        },
      },
      { ...serviceBearer, "idempotency-key": "endpoint-service-create", "if-none-match": "*" },
    );
    expect(serviceCreate.status).toBe(201);
    expect(docker.containers.size).toBe(1);

    const endpointDesired = {
      apiVersion: SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion,
      kind: SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind,
      form: { formRef: SELFHOST_CONTAINER_ENDPOINT_FORM_REF },
      metadata: { space: "tenant_endpoint", name: "web" },
      spec: {
        service: { apiVersion: SERVICE_FORM.apiVersion, kind: SERVICE_FORM.kind, name: "service" },
      },
    };
    const wrongSpace = await request(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      { ...endpointDesired, metadata: { space: "other_space", name: "web" } },
      key,
    );
    expect(wrongSpace.status).toBe(200);
    const wrongSpaceApply = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      {
        ...endpointDesired,
        metadata: { space: "other_space", name: "web" },
        review: {
          prepareDigest: String(
            (wrongSpace.body as { review: { prepareDigest: string } }).review.prepareDigest,
          ),
        },
      },
      { ...key, "idempotency-key": "endpoint-wrong-space", "if-none-match": "*" },
    );
    expect(wrongSpaceApply.status).not.toBe(201);
    expect(docker.containers.size).toBe(1);
    const endpointPrepared = await request(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      endpointDesired,
      key,
    );
    expect(endpointPrepared.status).toBe(200);
    const endpointRequestBody = {
      ...endpointDesired,
      review: {
        prepareDigest: String(
          (endpointPrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const endpointCreate = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      endpointRequestBody,
      { ...key, "idempotency-key": "endpoint-create", "if-none-match": "*" },
    );
    if (endpointCreate.status !== 201) {
      const operationId = (endpointCreate.body as { operation?: { id?: string } }).operation?.id;
      const operation = operationId
        ? await request(
            app,
            "GET",
            `/apis/forms.takoform.com/v1/operations/${operationId}`,
            undefined,
            key,
          )
        : undefined;
      throw new Error(
        `ContainerEndpoint create returned ${endpointCreate.status}: ${JSON.stringify({ response: endpointCreate.body, operation })}`,
      );
    }
    const sameInstanceReplay = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      endpointRequestBody,
      { ...key, "idempotency-key": "endpoint-create", "if-none-match": "*" },
    );
    expect(sameInstanceReplay.status).toBe(201);
    expect((sameInstanceReplay.body as { metadata: { uid: string } }).metadata.uid).toBe(
      (endpointCreate.body as { metadata: { uid: string } }).metadata.uid,
    );
    expect(docker.containers.size).toBe(1);
    // Lose the public acknowledgement and rebuild the ordinary Host instance;
    // the exact request/key must resolve to the committed UID, not a new route.
    app = buildHistoricalTakoformApp(appPorts);
    const endpointReplay = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      endpointRequestBody,
      { ...key, "idempotency-key": "endpoint-create", "if-none-match": "*" },
    );
    expect(endpointReplay.status).toBe(201);
    expect((endpointReplay.body as { metadata: { uid: string } }).metadata.uid).toBe(
      (endpointCreate.body as { metadata: { uid: string } }).metadata.uid,
    );
    expect(docker.containers.size).toBe(1);
    const changedReplay = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      {
        ...endpointRequestBody,
        review: { prepareDigest: `sha256:${"0".repeat(64)}` },
      },
      { ...key, "idempotency-key": "endpoint-create", "if-none-match": "*" },
    );
    expect(changedReplay.status).toBe(400);
    const unsupportedUpdate = await request(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`,
      endpointRequestBody,
      { ...key, "idempotency-key": "endpoint-not-an-update", "if-none-match": "*" },
    );
    expect(unsupportedUpdate.status).toBe(503);
    expect(docker.containers.size).toBe(1);
    const endpointUrl = String(
      (endpointCreate.body as { status: { outputs: { url: string } } }).status.outputs.url,
    );
    expect(endpointUrl).toMatch(/^https:\/\/ce-[0-9a-f]{40}\.container\.test\/$/);
    const dedicated = createSelfhostContainerEndpointIngress({
      qualification: endpointIngress,
      store: createTakoformStore(sql, () => now),
      deployments: createResourceDeploymentStore(sql, () => now),
    });
    const foreignHost = await dedicated(new Request("https://foreign.test/v1/organizations"));
    expect(foreignHost).toBeNull();
    expect((foreignHost ?? new Response(null, { status: 404 })).status).toBe(404);
    expect(
      (await dedicated(new Request("https://missing.container.test/v1/organizations")))?.status,
    ).toBe(404);
    const appResponse = await app.fetch(
      new Request(`${endpointUrl}v1/anything?x=one%20two`, {
        method: "POST",
        headers: { origin: "https://elsewhere.test", "content-type": "text/plain" },
        body: "payload",
      }),
    );
    expect(appResponse.status).toBe(207);
    expect(await appResponse.text()).toBe("POST /v1/anything?x=one%20two payload");
    const optionsResponse = await app.fetch(
      new Request(`${endpointUrl}_takoserver/health/live`, {
        method: "OPTIONS",
        headers: { origin: "https://elsewhere.test" },
      }),
    );
    expect(optionsResponse.status).toBe(207);
    expect(await optionsResponse.text()).toBe("OPTIONS /_takoserver/health/live");
    const redirect = await app.fetch(new Request(`${endpointUrl}manual-redirect`));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/destination");
    expect(await redirect.text()).toBe("move");
    const callsBeforeLoss = upstreamCalls;
    expect(
      (
        await app.fetch(
          new Request(`${endpointUrl}response-loss`, { method: "POST", body: "once" }),
        )
      ).status,
    ).toBe(503);
    expect(upstreamCalls).toBe(callsBeforeLoss + 1);
    const endpointPath = `/apis/forms.takoform.com/v1/resources/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion}/${SELFHOST_CONTAINER_ENDPOINT_FORM_REF.kind}/web`;
    const servicePath = `/apis/forms.takoform.com/v1/resources/${SERVICE_FORM.apiVersion}/${SERVICE_FORM.kind}/service`;
    const query = (ref: typeof SERVICE_FORM | typeof SELFHOST_CONTAINER_ENDPOINT_FORM_REF) =>
      new URLSearchParams({
        space: "tenant_endpoint",
        definitionVersion: ref.definitionVersion,
        schemaDigest: ref.schemaDigest,
      }).toString();
    const endpointManagedPath = `${endpointPath}?${query(SELFHOST_CONTAINER_ENDPOINT_FORM_REF)}`;
    const serviceManagedPath = `${servicePath}?${query(SERVICE_FORM)}`;
    const endpointRead = await request(app, "GET", endpointManagedPath, undefined, key);
    expect(endpointRead.status).toBe(200);
    const endpointUid = (endpointRead.body as { metadata: { uid: string } }).metadata.uid;
    expect(endpointUid).toBe((endpointCreate.body as { metadata: { uid: string } }).metadata.uid);
    const row = (
      await sql.query("SELECT resource_json FROM tf_resources WHERE uid = ?", [endpointUid])
    )[0];
    if (typeof row?.resource_json !== "string") throw new Error("committed Endpoint row missing");
    const originalResourceJson = row.resource_json;
    const alteredResource = JSON.parse(originalResourceJson) as {
      status: { outputs: { url: string } };
    };
    alteredResource.status.outputs.url = "https://different.container.test/";
    await sql.run("UPDATE tf_resources SET resource_json = ? WHERE uid = ?", [
      JSON.stringify(alteredResource),
      endpointUid,
    ]);
    try {
      expect((await app.fetch(new Request(`${endpointUrl}wrong-output`))).status).toBe(404);
    } finally {
      await sql.run("UPDATE tf_resources SET resource_json = ? WHERE uid = ?", [
        originalResourceJson,
        endpointUid,
      ]);
    }
    await sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ? AND state = 'live'",
      [endpointUid],
    );
    try {
      expect((await app.fetch(new Request(`${endpointUrl}pending-delete`))).status).toBe(404);
    } finally {
      await sql.run(
        "UPDATE tf_resource_deletion_attestations SET state = 'live' WHERE resource_uid = ? AND state = 'pending'",
        [endpointUid],
      );
    }
    const serviceMetadata = (
      serviceCreate.body as { metadata: { uid: string; generation: string; revision: string } }
    ).metadata;
    const captured = await request(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/capture`,
      { tenantRef: "tenant_endpoint", usage: { quantity: 1 } },
      key,
    );
    expect(captured.status).toBe(200);
    const managementIssued = await request(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      {
        tenantRef: "tenant_endpoint",
        resourceName: "service",
        resourceUid: serviceMetadata.uid,
        expiresInSeconds: 600,
      },
      key,
    );
    expect(managementIssued.status).toBe(201);
    const manager = {
      authorization: `Bearer ${String((managementIssued.body as { takoformRunToken: { token: string } }).takoformRunToken.token)}`,
    };
    const updatedServiceDesired = {
      ...serviceDesired,
      spec: {
        ...SERVICE_SPEC,
        workloadRevision: "revision-2",
        image: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
      },
    };
    const updatePrepared = await request(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      updatedServiceDesired,
      { ...manager, "takoform-expected-generation": serviceMetadata.generation },
    );
    expect(updatePrepared.status).toBe(200);
    const updateBody = {
      ...updatedServiceDesired,
      expectedUid: serviceMetadata.uid,
      expectedGeneration: serviceMetadata.generation,
      review: {
        prepareDigest: String(
          (updatePrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const updateHeaders = {
      ...manager,
      "idempotency-key": "endpoint-target-update",
      "if-match": `"${serviceMetadata.revision}"`,
      "takoform-expected-generation": serviceMetadata.generation,
    };
    const startingUpdate = await request(app, "PUT", servicePath, updateBody, updateHeaders);
    expect(startingUpdate.status).toBe(503);
    expect(docker.containers.size).toBe(2);
    expect((await app.fetch(new Request(`${endpointUrl}during-update`))).status).toBe(207);
    successorHealthy = true;
    const completedUpdate = await request(app, "PUT", servicePath, updateBody, updateHeaders);
    expect(completedUpdate.status).toBe(200);
    expect((completedUpdate.body as { metadata: { generation: string } }).metadata.generation).toBe(
      "2",
    );
    expect((await app.fetch(new Request(`${endpointUrl}after-update`))).status).toBe(207);
    expect((await request(app, "GET", endpointManagedPath, undefined, key)).body).toMatchObject({
      status: { outputs: { url: endpointUrl } },
    });
    const blockedServiceDelete = await request(app, "DELETE", serviceManagedPath, undefined, {
      ...manager,
      "idempotency-key": "service-delete-while-attached",
      "takoform-expected-generation": "2",
    });
    expect(blockedServiceDelete.status).toBe(409);
    expect((blockedServiceDelete.body as { error?: { code?: string } }).error?.code).toBe(
      "dependency_in_use",
    );
    const endpointDelete = await request(app, "DELETE", endpointManagedPath, undefined, {
      ...key,
      "idempotency-key": "endpoint-delete",
      "takoform-expected-generation": "1",
    });
    expect(endpointDelete.status).toBe(204);
    const revoked = await app.fetch(new Request(`${endpointUrl}after-delete`));
    expect(revoked.status).toBe(404);
    const endpointPreparedAgain = await request(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      endpointDesired,
      key,
    );
    expect(endpointPreparedAgain.status).toBe(200);
    const endpointReplacement = await request(
      app,
      "PUT",
      endpointPath,
      {
        ...endpointDesired,
        review: {
          prepareDigest: String(
            (endpointPreparedAgain.body as { review: { prepareDigest: string } }).review
              .prepareDigest,
          ),
        },
      },
      { ...key, "idempotency-key": "endpoint-create-replacement", "if-none-match": "*" },
    );
    expect(endpointReplacement.status).toBe(201);
    const replacementUrl = String(
      (endpointReplacement.body as { status: { outputs: { url: string } } }).status.outputs.url,
    );
    expect(replacementUrl).not.toBe(endpointUrl);
    expect((await app.fetch(new Request(`${endpointUrl}old-uid`))).status).toBe(404);
    expect((await app.fetch(new Request(`${replacementUrl}new-uid`))).status).toBe(207);
    const oldDeleteReplay = await request(app, "DELETE", endpointManagedPath, undefined, {
      ...key,
      "idempotency-key": "endpoint-delete",
      "takoform-expected-generation": "1",
    });
    expect(oldDeleteReplay.status).toBe(204);
    expect((await app.fetch(new Request(`${replacementUrl}survives-old-delete`))).status).toBe(207);
    const replacementDelete = await request(app, "DELETE", endpointManagedPath, undefined, {
      ...key,
      "idempotency-key": "endpoint-replacement-delete",
      "takoform-expected-generation": "1",
    });
    expect(replacementDelete.status).toBe(204);
    const serviceDelete = await request(app, "DELETE", serviceManagedPath, undefined, {
      ...manager,
      "idempotency-key": "service-delete-after-detach",
      "takoform-expected-generation": "2",
    });
    expect(serviceDelete.status).toBe(204);
    expect(docker.containers.size).toBe(0);
  } finally {
    await runtime.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
