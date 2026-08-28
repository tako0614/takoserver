import { describe, expect, spyOn, test } from "bun:test";
import { buildEdgeForms, edgeProviderOffering } from "../src/edge-forms.ts";
import type { JsonObject } from "../src/ports.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import {
  type ArtifactBytes,
  CloudflareProvider,
  type CloudflareZone,
} from "../src/providers/cloudflare.ts";

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
} as const;

function offering(id: string, kind: string): ProviderOffering {
  return {
    id,
    kind,
    displayName: id,
    form:
      kind === "worker_script"
        ? {
            apiVersion: "edge.forms.takoform.com/v1beta1",
            kind: "WorkerVersion",
            definitionVersion: "0.1.0",
            schemaDigest: "sha256:22fde31c0b695ca59f5c46230c1ed03d6a6f53c01015d4a5acf6bdb0ed70b50c",
          }
        : FORM_REF,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "observe", "import"],
  };
}

const BUCKET = offering("storage.object.standard", "object_bucket");
const DATABASE = offering("db.sql.standard", "sql_database");
const WORKER = offering("compute.worker.standard", "worker_script");

const IDENTITY = { tenantRef: "org_acme", space: "default", name: "assets" };

const MODULE_BYTES = new TextEncoder().encode("export default { fetch() {} }");

const ASSET_BUNDLE = `sha256:${"c".repeat(64)}`;

