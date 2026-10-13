import { expect, test } from "bun:test";
import type { Accounts, ApiKeyScope } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { openApiDocument } from "../src/openapi.ts";
import { type OrgBilling, OrgBillingError } from "../src/org-billing.ts";

const ORG = "org_billing_api_test";
const OTHER_ORG = "org_other";

function fixture() {
  const seen: string[] = [];
  let nextError: OrgBillingError | undefined;
  const actors: Record<string, { organizationId: string; scopes: readonly ApiKeyScope[] }> = {
    writer: { organizationId: ORG, scopes: ["wallet:write"] },
    reader: { organizationId: ORG, scopes: ["wallet:read"] },
    usageWriter: { organizationId: ORG, scopes: ["usage:write"] },
    usageReader: { organizationId: ORG, scopes: ["usage:read"] },
    wrongOrg: { organizationId: OTHER_ORG, scopes: ["wallet:write"] },
  };
  const billing = {
    async wallet(organizationId: string) {
      seen.push(`wallet:${organizationId}`);
      if (nextError) throw nextError;
      return {
        organizationId,
        currency: "USD",
        settledMinor: 0,
        heldMinor: 0,
        availableMinor: 0,
        entries: [],
      };
    },
    async lots(organizationId: string, limit?: number, cursor?: string) {
      seen.push(`lots:${organizationId}:${limit}:${cursor ?? ""}`);
      if (nextError) throw nextError;
      if (limit !== undefined && limit > 100) throw new OrgBillingError("invalid_limit", 400);
      return cursor === "next"
        ? { lots: [{ reference: "lot-2" }], cursor: null }
        : { lots: [{ reference: "lot-1" }], cursor: "next" };
    },
    async hold(input: { reference: string; amountMinor: number }) {
      seen.push(`hold:${input.reference}:${input.amountMinor}`);
      if (nextError) throw nextError;
      return {};
    },
    async readHold(organizationId: string, reference: string) {
      seen.push(`readHold:${organizationId}:${reference}`);
      if (nextError) throw nextError;
      return {};
    },
    async capture(input: { reference: string; amountMinor: number; actualMicros: string }) {
      seen.push(`capture:${input.reference}:${input.amountMinor}:${input.actualMicros}`);
      if (nextError) throw nextError;
      return { status: input.amountMinor === 0 ? "released" : "captured" };
    },
    async release(organizationId: string, reference: string) {
      seen.push(`release:${organizationId}:${reference}`);
      if (nextError) throw nextError;
      return {};
    },
    async usage(input: { reference: string; quantity: string; quantityUnit: string }) {
      seen.push(`usage:${input.reference}:${input.quantityUnit}:${input.quantity}`);
      if (nextError) throw nextError;
      return {};
    },
    async listUsage(organizationId: string, limit?: number, cursor?: string) {
      seen.push(`listUsage:${organizationId}:${limit}:${cursor ?? ""}`);
      if (nextError) throw nextError;
      if (limit !== undefined && limit > 100) throw new OrgBillingError("invalid_limit", 400);
      return cursor === "next"
        ? { usageRecords: [{ reference: "usage-2" }], cursor: null }
        : { usageRecords: [{ reference: "usage-1" }], cursor: "next" };
    },
    async expireDue() {
      return 0;
    },
  } as unknown as OrgBilling;
  const route = createControlRoutes({
    publicOrigin: "https://api.takoserver.test",
    accounts: {
      async authenticate(authorization) {
        const token = authorization?.replace(/^Bearer /u, "");
        const actor = token ? actors[token] : undefined;
        return actor
          ? {
              hostPrincipalId: "service-principal",
              principalId: "service-principal",
              organizationId: actor.organizationId,
              scopes: actor.scopes,
              kind: "api_key" as const,
            }
          : null;
      },
    } as Pick<Accounts, "authenticate"> as Accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {
      async wallet() {
        return {} as never;
      },
    } as never,
    billing,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  async function request(path: string, token: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, "https://api.takoserver.test");
    const response = await route(
      new Request(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      }),
      url,
    );
    if (!response) throw new Error("Organization billing route was not handled");
    return response;
  }
  return {
    request,
    seen,
    setError(code: string, status: number) {
      nextError = new OrgBillingError(code, status);
    },
  };
}

