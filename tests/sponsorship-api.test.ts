import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { ResourceInventory } from "../src/control.ts";
import { createLedger } from "../src/ledger.ts";
import { createSponsorshipRoutes } from "../src/sponsorship-api.ts";
import type { TakoformHost } from "../src/takoform/types.ts";
import type { TokenService } from "../src/token.ts";

const token = "hosted-sponsorship-service-token";
const base = "https://api.takoserver.test/v1/sponsorship/tenants/tenant_opaque";

describe("Hosted sponsorship owner API", () => {
  test("binds one legal Organization and credits the one wallet with expiry semantics", async () => {
    const sql = createEphemeralSql();
    let now = new Date("2026-08-20T00:00:00.000Z");
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["org_legal", "Legal Organization", "prn_1", now.toISOString()],
    );
    const route = createSponsorshipRoutes({
      sql,
      ledger: createLedger(sql, () => now),
      inventory: emptyInventory(),
      lifecycle: noLifecycle(),
      tokens: fakeTokens(),
      serviceToken: token,
      publicOrigin: "https://api.takoserver.test",
      clock: () => now,
    });

    expect(
      await call(route, "POST", base, { organizationId: "org_legal" }, "wrong-token"),
    ).toMatchObject({ status: 404 });
    expect(await call(route, "POST", base, { organizationId: "org_legal" })).toMatchObject({
      status: 201,
    });
    expect(await call(route, "POST", base, { organizationId: "org_other" })).toMatchObject({
      status: 404,
    });

    const funding = (
      kind: "plan-included" | "purchased",
      reference: string,
      expiresAt: string | null,
    ) =>
      call(route, "POST", `${base}/funding`, {
        tenantRef: "tenant_opaque",
        amountMinor: 1_000,
        currency: "USD",
        kind,
        reference,
        expiresAt,
      });
    expect(
      await funding("plan-included", "included:august", "2026-09-01T00:00:00.000Z"),
    ).toMatchObject({ status: 201 });
    expect(await funding("purchased", "purchase:1", null)).toMatchObject({
      status: 201,
    });
    expect(await funding("plan-included", "included:never", null)).toMatchObject({ status: 400 });
    expect(
      await funding("purchased", "purchase:expires", "2026-09-01T00:00:00.000Z"),
    ).toMatchObject({ status: 400 });
    expect(await json(await call(route, "GET", `${base}/wallet`))).toEqual({
      availableMinor: 2_000,
      currency: "USD",
    });
    now = new Date("2026-09-02T00:00:00.000Z");
    expect(await json(await call(route, "GET", `${base}/wallet`))).toEqual({
      availableMinor: 1_000,
      currency: "USD",
    });
  });

  test("lists only sponsored Resources and deletes through the Takoform lifecycle", async () => {
    const sql = createEphemeralSql();
    const now = new Date("2026-08-20T00:00:00.000Z");
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["org_legal", "Legal Organization", "prn_1", now.toISOString()],
    );
    const lifecycleRequests: Request[] = [];
    const inventory = resourceInventory();
    const lifecycle: TakoformHost = {
      async handle(request) {
        lifecycleRequests.push(request);
        return new Response(null, { status: 204 });
      },
    };
    const route = createSponsorshipRoutes({
      sql,
      ledger: createLedger(sql, () => now),
      inventory,
      lifecycle,
      tokens: fakeTokens(),
      serviceToken: token,
      publicOrigin: "https://api.takoserver.test",
      clock: () => now,
    });
    await call(route, "POST", base, { organizationId: "org_legal" });
    await call(route, "PUT", `${base}/resources/res_sponsored`, {
      billingMode: "sponsored",
    });
    await call(route, "PUT", `${base}/resources/res_direct`, {
      billingMode: "direct",
    });
    expect(await json(await call(route, "GET", `${base}/resources`))).toEqual({
      resources: [{ resourceId: "res_sponsored" }],
    });

    const firstInventory = (await json(await call(route, "GET", `${base}/inventory?limit=1`))) as {
      readonly items: readonly unknown[];
      readonly nextCursor?: string;
    };
    expect(firstInventory.items).toEqual([
      {
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "ObjectBucket",
        name: "res_direct",
        formRef: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
        uid: "res_direct",
        generation: "3",
        revision: "7",
        conditions: [],
      },
    ]);
    expect(firstInventory.nextCursor).toBeString();
    expect(
      await json(
        await call(
          route,
          "GET",
          `${base}/inventory?limit=1&cursor=${encodeURIComponent(firstInventory.nextCursor ?? "")}`,
        ),
      ),
    ).toEqual({
      items: [
        {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ObjectBucket",
          name: "res_sponsored",
          formRef: {
            apiVersion: "edge.forms.takoform.com/v1beta1",
            kind: "ObjectBucket",
            definitionVersion: "0.1.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
          uid: "res_sponsored",
          generation: "3",
          revision: "7",
          conditions: [],
        },
      ],
    });

    const removed = await call(route, "DELETE", `${base}/resources/res_sponsored`);
    expect(removed.status).toBe(204);
    expect(lifecycleRequests).toHaveLength(1);
    expect(lifecycleRequests[0]?.method).toBe("DELETE");
    expect(lifecycleRequests[0]?.headers.get("if-match")).toBe('"7"');
    expect(lifecycleRequests[0]?.headers.get("takoform-expected-generation")).toBe("3");
    expect(await json(await call(route, "GET", `${base}/resources`))).toEqual({
      resources: [],
    });

    expect(await call(route, "DELETE", `${base}/resources/res_direct`)).toMatchObject({
      status: 404,
    });
  });

  test("issues one short-lived multi-Resource credential without runtime materialization authority", async () => {
    const sql = createEphemeralSql();
    const now = new Date("2026-08-20T00:00:00.000Z");
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["org_legal", "Legal Organization", "prn_1", now.toISOString()],
    );
    const issued: unknown[] = [];
    const tokens = fakeTokens({
      async issueTakoformTenantRunToken(input) {
        issued.push(input);
        return {
          token: "runner-only-secret",
          expiresAt: "2026-08-20T00:05:00.000Z",
        };
      },
    });
    const route = createSponsorshipRoutes({
      sql,
      ledger: createLedger(sql, () => now),
      inventory: emptyInventory(),
      lifecycle: noLifecycle(),
      tokens,
      serviceToken: token,
      publicOrigin: "https://api.takoserver.test",
      clock: () => now,
    });
    await call(route, "POST", base, { organizationId: "org_legal" });
    const response = await call(route, "POST", `${base}/takoform-run-credentials`, {
      runRef: "run_host_1",
      spaceRef: "tsp_capsule_yurucommu",
      expiresInSeconds: 300,
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({
      takoformRunCredential: {
        token: "runner-only-secret",
        expiresAt: "2026-08-20T00:05:00.000Z",
      },
    });
    expect(issued).toEqual([
      {
        organizationId: "org_legal",
        tenantRef: "tenant_opaque",
        spaceRef: "tsp_capsule_yurucommu",
        runRef: "run_host_1",
        ttlSeconds: 300,
      },
    ]);
    expect(
      await call(route, "POST", `${base}/takoform-run-credentials`, {
        runRef: "run_legacy_materialization",
        spaceRef: "tsp_capsule_yurucommu",
        expiresInSeconds: 300,
        runtimeMaterialization: { kind: "retired" },
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call(route, "POST", `${base}/takoform-run-credentials`, {
        runRef: "run_host_2",
        spaceRef: "tsp_capsule_yurucommu",
        expiresInSeconds: 601,
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call(route, "POST", `${base}/takoform-run-credentials`, {
        runRef: "run_missing_space",
        expiresInSeconds: 300,
      }),
    ).toMatchObject({ status: 400 });
    expect(issued).toHaveLength(1);
  });

  test("authorizes only an active WorkerEndpoint in the exact opaque Capsule space", async () => {
    const sql = createEphemeralSql();
    const now = new Date("2026-08-20T00:00:00.000Z");
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["org_legal", "Legal Organization", "prn_1", now.toISOString()],
    );
    const route = createSponsorshipRoutes({
      sql,
      ledger: createLedger(sql, () => now),
      inventory: emptyInventory(),
      lifecycle: noLifecycle(),
      tokens: fakeTokens(),
      serviceToken: token,
      publicOrigin: "https://api.takoserver.test",
      clock: () => now,
    });
    await call(route, "POST", base, { organizationId: "org_legal" });
    await sql.run(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, updated_at, relations_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "org_legal",
        "tsp_capsule_yurucommu",
        "edge.forms.takoform.com/v1beta1",
        "WorkerEndpoint",
        "endpoint",
        "tfres_endpoint",
        "1",
        "1",
        JSON.stringify({}),
        now.getTime(),
        JSON.stringify([]),
      ],
    );
    await sql.run(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, state, observed_json, outputs_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "org_legal",
        "dep_endpoint",
        "tfres_endpoint",
        "compute.worker.endpoint.standard",
        "cloudflare",
        "cloudflare.primary",
        "endpoint:worker",
        "active",
        JSON.stringify({ enabled: true }),
        JSON.stringify({
          hostname: "storage.example.test",
          url: "https://storage.example.test/",
        }),
        now.getTime(),
        now.getTime(),
      ],
    );

    expect(
      await json(
        await call(route, "POST", `${base}/interface-oauth-resources/authorize`, {
          spaceRef: "tsp_capsule_yurucommu",
          resource: "https://storage.example.test/mcp",
        }),
      ),
    ).toEqual({ authorized: true });
    expect(
      await json(
        await call(route, "POST", `${base}/interface-oauth-resources/authorize`, {
          spaceRef: "tsp_other_capsule",
          resource: "https://storage.example.test/mcp",
        }),
      ),
    ).toEqual({ authorized: false });
    expect(
      await json(
        await call(route, "POST", `${base}/interface-oauth-resources/authorize`, {
          spaceRef: "tsp_capsule_yurucommu",
          resource: "https://attacker.example.test/mcp",
        }),
      ),
    ).toEqual({ authorized: false });
  });
});

async function call(
  route: ReturnType<typeof createSponsorshipRoutes>,
  method: string,
  url: string,
  body?: unknown,
  bearer = token,
): Promise<Response> {
  const request = new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await route(request, new URL(url))) ?? new Response(null, { status: 599 });
}

