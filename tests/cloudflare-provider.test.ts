import { describe, expect, spyOn, test } from "bun:test";
import {
  buildEdgeForms,
  edgeProviderOffering,
  objectBucketProviderOffering,
} from "../src/edge-forms.ts";
import type { JsonObject } from "../src/ports.ts";
import type {
  ProviderOffering,
  ProviderRelation,
  ProviderRuntimeBinding,
} from "../src/provider-port.ts";
import type {
  ProviderRuntimeInputLeasePort,
  ProviderRuntimeInputPreparationIdentity,
  ProviderRuntimeInputRecoveryInput,
} from "../src/provider-runtime-input-port.ts";
import {
  derivedProviderResourceIncarnationName,
  derivedProviderResourceName,
} from "../src/provider-worker-endpoint-origin.ts";
import {
  type ArtifactBytes,
  CloudflareProvider,
  type CloudflareZone,
} from "../src/providers/cloudflare.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

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

const SENSITIVE_OPERATION_KEY = `takoform-worker-runtime-v1-${"e".repeat(64)}`;
const SENSITIVE_PUBLIC_APPLY = {
  method: "PUT",
  path: "/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/WorkerVersion/version",
  ifNoneMatch: "*",
  body: '{"apiVersion":"edge.forms.takoform.com","kind":"WorkerVersion"}',
} as const;
const SENSITIVE_PREPARATION: ProviderRuntimeInputPreparationIdentity = {
  preparationId: "prep_sensitive",
  operationKey: SENSITIVE_OPERATION_KEY,
  workerResourceUid: "worker-uid",
  canonicalPublicOrigin: "https://api.takoserver.test",
  commitment: `sha256:${"b".repeat(64)}`,
};

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
    expect(provider.runtimeInputCapabilities).toBeUndefined();
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

  test("does not repeat a mutating POST after an indeterminate response", async () => {
    let posts = 0;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [BUCKET],
      artifacts,
      authorize: () => "Bearer token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        if (request.method === "POST") {
          posts += 1;
          // The backend accepted the bucket before the transport closed. The
          // provider cannot prove the result, so a recovery must stop rather
          // than issue the same POST a second time.
          throw new TypeError("connection closed after mutation");
        }
        throw new Error(`unexpected ${request.method}`);
      },
    });
    const input = {
      operationId: "op-indeterminate-bucket",
      offering: BUCKET,
      identity: IDENTITY,
      spec: {},
    } as const;

    const first = await provider.apply({ ...input, operationMode: "initial" });
    expect(first).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    const recovered = await provider.apply({ ...input, operationMode: "recovery" });
    expect(recovered).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(posts).toBe(1);
  });
});

/**
 * The current versionless ObjectBucket Form, which ADR 0007 admitted. Its
 * technical offering keeps the legacy `object_bucket` provider kind, so this
 * proves the ordinary-workers backend reaches the R2 lifecycle through the
 * exact current identity rather than through the retained v1beta1 one.
 */