const artifacts: ArtifactBytes = {
  async manifest(_tenantRef, digest) {
    if (digest === `sha256:${"d".repeat(64)}`) {
      return {
        kind: "WorkerBundle",
        mainModule: "index.js",
        modules: [
          {
            name: "index.js",
            mediaType: "application/javascript+module",
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      };
    }
    if (digest === ASSET_BUNDLE) {
      return {
        kind: "StaticAssetBundle",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            size: MODULE_BYTES.byteLength,
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      };
    }
    return null;
  },
  async blob(digest) {
    return digest === `sha256:${"e".repeat(64)}` ? MODULE_BYTES : null;
  },
};

const RELEASED_EDGE = await buildEdgeForms();

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string;
}

function recorder(
  responses: readonly { status: number; body: unknown }[],
  extraZones: readonly CloudflareZone[] = [],
) {
  const calls: Call[] = [];
  let index = 0;
  const provider = new CloudflareProvider({
    accountId: "acct_1",
    offerings: [BUCKET, DATABASE, WORKER],
    artifacts,
    zones: [
      ...extraZones,
      {
        suffix: "apps.takoserver.test",
        zoneId: "zone_platform",
        singleLabel: true,
        reservedLabels: ["www", "api"],
      },
      { suffix: "acme.example", zoneId: "zone_acme", tenantRef: "org_acme" },
    ],
    authorize: () => "Bearer secret-account-token",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    async fetch(request) {
      const body = await request.clone().text();
      calls.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        body,
      });
      const next = responses[Math.min(index++, responses.length - 1)] ?? {
        status: 200,
        body: { success: true, errors: [], result: {} },
      };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { provider, calls };
}

describe("Cloudflare provider", () => {
  test("dispatches an explicitly installed stable ModuleWorker offering", async () => {
    const calls: Call[] = [];
    const stable: ProviderOffering = {
      ...offering("stable-worker", "worker_script"),
      kind: "takoform.ModuleWorker",
      form: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ModuleWorker",
        definitionVersion: "0.2.0",
        schemaDigest: `sha256:${"1".repeat(64)}` as `sha256:${string}`,
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [stable],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        return Response.json({ success: true, errors: [], result: {} });
      },
    });

    const ticket = await provider.apply({
      operationId: "op_stable_worker",
      offering: stable,
      identity: { ...IDENTITY, name: "stable-worker" },
      spec: {},
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: expect.stringMatching(/^worker:/) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/workers/scripts/");
  });

  test("derives a backend name instead of trusting the customer's", async () => {
    const { provider, calls } = recorder([
      {
        status: 200,
        body: { success: true, errors: [], result: { name: "ts-x" } },
      },
    ]);
    const ticket = await provider.apply({
      operationId: "op_1",
      offering: BUCKET,
      identity: IDENTITY,
      spec: { location: "apac" },
    });
    expect(ticket.phase).toBe("succeeded");
    if (ticket.phase !== "succeeded") throw new Error("expected success");

    // Two organizations may both call a bucket "assets"; Cloudflare names are
    // account-global, so the name is derived from the whole address.
    expect(ticket.result.nativeId).toMatch(/^r2:ts-[0-9a-f]{40}$/u);
    expect(calls[0]?.body).not.toContain("assets");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      locationHint: "apac",
    });
  });

  test("publishes a Worker from a committed bundle as a multipart upload", async () => {
    const { provider, calls } = recorder([
      {
        status: 200,
        body: { success: true, errors: [], result: { id: "script" } },
      },
    ]);
    const ticket = await provider.apply({
      operationId: "op_2",
      offering: WORKER,
      identity: { ...IDENTITY, name: "yurucommu" },
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        compatibilityDate: "2026-08-17",
        compatibilityFlags: ["nodejs_compat"],
        bindings: [
          { type: "d1", name: "DB", databaseId: "uuid-1" },
          { type: "r2_bucket", name: "OBJECTS", bucketName: "ts-abc" },
          { type: "secret_text", name: "SNEAKY", text: "nope" },
        ],
        hostnames: ["yurucommu.apps.takoserver.test"],
      },
    });
    expect(ticket.phase).toBe("succeeded");
    if (ticket.phase !== "succeeded") throw new Error("expected success");
    expect(ticket.result.outputs).toMatchObject({
      url: "https://yurucommu.apps.takoserver.test",
    });
    // The route is attached, not merely promised in an output field.
    const attach = calls[1];
    expect(attach?.method).toBe("PUT");
    expect(attach?.url).toContain("/workers/domains");
    expect(JSON.parse(attach?.body ?? "{}")).toMatchObject({
      zone_id: "zone_platform",
      hostname: "yurucommu.apps.takoserver.test",
    });

    const upload = calls[0];
    expect(upload?.method).toBe("PUT");
    expect(upload?.url).toContain("/workers/scripts/");
    expect(upload?.body).toContain("index.js");
    expect(upload?.body).toContain("nodejs_compat");
    expect(upload?.body).toContain("export default");
    // Only binding kinds the product understands are forwarded, so a bundle
    // cannot ask for reach its Form never offered.
    expect(upload?.body).toContain('"name":"DB"');
    expect(upload?.body).not.toContain("SNEAKY");
    // An upload replaces the binding set, so secrets the operator set must be
    // explicitly preserved or a deploy would quietly delete them.
    expect(upload?.body).toContain('"keep_bindings":["secret_text"]');
  });

  test("creates Durable Object classes in the upload that binds them", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: {} } },
    ]);
    const ticket = await provider.apply({
      operationId: "op_do",
      offering: WORKER,
      identity: { ...IDENTITY, name: "stateful" },
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        durableObjects: [
          { name: "SESSIONS", className: "SessionDO" },
          { name: "LIMITS", className: "RateLimiterDO", storage: "key-value" },
        ],
      },
    });
    expect(ticket.phase).toBe("succeeded");

    const metadata = calls[0]?.body ?? "";
    // Binding and migration travel together: a script bound to a class that
    // was never created is rejected outright.
    expect(metadata).toContain('"type":"durable_object_namespace"');
    expect(metadata).toContain('"class_name":"SessionDO"');
    // One migration object, not a list: the list form belongs to the
    // multi-script API and is rejected outright here.
    expect(metadata).toMatch(/"migrations":\{/u);
    expect(metadata).toContain('"new_sqlite_classes":["SessionDO"]');
    expect(metadata).toContain('"new_classes":["RateLimiterDO"]');
  });

  test("does not re-create Durable Object classes an update already has", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: {} } },
    ]);
    await provider.apply({
      operationId: "op_do2",
      offering: WORKER,
      identity: { ...IDENTITY, name: "stateful" },
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        durableObjects: [{ name: "SESSIONS", className: "SessionDO" }],
      },
      previous: {
        nativeId: "worker:tsw-existing",
        spec: {
          bundle: `sha256:${"d".repeat(64)}`,
          durableObjects: [{ name: "SESSIONS", className: "SessionDO" }],
        },
      },
    });
    // Re-declaring an existing class would ask Cloudflare to create something
    // that already holds state.
    expect(calls[0]?.body ?? "").not.toContain("migrations");
  });

  test("refuses a hostname no configured zone serves", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: {} } },
    ]);
    const ticket = await provider.apply({
      operationId: "op_host",
      offering: WORKER,
      identity: { ...IDENTITY, name: "squatter" },
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["www.somebody-elses-domain.test"],
      },
    });
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure.code).toBe("invalid_spec");
    // The script uploaded, but no route was attached to a domain the tenant
    // never proved it controls.
    expect(calls.filter((call) => call.url.includes("/workers/domains"))).toHaveLength(0);
  });

  test("keeps a tenant zone to the tenant it belongs to", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: {} } },
    ]);
    const ticket = await provider.apply({
      operationId: "op_zone",
      offering: WORKER,
      identity: { tenantRef: "org_other", space: "default", name: "app" },
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["app.acme.example"],
      },
    });
    expect(ticket.phase).toBe("failed");
    expect(calls.filter((call) => call.url.includes("/workers/domains"))).toHaveLength(0);
  });

  test("keeps reserved names and certificate-depth rules out of tenant hands", async () => {
    for (const hostname of [
      // A name a visitor would read as the platform's own.
      "www.apps.takoserver.test",
      "api.apps.takoserver.test",
      // Two levels below the suffix: a universal certificate would not cover
      // it, so the address would resolve and then fail to negotiate TLS.
      "deep.nested.apps.takoserver.test",
      // The zone apex itself is not a tenant's to take.
      "apps.takoserver.test",
    ]) {
      const { provider, calls } = recorder([
        { status: 200, body: { success: true, errors: [], result: {} } },
      ]);
      const ticket = await provider.apply({
        operationId: "op_reserved",
        offering: WORKER,
        identity: IDENTITY,
        spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: [hostname] },
      });
      expect(ticket.phase).toBe("failed");
      expect(calls.filter((call) => call.url.includes("/workers/domains"))).toHaveLength(0);
    }
  });

  /**
   * A domain someone brought with them is only useful at its apex. `example.com`
   * with nothing in front of it is the address a customer actually wants, and a
   * console or a marketing site that can only live at `www.` is a product
   * limitation dressed up as a rule. A shared platform zone still refuses its
   * own apex, because that name is the platform rather than anyone's to take.
   */
  test("serves the apex of a zone that offers it", async () => {
    const { provider, calls } = recorder(
      [
        { status: 200, body: { success: true, errors: [], result: {} } },
        { status: 200, body: { success: true, errors: [], result: {} } },
      ],
      [
        {
          suffix: "brought.example",
          zoneId: "zone_brought",
          tenantRef: "org_acme",
          apex: true,
        },
      ],
    );
    const ticket = await provider.apply({
      operationId: "op_apex",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["brought.example"],
      },
    });
    expect(ticket.phase).toBe("succeeded");
    const attached = calls.find((call) => call.url.includes("/workers/domains"));
    expect(JSON.parse(String(attached?.body))).toMatchObject({
      zone_id: "zone_brought",
      hostname: "brought.example",
    });
  });

  test("refuses the apex of a zone that does not offer it", async () => {
    const { provider, calls } = recorder(
      [{ status: 200, body: { success: true, errors: [], result: {} } }],
      [
        {
          suffix: "shared.example",
          zoneId: "zone_shared",
          tenantRef: "org_acme",
        },
      ],
    );
    const ticket = await provider.apply({
      operationId: "op_apex_refused",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["shared.example"],
      },
    });
    expect(ticket.phase).toBe("failed");
    expect(calls.filter((call) => call.url.includes("/workers/domains"))).toHaveLength(0);
  });

  test("refuses to publish a bundle the tenant does not hold", async () => {
    const { provider, calls } = recorder([]);
    const ticket = await provider.apply({
      operationId: "op_3",
      offering: WORKER,
      identity: IDENTITY,
      spec: { bundle: `sha256:${"f".repeat(64)}` },
    });
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure.code).toBe("invalid_spec");
    // Nothing was attempted against the backend.
    expect(calls).toHaveLength(0);
  });

  test("classifies backend refusals without repeating their words", async () => {
    for (const [status, code] of [
      [401, "denied"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "quota"],
      [500, "unavailable"],
    ] as const) {
      const { provider } = recorder([
        {
          status,
          body: {
            success: false,
            errors: [{ message: "internal cloudflare detail" }],
          },
        },
      ]);
      const ticket = await provider.apply({
        operationId: `op_${status}`,
        offering: BUCKET,
        identity: IDENTITY,
        spec: {},
      });
      expect(ticket.phase).toBe("failed");
      if (ticket.phase !== "failed") throw new Error("expected failure");
      expect(ticket.failure.code).toBe(code);
      expect(ticket.failure.message).not.toContain("cloudflare detail");
    }
  });

  test("treats an already absent resource as deleted", async () => {
    const { provider } = recorder([{ status: 404, body: { success: false, errors: [] } }]);
    const ticket = await provider.delete({
      operationId: "op_4",
      offering: BUCKET,
      nativeId: "r2:ts-abc",
      identity: IDENTITY,
    });
    expect(ticket.phase).toBe("succeeded");
  });

  test("reports a database identifier the caller can bind to", async () => {
    const { provider } = recorder([
      {
        status: 200,
        body: { success: true, errors: [], result: { uuid: "db-uuid-1" } },
      },
    ]);
    const ticket = await provider.apply({
      operationId: "op_5",
      offering: DATABASE,
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket.phase).toBe("succeeded");
    if (ticket.phase !== "succeeded") throw new Error("expected success");
    expect(ticket.result.outputs).toMatchObject({ databaseId: "db-uuid-1" });
  });

  test("reports an unreachable backend as retryable", async () => {
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [BUCKET],
      artifacts,
      authorize: () => "Bearer token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch() {
        throw new TypeError("connection reset");
      },
    });
    const ticket = await provider.apply({
      operationId: "op_6",
      offering: BUCKET,
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket.phase).toBe("failed");
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});

