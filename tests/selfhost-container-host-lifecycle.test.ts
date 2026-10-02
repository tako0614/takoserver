import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { createDockerHttpRevisionRuntime } from "../src/providers/docker-http-revision.ts";
import { createSelfhostContainerRuntime } from "../src/providers/selfhost-container-runtime.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import type { SigningKey } from "../src/token.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";
import {
  installLocalContainerCandidateForTest,
  loadVerifiedLocalContainerCandidate,
  SELFHOST_CONTAINER_CANDIDATE_SHA256,
} from "./fixtures/selfhost-container-host-authority.ts";

const CANDIDATE_PROVENANCE = {
  repository: "takoform-forms",
  baseCommit: "7ee6aee38484f75a6b334e24a34763b1d8a95b99",
  rendererSourceSha256: "bab247a1b4656d91b11970fb94dba71c2d97ebfe09f613a926f1fffc1bcf6884",
  artifactSha256: SELFHOST_CONTAINER_CANDIDATE_SHA256,
  coreValidation:
    "formpackage.ValidateDefinition + ValidatePackageIndex + VerifyDirectory in focused Go tests",
} as const;
const CANDIDATE = {
  publicationStatus: "UNPUBLISHED",
  contractClosure:
    "form-only; container.http Interface and module-worker.container-http Binding are withheld",
  formRef: {
    apiVersion: "edge.forms.takoform.com",
    kind: "ContainerService",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
  },
  packageDigest: "sha256:0fb3c53940180e3f661268e079f9dbc6667c4d1fbbc74b4561ebb5ffa2740d33",
  definition: {
    apiVersion: "edge.forms.takoform.com",
    kind: "ContainerService",
    definitionVersion: "0.1.0",
    title: "Container Service",
    description:
      "One logical private HTTP Container service identified by an OCI image pinned to a sha256 manifest digest. The Host provisions and operates exact execution revisions using Host Offering-owned capacity and placement; those are never customer desired fields. This Form-only local candidate does not publish caller-facing HTTP invocation; container.http and its Worker Binding remain a separate unresolved contract gap. The service exposes the declared HTTP port and health path. An update starts the exact requested workload revision, verifies health before moving serving traffic, and preserves the previous serving execution revision of the same Resource incarnation if startup or health fails. A lost operation acknowledgement is resolved by readback of the same resource UID, desired generation, and operation identity before retry; a mismatched identity is never adopted. Delete is fenced by the exact observed incarnation. Durable restart recovery reconciles persisted desired/observed generations and operation identity; it is not process-control through the request API. `requiredSensitiveVars` contains names only, never secret values. This initial local executable slice refuses any nonempty requiredSensitiveVars because the current Host API cannot supply secret material. `environment` is classified as ordinary nonsecret desired-state configuration and is persisted/read back as part of ResourceSpec. Callers MUST NOT put secrets in this field; the schema does not automatically detect or reject secret values. A separate sealed, generation-bound secret transport is not available. `outboundInternet` is explicitly false when omitted and becomes true only when requested.",
    role: "identity",
    requiresHostApi: "forms.takoform.com/v1",
    desiredSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      description:
        "One logical private HTTP Container service identified by an OCI image pinned to a sha256 manifest digest. The Host provisions and operates exact execution revisions using Host Offering-owned capacity and placement; those are never customer desired fields. This Form-only local candidate does not publish caller-facing HTTP invocation; container.http and its Worker Binding remain a separate unresolved contract gap. The service exposes the declared HTTP port and health path. An update starts the exact requested workload revision, verifies health before moving serving traffic, and preserves the previous serving execution revision of the same Resource incarnation if startup or health fails. A lost operation acknowledgement is resolved by readback of the same resource UID, desired generation, and operation identity before retry; a mismatched identity is never adopted. Delete is fenced by the exact observed incarnation. Durable restart recovery reconciles persisted desired/observed generations and operation identity; it is not process-control through the request API. `requiredSensitiveVars` contains names only, never secret values. This initial local executable slice refuses any nonempty requiredSensitiveVars because the current Host API cannot supply secret material. `environment` is classified as ordinary nonsecret desired-state configuration and is persisted/read back as part of ResourceSpec. Callers MUST NOT put secrets in this field; the schema does not automatically detect or reject secret values. A separate sealed, generation-bound secret transport is not available. `outboundInternet` is explicitly false when omitted and becomes true only when requested.",
      properties: {
        environment: {
          additionalProperties: { maxLength: 4096, pattern: "^[\\s\\S]*$", type: "string" },
          default: {},
          description:
            "At most 64 ordinary bounded desired-state strings persisted/read back as ResourceSpec. Callers MUST NOT put secrets here; automatic secret-value detection/rejection is not provided.",
          maxProperties: 64,
          propertyNames: {
            pattern: "^[A-Za-z][A-Za-z0-9._-]{0,63}$",
            type: "string",
            "x-takoform-fieldPolicy": "portable-data-only-v1",
          },
          type: "object",
        },
        healthPath: {
          description:
            "Absolute path used by the Host to establish readiness before an update is made serving.",
          maxLength: 2048,
          pattern:
            "^/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+(?:/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+)*$|^/$",
          type: "string",
        },
        httpPort: {
          description:
            "The private HTTP listener port inside the image; public port mapping and placement are Host-owned.",
          maximum: 65535,
          minimum: 1,
          type: "integer",
        },
        image: {
          description:
            "OCI image reference including its immutable sha256 manifest digest; mutable tags without a digest are refused.",
          maxLength: 512,
          pattern:
            "^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$",
          type: "string",
        },
        outboundInternet: {
          default: false,
          description:
            "Whether this workload may initiate outbound Internet connections. Omission means false.",
          type: "boolean",
        },
        requiredSensitiveVars: {
          default: [],
          description:
            "Names of required sensitive process variables only; values are supplied outside portable desired state. This initial executable local slice refuses a nonempty set.",
          items: { pattern: "^[A-Za-z][A-Za-z0-9._-]{0,63}$", type: "string" },
          maxItems: 64,
          type: "array",
          uniqueItems: true,
        },
        workloadRevision: {
          description:
            "Author-declared bounded revision identity for this desired workload; it is part of the exact operation fence, not a Host UID or generation.",
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          type: "string",
        },
      },
      required: ["healthPath", "httpPort", "image", "workloadRevision"],
      title: "Container Service desired state",
      type: "object",
    },
    lifecycleCapabilities: ["create", "read", "update", "delete", "observe"],
    conformanceFixtures: [{ name: "canonical", desiredPath: "fixtures/desired.json" }],
    negativeConformanceFixtures: [
      {
        name: "reject-unexpected-property",
        stage: "desired",
        inputPath: "fixtures/negative-unexpected-property.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-missing-image",
        stage: "desired",
        inputPath: "fixtures/negative-missing-image.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-missing-http-port",
        stage: "desired",
        inputPath: "fixtures/negative-missing-http-port.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-missing-health-path",
        stage: "desired",
        inputPath: "fixtures/negative-missing-health-path.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-missing-workload-revision",
        stage: "desired",
        inputPath: "fixtures/negative-missing-workload-revision.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-image",
        stage: "desired",
        inputPath: "fixtures/negative-image.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-http-port",
        stage: "desired",
        inputPath: "fixtures/negative-http-port.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-health-path",
        stage: "desired",
        inputPath: "fixtures/negative-health-path.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-environment",
        stage: "desired",
        inputPath: "fixtures/negative-environment.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-workload-revision",
        stage: "desired",
        inputPath: "fixtures/negative-workload-revision.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-required-sensitive-vars",
        stage: "desired",
        inputPath: "fixtures/negative-required-sensitive-vars.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-sensitive-requirement-values-not-names",
        stage: "desired",
        inputPath: "fixtures/negative-sensitive-requirement-values-not-names.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-http-port-out-of-range",
        stage: "desired",
        inputPath: "fixtures/negative-http-port-out-of-range.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-environment-value-too-long",
        stage: "desired",
        inputPath: "fixtures/negative-environment-value-too-long.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-registry-port-out-of-range",
        stage: "desired",
        inputPath: "fixtures/negative-registry-port-out-of-range.json",
        expectedFailure: "schema_validation_failed",
      },
      {
        name: "reject-health-path-empty-segment",
        stage: "desired",
        inputPath: "fixtures/negative-health-path-empty-segment.json",
        expectedFailure: "schema_validation_failed",
      },
    ],
  },
  desired: {
    environment: {
      "APP.MODE": "production",
      APP_MODE: "standard",
    },
    healthPath: "/health",
    httpPort: 8080,
    image:
      "ghcr.io/example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    outboundInternet: false,
    requiredSensitiveVars: [],
    workloadRevision: "revision-1",
  },
} as const;
const ORIGIN = "https://container-host.test";
const FORM_REF = CANDIDATE.formRef;
const OFFERING_ID = "selfhost.container.http.standard";
const INSTALLATION_ID = "local.primary";
const LONG_HEALTH_PATH = `/${"a".repeat(1100)}`;
const workerLeases: ProviderRuntimeInputLeasePort = {
  async acquire(): Promise<never> {
    throw new Error("ContainerService must not acquire a Worker runtime-input lease");
  },
  async recover(): Promise<never> {
    throw new Error("ContainerService must not recover a Worker runtime-input lease");
  },
  async abandon() {},
};

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