describe("current ObjectBucket Form on the ordinary-workers backend", () => {
  const form = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
  );
  if (!form) throw new Error("current ObjectBucket Form missing");
  const offering = objectBucketProviderOffering(form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });

  // A Resource UID: the current Form derives its bucket from the incarnation,
  // so destroying a bucket and declaring one with the same name gets an empty
  // one rather than the old bytes.
  const MEDIA = { ...IDENTITY, name: "media", uid: "res_media_1" } as const;

  function bucketProvider(status = 200, body: unknown = { success: true, errors: [], result: {} }) {
    return scriptedBucketProvider(() => ({ status, body }));
  }

  function scriptedBucketProvider(
    script: (call: { method: string; path: string; index: number }) => {
      status: number;
      body: unknown;
    },
  ) {
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [offering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const index = calls.length;
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.clone().text(),
        });
        const { status, body } = script({
          method: request.method,
          path: new URL(request.url).pathname,
          index,
        });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    });
    return { provider, calls };
  }

  /** The exact name this Host derives for one Resource incarnation. */
  async function derivedBucket(identity: {
    tenantRef: string;
    space: string;
    name: string;
    uid: string;
  }): Promise<string> {
    return await derivedProviderResourceIncarnationName("ts", identity);
  }

  test("names the offering by the exact current FormRef", () => {
    expect(offering.form).toEqual({
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      definitionVersion: "0.1.0",
      schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
    });
    expect(offering.providedInterfaces.map(({ name }) => name)).toEqual(["edge.objects"]);
    // The Form declares no update, so the offering never claims one.
    expect(offering.capabilities).toEqual(["create", "delete", "import", "observe"]);
  });

  test("creates a bucket under a derived name and reports no tenant name", async () => {
    const { provider, calls } = bucketProvider();
    const ticket = await provider.apply({
      operationId: "op-current-bucket",
      offering,
      identity: MEDIA,
      spec: {},
    });

    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: `r2:${await derivedBucket(MEDIA)}` },
    });
    // The address alone is not the name: a second incarnation of the same
    // address is a different bucket, exactly as the self-host KV store does.
    expect(await derivedBucket(MEDIA)).not.toBe(
      await derivedBucket({ ...MEDIA, uid: "res_media_2" }),
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/client/v4/accounts/acct_1/r2/buckets");
    expect(calls[0]?.body).not.toContain("media");
    expect(calls[0]?.body).not.toContain("org_acme");
  });

  test("observes and deletes by the derived native identity only", async () => {
    const { provider, calls } = bucketProvider();
    const created = await provider.apply({
      operationId: "op-current-bucket-observe",
      offering,
      identity: MEDIA,
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("expected success");
    const nativeId = created.result.nativeId;
    const name = nativeId.slice("r2:".length);

    const observed = await provider.observe({
      offering,
      nativeId,
      identity: MEDIA,
      spec: {},
    });
    expect(observed).toMatchObject({ phase: "succeeded", result: { nativeId } });

    const deleted = await provider.delete({
      operationId: "op-current-bucket-delete",
      offering,
      nativeId,
      identity: MEDIA,
    });
    expect(deleted).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /client/v4/accounts/acct_1/r2/buckets",
      `GET /client/v4/accounts/acct_1/r2/buckets/${name}`,
      `DELETE /client/v4/accounts/acct_1/r2/buckets/${name}`,
    ]);
  });

  test("treats an already-absent bucket as a completed delete", async () => {
    const { provider } = bucketProvider(404, {
      success: false,
      errors: [{ code: 10006, message: "bucket not found" }],
    });
    const deleted = await provider.delete({
      operationId: "op-current-bucket-delete-absent",
      offering,
      nativeId: `r2:ts-${"c".repeat(40)}`,
      identity: MEDIA,
    });
    expect(deleted).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
  });

  test("refuses a create whose derived bucket already exists, and says how to repair it", async () => {
    const { provider, calls } = scriptedBucketProvider(({ method }) =>
      method === "POST"
        ? { status: 400, body: { success: false, errors: [{ message: "already exists" }] } }
        : { status: 200, body: { success: true, errors: [], result: {} } },
    );
    const ticket = await provider.apply({
      operationId: "op-current-bucket-conflict",
      offering,
      identity: MEDIA,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure.message).toContain("import it onto this Resource");
    // Exactly one readback proves the claim; nothing was mutated twice.
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  test("keeps a create refusal that is not an existing bucket as the backend classified it", async () => {
    const { provider } = scriptedBucketProvider(({ method }) =>
      method === "POST"
        ? { status: 400, body: { success: false, errors: [{ message: "bad location" }] } }
        : { status: 404, body: { success: false, errors: [] } },
    );
    const ticket = await provider.apply({
      operationId: "op-current-bucket-invalid",
      offering,
      identity: MEDIA,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
  });

  test("refuses to destroy a bucket R2 still reports as present", async () => {
    const name = await derivedBucket(MEDIA);
    const { provider, calls } = scriptedBucketProvider(({ method }) =>
      method === "DELETE"
        ? { status: 400, body: { success: false, errors: [{ message: "bucket not empty" }] } }
        : { status: 200, body: { success: true, errors: [], result: {} } },
    );
    const ticket = await provider.delete({
      operationId: "op-current-bucket-not-empty",
      offering,
      nativeId: `r2:${name}`,
      identity: MEDIA,
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure.message).toContain("empty it and destroy again");
    expect(calls.map((call) => call.method)).toEqual(["DELETE", "GET"]);
  });

  test("names the exact repair when a create acknowledgement was lost", async () => {
    const { provider, calls } = bucketProvider();
    const ticket = await provider.apply({
      operationId: "op-current-bucket-lost",
      operationMode: "recovery",
      offering,
      identity: MEDIA,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    if (ticket.phase !== "failed") throw new Error("expected failure");
    expect(ticket.failure.message).toContain(
      "import the bucket this Host derives for this Resource address",
    );
    expect(calls).toEqual([]);
  });

  test("refuses a create with no Resource incarnation to derive a bucket from", async () => {
    const { provider, calls } = bucketProvider();
    const ticket = await provider.apply({
      operationId: "op-current-bucket-no-uid",
      offering,
      identity: { ...IDENTITY, name: "media" },
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
  });
});

/**
 * Import is the one lifecycle whose native address comes from the caller. The
 * account credential this adapter holds reaches every object in the operator's
 * Cloudflare account, so adoption is fenced to the object this Host derives for
 * the exact Resource address being imported onto.
 */
describe("import fence on the ordinary-workers backend", () => {
  const bucketForm = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
  );
  const workerForm = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!bucketForm || !workerForm) throw new Error("current Form missing");
  const bucketOffering = objectBucketProviderOffering(bucketForm, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });
  const workerOffering = edgeProviderOffering(workerForm, {
    id: "compute.edge.standard",
    regions: ["global"],
  });
  const VICTIM = {
    tenantRef: "org_victim",
    space: "default",
    name: "media",
    uid: "res_v",
  } as const;
  const ATTACKER = {
    tenantRef: "org_attacker",
    space: "default",
    name: "media",
    uid: "res_a",
  } as const;

  function fenceProvider() {
    const calls: Call[] = [];
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [bucketOffering, workerOffering],
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
        return new Response(JSON.stringify({ success: true, errors: [], result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    return { provider, calls };
  }

  test("refuses the control plane's own bucket before any API call", async () => {
    const { provider, calls } = fenceProvider();
    const ticket = await provider.adopt({
      operationId: "op-import-control-plane",
      offering: bucketOffering,
      nativeId: "r2:takoserver-objects-production",
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
  });

  test("refuses another tenant's derived bucket name before any API call", async () => {
    const { provider, calls } = fenceProvider();
    const victimBucket = await derivedProviderResourceIncarnationName("ts", VICTIM);
    const ticket = await provider.adopt({
      operationId: "op-import-cross-tenant",
      offering: bucketOffering,
      nativeId: `r2:${victimBucket}`,
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
  });

  test("adopts the bucket this Host minted for this exact address", async () => {
    const { provider, calls } = fenceProvider();
    const own = await derivedProviderResourceIncarnationName("ts", ATTACKER);
    const ticket = await provider.adopt({
      operationId: "op-import-own",
      offering: bucketOffering,
      nativeId: `r2:${own}`,
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: `r2:${own}` },
    });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      `GET /client/v4/accounts/acct_1/r2/buckets/${own}`,
    ]);
  });

  test("refuses a native identity of the wrong Cloudflare kind", async () => {
    const { provider, calls } = fenceProvider();
    const own = await derivedProviderResourceIncarnationName("ts", ATTACKER);
    const ticket = await provider.adopt({
      operationId: "op-import-wrong-kind",
      offering: bucketOffering,
      nativeId: `kv:${own}`,
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
  });

  test("fences every kind, not only R2: a foreign script is refused and this Host's own is not", async () => {
    const { provider, calls } = fenceProvider();
    const foreign = await provider.adopt({
      operationId: "op-import-foreign-script",
      offering: workerOffering,
      nativeId: "worker:takoserver-production",
      identity: ATTACKER,
      spec: {},
    });
    expect(foreign).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    const own = await derivedProviderResourceName("tsw", ATTACKER);
    const mine = await provider.adopt({
      operationId: "op-import-own-script",
      offering: workerOffering,
      nativeId: `worker:${own}`,
      identity: ATTACKER,
      spec: {},
    });
    expect(mine).toMatchObject({ phase: "succeeded", result: { nativeId: `worker:${own}` } });
    // ModuleWorker observation is answered from the native identity itself.
    expect(calls).toEqual([]);
  });

  test("refuses a kind whose native name Cloudflare assigns, because none can be recomputed", async () => {
    const { provider, calls } = fenceProvider();
    const kvForm = currentTakoformCandidates().forms.find(
      (candidate) => candidate.identity.formRef.kind === "EdgeKVNamespace",
    );
    if (!kvForm) throw new Error("current EdgeKVNamespace Form missing");
    const ticket = await provider.adopt({
      operationId: "op-import-kv",
      offering: edgeProviderOffering(kvForm, { id: "storage.kv.standard", regions: ["global"] }),
      nativeId: "kv:0123456789abcdef0123456789abcdef",
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
  });

  test("fences adoption recovery on the same derivation", async () => {
    const { provider, calls } = fenceProvider();
    const victimBucket = await derivedProviderResourceIncarnationName("ts", VICTIM);
    const ticket = await provider.recoverAdopt({
      operationId: "op-import-recover",
      offering: bucketOffering,
      nativeId: `r2:${victimBucket}`,
      identity: ATTACKER,
      spec: {},
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(calls).toEqual([]);
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

  test("recovers an already uploaded Version without uploading it again", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const requests: Request[] = [];
    let storedVersion: { id: string; marker: string } | undefined;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
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
    const apply = (operationMode: "initial" | "recovery") =>
      provider.apply({
        operationId: "op-version-commit-retry",
        operationMode,
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: { handlers: ["fetch"], requiredSensitiveVars: [] },
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
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-commit-retry" },
    });
    expect(await apply("recovery")).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-commit-retry" },
    });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
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

  test("keeps an unacknowledged upload indeterminate", async () => {
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
        if (request.method === "GET") {
          return Response.json({ success: true, errors: [], result: { items: [] } });
        }
        uploads += 1;
        return Response.json({ success: true, errors: [], result: {} });
      },
    });
    const ticket = await provider.apply({
      operationId: "op-version-ambiguous-upload",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: [] },
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

  /**
   * ADR 0007: the ordinary-workers backend consumes the materialized
   * edge.objects capability and projects Cloudflare's native R2 binding under
   * the declared name. Everything a caller controls is validated against the
   * Provider Pack's result before the first Cloudflare call.
   */
  describe("portable object Bindings on the ordinary-workers backend", () => {
    const BUCKET_NAME = `ts-${"a".repeat(40)}`;
    const OBJECT_BUCKET_BINDING = {
      apiVersion: "bindings.takoform.com/v1alpha2",
      name: "module-worker.object-bucket",
      version: "1.1.0",
      schemaDigest: "sha256:ff8661459b73a8d229e0915c698afad2aa297b5db90fe5e1693d346a7ae3adfb",
    } as const;
    const MEDIA_DECLARATION = {
      bucketBindings: [
        {
          name: "MEDIA",
          resource: {
            apiVersion: "edge.forms.takoform.com",
            kind: "ObjectBucket",
            name: "media",
          },
        },
      ],
    } as const;

    function objectsProvider() {
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
          calls.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.get("authorization"),
            body: await request.clone().text(),
          });
          return Response.json({
            success: true,
            errors: [],
            result: { id: "version-objects" },
          });
        },
      });
      return { provider, calls, workerOffering, versionOffering };
    }

    function runtimeBinding(overrides: Record<string, unknown> = {}) {
      return {
        name: "MEDIA",
        targetUid: "bucket-uid",
        bindingRef: OBJECT_BUCKET_BINDING,
        material: {
          kind: "takoserver.cloudflare-r2.edge-objects@v1",
          bucketName: BUCKET_NAME,
        },
        ...overrides,
      } as ProviderRuntimeBinding;
    }

    const ACTIVE_BUCKET = {
      nativeId: `r2:${BUCKET_NAME}`,
      offeringId: "storage.object.standard",
      providerPackRef: "cloudflare",
      outputs: { protocol: "s3", bucketName: BUCKET_NAME },
    } as const;

    function bucketRelation(deployment: Parameters<typeof related>[2] = ACTIVE_BUCKET) {
      return related(
        "/bucketBindings/0/resource",
        stored("ObjectBucket", "bucket-uid", {}),
        deployment,
        OBJECT_BUCKET_BINDING,
      );
    }

    function workerRelations(workerOfferingId: string) {
      return [
        related("/worker", stored("ModuleWorker", "worker-uid", {}), {
          nativeId: "worker:script-name",
          offeringId: workerOfferingId,
          providerPackRef: "cloudflare",
          outputs: { scriptName: "script-name" },
        }),
        related(
          "/bundle",
          stored("WorkerBundle", "bundle-uid", {
            manifestDigest: `sha256:${"d".repeat(64)}`,
          }),
        ),
      ];
    }

    test("projects the declared name as a native R2 binding", async () => {
      const { provider, calls, workerOffering, versionOffering } = objectsProvider();
      const ticket = await provider.apply({
        operationId: "op-version-objects",
        operationMode: "initial",
        offering: versionOffering,
        identity: { ...IDENTITY, name: "version" },
        spec: { handlers: ["fetch"], requiredSensitiveVars: [], ...MEDIA_DECLARATION },
        runtimeBindings: [runtimeBinding()],
        relations: [...workerRelations(workerOffering.id), bucketRelation()],
      });

      expect(ticket).toMatchObject({
        phase: "succeeded",
        result: { nativeId: "version:script-name:version-objects" },
      });
      const upload = calls[0]?.body ?? "";
      expect(upload).toContain(
        `{"type":"r2_bucket","name":"MEDIA","bucket_name":"${BUCKET_NAME}"}`,
      );
      // The bucket's public Resource name is never a provider address.
      expect(upload).not.toContain('"media"');
      // Nothing about the bucket reaches the ticket the Host records.
      expect(JSON.stringify(ticket)).not.toContain(BUCKET_NAME);
    });

    const refusals = [
      {
        label: "a declaration the Provider Pack did not materialize",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [] as ProviderRuntimeBinding[],
        relations: () => [bucketRelation()],
      },
      {
        label: "a materialized Binding the version never declared",
        spec: {},
        runtimeBindings: [runtimeBinding()],
        relations: () => [bucketRelation()],
      },
      {
        label: "a declaration name that disagrees with the Binding name",
        spec: {
          bucketBindings: [
            {
              name: "ASSETS",
              resource: {
                apiVersion: "edge.forms.takoform.com",
                kind: "ObjectBucket",
                name: "media",
              },
            },
          ],
        },
        runtimeBindings: [runtimeBinding()],
        relations: () => [bucketRelation()],
      },
      {
        label: "a Binding whose target uid is not the relation's",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [runtimeBinding({ targetUid: "other-uid" })],
        relations: () => [bucketRelation()],
      },
      {
        label: "a foreign Binding identity",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [
          runtimeBinding({
            bindingRef: { ...OBJECT_BUCKET_BINDING, schemaDigest: `sha256:${"f".repeat(64)}` },
          }),
        ],
        relations: () => [bucketRelation()],
      },
      {
        label: "a material this provider did not derive",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [runtimeBinding({ material: { kind: "other@v1", bucketName: "media" } })],
        relations: () => [bucketRelation()],
      },
      {
        label: "a bucket realized under another provider installation",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [runtimeBinding()],
        relations: () => [
          bucketRelation({ ...ACTIVE_BUCKET, providerInstallationRef: "cloudflare.secondary" }),
        ],
      },
      {
        label: "a bucket Deployment that is not active",
        spec: MEDIA_DECLARATION as Record<string, unknown>,
        runtimeBindings: [runtimeBinding()],
        relations: () => [bucketRelation({ ...ACTIVE_BUCKET, state: "draining" })],
      },
      {
        // Cloudflare accepts a metadata list carrying one name twice and keeps
        // whichever it prefers, so two declarations under one name are refused
        // here rather than resolved by the backend's taste.
        label: "a var that shares its name with the bucket Binding",
        spec: { vars: { MEDIA: "plain" }, ...MEDIA_DECLARATION },
        runtimeBindings: [runtimeBinding()],
        relations: () => [bucketRelation()],
      },
      {
        label: "a KV Binding that shares its name with a var",
        spec: {
          vars: { CACHE: "plain" },
          kvBindings: [
            {
              name: "CACHE",
              resource: {
                apiVersion: "edge.forms.takoform.com",
                kind: "EdgeKVNamespace",
                name: "cache",
              },
            },
          ],
          ...MEDIA_DECLARATION,
        },
        runtimeBindings: [runtimeBinding()],
        relations: () => [
          bucketRelation(),
          related("/kvBindings/0/resource", stored("EdgeKVNamespace", "kv-uid", {}), {
            nativeId: "kv:kv-id",
            offeringId: "storage.kv.standard",
            providerPackRef: "cloudflare",
            outputs: { namespaceId: "kv-id" },
          }),
        ],
      },
    ];

    for (const [index, scenario] of refusals.entries()) {
      test(`refuses ${scenario.label} before any Cloudflare call`, async () => {
        const { provider, calls, workerOffering, versionOffering } = objectsProvider();
        const ticket = await provider.apply({
          operationId: `op-version-objects-refusal-${index}`,
          operationMode: "initial",
          offering: versionOffering,
          identity: { ...IDENTITY, name: "version" },
          spec: { handlers: ["fetch"], requiredSensitiveVars: [], ...scenario.spec },
          runtimeBindings: scenario.runtimeBindings,
          relations: [...workerRelations(workerOffering.id), ...scenario.relations()],
        });

        expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
        expect(calls).toEqual([]);
        expect(JSON.stringify(ticket)).not.toContain(BUCKET_NAME);
      });
    }
  });

  test("provisions a fetch-only Worker Version without secret bindings", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let uploadBody = "";
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
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
    const ticket = await provider.apply({
      operationId: "op-version-fetch-only",
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, name: "version" },
      spec: { handlers: ["fetch"], requiredSensitiveVars: [] },
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
    expect(uploadBody).not.toContain('"type":"secret_text"');
  });

  test("refuses sensitive Worker bindings without a runtime-input authority before mutation", async () => {
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
      operationId: "op-version-sensitive-unsupported",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
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
        message: "required sensitive Worker runtime inputs are unavailable",
      },
    });
  });

  test("leases, erases, uploads, and settles exact sensitive Worker bindings", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const events: string[] = [];
    let settledReceipt: string | undefined;
    let uploadedMetadata: { bindings?: Array<Record<string, unknown>> } | undefined;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire(input) {
        events.push("acquire");
        expect(input).toEqual({
          organizationId: "org_acme",
          operationId: "op-version-sensitive",
          resourceUid: "worker-version-uid",
          reference: SENSITIVE_OPERATION_KEY,
          target: {
            space: "default",
            workerName: "moduleworker",
            workerResourceUid: "worker-uid",
            bundleName: "workerbundle",
          },
          bindingNames: ["ENCRYPTION_KEY", "OIDC_CLIENT_SECRET"],
          publicApply: SENSITIVE_PUBLIC_APPLY,
        });
        return {
          bindings: {
            ENCRYPTION_KEY: "secret-encryption-value",
            OIDC_CLIENT_SECRET: "secret-oidc-value",
          },
          preparation: SENSITIVE_PREPARATION,
          async abort() {
            events.push("abort");
          },
          async dispatch() {
            events.push("dispatch");
            return {
              async settle(receiptDigest) {
                events.push("settle");
                settledReceipt = receiptDigest;
              },
            };
          },
        };
      },
      async recover() {
        throw new Error("recovery must not run on a confirmed initial upload");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        events.push("upload");
        expect(events).toEqual(["acquire", "dispatch", "upload"]);
        const form = await request.formData();
        const metadata = form.get("metadata");
        uploadedMetadata = JSON.parse(
          typeof metadata === "string" ? metadata : await (metadata as Blob).text(),
        ) as { bindings?: Array<Record<string, unknown>> };
        return Response.json({ success: true, errors: [], result: { id: "version-sensitive" } });
      },
    });
    expect(provider.runtimeInputCapabilities).toEqual({ maximumBindings: 64 });
    const ticket = await provider.apply({
      operationId: "op-version-sensitive",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, uid: "worker-version-uid", name: "version" },
      spec: {
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY", "OIDC_CLIENT_SECRET"],
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

    expect(events).toEqual(["acquire", "dispatch", "upload", "settle"]);
    const bindings = uploadedMetadata?.bindings ?? [];
    expect(
      bindings
        .filter((binding) => binding.type === "secret_text")
        .map((binding) => binding.name)
        .sort(),
    ).toEqual(["ENCRYPTION_KEY", "OIDC_CLIENT_SECRET"]);
    expect(uploadedMetadata?.bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "ENCRYPTION_KEY", text: "secret-encryption-value" },
        { type: "secret_text", name: "OIDC_CLIENT_SECRET", text: "secret-oidc-value" },
        {
          type: "plain_text",
          name: "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT",
          text: SENSITIVE_PREPARATION.commitment,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
          text: expect.stringMatching(/^tsop-v1:[0-9a-f]{64}$/u),
        },
      ]),
    );
    expect(settledReceipt).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(ticket).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-sensitive" },
    });
    expect(JSON.stringify(ticket)).not.toContain("secret-encryption-value");
    expect(JSON.stringify(ticket)).not.toContain("secret-oidc-value");
  });

  test("settles a dispatched sensitive lease by readback without uploading twice", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let marker = "";
    let commitment = "";
    let uploads = 0;
    let acquires = 0;
    let recoveries = 0;
    let recoveredInput: ProviderRuntimeInputRecoveryInput | undefined;
    let recoveredReceipt: string | undefined;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire(input) {
        acquires += 1;
        expect(input).toEqual({
          organizationId: "org_acme",
          operationId: "op-version-sensitive-recovery",
          resourceUid: "worker-version-recovery-uid",
          reference: SENSITIVE_OPERATION_KEY,
          target: {
            space: "default",
            workerName: "moduleworker",
            workerResourceUid: "worker-uid",
            bundleName: "workerbundle",
          },
          bindingNames: ["ENCRYPTION_KEY"],
          publicApply: SENSITIVE_PUBLIC_APPLY,
        });
        return {
          bindings: { ENCRYPTION_KEY: "secret-lost-ack-value" },
          preparation: SENSITIVE_PREPARATION,
          async abort() {
            throw new Error("the dispatched lease must not be aborted after upload");
          },
          async dispatch() {
            return {
              async settle() {
                throw new Error("a lost upload acknowledgement cannot settle initial dispatch");
              },
            };
          },
        };
      },
      async recover(input) {
        recoveries += 1;
        recoveredInput = input;
        return {
          preparation: SENSITIVE_PREPARATION,
          bindingNames: ["ENCRYPTION_KEY"],
          async settle(receiptDigest) {
            recoveredReceipt = receiptDigest;
          },
        };
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST") {
          uploads += 1;
          const form = await request.formData();
          const metadataPart = form.get("metadata");
          const metadata = JSON.parse(
            typeof metadataPart === "string" ? metadataPart : await (metadataPart as Blob).text(),
          ) as { bindings?: Array<{ name?: string; text?: string; type?: string }> };
          marker =
            metadata.bindings?.find(
              (binding) => binding.name === "TAKOSERVER_INTERNAL_OPERATION_MARKER",
            )?.text ?? "";
          commitment =
            metadata.bindings?.find(
              (binding) => binding.name === "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT",
            )?.text ?? "";
          throw new TypeError("connection closed after provider commit");
        }
        if (request.method === "GET" && url.pathname.endsWith("/versions")) {
          const page = Number(url.searchParams.get("page"));
          return Response.json({
            success: true,
            errors: [],
            result: { items: page === 1 ? [{ id: "version-sensitive-recovered" }] : [] },
            result_info: { page, per_page: 100 },
          });
        }
        if (request.method === "GET" && url.pathname.endsWith("/version-sensitive-recovered")) {
          return Response.json({
            success: true,
            errors: [],
            result: {
              id: "version-sensitive-recovered",
              resources: {
                bindings: [
                  {
                    type: "plain_text",
                    name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                    text: marker,
                  },
                  {
                    type: "plain_text",
                    name: "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT",
                    text: commitment,
                  },
                  { type: "secret_text", name: "ENCRYPTION_KEY" },
                ],
              },
            },
          });
        }
        throw new Error(`unexpected request: ${request.method} ${url.pathname}`);
      },
    });
    const input = {
      operationId: "op-version-sensitive-recovery",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
      offering: versionOffering,
      identity: { ...IDENTITY, uid: "worker-version-recovery-uid", name: "version" },
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
    } as const;

    expect(await provider.apply({ ...input, operationMode: "initial" })).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(await provider.apply({ ...input, operationMode: "recovery" })).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "version:script-name:version-sensitive-recovered" },
    });
    expect(uploads).toBe(1);
    expect(acquires).toBe(1);
    expect(recoveries).toBe(1);
    expect(recoveredInput).toEqual({
      organizationId: "org_acme",
      operationId: "op-version-sensitive-recovery",
      resourceUid: "worker-version-recovery-uid",
      reference: SENSITIVE_OPERATION_KEY,
      target: {
        space: "default",
        workerName: "moduleworker",
        workerResourceUid: "worker-uid",
        bundleName: "workerbundle",
      },
      bindingNames: ["ENCRYPTION_KEY"],
    });
    expect(recoveredReceipt).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("rejects sensitive recovery for every exact secret_text closure mismatch", async () => {
    const operationId = "op-version-sensitive-closure-mismatch";
    const operationDigest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(operationId) as unknown as BufferSource,
      ),
    );
    const operationMarker = `tsop-v1:${[...operationDigest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    const scenarios = [
      { name: "missing expected", bindings: [] },
      {
        name: "extra unexpected",
        bindings: [
          { type: "secret_text", name: "ENCRYPTION_KEY" },
          { type: "secret_text", name: "UNEXPECTED" },
        ],
      },
      {
        name: "duplicate expected",
        bindings: [
          { type: "secret_text", name: "ENCRYPTION_KEY" },
          { type: "secret_text", name: "ENCRYPTION_KEY" },
        ],
      },
      {
        name: "expected name with wrong type",
        bindings: [{ type: "plain_text", name: "ENCRYPTION_KEY", text: "not-a-secret" }],
      },
    ] as const;

    for (const scenario of scenarios) {
      const workerOffering = technical("ModuleWorker");
      const versionOffering = technical("WorkerVersion");
      let posts = 0;
      let settlements = 0;
      let recoveries = 0;
      const runtimeInputs: ProviderRuntimeInputLeasePort = {
        async acquire() {
          throw new Error("sensitive recovery must use recover, not acquire");
        },
        async recover(input) {
          recoveries += 1;
          expect(input).toEqual({
            organizationId: "org_acme",
            operationId,
            resourceUid: "worker-version-closure-uid",
            reference: SENSITIVE_OPERATION_KEY,
            target: {
              space: "default",
              workerName: "moduleworker",
              workerResourceUid: "worker-uid",
              bundleName: "workerbundle",
            },
            bindingNames: ["ENCRYPTION_KEY"],
          });
          return {
            preparation: SENSITIVE_PREPARATION,
            bindingNames: ["ENCRYPTION_KEY"],
            async settle() {
              settlements += 1;
            },
          };
        },
      };
      const provider = new CloudflareProvider({
        accountId: "acct_1",
        offerings: [workerOffering, versionOffering],
        artifacts,
        runtimeInputs,
        authorize: () => "Bearer secret-account-token",
        apiOrigin: "https://api.cloudflare.test/client/v4",
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === "POST") {
            posts += 1;
            throw new Error("sensitive recovery must not upload a second Worker Version");
          }
          if (request.method === "GET" && url.pathname.endsWith("/versions")) {
            const page = Number(url.searchParams.get("page"));
            return Response.json({
              success: true,
              errors: [],
              result: {
                items: page === 1 ? [{ id: "version-sensitive-closure" }] : [],
              },
              result_info: { page, per_page: 100 },
            });
          }
          if (request.method === "GET" && url.pathname.endsWith("/version-sensitive-closure")) {
            return Response.json({
              success: true,
              errors: [],
              result: {
                id: "version-sensitive-closure",
                resources: {
                  bindings: [
                    {
                      type: "plain_text",
                      name: "TAKOSERVER_INTERNAL_OPERATION_MARKER",
                      text: operationMarker,
                    },
                    {
                      type: "plain_text",
                      name: "TAKOSERVER_INTERNAL_RUNTIME_INPUT_COMMITMENT",
                      text: SENSITIVE_PREPARATION.commitment,
                    },
                    ...scenario.bindings,
                  ],
                },
              },
            });
          }
          throw new Error(`unexpected request: ${request.method} ${url.pathname}`);
        },
      });

      const ticket = await provider.apply({
        operationId,
        operationKey: SENSITIVE_OPERATION_KEY,
        publicApply: SENSITIVE_PUBLIC_APPLY,
        operationMode: "recovery",
        offering: versionOffering,
        identity: { ...IDENTITY, uid: "worker-version-closure-uid", name: "version" },
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
        failure: { code: "provider_error", retryable: false },
      });
      expect({ recoveries, posts, settlements }).toEqual({
        recoveries: 1,
        posts: 0,
        settlements: 0,
      });
    }
  });

  test("does not log sensitive values when a Worker Version POST loses its response", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    let posts = 0;
    let dispatches = 0;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire(input) {
        expect(input.reference).toBe(SENSITIVE_OPERATION_KEY);
        return {
          bindings: { ENCRYPTION_KEY: "transport-secret-value" },
          preparation: SENSITIVE_PREPARATION,
          async abort() {},
          async dispatch() {
            dispatches += 1;
            return { async settle() {} };
          },
        };
      },
      async recover() {
        throw new Error("recovery is not part of this transport failure");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        posts += 1;
        expect(request.method).toBe("POST");
        throw new TypeError(
          "connection lost after sending transport-secret-value with Bearer secret-account-token",
        );
      },
    });

    try {
      const ticket = await provider.apply({
        operationId: "op-version-sensitive-transport-error",
        operationKey: SENSITIVE_OPERATION_KEY,
        publicApply: SENSITIVE_PUBLIC_APPLY,
        operationMode: "initial",
        offering: versionOffering,
        identity: { ...IDENTITY, uid: "worker-version-transport-uid", name: "version" },
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
        failure: { code: "unavailable", retryable: true },
      });
      expect({ posts, dispatches }).toEqual({ posts: 1, dispatches: 1 });
      expect(log).toHaveBeenCalledTimes(1);
      const event = String(log.mock.calls[0]?.[0]);
      expect(event).toContain('"event":"takoserver.provider.fetch_failed"');
      expect(event).toContain('"errorName":"TypeError"');
      expect(event).not.toContain("transport-secret-value");
      expect(event).not.toContain("secret-account-token");
    } finally {
      log.mockRestore();
    }
  });

  test("does not log sensitive values from a Worker Version backend refusal", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    let posts = 0;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire() {
        return {
          bindings: { ENCRYPTION_KEY: "backend-secret-value" },
          preparation: SENSITIVE_PREPARATION,
          async abort() {},
          async dispatch() {
            return { async settle() {} };
          },
        };
      },
      async recover() {
        throw new Error("recovery is not part of this backend refusal");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        posts += 1;
        expect(request.method).toBe("POST");
        return Response.json(
          {
            success: false,
            errors: [{ message: "backend saw backend-secret-value" }],
          },
          { status: 500 },
        );
      },
    });

    try {
      const ticket = await provider.apply({
        operationId: "op-version-sensitive-backend-error",
        operationKey: SENSITIVE_OPERATION_KEY,
        publicApply: SENSITIVE_PUBLIC_APPLY,
        operationMode: "initial",
        offering: versionOffering,
        identity: { ...IDENTITY, uid: "worker-version-backend-uid", name: "version" },
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
        failure: { code: "unavailable", retryable: true },
      });
      expect(posts).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      const event = String(log.mock.calls[0]?.[0]);
      expect(event).toContain('"event":"takoserver.provider.refused"');
      expect(event).not.toContain("backend-secret-value");
      expect(event).not.toContain("secret-account-token");
    } finally {
      log.mockRestore();
    }
  });

  test("aborts an invalid sensitive lease before dispatch without a Worker Version POST", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let aborts = 0;
    let dispatches = 0;
    let posts = 0;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire() {
        return {
          bindings: { UNEXPECTED: "must-not-be-uploaded" },
          preparation: SENSITIVE_PREPARATION,
          async abort() {
            aborts += 1;
          },
          async dispatch() {
            dispatches += 1;
            return { async settle() {} };
          },
        };
      },
      async recover() {
        throw new Error("recovery is not part of this pre-dispatch failure");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch() {
        posts += 1;
        throw new Error("the invalid lease must fail before the backend is reached");
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-sensitive-invalid-lease",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
      operationMode: "initial",
      offering: versionOffering,
      identity: { ...IDENTITY, uid: "worker-version-invalid-lease-uid", name: "version" },
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
      failure: { code: "denied", retryable: false },
    });
    expect({ aborts, dispatches, posts }).toEqual({ aborts: 1, dispatches: 0, posts: 0 });
  });

  test("rejects sensitive acquisition before uploading Worker Version assets", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    const providerCalls: string[] = [];
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire(input) {
        expect(input).toEqual({
          organizationId: "org_acme",
          operationId: "op-version-sensitive-assets-acquire-rejected",
          resourceUid: "worker-version-sensitive-assets-acquire-rejected-uid",
          reference: SENSITIVE_OPERATION_KEY,
          target: {
            space: "default",
            workerName: "moduleworker",
            workerResourceUid: "worker-uid",
            bundleName: "workerbundle",
          },
          bindingNames: ["ENCRYPTION_KEY"],
          publicApply: SENSITIVE_PUBLIC_APPLY,
        });
        throw new Error("runtime input authority rejected the lease");
      },
      async recover() {
        throw new Error("recovery is not part of this initial acquisition rejection");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        providerCalls.push(`${request.method} ${new URL(request.url).pathname}`);
        throw new Error("the provider must not be reached after acquisition rejection");
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-sensitive-assets-acquire-rejected",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
      operationMode: "initial",
      offering: versionOffering,
      identity: {
        ...IDENTITY,
        uid: "worker-version-sensitive-assets-acquire-rejected-uid",
        name: "version",
      },
      spec: {
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY"],
        assets: { bundle: ASSET_BUNDLE },
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
        related(
          "/assets/bundle",
          stored("StaticAssetBundle", "assets-bundle-uid", {
            manifestDigest: ASSET_BUNDLE,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "denied", retryable: false },
    });
    expect(providerCalls).toEqual([]);
    expect(providerCalls.filter((call) => call.endsWith("/assets-upload-session"))).toEqual([]);
  });

  test("aborts a sensitive lease when Worker Version asset upload fails before dispatch", async () => {
    const workerOffering = technical("ModuleWorker");
    const versionOffering = technical("WorkerVersion");
    let sessionPosts = 0;
    let assetPosts = 0;
    let versionPosts = 0;
    let aborts = 0;
    let dispatches = 0;
    const runtimeInputs: ProviderRuntimeInputLeasePort = {
      async acquire(input) {
        expect(input).toEqual({
          organizationId: "org_acme",
          operationId: "op-version-sensitive-assets-upload-failure",
          resourceUid: "worker-version-sensitive-assets-upload-failure-uid",
          reference: SENSITIVE_OPERATION_KEY,
          target: {
            space: "default",
            workerName: "moduleworker",
            workerResourceUid: "worker-uid",
            bundleName: "workerbundle",
          },
          bindingNames: ["ENCRYPTION_KEY"],
          publicApply: SENSITIVE_PUBLIC_APPLY,
        });
        return {
          bindings: { ENCRYPTION_KEY: "asset-upload-secret" },
          preparation: SENSITIVE_PREPARATION,
          async abort() {
            aborts += 1;
          },
          async dispatch() {
            dispatches += 1;
            return { async settle() {} };
          },
        };
      },
      async recover() {
        throw new Error("recovery is not part of this initial asset upload failure");
      },
    };
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering, versionOffering],
      artifacts,
      runtimeInputs,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname.endsWith("/assets-upload-session")) {
          sessionPosts += 1;
          return Response.json({
            success: true,
            errors: [],
            result: { jwt: "asset-token", buckets: [["e".repeat(32)]] },
          });
        }
        if (request.method === "POST" && url.pathname.endsWith("/workers/assets/upload")) {
          assetPosts += 1;
          return Response.json(
            { success: false, errors: [{ message: "asset upload failed" }] },
            { status: 500 },
          );
        }
        if (request.method === "POST" && url.pathname.endsWith("/versions")) {
          versionPosts += 1;
          return Response.json({
            success: true,
            errors: [],
            result: { id: "must-not-upload" },
          });
        }
        throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
      },
    });

    const ticket = await provider.apply({
      operationId: "op-version-sensitive-assets-upload-failure",
      operationKey: SENSITIVE_OPERATION_KEY,
      publicApply: SENSITIVE_PUBLIC_APPLY,
      operationMode: "initial",
      offering: versionOffering,
      identity: {
        ...IDENTITY,
        uid: "worker-version-sensitive-assets-upload-failure-uid",
        name: "version",
      },
      spec: {
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY"],
        assets: { bundle: ASSET_BUNDLE },
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
        related(
          "/assets/bundle",
          stored("StaticAssetBundle", "assets-bundle-uid", {
            manifestDigest: ASSET_BUNDLE,
          }),
        ),
      ],
    });

    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect({ sessionPosts, assetPosts, versionPosts, aborts, dispatches }).toEqual({
      sessionPosts: 1,
      assetPosts: 1,
      versionPosts: 0,
      aborts: 1,
      dispatches: 0,
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

  test("proves exact Worker identities absent/present without a mutation", async () => {
    const workerOffering = technical("ModuleWorker");
    const calls: Call[] = [];
    let response: Response = Response.json({
      success: true,
      errors: [],
      result: { id: "script-exact" },
    });
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [workerOffering],
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
        return response;
      },
    });
    const descriptor = provider.createNativeReadbackDescriptor({
      offering: workerOffering,
      nativeId: "worker:script-exact",
      identity: IDENTITY,
    });
    expect(calls).toHaveLength(0);

    const present = await provider.verifyNativeAbsence({
      offering: workerOffering,
      descriptor,
    });
    expect(present).toMatchObject({ outcome: "present", evidence: { kind: "ModuleWorker" } });
    expect(JSON.stringify(present)).not.toContain("script-exact");

    response = new Response("not-json", { status: 200 });
    const malformed = await provider.verifyNativeAbsence({
      offering: workerOffering,
      descriptor,
    });
    expect(malformed).toEqual({ outcome: "unknown", reason: "malformed", retryable: false });

    response = new Response(null, { status: 404 });
    const absent = await provider.verifyNativeAbsence({ offering: workerOffering, descriptor });
    expect(absent).toMatchObject({ outcome: "absent" });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => !call.method.match(/DELETE|PUT|POST/u))).toBe(true);
  });

  test("treats a retained Worker Version as present until its parent is deleted", async () => {
    const versionOffering = technical("WorkerVersion");
    const calls: string[] = [];
    let parentDeleted = false;
    const provider = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [versionOffering],
      artifacts,
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      async fetch(request) {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return parentDeleted
          ? new Response(null, { status: 404 })
          : Response.json({ success: true, errors: [], result: { id: "version-exact" } });
      },
    });
    const descriptor = provider.createNativeReadbackDescriptor({
      offering: versionOffering,
      nativeId: "version:script-exact:version-exact",
      identity: IDENTITY,
    });
    expect(await provider.verifyNativeAbsence({ offering: versionOffering, descriptor })).toEqual({
      outcome: "present",
      evidence: { provider: "cloudflare", kind: "WorkerVersion", state: "present" },
    });
    parentDeleted = true;
    expect(await provider.verifyNativeAbsence({ offering: versionOffering, descriptor })).toEqual({
      outcome: "absent",
      evidence: { provider: "cloudflare", kind: "WorkerVersion", state: "absent" },
    });
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
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
      providerInstallationRef?: string;
      state?: NonNullable<ProviderRelation["deployment"]>["state"];
    },
    bindingRef?: ProviderRelation["bindingRef"],
  ): ProviderRelation {
    return {
      pointer,
      relation: pointer.replace(/\/\d+/gu, "/*"),
      targetUid: resource.metadata.uid,
      resource,
      ...(bindingRef ? { bindingRef } : {}),
      ...(deployment
        ? {
            deployment: {
              tenantId: "org_acme",
              id: `dep_${resource.metadata.uid}`,
              resourceUid: resource.metadata.uid,
              offeringId: deployment.offeringId,
              providerPackRef: deployment.providerPackRef,
              providerInstallationRef: deployment.providerInstallationRef ?? "cloudflare.primary",
              nativeId: deployment.nativeId,
              state: deployment.state ?? "active",
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