describe("released edge Form placement", () => {
  const edge = RELEASED_EDGE;
  const form = (kind: string) => {
    const found = edge.forms.find((candidate) => candidate.identity.formRef.kind === kind);
    if (!found) throw new Error(`missing released Form: ${kind}`);
    return found;
  };
  const technical = (kind: string) =>
    edgeProviderOffering(form(kind), {
      id: `cloudflare.edge.${kind}`,
      regions: ["global"],
    });

  test("creates the provider-backed identity Forms without inventing their schema", async () => {
    const offerings = [
      technical("ModuleWorker"),
      technical("EdgeKVNamespace"),
      technical("SQLiteDatabase"),
      technical("AtLeastOnceQueue"),
    ];
    const calls: Call[] = [];
    const responses = [
      {},
      { id: "kv-id" },
      { uuid: "database-id", name: "database-name" },
      { queue_id: "queue-id", queue_name: "queue-name" },
    ];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings,
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        return Response.json({
          success: true,
          errors: [],
          result: responses[calls.length - 1],
        });
      },
    });
    const worker = await provider.apply({
      operationId: "op-worker",
      offering: offerings[0] as ProviderOffering,
      identity: { ...IDENTITY, name: "api" },
      spec: {},
    });
    expect(worker.phase).toBe("succeeded");
    expect(worker).toMatchObject({
      phase: "succeeded",
      result: { nativeId: expect.stringMatching(/^worker:tsw-/) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/workers/scripts/tsw-");
    expect(calls[0]?.body).toContain("takoserver-bootstrap.mjs");
    expect(calls[0]?.body).toContain("Not deployed");
    const kv = await provider.apply({
      operationId: "op-kv",
      offering: offerings[1] as ProviderOffering,
      identity: { ...IDENTITY, name: "cache" },
      spec: {},
    });
    const database = await provider.apply({
      operationId: "op-db",
      offering: offerings[2] as ProviderOffering,
      identity: { ...IDENTITY, name: "main" },
      spec: {},
    });
    const queue = await provider.apply({
      operationId: "op-queue",
      offering: offerings[3] as ProviderOffering,
      identity: { ...IDENTITY, name: "jobs" },
      spec: { messageRetentionSeconds: 86_400, deliveryDelaySeconds: 3 },
    });
    expect(kv).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "kv:kv-id" },
    });
    expect(database).toMatchObject({
      phase: "succeeded",
      result: {
        nativeId: "d1:database-id",
        outputs: { databaseId: "database-id" },
      },
    });
    expect(queue).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "queue:queue-id" },
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      expect.stringMatching(/\/workers\/scripts\/tsw-/),
      "/client/v4/accounts/acct_1/storage/kv/namespaces",
      "/client/v4/accounts/acct_1/d1/database",
      "/client/v4/accounts/acct_1/queues",
    ]);
  });

  test("uploads a Worker Version then deploys that exact provider Version", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const deploymentOffering = technical("WorkerDeployment");
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering, deploymentOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        return Response.json({
          success: true,
          errors: [],
          result: url.pathname.endsWith("/versions")
            ? { id: "version-id" }
            : { id: "deployment-id" },
        });
      },
    });
    const worker = related("/worker", stored("ModuleWorker", "worker-uid", {}), {
      nativeId: "worker:script-name",
      offeringId: workerOffering.id,
      providerPackRef: "cloudflare",
      outputs: { scriptName: "script-name" },
    });
    const bundle = related(
      "/bundle",
      stored("WorkerBundle", "bundle-uid", {
        manifestDigest: `sha256:${"d".repeat(64)}`,
      }),
    );
    const version = await provider.apply({
      operationId: "op-version",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "v1" },
      spec: {
        worker: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ModuleWorker",
          name: "api",
        },
        bundle: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerBundle",
          name: "bundle",
        },
        handlers: ["fetch"],
        vars: {
          OIDC_ISSUER_URL: "https://accounts.example",
          FEATURES: { browser: true },
        },
      },
      relations: [worker, bundle],
    });
    expect(version).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-id" },
    });
    const versionRelation = related(
      "/versions/0/workerVersion",
      stored("WorkerVersion", "version-uid", {}),
      {
        nativeId: "version:script-name:version-id",
        offeringId: versionOffering.id,
        providerPackRef: "cloudflare",
        outputs: { versionId: "version-id", scriptName: "script-name" },
      },
    );
    const deployed = await provider.apply({
      operationId: "op-deploy",
      offering: deploymentOffering,
      identity: { ...IDENTITY, name: "live" },
      spec: { versions: [{ weight: 10_000 }], worker: {} },
      relations: [worker, versionRelation],
    });
    expect(deployed).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "deployment:script-name:deployment-id" },
    });
    const versionUpload = calls.find(
      (call) => call.method === "POST" && call.url.includes("/versions"),
    );
    const deployment = calls.find(
      (call) => call.method === "POST" && call.url.includes("/deployments"),
    );
    expect(versionUpload?.url).toContain("/workers/scripts/script-name/versions");
    expect(versionUpload?.body).toContain(
      '"type":"plain_text","name":"OIDC_ISSUER_URL","text":"https://accounts.example"',
    );
    expect(versionUpload?.body).toContain(
      '"type":"json","name":"FEATURES","json":{"browser":true}',
    );
    expect(versionUpload?.body).not.toContain('"text":"\\"https://accounts.example\\""');
    expect(deployment?.url).toContain("/workers/scripts/script-name/deployments");
    expect(deployment?.body).toContain('"percentage":100');
    expect(deployment?.body).toContain('"version_id":"version-id"');
  });

  test("marks a first Worker Version dispatch without scanning existing history", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const calls: Call[] = [];
    let uploadMetadata: Record<string, unknown> | undefined;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        if (request.method === "GET") {
          throw new Error("a brand-new leased dispatch must not scan Worker Version history");
        }
        const form = await request.formData();
        const metadata = form.get("metadata");
        uploadMetadata = JSON.parse(
          typeof metadata === "string" ? metadata : await (metadata as Blob).text(),
        ) as Record<string, unknown>;
        return Response.json({
          success: true,
          errors: [],
          result: { id: "version-tagged" },
        });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-tagged",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-tagged" },
    });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
    expect(uploadMetadata).not.toHaveProperty("annotations");
    expect(uploadMetadata?.bindings).toContainEqual({
      type: "plain_text",
      name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
      text: "tsop-v1:97121f2b71233d7f95df7a5bbcd4b228b9804d80cfda21c25eabdb452e612db9",
    });
  });

  test("recovers only from the official Version GET resources binding shape", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let uploads = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: { items: page === 1 ? [{ id: "version-official-shape" }] : [] },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.includes("/versions/")) {
          return Response.json({
            success: true,
            errors: [],
            result: {
              id: "version-official-shape",
              resources: {
                bindings: [
                  {
                    type: "plain_text",
                    name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                    text: "tsop-v1:04976831663cd11567d29c11e858e442a576472042bca36820c6bea5d897b2f7",
                  },
                ],
              },
              metadata: {},
              number: 42,
            },
          });
        }
        uploads += 1;
        return Response.json({ success: true, errors: [], result: { id: "duplicate" } });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-official-shape",
      operationMode: "recovery",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-official-shape" },
    });
    expect(uploads).toBe(0);
  });

  test("does not invent root annotations on Version GET", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let uploads = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: { items: page === 1 ? [{ id: "version-root-annotation" }] : [] },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.includes("/versions/")) {
          return Response.json({
            success: true,
            errors: [],
            result: {
              id: "version-root-annotation",
              annotations: { "workers/tag": "op-version-official-shape" },
              resources: { bindings: [] },
            },
          });
        }
        uploads += 1;
        return Response.json({ success: true, errors: [], result: { id: "duplicate" } });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-official-shape",
      operationMode: "recovery",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(uploads).toBe(0);
  });

  test("refuses a customer binding that collides with the reserved operation marker", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let requests = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch() {
        requests += 1;
        throw new Error("a reserved binding collision must fail before Cloudflare is reached");
      },
    });

    expect(
      await provider.apply({
        operationId: "op-version-marker-collision",
        operationMode: "initial",
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: {
          handlers: ["fetch"],
          vars: { TAKOSERVER_INTERNAL_OPERATION_MARKER: "customer-controlled" },
        },
        relations: [
          related("/worker", stored("ModuleWorker", "worker-uid", {}), {
            nativeId: "worker:script-name",
            offeringId: workerOffering.id,
            providerPackRef: "cloudflare",
            outputs: { scriptName: "script-name" },
          }),
          related(
            "/bundle",
            stored("WorkerBundle", "bundle-uid", {
              manifestDigest: `sha256:${"d".repeat(64)}`,
            }),
          ),
        ],
      }),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(requests).toBe(0);
  });

  test("retries a refused runtime commit by recovering the Version and committing only", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const requests: Request[] = [];
    const materialized: unknown[] = [];
    const committed: unknown[] = [];
    let storedVersion: { id: string; marker: string } | undefined;
    let refuseFirstCommit = true;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings(input) {
          materialized.push(input);
          return { values: { ENCRYPTION_KEY: "generated-encryption-key" } };
        },
        async commitRuntimeBindings(input) {
          committed.push(input);
          if (refuseFirstCommit) {
            refuseFirstCommit = false;
            throw new Error("commit acknowledgement lost");
          }
        },
        async rollbackRuntimeBindings() {
          throw new Error("an uploaded immutable Version must not be rolled back");
        },
      },
      async fetch(request) {
        requests.push(request.clone());
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: {
              items: page === 1 && storedVersion ? [{ id: storedVersion.id }] : [],
            },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.includes("/versions/")) {
          return Response.json({
            success: true,
            errors: [],
            result: storedVersion
              ? {
                  id: storedVersion.id,
                  resources: {
                    bindings: [
                      {
                        type: "plain_text",
                        name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                        text: storedVersion.marker,
                      },
                    ],
                    script: {},
                    script_runtime: {},
                  },
                }
              : null,
          });
        }
        if (request.method === "POST" && url.pathname.endsWith("/versions")) {
          const form = await request.formData();
          const part = form.get("metadata");
          const metadata = JSON.parse(
            typeof part === "string" ? part : await (part as Blob).text(),
          ) as { bindings?: Array<{ name?: string; text?: string }> };
          storedVersion = {
            id: "version-commit-retry",
            marker:
              metadata.bindings?.find(
                (binding) => binding.name === "TAKOSERVER_INTERNAL_OPERATION_MARKER",
              )?.text ?? "",
          };
          return Response.json({
            success: true,
            errors: [],
            result: { id: storedVersion.id },
          });
        }
        throw new Error(`unexpected Cloudflare request: ${request.method} ${url.pathname}`);
      },
    });
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;
    const apply = (operationMode: "initial" | "recovery") =>
      provider.apply({
        operationId: "op-version-commit-retry",
        operationMode,
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
        runtimeMaterialization,
        relations: [
          related("/worker", stored("ModuleWorker", "worker-uid", {}), {
            nativeId: "worker:script-name",
            offeringId: workerOffering.id,
            providerPackRef: "cloudflare",
            outputs: { scriptName: "script-name" },
          }),
          related(
            "/bundle",
            stored("WorkerBundle", "bundle-uid", {
              manifestDigest: `sha256:${"d".repeat(64)}`,
            }),
          ),
        ],
      });

    expect(await apply("initial")).toMatchObject({
      phase: "failed",
      failure: { code: "provider_error" },
    });
    expect(await apply("recovery")).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-commit-retry" },
    });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(materialized).toHaveLength(1);
    expect(committed).toHaveLength(2);
    expect(committed[1]).toEqual(materialized[0]);
  });

  test("recovers the one tagged Version after its upload response is lost", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let storedVersion: { id: string; marker: string } | undefined;
    let uploads = 0;
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: {
              items: page === 1 && storedVersion ? [{ id: storedVersion.id }] : [],
            },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.includes("/versions/")) {
          return Response.json({
            success: true,
            errors: [],
            result: storedVersion
              ? {
                  id: storedVersion.id,
                  resources: {
                    bindings: [
                      {
                        type: "plain_text",
                        name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                        text: storedVersion.marker,
                      },
                    ],
                    script: {},
                    script_runtime: {},
                  },
                }
              : null,
          });
        }
        if (request.method === "POST" && url.pathname.endsWith("/versions")) {
          uploads += 1;
          const form = await request.formData();
          const part = form.get("metadata");
          const metadata = JSON.parse(
            typeof part === "string" ? part : await (part as Blob).text(),
          ) as { bindings?: Array<{ name?: string; text?: string }> };
          storedVersion = {
            id: "version-lost-response",
            marker:
              metadata.bindings?.find(
                (binding) => binding.name === "TAKOSERVER_INTERNAL_OPERATION_MARKER",
              )?.text ?? "",
          };
          throw new TypeError("connection closed after upload");
        }
        throw new Error(`unexpected Cloudflare request: ${request.method} ${url.pathname}`);
      },
    });
    const apply = (operationMode: "initial" | "recovery") =>
      provider.apply({
        operationId: "op-version-lost-response",
        operationMode,
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: { handlers: ["fetch"] },
        relations: [
          related("/worker", stored("ModuleWorker", "worker-uid", {}), {
            nativeId: "worker:script-name",
            offeringId: workerOffering.id,
            providerPackRef: "cloudflare",
            outputs: { scriptName: "script-name" },
          }),
          related(
            "/bundle",
            stored("WorkerBundle", "bundle-uid", {
              manifestDigest: `sha256:${"d".repeat(64)}`,
            }),
          ),
        ],
      });

    try {
      expect(await apply("initial")).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      expect(await apply("recovery")).toMatchObject({
        phase: "succeeded",
        result: { nativeId: "version:script-name:version-lost-response" },
      });
      expect(uploads).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  test("refuses a mismatched recovery page without uploading", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let uploads = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        if (request.method === "POST") uploads += 1;
        return Response.json({
          success: true,
          errors: [],
          result: request.method === "GET" ? { items: [] } : { id: "must-not-upload" },
          result_info: { page: 2, per_page: 100 },
        });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-page-mismatch",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "provider_error" },
    });
    expect(uploads).toBe(0);
  });

  test("keeps an unacknowledged upload indeterminate instead of rolling materialization back", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const rollbacks: unknown[] = [];
    let uploads = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings() {
          return {
            values: { ENCRYPTION_KEY: "generated-encryption-key" },
            rollbackReceipt: "opaque-read-receipt",
          };
        },
        async commitRuntimeBindings() {
          throw new Error("an unacknowledged Version must not be committed");
        },
        async rollbackRuntimeBindings(input) {
          rollbacks.push(input);
        },
      },
      async fetch(request) {
        if (request.method === "GET") {
          return Response.json({ success: true, errors: [], result: { items: [] } });
        }
        uploads += 1;
        return Response.json({ success: true, errors: [], result: {} });
      },
    });
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;

    const ticket = await provider.apply({
      operationId: "op-version-ambiguous-upload",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
      runtimeMaterialization,
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(uploads).toBe(1);
    expect(rollbacks).toEqual([]);
  });

  for (const scenario of [
    {
      name: "duplicate matching markers",
      items: [{ id: "version-duplicate-a" }, { id: "version-duplicate-b" }],
      detail(id: string) {
        return {
          id,
          resources: {
            bindings: [
              {
                type: "plain_text",
                name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                text: "tsop-v1:2498eb0818830b5389ee0a3d130902477a5897c00d76ee4d7ed126076892a53e",
              },
            ],
          },
        };
      },
    },
    {
      name: "a malformed reserved marker binding",
      items: [{ id: "version-malformed-tag" }],
      detail(id: string) {
        return {
          id,
          resources: {
            bindings: [
              {
                type: "plain_text",
                name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                text: 42,
              },
            ],
          },
        };
      },
    },
    {
      name: "a mismatched detail identity",
      items: [{ id: "version-listed" }],
      detail() {
        return {
          id: "version-different",
          resources: {
            bindings: [
              {
                type: "plain_text",
                name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                text: "tsop-v1:2498eb0818830b5389ee0a3d130902477a5897c00d76ee4d7ed126076892a53e",
              },
            ],
          },
        };
      },
    },
  ] as const) {
    test(`refuses ${scenario.name} without uploading`, async () => {
      const workerOffering = technical("ModuleWorker");
      const versionOffering = technical("WorkerVersion");
      let uploads = 0;
      const provider = new CloudflareProvider({
        accountId: "acct_1",
        offerings: [workerOffering, versionOffering],
        artifacts,
        authorize: () => "Bearer secret-account-token",
        apiOrigin: "https://api.cloudflare.test/client/v4",
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname.endsWith("/versions")) {
            const page = Number(url.searchParams.get("page"));
            return Response.json({
              success: true,
              errors: [],
              result: { items: page === 1 ? scenario.items : [] },
              result_info: { page, per_page: 100 },
            });
          }
          if (request.method === "GET" && url.pathname.includes("/versions/")) {
            const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
            return Response.json({
              success: true,
              errors: [],
              result: scenario.detail(id),
            });
          }
          uploads += 1;
          return Response.json({
            success: true,
            errors: [],
            result: { id: "must-not-upload" },
          });
        },
      });

      const ticket = await provider.apply({
        operationId: "op-version-recovery-refusal",
        operationMode: "recovery",
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: { handlers: ["fetch"] },
        relations: [
          related("/worker", stored("ModuleWorker", "worker-uid", {}), {
            nativeId: "worker:script-name",
            offeringId: workerOffering.id,
            providerPackRef: "cloudflare",
            outputs: { scriptName: "script-name" },
          }),
          related(
            "/bundle",
            stored("WorkerBundle", "bundle-uid", {
              manifestDigest: `sha256:${"d".repeat(64)}`,
            }),
          ),
        ],
      });

      expect(ticket).toMatchObject({
        phase: "failed",
        failure: { code: "provider_error" },
      });
      expect(uploads).toBe(0);
    });
  }

  test("keeps a bounded recovery indeterminate without uploading again", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let listings = 0;
    let details = 0;
    let uploads = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          listings += 1;
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: { items: [{ id: `version-page-${page}` }] },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.includes("/versions/")) {
          details += 1;
          return Response.json({
            success: true,
            errors: [],
            result: {
              id: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
              resources: { bindings: [] },
              metadata: {},
            },
          });
        }
        uploads += 1;
        return Response.json({ success: true, errors: [], result: { id: "must-not-upload" } });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-unbounded-recovery",
      operationMode: "recovery",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect({ listings, details, uploads }).toEqual({ listings: 10, details: 10, uploads: 0 });
  });

  test("logs a sanitized transport exception when a Worker Version upload never gets a response", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        throw new TypeError("Network connection lost: Bearer secret-account-token");
      },
    });

    try {
      const ticket = await provider.apply({
        operationId: "op-version-transport-failure",
        operationMode: "initial",
        offering: versionOffering,
        identity: { ...IDENTITY, name: "v1" },
        spec: {
          handlers: ["fetch"],
          vars: { PRIVATE_VALUE: "must-not-enter-the-operator-log" },
        },
        relations: [
          related("/worker", stored("ModuleWorker", "worker-uid", {}), {
            nativeId: "worker:script-name",
            offeringId: workerOffering.id,
            providerPackRef: "cloudflare",
            outputs: { scriptName: "script-name" },
          }),
          related(
            "/bundle",
            stored("WorkerBundle", "bundle-uid", {
              manifestDigest: `sha256:${"d".repeat(64)}`,
            }),
          ),
        ],
      });

      expect(ticket).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable", retryable: true },
      });
      expect(log).toHaveBeenCalledTimes(1);
      const event = String(log.mock.calls[0]?.[0]);
      expect(event).toContain('"event":"takoserver.provider.fetch_failed"');
      expect(event).toContain('"errorName":"TypeError"');
      expect(event).toContain('"message":"Network connection lost: [REDACTED]"');
      expect(event).not.toContain("secret-account-token");
      expect(event).not.toContain("must-not-enter-the-operator-log");
    } finally {
      log.mockRestore();
    }
  });

  test("provisions a stable Worker Version without a runtime materializer", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        return Response.json({
          success: true,
          errors: [],
          result: { id: "version-s3" },
        });
      },
    });
    const bucketName = `tss3-${"a".repeat(40)}`;
    const ticket = await provider.apply({
      operationId: "op-version-s3",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: [] },
      standardServices: [
        {
          name: "MEDIA",
          required: true,
          service: {
            apiVersion: "standards.takoform.com/v1",
            protocol: "com.amazonaws.s3",
          },
          endpoint: {
            kind: "takoserver.cloudflare-r2-bucket@v1",
            bucketName,
          },
          credential: { kind: "takoserver.cloudflare-r2-binding@v1" },
        },
      ],
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-s3" },
    });
    const versionUpload = calls.find(
      (call) => call.method === "POST" && call.url.includes("/versions"),
    );
    expect(versionUpload?.body).toContain(
      `"type":"r2_bucket","name":"MEDIA","bucket_name":"${bucketName}"`,
    );
    expect(versionUpload?.body).not.toContain('"type":"secret_text"');
    expect(JSON.stringify(ticket)).not.toContain(bucketName);
    expect(JSON.stringify(ticket)).not.toContain("com.amazonaws.s3");
  });

  test("ignores unused runtime authority for a fetch-only Worker Version", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let materializerCalls = 0;
    let uploadBody = "";
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings() {
          materializerCalls += 1;
          throw new Error("unused authority must not be materialized");
        },
        async commitRuntimeBindings() {
          materializerCalls += 1;
          throw new Error("unused authority must not be committed");
        },
        async rollbackRuntimeBindings() {
          materializerCalls += 1;
          throw new Error("unused authority must not be rolled back");
        },
      },
      async fetch(request) {
        if (request.method !== "POST") {
          throw new Error("a first dispatch must not enter recovery");
        }
        uploadBody = await request.clone().text();
        return Response.json({
          success: true,
          errors: [],
          result: { id: "version-fetch-only" },
        });
      },
    });
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;

    const ticket = await provider.apply({
      operationId: "op-version-fetch-only",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: [] },
      runtimeMaterialization,
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-fetch-only" },
    });
    expect(materializerCalls).toBe(0);
    expect(uploadBody).not.toContain('"type":"secret_text"');
  });

  test("materializes exact sensitive bindings only inside the immutable Worker Version upload", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const calls: Call[] = [];
    const materialized: unknown[] = [];
    const committed: unknown[] = [];
    const lifecycle: string[] = [];
    let uploadMetadata: Record<string, unknown> | undefined;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings(input) {
          lifecycle.push("materialize");
          materialized.push(input);
          return {
            values: {
              ENCRYPTION_KEY: "generated-encryption-key",
              TAKOSUMI_ACCOUNTS_CLIENT_ID: "public-client-id",
            },
          };
        },
        async commitRuntimeBindings(input) {
          lifecycle.push("commit");
          committed.push(input);
        },
        async rollbackRuntimeBindings() {
          throw new Error("a successful upload must not roll back");
        },
      },
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        lifecycle.push("upload");
        const form = await request.clone().formData();
        const metadataPart = form.get("metadata");
        uploadMetadata = JSON.parse(
          typeof metadataPart === "string" ? metadataPart : await (metadataPart as Blob).text(),
        ) as Record<string, unknown>;
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        return Response.json({
          success: true,
          errors: [],
          result: { id: "version-sensitive" },
        });
      },
    });
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;
    const ticket = await provider.apply({
      operationId: "op-version-sensitive",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: {
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"],
      },
      runtimeMaterialization,
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-sensitive" },
    });
    expect(materialized).toEqual([
      {
        request: runtimeMaterialization,
        resourceName: "version",
        scriptName: "script-name",
        publicOrigin: "https://script-name.workers.example",
        bindings: ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"],
      },
    ]);
    expect(committed).toEqual(materialized);
    expect(committed[0]).toBe(materialized[0]);
    expect(lifecycle).toEqual(["materialize", "upload", "commit"]);
    expect(calls[0]?.body).toContain(
      '"type":"secret_text","name":"ENCRYPTION_KEY","text":"generated-encryption-key"',
    );
    expect(calls[0]?.body).toContain(
      '"type":"secret_text","name":"TAKOSUMI_ACCOUNTS_CLIENT_ID","text":"public-client-id"',
    );
    expect(uploadMetadata).not.toHaveProperty("annotations");
    expect(uploadMetadata?.bindings).toContainEqual({
      type: "plain_text",
      name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
      text: "tsop-v1:8f0fa7feeca8c241ad945d9775309bb2e3f5331d6a0bedb4e30453cdea472801",
    });
    // A host-materialized WorkerVersion owns the exact sensitive binding set.
    // Preserving older secret_text bindings would leave a removed declaration
    // available to the next immutable Version.
    expect(calls[0]?.body).not.toContain("keep_bindings");
    expect(JSON.stringify(ticket)).not.toContain("generated-encryption-key");
    expect(JSON.stringify(ticket)).not.toContain("public-client-id");
  });

  test("returns an opaque materialization receipt when Worker Version upload fails", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const rollbacks: unknown[] = [];
    const commits: unknown[] = [];
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings() {
          return {
            values: { ENCRYPTION_KEY: "generated-encryption-key" },
            rollbackReceipt: "opaque-rollback-receipt",
          };
        },
        async commitRuntimeBindings(input) {
          commits.push(input);
        },
        async rollbackRuntimeBindings(input) {
          rollbacks.push(input);
        },
      },
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        return Response.json(
          { success: false, errors: [{ code: 10000 }], result: null },
          { status: 503 },
        );
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-upload-failed",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
      runtimeMaterialization,
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(rollbacks).toEqual([
      {
        request: runtimeMaterialization,
        rollbackReceipt: "opaque-rollback-receipt",
      },
    ]);
    expect(commits).toEqual([]);
    expect(JSON.stringify(ticket)).not.toContain("generated-encryption-key");
  });

  test("does not report a Worker Version success when runtime activation is refused", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const commits: unknown[] = [];
    const runtimeMaterialization = {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_yurucommu",
      workspaceId: "workspace_1",
      capsuleId: "capsule_yurucommu",
      installingPrincipalId: "tsub_owner",
      requirements: [],
    } as const;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      runtimeMaterializer: {
        async materializeRuntimeBindings() {
          return { values: { ENCRYPTION_KEY: "generated-encryption-key" } };
        },
        async commitRuntimeBindings(input) {
          commits.push(input);
          throw new Error("activation RPC included generated-encryption-key");
        },
        async rollbackRuntimeBindings() {
          throw new Error("an uploaded Version cannot roll back activation");
        },
      },
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          return Response.json({
            success: true,
            errors: [],
            result: { items: [] },
            result_info: { page: 1, per_page: 100 },
          });
        }
        return Response.json({
          success: true,
          errors: [],
          result: { id: "version-commit-refused" },
        });
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-commit-refused",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
      runtimeMaterialization,
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });

    expect(ticket).toEqual({
      phase: "failed",
      failure: {
        code: "provider_error",
        message: "runtime binding activation was not confirmed by the host",
        retryable: false,
      },
    });
    expect(commits).toEqual([
      {
        request: runtimeMaterialization,
        resourceName: "version",
        scriptName: "script-name",
        publicOrigin: "https://script-name.workers.example",
        bindings: ["ENCRYPTION_KEY"],
      },
    ]);
    expect(JSON.stringify(ticket)).not.toContain("generated-encryption-key");
  });

  test("refuses sensitive Worker Version declarations without exact runtime authority", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "workers.example",
      async fetch() {
        throw new Error("provider must not be reached");
      },
    });
    const ticket = await provider.apply({
      operationId: "op-version-unmaterialized",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
      relations: [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOffering.id,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        retryable: false,
        message: "the sensitive Worker bindings have no runtime materialization authority",
      },
    });
  });

  test("reads and atomically appends the exact SQLite migration prefix", async () => {
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [technical("SQLiteDatabase")],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        const index = calls.length;
        const result =
          index === 1
            ? [
                {
                  success: true,
                  results: [{ name: "_takoform_sqlite_migrations" }],
                },
              ]
            : index === 2
              ? [
                  {
                    success: true,
                    results: [
                      {
                        sequence: 1,
                        path: "0001.sql",
                        digest: `sha256:${"a".repeat(64)}`,
                      },
                    ],
                  },
                ]
              : Array.from({ length: 4 }, () => ({
                  success: true,
                  results: [],
                }));
        return Response.json({ success: true, errors: [], result });
      },
    });
    const ledger = await provider.sqliteMigrations.readLedger({
      nativeId: "d1:database-id",
    });
    expect(ledger).toEqual({
      ok: true,
      value: [{ path: "0001.sql", digest: `sha256:${"a".repeat(64)}` }],
    });
    const applied = await provider.sqliteMigrations.applySuffix({
      nativeId: "d1:database-id",
      expectedPrefix: [{ path: "0001.sql", digest: `sha256:${"a".repeat(64)}` }],
      migrations: [
        {
          path: "0002.sql",
          digest: `sha256:${"b".repeat(64)}`,
          sql: new TextEncoder().encode("CREATE TABLE example (id INTEGER PRIMARY KEY);"),
        },
      ],
    });
    expect(applied).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.endsWith("/d1/database/database-id/query"))).toBe(true);
    const batch = JSON.parse(calls[2]?.body ?? "{}") as {
      batch?: { sql?: string; params?: unknown[] }[];
    };
    expect(batch.batch).toHaveLength(4);
    expect(batch.batch?.[1]?.sql).toContain("json_each(?)");
    expect(batch.batch?.[1]?.params).toEqual([
      1,
      JSON.stringify([{ path: "0001.sql", digest: `sha256:${"a".repeat(64)}` }]),
    ]);
    expect(batch.batch?.[2]?.sql).toBe("CREATE TABLE example (id INTEGER PRIMARY KEY);");
    expect(batch.batch?.[3]?.sql).toContain("INSERT INTO _takoform_sqlite_migrations");
    expect(batch.batch?.[3]?.params?.[0]).toBe(2);
  });

  test("observes and removes every composed provider object without guessing identity", async () => {
    const offerings = [
      technical("WorkerVersion"),
      technical("WorkerDeployment"),
      technical("WorkerEndpoint"),
      technical("WorkerCustomDomain"),
      technical("WorkerCronTrigger"),
      technical("QueueConsumer"),
    ];
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings,
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      workerEndpointSuffix: "tenant.workers.dev",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        const result = path.endsWith("/subdomain")
          ? { enabled: true }
          : path.endsWith("/workers/domains/domain-id")
            ? {
                id: "domain-id",
                hostname: "api.example.com",
                service: "script-name",
              }
            : path.endsWith("/schedules") && request.method === "GET"
              ? [{ cron: "*/5 * * * *" }, { cron: "0 0 * * *" }]
              : path.includes("/consumers/")
                ? { consumer_id: "consumer-id", script_name: "script-name" }
                : path.includes("/deployments/")
                  ? { id: "deployment-id", versions: [] }
                  : { id: "version-id" };
        return Response.json({ success: true, errors: [], result });
      },
    });
    const cases = [
      ["version:script-name:version-id", offerings[0], {}],
      ["deployment:script-name:deployment-id", offerings[1], {}],
      ["endpoint:script-name", offerings[2], {}],
      ["domain:domain-id", offerings[3], { hostname: "api.example.com" }],
      ["cron:script-name:cron-digest", offerings[4], { cron: "*/5 * * * *" }],
      ["consumer:queue-id:consumer-id", offerings[5], {}],
    ] as const;
    for (const [nativeId, offering, spec] of cases) {
      expect(
        await provider.observe({
          offering: offering as ProviderOffering,
          nativeId,
          spec,
        }),
      ).toMatchObject({ phase: "succeeded", result: { nativeId } });
    }

    const retained = await provider.delete({
      operationId: "delete-version",
      offering: offerings[0] as ProviderOffering,
      nativeId: "version:script-name:version-id",
      identity: IDENTITY,
      spec: {},
    });
    expect(retained).toMatchObject({
      phase: "succeeded",
      result: { disposition: "retained", observed: { retained: true } },
    });
    for (const [nativeId, offering, spec] of cases.slice(1)) {
      expect(
        await provider.delete({
          operationId: `delete-${nativeId}`,
          offering: offering as ProviderOffering,
          nativeId,
          identity: IDENTITY,
          spec,
        }),
      ).toMatchObject({ phase: "succeeded", result: { nativeId } });
    }
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toContain(
      "DELETE /client/v4/accounts/acct_1/workers/scripts/script-name/deployments/deployment-id",
    );
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toContain(
      "DELETE /client/v4/accounts/acct_1/workers/domains/domain-id",
    );
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toContain(
      "DELETE /client/v4/accounts/acct_1/queues/queue-id/consumers/consumer-id",
    );
    const scheduleUpdate = calls.find(
      (call) => call.method === "PUT" && call.url.endsWith("/schedules"),
    );
    expect(scheduleUpdate?.body).toBe('[{"cron":"0 0 * * *"}]');
  });

  function stored(kind: string, uid: string, spec: JsonObject) {
    const installed = form(kind);
    return {
      apiVersion: installed.identity.formRef.apiVersion,
      kind,
      form: installed.identity,
      metadata: {
        name: kind.toLowerCase(),
        space: "default",
        uid,
        generation: "1",
        revision: "1",
      },
      spec,
      status: { observedGeneration: "1", conditions: [] },
    };
  }

  function related(
    pointer: string,
    resource: ReturnType<typeof stored>,
    deployment?: {
      nativeId: string;
      offeringId: string;
      providerPackRef: string;
      outputs: JsonObject;
    },
  ): ProviderRelation {
    return {
      pointer,
      relation: pointer.replace(/\/\d+/gu, "/*"),
      targetUid: resource.metadata.uid,
      resource,
      ...(deployment
        ? {
            deployment: {
              tenantId: "org_acme",
              id: `dep_${resource.metadata.uid}`,
              resourceUid: resource.metadata.uid,
              offeringId: deployment.offeringId,
              providerPackRef: deployment.providerPackRef,
              providerInstallationRef: "cloudflare.primary",
              nativeId: deployment.nativeId,
              state: "active",
              observed: {},
              outputs: deployment.outputs,
              createdAt: "2026-08-19T00:00:00.000Z",
              updatedAt: "2026-08-19T00:00:00.000Z",
            },
          }
        : {}),
    };
  }
});