test("Organization and exact scopes are checked before hold body parsing or lookup", async () => {
  const { request, seen } = fixture();
  const malformed = { method: "POST", body: "{" };
  const wrongOrganization = await request(
    `/v1/organizations/${ORG}/wallet/holds`,
    "wrongOrg",
    malformed,
  );
  expect(wrongOrganization.status).toBe(403);
  const missingScope = await request(`/v1/organizations/${ORG}/wallet/holds`, "reader", malformed);
  expect(missingScope.status).toBe(403);
  expect(seen).toEqual([]);
});

test("wallet and usage write scopes do not grant read access", async () => {
  const { request, seen } = fixture();
  expect((await request(`/v1/organizations/${ORG}/wallet`, "writer")).status).toBe(403);
  expect((await request(`/v1/organizations/${ORG}/wallet/lots?limit=bad`, "wrongOrg")).status).toBe(
    403,
  );
  expect((await request(`/v1/organizations/${ORG}/wallet/holds/ref-1`, "writer")).status).toBe(403);
  expect(
    (await request(`/v1/organizations/${ORG}/wallet/usage-records`, "usageWriter")).status,
  ).toBe(403);
  expect(seen).toEqual([]);
});

test("hold request rejects unknown keys and encoded path references cannot escape one component", async () => {
  const { request, seen } = fixture();
  const extraField = await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "run:one",
      amountMinor: 5,
      pricingRevision: "test.1",
      measurementFingerprint: "sha256:test",
      fundingMinor: 100,
    }),
  });
  expect(extraField.status).toBe(400);
  expect((await request(`/v1/organizations/${ORG}/wallet/holds/a%2Fb`, "reader")).status).toBe(400);
  expect(seen).toEqual([]);
});

test("billing lifecycle errors retain their 402 and 409 public statuses", async () => {
  const { request, setError, seen } = fixture();
  const body = {
    reference: "run:one",
    amountMinor: 5,
    pricingRevision: "test.1",
    measurementFingerprint: "sha256:test",
  };
  setError("insufficient_funds", 402);
  expect(
    (
      await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(402);
  setError("capture_exceeds_hold", 409);
  expect(
    (
      await request(`/v1/organizations/${ORG}/wallet/holds/run:one/capture`, "writer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountMinor: 6,
          actualMicros: "60000",
          measurementFingerprint: "sha256:test",
        }),
      })
    ).status,
  ).toBe(409);
  expect(seen).toEqual(["hold:run:one:5", "capture:run:one:6:60000"]);
});

test("zero-cost capture is accepted and returns the service's closed receipt", async () => {
  const { request, seen } = fixture();
  const response = await request(
    `/v1/organizations/${ORG}/wallet/holds/run:zero/capture`,
    "writer",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountMinor: 0,
        actualMicros: "0",
        measurementFingerprint: "measured-zero",
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ hold: { status: "released" } });
  expect(seen).toEqual(["capture:run:zero:0:0"]);
});