async function http(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
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
  if (response.status !== status) {
    throw new Error(`expected HTTP ${status}, received ${response.status}: ${text}`);
  }
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function dockerFixture() {
  const containers = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let sequence = 0;
  let loseNextCreateAck = false;
  const network = {
    Name: "host-test-net",
    Driver: "bridge",
    Scope: "local",
    Internal: true,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": INSTALLATION_ID },
  };
  const engine = async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const url = new URL(path, "http://docker.invalid");
    if (method === "GET" && url.pathname === "/networks/host-test-net") {
      return { status: 200, body: JSON.stringify(network) };
    }
    if (url.pathname === "/images/create") {
      return { status: 200, body: `${JSON.stringify({ status: "done" })}\n` };
    }
    if (method === "POST" && url.pathname === "/containers/create" && body) {
      const name = url.searchParams.get("name");
      if (!name || body.Image === undefined || body.Labels === undefined) {
        throw new Error("invalid Docker create request");
      }
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
        NetworkSettings: { Networks: { "host-test-net": { IPAddress: "172.22.0.10" } } },
      });
      if (loseNextCreateAck) {
        loseNextCreateAck = false;
        throw new Error("simulated lost Docker create acknowledgement");
      }
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
      containers.set(name, { ...current, State: { Running: true } });
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
    throw new Error(`unexpected Docker request ${method} ${url.pathname}`);
  };
  const options = {
    socketPath: "/var/run/docker.sock",
    installationId: INSTALLATION_ID,
    network: "host-test-net",
    maxMemoryBytes: 512 * 1024 * 1024,
    maxNanoCpus: 1_000_000_000,
    pidsLimit: 64,
    engine,
    healthFetch: async () => new Response("ok", { status: 200 }),
  };
  return {
    containers,
    calls,
    options,
    loseCreateAck() {
      loseNextCreateAck = true;
    },
  };
}