/**
 * An operator that holds names back from a zone it also offers to customers
 * ends up with two zones for the same suffix: the open one with reserved
 * labels, and its own grant. Which one applies must follow from the grant, not
 * from where the entries sit in a list — a reordering that silently hands a
 * reserved name to a tenant is exactly the kind of defect nobody looks for.
 */
describe("overlapping zones", () => {
  for (const order of ["granted first", "granted last"] as const) {
    test(`resolves by grant, not by configuration order (${order})`, async () => {
      const granted: CloudflareZone = {
        suffix: "shared.example",
        zoneId: "zone_operator",
        tenantRef: "org_acme",
        apex: true,
      };
      const open: CloudflareZone = {
        suffix: "shared.example",
        zoneId: "zone_open",
        singleLabel: true,
        reservedLabels: ["api"],
      };
      const { provider, calls } = recorder(
        [
          { status: 200, body: { success: true, errors: [], result: {} } },
          { status: 200, body: { success: true, errors: [], result: {} } },
        ],
        order === "granted first" ? [granted, open] : [open, granted],
      );

      // `api` is reserved on the open zone; the operator's own grant is what
      // makes it serveable, and only for them.
      const ticket = await provider.apply({
        operationId: "op_overlap",
        offering: WORKER,
        identity: IDENTITY,
        spec: {
          bundle: `sha256:${"d".repeat(64)}`,
          hostnames: ["api.shared.example"],
        },
      });
      expect(ticket.phase).toBe("succeeded");
      const attached = calls.find((call) => call.url.includes("/workers/domains"));
      expect(JSON.parse(String(attached?.body))).toMatchObject({
        zone_id: "zone_operator",
      });
    });
  }

  test("still refuses a reserved name to a tenant with no grant", async () => {
    const { provider, calls } = recorder(
      [{ status: 200, body: { success: true, errors: [], result: {} } }],
      [
        {
          suffix: "shared.example",
          zoneId: "zone_operator",
          tenantRef: "org_other",
          apex: true,
        },
        {
          suffix: "shared.example",
          zoneId: "zone_open",
          singleLabel: true,
          reservedLabels: ["api"],
        },
      ],
    );
    const ticket = await provider.apply({
      operationId: "op_overlap_denied",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["api.shared.example"],
      },
    });
    expect(ticket.phase).toBe("failed");
    expect(calls.filter((call) => call.url.includes("/workers/domains"))).toHaveLength(0);
  });
});