test("usage quantity is passed as canonical decimal text and API scope schemas are published", async () => {
  const { request, seen } = fixture();
  const response = await request(`/v1/organizations/${ORG}/wallet/usage-records`, "usageWriter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "storage:hour-1",
      meter: "takosumi.storage.byte-hours",
      quantityUnit: "byte-millisecond",
      quantity: "3600000",
      periodStart: "2026-10-13T10:00:00.000Z",
      periodEnd: "2026-10-13T11:00:00.000Z",
      pricingRevision: "test.1",
      expectedMinor: 1,
      measurementFingerprint: "sha256:test",
    }),
  });
  expect(response.status).toBe(201);
  expect(seen).toEqual(["usage:storage:hour-1:byte-millisecond:3600000"]);
  const paths = openApiDocument.paths as Record<string, Record<string, Record<string, unknown>>>;
  expect(
    paths[`/v1/organizations/{organizationId}/wallet/holds`]?.post?.["x-required-scopes"],
  ).toEqual(["wallet:write"]);
  expect(
    paths[`/v1/organizations/{organizationId}/wallet/usage-records`]?.post?.["x-required-scopes"],
  ).toEqual(["usage:write"]);
  const schemas = openApiDocument.components.schemas as Record<string, unknown>;
  expect(schemas.CreateWalletHoldRequest).toBeDefined();
  expect(schemas.WalletHoldReceipt).toBeDefined();
  expect(schemas.WalletLotsResponse).toBeDefined();
  expect(schemas.CreateWalletUsageRecordRequest).toBeDefined();
  expect(schemas.WalletUsageReceipt).toBeDefined();
  const lotsResponse = schemas.WalletLotsResponse as {
    required: string[];
    properties: {
      lots: { items: { required: string[]; properties: Record<string, unknown> } };
      cursor: unknown;
    };
  };
  expect(lotsResponse.required).toContain("cursor");
  expect(lotsResponse.properties.cursor).toBeDefined();
  const lot = lotsResponse.properties.lots.items;
  expect(lot.required).toContain("remainingMinor");
  expect(lot.required).toContain("availableMinor");
  expect(lot.properties).not.toHaveProperty("allocatedMinor");
  expect(lot.properties.reference).toEqual({ type: "string", minLength: 1 });
  const wallet = schemas.WalletResponse as {
    properties: {
      wallet: {
        properties: {
          entries: { items: { properties: { reference: Record<string, unknown> } } };
        };
      };
    };
  };
  expect(wallet.properties.wallet.properties.entries.items.properties.reference).toEqual({
    type: "string",
    minLength: 1,
  });
  expect(
    (schemas.WalletUsageReceipt as { properties: { meter: { maxLength: number } } }).properties
      .meter.maxLength,
  ).toBe(128);
});

test("wallet lot pagination forwards opaque cursors and returns distinct pages", async () => {
  const { request, seen } = fixture();
  const firstResponse = await request(`/v1/organizations/${ORG}/wallet/lots?limit=1`, "reader");
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as {
    lots: { reference: string }[];
    cursor: string | null;
  };
  expect(first).toEqual({ lots: [{ reference: "lot-1" }], cursor: "next" });

  const secondResponse = await request(
    `/v1/organizations/${ORG}/wallet/lots?limit=1&cursor=${first.cursor}`,
    "reader",
  );
  expect(secondResponse.status).toBe(200);
  const second = (await secondResponse.json()) as {
    lots: { reference: string }[];
    cursor: string | null;
  };
  expect(second).toEqual({ lots: [{ reference: "lot-2" }], cursor: null });
  expect(new Set([...first.lots, ...second.lots].map((lot) => lot.reference)).size).toBe(2);
  expect(seen).toEqual([`lots:${ORG}:1:`, `lots:${ORG}:1:next`]);
});

test("wallet lot route does not clamp a limit above the service ceiling", async () => {
  const { request, seen } = fixture();
  const response = await request(`/v1/organizations/${ORG}/wallet/lots?limit=101`, "reader");
  expect(response.status).toBe(400);
  expect(seen).toEqual([`lots:${ORG}:101:`]);
});

test("usage pagination forwards the opaque cursor and returns a non-overlapping next page", async () => {
  const { request, seen } = fixture();
  const firstResponse = await request(
    `/v1/organizations/${ORG}/wallet/usage-records?limit=1`,
    "usageReader",
  );
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as {
    usageRecords: { reference: string }[];
    cursor: string | null;
  };
  expect(first).toEqual({ usageRecords: [{ reference: "usage-1" }], cursor: "next" });

  const secondResponse = await request(
    `/v1/organizations/${ORG}/wallet/usage-records?limit=1&cursor=${first.cursor}`,
    "usageReader",
  );
  expect(secondResponse.status).toBe(200);
  const second = (await secondResponse.json()) as {
    usageRecords: { reference: string }[];
    cursor: string | null;
  };
  expect(second).toEqual({ usageRecords: [{ reference: "usage-2" }], cursor: null });
  expect(
    new Set([...first.usageRecords, ...second.usageRecords].map((record) => record.reference)).size,
  ).toBe(2);
  expect(seen).toEqual([`listUsage:${ORG}:1:`, `listUsage:${ORG}:1:next`]);
});

test("usage route does not silently clamp a limit that exceeds the billing service ceiling", async () => {
  const { request, seen } = fixture();
  const response = await request(
    `/v1/organizations/${ORG}/wallet/usage-records?limit=101`,
    "usageReader",
  );
  expect(response.status).toBe(400);
  expect(seen).toEqual([`listUsage:${ORG}:101:`]);
});
