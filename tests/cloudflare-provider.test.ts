import { describe, expect, test } from "bun:test";
import type { ProviderOffering } from "../src/provider-port.ts";
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
      [{ suffix: "brought.example", zoneId: "zone_brought", tenantRef: "org_acme", apex: true }],
    );
    const ticket = await provider.apply({
      operationId: "op_apex",
      offering: WORKER,
      identity: IDENTITY,
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["brought.example"] },
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
      [{ suffix: "shared.example", zoneId: "zone_shared", tenantRef: "org_acme" }],
    );
    const ticket = await provider.apply({
      operationId: "op_apex_refused",
      offering: WORKER,
      identity: IDENTITY,
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["shared.example"] },
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
        spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["api.shared.example"] },
      });
      expect(ticket.phase).toBe("succeeded");
      const attached = calls.find((call) => call.url.includes("/workers/domains"));
      expect(JSON.parse(String(attached?.body))).toMatchObject({ zone_id: "zone_operator" });
    });
  }

  test("still refuses a reserved name to a tenant with no grant", async () => {
    const { provider, calls } = recorder(
      [{ status: 200, body: { success: true, errors: [], result: {} } }],
      [
        { suffix: "shared.example", zoneId: "zone_operator", tenantRef: "org_other", apex: true },
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
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["api.shared.example"] },
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
      [{ suffix: "brought.example", zoneId: "zone_brought", tenantRef: "org_acme", apex: true }],
    );
    const ticket = await provider.apply({
      operationId: "op_taken",
      offering: WORKER,
      identity: IDENTITY,
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["brought.example"] },
    });

    expect(ticket.phase).toBe("failed");
    expect(ticket).toMatchObject({ failure: { code: "invalid_spec", retryable: false } });
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
      { status: 200, body: { success: true, errors: [], result: { jwt: "asset-token" } } },
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
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
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
      errors: [{ code: 100117, message: "Hostname already has externally managed DNS records" }],
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
      spec: { bundle: `sha256:${"d".repeat(64)}`, hostnames: ["brought.example"] },
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
