import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { ResourceInventory } from "../src/control.ts";
import { createLedger } from "../src/ledger.ts";
import { createSponsorshipRoutes } from "../src/sponsorship-api.ts";
import type { TakoformHost } from "../src/takoform/types.ts";

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