test("publisher-emitted unpublished Form selects the Host Offering for a normal quote and create", async () => {
  expect(CANDIDATE.publicationStatus).toBe("UNPUBLISHED");
  expect(CANDIDATE.contractClosure).toStartWith("form-only;");
  expect(CANDIDATE_PROVENANCE.artifactSha256).toBe(
    "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2",
  );

  const localCandidate = await loadVerifiedLocalContainerCandidate(
    join(import.meta.dir, "fixtures/selfhost-container-service-candidate.json"),
  );
  expect(localCandidate.form.identity.formRef).toEqual(FORM_REF);
  expect(localCandidate.form.desiredSchema).toEqual(CANDIDATE.definition.desiredSchema);
  const form = localCandidate.form;

  const root = mkdtempSync(join(tmpdir(), "container-host-red-"));
  let database = new Database(join(root, "control.sqlite"));
  const docker = dockerFixture();
  const backend = createDockerHttpRevisionRuntime(docker.options);
  let containerRuntime = await createSelfhostContainerRuntime({
    root: join(root, "runtime"),
    backend,
    drainTimeoutMs: 1_000,
  });
  try {
    migrateSqlite(database);
    let sql = createSqliteSql(database);
    const signingPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    const publicJwk = await crypto.subtle.exportKey("jwk", signingPair.publicKey);
    await sql.run(
      "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
      [
        "container-host-test",
        JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
        0,
      ],
    );
    const signingKey: SigningKey = {
      keyId: "container-host-test",
      privateKey: signingPair.privateKey,
    };
    const objects = createMemoryObjectStore();
    const now = new Date("2026-10-02T00:00:00.000Z");
    const candidates = currentTakoformCandidates();
    const forms = [...candidates.forms, form];
    const providerArtifacts = {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    };
    const edge = await buildEdgeForms();
    const makeApp = (
      currentSql: ReturnType<typeof createSqliteSql>,
      runtime: typeof containerRuntime,
    ) => {
      const artifacts = createTakoformArtifacts({
        sql: currentSql,
        objects,
        clock: () => now,
        randomId: () => crypto.randomUUID(),
      });
      const composition = createStandaloneProviderComposition({
        mode: "stable-selfhost",
        stableForms: forms,
        edge,
        dataRoot: join(root, "provider"),
        runtime: workerd,
        container: {
          runtime,
          capacityProfile: {
            id: OFFERING_ID,
            memoryBytes: 256 * 1024 * 1024,
            nanoCpus: 500_000_000,
            pidsLimit: 64,
          },
        },
        runtimeInputs: workerLeases,
        workerRuntimeAvailable: false,
        artifacts: providerArtifacts,
        now,
      });
      return buildApp({
        sql: currentSql,
        objects,
        publicOrigin: ORIGIN,
        clock: () => now,
        forms,
        bindings: candidates.bindings,
        hostForms: forms,
        hostBindings: candidates.bindings,
        ...composition,
        artifacts,
        identity: {
          async verify() {
            return {
              providerSubject: "container-owner",
              email: "container-owner@example.test",
              displayName: "Container owner",
            };
          },
        },
        settlement: {
          async verify() {
            throw new Error("zero-cost local Offering must not require settlement");
          },
        },
        signingKey,
      });
    };
    let app = makeApp(sql, containerRuntime);

    const session = await http(app, "POST", "/v1/sessions", 200, {
      provider: "google",
      assertion: "synthetic-local-identity",
    });
    const owner = {
      authorization: `Bearer ${String((session.body as { sessionToken: string }).sessionToken)}`,
    };
    const organizationResult = await http(
      app,
      "POST",
      "/v1/organizations",
      201,
      {
        name: "Container lifecycle",
      },
      owner,
    );
    const organizationId = String(
      (organizationResult.body as { organization: { id: string } }).organization.id,
    );
    const keyResult = await http(
      app,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      201,
      {
        name: "container-lifecycle",
        scopes: ["reseller:write", "catalog:read", "wallet:read"],
        expiresInSeconds: 3600,
      },
      owner,
    );
    const key = {
      authorization: `Bearer ${String((keyResult.body as { secret: string }).secret)}`,
    };
    const resourceWriterResult = await http(
      app,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      201,
      {
        name: "container-resource-writer",
        scopes: ["resources:read", "resources:write"],
        expiresInSeconds: 3600,
      },
      owner,
    );
    const resourceWriter = {
      authorization: `Bearer ${String((resourceWriterResult.body as { secret: string }).secret)}`,
    };
    const catalog = await http(
      app,
      "GET",
      `/v1/catalog?organizationId=${organizationId}`,
      200,
      undefined,
      key,
    );
    expect(
      (catalog.body as { offerings: { id: string; form: { kind: string } }[] }).offerings.some(
        (offering) => offering.id === OFFERING_ID && offering.form.kind === FORM_REF.kind,
      ),
    ).toBe(true);

    const quote = await http(
      app,
      "POST",
      "/v1/reseller/quotes",
      201,
      { tenantRef: "tenant_container", offeringId: OFFERING_ID, quantity: 1 },
      key,
    );
    const reservation = await http(
      app,
      "POST",
      "/v1/reseller/reservations",
      201,
      {
        tenantRef: "tenant_container",
        quoteId: String((quote.body as { quote: { id: string } }).quote.id),
      },
      key,
    );
    const reservationId = String(
      (reservation.body as { reservation: { id: string } }).reservation.id,
    );
    const issued = await http(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      201,
      { tenantRef: "tenant_container", resourceName: "service", expiresInSeconds: 600 },
      key,
    );
    const bearer = {
      authorization: `Bearer ${String(
        (issued.body as { takoformRunToken: { token: string } }).takoformRunToken.token,
      )}`,
    };
    const desired = {
      apiVersion: FORM_REF.apiVersion,
      kind: FORM_REF.kind,
      form: { formRef: FORM_REF },
      metadata: { space: "tenant_container", name: "service" },
      spec: { ...CANDIDATE.desired, healthPath: LONG_HEALTH_PATH },
    };
    const uninstalledRefusal = await http(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      404,
      desired,
      bearer,
    );
    expect(uninstalledRefusal.body).toMatchObject({ error: { code: "form_unknown" } });
    expect(docker.calls).toHaveLength(0);

    await installLocalContainerCandidateForTest({
      sql,
      objects,
      hostId: ORIGIN,
      candidate: localCandidate,
    });
    app = makeApp(sql, containerRuntime);
    const prepared = await http(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      desired,
      bearer,
    );
    const query = new URLSearchParams({
      space: "tenant_container",
      definitionVersion: FORM_REF.definitionVersion,
      schemaDigest: FORM_REF.schemaDigest,
    });
    const createRequestBody = {
      ...desired,
      review: {
        prepareDigest: String(
          (prepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const createRequestHeaders = {
      ...bearer,
      "idempotency-key": "container-create-1",
      "if-none-match": "*",
    };
    try {
      const lostCreateAcknowledgement = await app.fetch(
        new Request(
          new URL(
            `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`,
            ORIGIN,
          ),
          {
            method: "PUT",
            headers: {
              ...createRequestHeaders,
              "content-type": "application/json",
            },
            body: JSON.stringify(createRequestBody),
          },
        ),
      );
      // Deliberately drop the complete Host response as an acknowledgement
      // fault; only the exact original request is replayed after reopening
      // SQLite and the runtime journal below.
      const droppedStatus = lostCreateAcknowledgement.status;
      const droppedBody = await lostCreateAcknowledgement.text();
      if (droppedStatus !== 201) {
        throw new Error(
          `create effect was not acknowledged before simulated loss: ${droppedStatus} ${droppedBody}`,
        );
      }
    } catch (error) {
      throw new Error(`${String(error)}; dockerCalls=${JSON.stringify(docker.calls)}`);
    }
    expect(docker.containers.size).toBe(1);
    await containerRuntime.close();
    database.close();
    database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    sql = createSqliteSql(database);
    containerRuntime = await createSelfhostContainerRuntime({
      root: join(root, "runtime"),
      backend,
      drainTimeoutMs: 1_000,
    });
    app = makeApp(sql, containerRuntime);
    const applied = await http(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`,
      201,
      createRequestBody,
      createRequestHeaders,
    );
    const createCalls = docker.calls.filter((call) => call.path.startsWith("/containers/create"));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.body?.Env).toContain("APP.MODE=production");
    const created = applied.body as {
      metadata: { uid: string; generation: string; revision: string };
      spec: Record<string, unknown>;
    };
    expect(created.metadata.generation).toBe("1");
    expect(created.spec).toMatchObject({ ...CANDIDATE.desired, healthPath: LONG_HEALTH_PATH });
    const resourcePath = `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service?${query}`;
    await http(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/capture`,
      200,
      { tenantRef: "tenant_container", usage: { quantity: 1 } },
      key,
    );
    const manageIssued = await http(
      app,
      "POST",
      `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
      201,
      {
        tenantRef: "tenant_container",
        resourceName: "service",
        resourceUid: created.metadata.uid,
        expiresInSeconds: 600,
      },
      key,
    );
    const manager = {
      authorization: `Bearer ${String(
        (manageIssued.body as { takoformRunToken: { token: string } }).takoformRunToken.token,
      )}`,
    };
    const observed = await http(app, "GET", resourcePath, 200, undefined, manager);
    expect(observed.body).toMatchObject({ metadata: { uid: created.metadata.uid } });
    expect(docker.calls.some((call) => call.path === "/containers/create")).toBe(false);
    const nativeCallsBeforeSensitiveRefusal = docker.calls.length;
    const sensitiveDesired = {
      ...desired,
      spec: { ...CANDIDATE.desired, requiredSensitiveVars: ["API_TOKEN"] },
    };
    const sensitivePrepared = await http(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      sensitiveDesired,
      { ...manager, "takoform-expected-generation": created.metadata.generation },
    );
    const sensitiveRefusal = await http(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`,
      422,
      {
        ...sensitiveDesired,
        expectedUid: created.metadata.uid,
        expectedGeneration: created.metadata.generation,
        review: {
          prepareDigest: String(
            (sensitivePrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
          ),
        },
      },
      {
        ...manager,
        "idempotency-key": "container-sensitive-refusal-1",
        "if-match": `"${created.metadata.revision}"`,
        "takoform-expected-generation": created.metadata.generation,
      },
    );
    expect(sensitiveRefusal.body).toMatchObject({
      error: { code: "unsupported_capability" },
    });
    expect(docker.calls).toHaveLength(nativeCallsBeforeSensitiveRefusal);

    const updatedDesired = {
      ...desired,
      spec: {
        ...CANDIDATE.desired,
        image: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
        workloadRevision: "revision-2",
      },
    };
    const updatePrepared = await http(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      updatedDesired,
      { ...manager, "takoform-expected-generation": created.metadata.generation },
    );
    const updated = await http(
      app,
      "PUT",
      `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`,
      200,
      {
        ...updatedDesired,
        review: {
          prepareDigest: String(
            (updatePrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
          ),
        },
      },
      {
        ...manager,
        "idempotency-key": "container-update-1",
        "if-match": `"${created.metadata.revision}"`,
        "takoform-expected-generation": created.metadata.generation,
      },
    );
    expect(updated.body).toMatchObject({
      metadata: { uid: created.metadata.uid, generation: "2" },
    });
    expect(docker.containers.size).toBe(2);
    expect(docker.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
      2,
    );
    const runtimeRoot = join(root, "runtime");
    const journalFiles = readdirSync(runtimeRoot).filter((name) => name.endsWith(".json"));
    expect(journalFiles).toHaveLength(1);
    const journalPath = join(runtimeRoot, journalFiles[0] as string);
    const retainedJournal = readFileSync(journalPath);
    const nativeDeleteCallsBeforeFinalDelete = docker.calls.filter(
      (call) => call.method === "DELETE",
    ).length;
    const nativeObjectsBeforeMissingJournalDelete = docker.containers.size;
    const deleteHeaders = {
      ...manager,
      "idempotency-key": "container-delete-1",
      "takoform-expected-generation": "2",
    };
    await containerRuntime.close();
    database.close();
    unlinkSync(journalPath);
    database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    sql = createSqliteSql(database);
    containerRuntime = await createSelfhostContainerRuntime({
      root: runtimeRoot,
      backend,
      drainTimeoutMs: 1_000,
    });
    app = makeApp(sql, containerRuntime);
    const resourceObservePath = `${resourcePath.slice(0, resourcePath.indexOf("?"))}/observe?${query}`;
    const missingJournalObservation = await app.fetch(
      new Request(new URL(resourceObservePath, ORIGIN), {
        method: "POST",
        headers: {
          ...manager,
          "takoform-expected-generation": "2",
        },
      }),
    );
    expect(missingJournalObservation.status).toBe(503);
    expect(docker.containers.size).toBe(nativeObjectsBeforeMissingJournalDelete);
    expect(docker.calls.filter((call) => call.method === "DELETE")).toHaveLength(
      nativeDeleteCallsBeforeFinalDelete,
    );
    await containerRuntime.close();
    database.close();
    writeFileSync(journalPath, retainedJournal, { mode: 0o600 });
    chmodSync(journalPath, 0o600);
    database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    sql = createSqliteSql(database);
    containerRuntime = await createSelfhostContainerRuntime({
      root: runtimeRoot,
      backend,
      drainTimeoutMs: 1_000,
    });
    app = makeApp(sql, containerRuntime);

    const droppedDeleteAcknowledgement = await app.fetch(
      new Request(new URL(resourcePath, ORIGIN), {
        method: "DELETE",
        headers: deleteHeaders,
      }),
    );
    const droppedDeleteStatus = droppedDeleteAcknowledgement.status;
    const droppedDeleteBody = await droppedDeleteAcknowledgement.text();
    if (droppedDeleteStatus !== 204) {
      throw new Error(
        `delete did not complete after journal restore: ${droppedDeleteStatus} ${droppedDeleteBody}`,
      );
    }
    expect(docker.containers.size).toBe(0);
    await containerRuntime.close();
    database.close();
    database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    sql = createSqliteSql(database);
    containerRuntime = await createSelfhostContainerRuntime({
      root: runtimeRoot,
      backend,
      drainTimeoutMs: 1_000,
    });
    app = makeApp(sql, containerRuntime);
    const replayedDelete = await http(app, "DELETE", resourcePath, 204, undefined, deleteHeaders);
    expect(replayedDelete.status).toBe(204);
    expect(docker.calls.filter((call) => call.method === "DELETE")).toHaveLength(
      nativeDeleteCallsBeforeFinalDelete + nativeObjectsBeforeMissingJournalDelete,
    );
    expect(docker.containers.size).toBe(0);

    const spentProvisionReplay = await app.fetch(
      new Request(
        new URL(
          `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service`,
          ORIGIN,
        ),
        {
          method: "PUT",
          headers: {
            ...createRequestHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(createRequestBody),
        },
      ),
    );
    expect(spentProvisionReplay.status).toBe(401);
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
      2,
    );

    const replayQuote = await http(
      app,
      "POST",
      "/v1/reseller/quotes",
      201,
      { tenantRef: "tenant_container", offeringId: OFFERING_ID, quantity: 1 },
      key,
    );
    const replayReservation = await http(
      app,
      "POST",
      "/v1/reseller/reservations",
      201,
      {
        tenantRef: "tenant_container",
        quoteId: String((replayQuote.body as { quote: { id: string } }).quote.id),
      },
      key,
    );
    const replayReservationId = String(
      (replayReservation.body as { reservation: { id: string } }).reservation.id,
    );
    const replayIssued = await http(
      app,
      "POST",
      `/v1/reseller/reservations/${replayReservationId}/takoform-run-tokens`,
      201,
      { tenantRef: "tenant_container", resourceName: "service-replay", expiresInSeconds: 600 },
      key,
    );
    const replayBearer = {
      authorization: `Bearer ${String(
        (replayIssued.body as { takoformRunToken: { token: string } }).takoformRunToken.token,
      )}`,
    };
    const replayDesired = {
      ...desired,
      metadata: { space: "tenant_container", name: "service-replay" },
    };
    const replayPrepared = await http(
      app,
      "POST",
      "/apis/forms.takoform.com/v1/resources/prepare",
      200,
      replayDesired,
      replayBearer,
    );
    const replayCreateBody = {
      ...replayDesired,
      review: {
        prepareDigest: String(
          (replayPrepared.body as { review: { prepareDigest: string } }).review.prepareDigest,
        ),
      },
    };
    const replayCreateHeaders = {
      ...replayBearer,
      "idempotency-key": "container-create-replay-1",
      "if-none-match": "*",
    };
    const replayCreatePath = `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service-replay`;
    const replayCreated = await http(
      app,
      "PUT",
      replayCreatePath,
      201,
      replayCreateBody,
      replayCreateHeaders,
    );
    const replayCreatedMetadata = (
      replayCreated.body as {
        metadata: { uid: string; generation: string; revision: string };
      }
    ).metadata;
    expect(docker.containers.size).toBe(1);
    const ownerDelete = await http(app, "DELETE", `${replayCreatePath}?${query}`, 204, undefined, {
      ...resourceWriter,
      "idempotency-key": "container-owner-delete-before-capture",
      "if-match": `"${replayCreatedMetadata.revision}"`,
      "takoform-expected-generation": replayCreatedMetadata.generation,
    });
    expect(ownerDelete.status).toBe(204);
    expect(docker.containers.size).toBe(0);
    const replayAfterOwnerDelete = await app.fetch(
      new Request(
        new URL(
          `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service-replay`,
          ORIGIN,
        ),
        {
          method: "PUT",
          headers: {
            ...replayCreateHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(replayCreateBody),
        },
      ),
    );
    expect(replayAfterOwnerDelete.status).toBe(404);
    expect(docker.containers.size).toBe(0);
    const changedReplay = {
      ...replayCreateBody,
      spec: { ...replayCreateBody.spec, workloadRevision: "revision-replay-changed" },
    };
    const changedReplayResponse = await app.fetch(
      new Request(
        new URL(
          `/apis/forms.takoform.com/v1/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/service-replay`,
          ORIGIN,
        ),
        {
          method: "PUT",
          headers: {
            ...replayCreateHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(changedReplay),
        },
      ),
    );
    expect(changedReplayResponse.status).toBe(404);
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.filter((call) => call.path.startsWith("/containers/create"))).toHaveLength(
      3,
    );
  } finally {
    await containerRuntime.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