async function json(response: Response): Promise<unknown> {
  return await response.json();
}

function emptyInventory(): ResourceInventory {
  return {
    async listResources() {
      return { resources: [], cursor: null };
    },
    async resourceByUid() {
      return null;
    },
    async listOperations() {
      return [];
    },
  };
}

function resourceInventory(): ResourceInventory {
  const listing = (uid: string) => ({
    space: "hosted-space",
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    name: uid,
    uid,
    generation: "3",
    revision: "7",
    updatedAt: "2026-08-20T00:00:00.000Z",
    resource: {
      apiVersion: "edge.forms.takoform.com/v1beta1",
      kind: "ObjectBucket",
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
        },
      },
      metadata: {
        name: uid,
        space: "hosted-space",
        uid,
        generation: "3",
        revision: "7",
      },
      spec: {},
      status: { observedGeneration: "3", conditions: [] },
    },
  });
  return {
    async listResources() {
      return {
        resources: [listing("res_sponsored"), listing("res_direct")],
        cursor: null,
      };
    },
    async resourceByUid(_tenantId, uid) {
      return uid === "res_sponsored" || uid === "res_direct" ? listing(uid) : null;
    },
    async listOperations() {
      return [];
    },
  };
}

function noLifecycle(): TakoformHost {
  return {
    async handle() {
      return null;
    },
  };
}

function fakeTokens(overrides: Partial<TokenService> = {}): TokenService {
  const unavailable = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    issueProvisionToken: unavailable,
    verifyProvisionToken: unavailable,
    consumeProvisionToken: unavailable,
    issueTakoformRunToken: unavailable,
    issueTakoformTenantRunToken: unavailable,
    verifyTakoformTenantRunToken: unavailable,
    verifyTakoformRunToken: unavailable,
    claimTakoformRunTokenForCreate: unavailable,
    ...overrides,
  } as TokenService;
}