/**
 * A domain someone brought with them already points somewhere. Cloudflare
 * refuses to attach a Worker to such a hostname until the existing records are
 * gone — which is a thing only the customer can do, and which reads as a
 * transient fault if it is reported as "the resource is busy".
 */
describe("hostname already in use", () => {
  test("says what the customer must clear, not that the backend is busy", async () => {
    const { provider } = recorder(
      [
        { status: 200, body: { success: true, errors: [], result: {} } },
        {
          status: 409,
          body: {
            success: false,
            errors: [
              {
                code: 100117,
                message:
                  "Hostname 'brought.example' already has externally managed DNS records (A, CNAME, etc).",
              },
            ],
          },
        },
      ],
      [
        {
          suffix: "brought.example",
          zoneId: "zone_brought",
          tenantRef: "org_acme",
          apex: true,
        },
      ],
    );
    const ticket = await provider.apply({
      operationId: "op_taken",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["brought.example"],
      },
    });

    expect(ticket.phase).toBe("failed");
    expect(ticket).toMatchObject({
      failure: { code: "invalid_spec", retryable: false },
    });
    // Ours, not Cloudflare's: no backend wording crosses back.
    expect(JSON.stringify(ticket)).toContain("remove them in the zone");
    expect(JSON.stringify(ticket)).not.toContain("externally managed");
  });
});

