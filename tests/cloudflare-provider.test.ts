import { describe, expect, test } from "bun:test";
import type { ProviderOffering } from "../src/provider-port.ts";
import { type ArtifactBytes, CloudflareProvider } from "../src/providers/cloudflare.ts";

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"c".repeat(64)}`,
} as const;

function offering(id: string, kind: string): ProviderOffering {
  return {
    id,
    kind,
    displayName: id,
    form: { ...FORM_REF, kind: kind === "worker_script" ? "WorkerScript" : FORM_REF.kind },
    unit: "unit",
    unitPriceMinor: 100,
    protocols: [],
    capabilities: ["create", "update", "delete", "observe", "import"],
  };
}

const BUCKET = offering("storage.object.standard", "object_bucket");
const DATABASE = offering("db.sql.standard", "sql_database");
const WORKER = offering("compute.worker.standard", "worker_script");

const IDENTITY = { tenantRef: "org_acme", space: "default", name: "assets" };

const MODULE_BYTES = new TextEncoder().encode("export default { fetch() {} }");

const artifacts: ArtifactBytes = {
  async manifest(_tenantRef, digest) {
    return digest === `sha256:${"d".repeat(64)}`
      ? {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [
            {
              name: "index.js",
              mediaType: "application/javascript+module",
              digest: `sha256:${"e".repeat(64)}`,
            },
          ],
        }
      : null;
  },
  async blob(digest) {
    return digest === `sha256:${"e".repeat(64)}` ? MODULE_BYTES : null;
  },
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string;
}

function recorder(responses: readonly { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  let index = 0;
  const provider = new CloudflareProvider({
    accountId: "acct_1",
    offerings: [BUCKET, DATABASE, WORKER],
    artifacts,
    zones: [
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
  test("derives a backend name instead of trusting the customer's", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: { name: "ts-x" } } },
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
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ locationHint: "apac" });
  });

  test("publishes a Worker from a committed bundle as a multipart upload", async () => {
    const { provider, calls } = recorder([
      { status: 200, body: { success: true, errors: [], result: { id: "script" } } },
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
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["app.acme.example"] },
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
          body: { success: false, errors: [{ message: "internal cloudflare detail" }] },
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
      { status: 200, body: { success: true, errors: [], result: { uuid: "db-uuid-1" } } },
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
    expect(ticket.failure).toMatchObject({ code: "unavailable", retryable: true });
  });
});