/**
 * Static assets are only half of serving a site. The asset layer answers
 * requests that match a file; everything else reaches the Worker, so a Worker
 * that cannot ask the asset layer anything is a Worker whose application 404s
 * on every deep link. The binding is not optional and not declared — declaring
 * assets is the declaration.
 */
describe("asset binding", () => {
  test("hands a script that declares assets a way to reach them", async () => {
    const { provider, calls } = recorder([
      {
        status: 200,
        body: { success: true, errors: [], result: { jwt: "asset-token" } },
      },
      { status: 200, body: { success: true, errors: [], result: {} } },
      { status: 200, body: { success: true, errors: [], result: {} } },
    ]);
    const ticket = await provider.apply({
      operationId: "op_assets",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        assets: { bundle: ASSET_BUNDLE },
      },
    });

    expect(ticket.phase).toBe("succeeded");
    const upload = calls.find(
      (call) => call.url.includes("/workers/scripts/") && !call.url.includes("assets-upload"),
    );
    expect(String(upload?.body)).toContain('"type":"assets","name":"ASSETS"');
  });

  test("refuses a declared binding that would collide with it", async () => {
    const { provider } = recorder([]);
    const ticket = await provider.apply({
      operationId: "op_assets_collide",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        assets: { bundle: ASSET_BUNDLE },
        bindings: [{ type: "plain_text", name: "ASSETS", text: "mine" }],
      },
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
  });
});

/**
 * A domain somebody brings almost always resolves already — to their old host,
 * to a parking page, to a record nobody remembers adding. Without a way
 * through, the answer to "point my domain here" is "first go and delete some
 * DNS records", which is a worse product and a step people get wrong.
 *
 * Replacing a record is destructive and one-way, so it happens only for a
 * hostname the declaration named.
 */
describe("taking a hostname that already points somewhere", () => {
  const zone: CloudflareZone = {
    suffix: "brought.example",
    zoneId: "zone_brought",
    tenantRef: "org_acme",
    apex: true,
  };
  const taken = {
    status: 409,
    body: {
      success: false,
      errors: [
        {
          code: 100117,
          message: "Hostname already has externally managed DNS records",
        },
      ],
    },
  };
  const ok = { status: 200, body: { success: true, errors: [], result: {} } };

  test("clears the records it was told to replace, then attaches", async () => {
    const { provider, calls } = recorder(
      [
        ok, // script upload
        taken, // first attach
        {
          status: 200,
          body: {
            success: true,
            errors: [],
            result: [
              { id: "rec_a", type: "A" },
              { id: "rec_txt", type: "TXT" },
            ],
          },
        },
        ok, // delete rec_a
        ok, // attach again
      ],
      [zone],
    );
    const ticket = await provider.apply({
      operationId: "op_takeover",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["brought.example"],
        replaceExistingRecords: ["brought.example"],
      },
    });

    expect(ticket.phase).toBe("succeeded");
    const deletes = calls.filter((call) => call.url.includes("/dns_records/"));
    // The A record stood in the way. The TXT record proves something
    // elsewhere and was left exactly where it was.
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain("rec_a");
  });

  test("does not touch records for a hostname it was not told to replace", async () => {
    const { provider, calls } = recorder([ok, taken], [zone]);
    const ticket = await provider.apply({
      operationId: "op_no_takeover",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["brought.example"],
      },
    });

    expect(ticket.phase).toBe("failed");
    expect(calls.filter((call) => call.url.includes("/dns_records"))).toHaveLength(0);
  });

  test("will not replace records for a hostname it is not serving", async () => {
    const { provider, calls } = recorder([ok, taken], [zone]);
    await provider.apply({
      operationId: "op_wrong_name",
      offering: WORKER,
      identity: IDENTITY,
      spec: {
        bundle: `sha256:${"d".repeat(64)}`,
        hostnames: ["brought.example"],
        // Naming a different hostname must not authorise anything here.
        replaceExistingRecords: ["someone-else.example"],
      },
    });
    expect(calls.filter((call) => call.url.includes("/dns_records"))).toHaveLength(0);
  });
});
