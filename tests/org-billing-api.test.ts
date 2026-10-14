import { expect, test } from "bun:test";
import type { Accounts, ApiKeyScope } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { HOST_ERROR_HTTP_STATUS, STABLE_ERROR_HTTP_STATUS } from "../src/error-envelope.ts";
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
    wrongOrg: { organizationId: OTHER_ORG, scopes: ["wallet:read", "wallet:write"] },
  };
  const billing = {
    async wallet(organizationId: string) {
      seen.push(`wallet:${organizationId}`);
      if (nextError) throw nextError;
      return {
        organizationId,
        currency: "USD",
        settledMicros: 0,
        heldMicros: 0,
        availableMicros: 0,
        entries: [],
      };
    },
    async usageSummary(organizationId: string) {
      seen.push(`usageSummary:${organizationId}`);
      if (nextError) throw nextError;
      return {
        organizationId,
        currency: "USD",
        unit: "USD-micros",
        periodKind: "free",
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-11-01T00:00:00.000Z",
        nextResetAt: "2026-11-01T00:00:00.000Z",
        originalIncludedMicros: 1_500_000,
        effectiveIncludedMicros: 1_500_000,
        usedMicros: 0,
        heldMicros: 0,
        availableMicros: 1_500_000,
        revokedMicros: 0,
        utilizationBasisPoints: 0,
        reached80Percent: false,
        reached95Percent: false,
        limitReached: false,
        purchasedAvailableMicros: 0,
        directAvailableMicros: 0,
      };
    },
    async lots(organizationId: string, limit?: number, cursor?: string) {
      seen.push(`lots:${organizationId}:${limit}:${cursor ?? ""}`);
      if (nextError) throw nextError;
      if (limit !== undefined && limit > 100) throw new OrgBillingError("invalid_limit", 400);
      return cursor === "next"
        ? { lots: [fakeLot("lot-2")], cursor: null }
        : { lots: [fakeLot("lot-1")], cursor: "next" };
    },
    async hold(input: { reference: string; amountMicros: number }) {
      seen.push(`hold:${input.reference}:${input.amountMicros}`);
      if (nextError) throw nextError;
      return fakeHold(input.reference, input.amountMicros);
    },
    async readHold(organizationId: string, reference: string) {
      seen.push(`readHold:${organizationId}:${reference}`);
      if (nextError) throw nextError;
      return fakeHold(reference, 0);
    },
    async capture(input: { reference: string; amountMicros: number; actualMicros: string }) {
      seen.push(`capture:${input.reference}:${input.amountMicros}:${input.actualMicros}`);
      if (nextError) throw nextError;
      return fakeHold(
        input.reference,
        input.amountMicros,
        input.amountMicros === 0 ? "released" : "captured",
      );
    },
    async release(organizationId: string, reference: string) {
      seen.push(`release:${organizationId}:${reference}`);
      if (nextError) throw nextError;
      return fakeHold(reference, 0, "released");
    },
    async usage(input: { reference: string; quantity: string; quantityUnit: string }) {
      seen.push(`usage:${input.reference}:${input.quantityUnit}:${input.quantity}`);
      if (nextError) throw nextError;
      return fakeUsage(input.reference, 0);
    },
    async listUsage(organizationId: string, limit?: number, cursor?: string) {
      seen.push(`listUsage:${organizationId}:${limit}:${cursor ?? ""}`);
      if (nextError) throw nextError;
      if (limit !== undefined && limit > 100) throw new OrgBillingError("invalid_limit", 400);
      return cursor === "next"
        ? { usageRecords: [fakeUsage("usage-2", 0)], cursor: null }
        : { usageRecords: [fakeUsage("usage-1", 0)], cursor: "next" };
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

function fakeLot(reference: string) {
  return {
    reference,
    kind: "purchased" as const,
    consumptionClass: "purchased" as const,
    amountMicros: 0,
    spentMicros: 0,
    remainingMicros: 0,
    heldMicros: 0,
    availableMicros: 0,
    expiresAt: null,
    createdAt: "2026-10-13T00:00:00.000Z",
  };
}

function fakeHold(
  reference: string,
  amountMicros: number,
  status: "live" | "captured" | "released" = "live",
) {
  return {
    organizationId: ORG,
    reference,
    moneyPolicy: "usd-micros-v2" as const,
    amountMicros,
    pricingRevision: "test.1",
    status,
    capturedMicros: status === "captured" ? amountMicros : 0,
    releasedMicros: status === "released" ? amountMicros : 0,
    actualMicros: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    expiresAt: null,
    closedAt: null,
  };
}

function fakeUsage(reference: string, amountMicros: number) {
  return {
    organizationId: ORG,
    reference,
    moneyPolicy: "usd-micros-v2" as const,
    pricingRevision: "test.1",
    meter: "requests",
    quantity: "0",
    quantityUnit: "request",
    periodStart: "2026-10-12T00:00:00.000Z",
    periodEnd: "2026-10-12T01:00:00.000Z",
    rate: { numeratorMicros: "0", denominator: "1" },
    amountMicros,
    status: "paid" as const,
    createdAt: "2026-10-13T00:00:00.000Z",
    paidAt: "2026-10-13T00:00:00.000Z",
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
  expect((await request(`/v1/organizations/${ORG}/wallet/usage-summary`, "writer")).status).toBe(
    403,
  );
  expect((await request(`/v1/organizations/${ORG}/wallet/usage-summary`, "wrongOrg")).status).toBe(
    403,
  );
  expect((await request(`/v1/organizations/${ORG}/wallet/lots?limit=bad`, "wrongOrg")).status).toBe(
    403,
  );
  expect((await request(`/v1/organizations/${ORG}/wallet/holds/ref-1`, "writer")).status).toBe(403);
  expect(
    (await request(`/v1/organizations/${ORG}/wallet/usage-records`, "usageWriter")).status,
  ).toBe(403);
  expect(seen).toEqual([]);
});

test("usage summary serves only wallet:read for the same Organization", async () => {
  const { request, seen } = fixture();
  const response = await request(`/v1/organizations/${ORG}/wallet/usage-summary`, "reader");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    usageSummary: { organizationId: ORG, unit: "USD-micros", effectiveIncludedMicros: "1500000" },
  });
  expect(seen).toEqual([`usageSummary:${ORG}`]);
});

test("hold request rejects unknown keys and encoded path references cannot escape one component", async () => {
  const { request, seen } = fixture();
  const extraField = await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "run:one",
      amountMicros: "5",
      pricingRevision: "test.1",
      measurementFingerprint: "sha256:test",
      fundingMinor: 100,
    }),
  });
  expect(extraField.status).toBe(400);
  const legacyCents = await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "run:one",
      amountMinor: 5,
      pricingRevision: "test.1",
      measurementFingerprint: "sha256:test",
    }),
  });
  expect(legacyCents.status).toBe(400);
  expect((await request(`/v1/organizations/${ORG}/wallet/holds/a%2Fb`, "reader")).status).toBe(400);
  expect(seen).toEqual([]);
});

test("wallet money is published as canonical USD-micros decimal strings", async () => {
  const { request } = fixture();
  const walletResponse = await request(`/v1/organizations/${ORG}/wallet`, "reader");
  expect(await walletResponse.json()).toMatchObject({
    wallet: {
      currency: "USD",
      unit: "USD-micros",
      moneyPolicy: "usd-micros-v2",
      settledMicros: "0",
      heldMicros: "0",
      availableMicros: "0",
    },
  });
  const holdResponse = await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "run:wire",
      amountMicros: "5",
      pricingRevision: "test.1",
      measurementFingerprint: "sha256:test",
    }),
  });
  expect(holdResponse.status).toBe(201);
  expect(await holdResponse.json()).toMatchObject({
    hold: { moneyPolicy: "usd-micros-v2", amountMicros: "5", capturedMicros: "0" },
  });
  const numericMicros = await request(`/v1/organizations/${ORG}/wallet/holds`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "run:numeric",
      amountMicros: 5,
      pricingRevision: "test.1",
      measurementFingerprint: "sha256:test",
    }),
  });
  expect(numericMicros.status).toBe(400);
});

test("billing lifecycle errors retain their 402 and 409 public statuses", async () => {
  const { request, setError, seen } = fixture();
  const body = {
    reference: "run:one",
    amountMicros: "5",
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
          amountMicros: "6",
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
        amountMicros: "0",
        actualMicros: "0",
        measurementFingerprint: "measured-zero",
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ hold: { status: "released" } });
  expect(seen).toEqual(["capture:run:zero:0:0"]);
});

test("hold release accepts an empty body whether the runtime presents it as null or as a stream", async () => {
  const { request, seen } = fixture();
  // Bun presents a bodiless POST as `body === null`; workerd presents every
  // POST, bodiless or not, as a stream. All of these are the documented
  // "no request body" and must release.
  const bodies: Record<string, () => RequestInit> = {
    absent: () => ({ method: "POST" }),
    "empty string": () => ({ method: "POST", body: "" }),
    "empty stream": () => ({
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    }),
    "empty chunk then end": () => ({
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(0));
          controller.close();
        },
      }),
    }),
    "declared zero": () => ({ method: "POST", headers: { "content-length": "0" }, body: "" }),
  };
  for (const [name, init] of Object.entries(bodies)) {
    const reference = `run:${name.replaceAll(" ", "-")}`;
    const response = await request(
      `/v1/organizations/${ORG}/wallet/holds/${reference}/release`,
      "writer",
      init(),
    );
    expect({ name, status: response.status }).toEqual({ name, status: 200 });
    expect(await response.json()).toEqual({
      hold: {
        ...fakeHold(reference, 0, "released"),
        amountMicros: "0",
        capturedMicros: "0",
        releasedMicros: "0",
      },
    });
  }
  expect(seen).toEqual(
    Object.keys(bodies).map((name) => `release:${ORG}:run:${name.replaceAll(" ", "-")}`),
  );
});

test("hold release refuses any request byte before releasing and never buffers a long body", async () => {
  const { request, seen } = fixture();
  const json = await request(`/v1/organizations/${ORG}/wallet/holds/run:json/release`, "writer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(json.status).toBe(400);
  expect(((await json.json()) as { error: { code: string } }).error.code).toBe("invalid_argument");
  const declared = await request(
    `/v1/organizations/${ORG}/wallet/holds/run:declared/release`,
    "writer",
    { method: "POST", headers: { "content-length": "1" }, body: "x" },
  );
  expect(declared.status).toBe(400);

  // 4 MiB with no declared length: the route must stop at the first byte.
  let pulls = 0;
  let cancelled = false;
  const long = await request(`/v1/organizations/${ORG}/wallet/holds/run:long/release`, "writer", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1_024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  expect(long.status).toBe(400);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(2);
  expect(seen).toEqual([]);
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
      expectedMicros: "1",
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
  expect(schemas.WalletUsageSummaryResponse).toBeDefined();
  expect(
    paths[`/v1/organizations/{organizationId}/wallet/usage-summary`]?.get?.["x-required-scopes"],
  ).toEqual(["wallet:read"]);
  expect(schemas.CreateWalletUsageRecordRequest).toBeDefined();
  expect(schemas.WalletUsageReceipt).toBeDefined();
  const holdRequest = schemas.CreateWalletHoldRequest as {
    required: string[];
    properties: Record<string, unknown>;
  };
  expect(holdRequest.required).toContain("amountMicros");
  expect(holdRequest.required).not.toContain("amountMinor");
  const walletResponse = schemas.WalletResponse as {
    properties: { wallet: { properties: Record<string, unknown> } };
  };
  expect(walletResponse.properties.wallet.properties).toMatchObject({
    currency: { const: "USD" },
    unit: { const: "USD-micros" },
    moneyPolicy: { const: "usd-micros-v2" },
  });
  expect(schemas.AiModelsResponse).toBeDefined();
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
  expect(lot.required).toContain("remainingMicros");
  expect(lot.required).toContain("availableMicros");
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

test("published wallet refusals name each billing code under the status it is answered with", () => {
  const prefix = "/v1/organizations/{organizationId}/wallet";
  const paths = openApiDocument.paths as Record<
    string,
    Record<string, { readonly responses?: Record<string, { readonly description: string }> }>
  >;
  const named = (description: string) =>
    [...description.matchAll(/`([a-z0-9_]+)`/gu)].map((match) => match[1] ?? "");
  const responses = (path: string, method: string) =>
    paths[`${prefix}${path}`]?.[method]?.responses;
  const codes = (path: string, method: string, status: string) =>
    named(responses(path, method)?.[status]?.description ?? "");

  // Staging main-c048: a mismatched expectedMinor is a 409, never a 400.
  expect(codes("/usage-records", "post", "409")).toEqual([
    "measurement_conflict",
    "reference_conflict",
    "pricing_revision_unavailable",
    "usage_period_crosses_tariff",
  ]);
  expect(responses("/usage-records", "post")?.["400"]?.description).not.toMatch(/tariff|match/u);
  expect(codes("/holds/{reference}/capture", "post", "409")).toEqual([
    "hold_closed",
    "capture_exceeds_hold",
    "measurement_conflict",
    "reference_conflict",
  ]);
  expect(codes("/holds", "post", "409")).toEqual([
    "reference_conflict",
    "pricing_revision_unavailable",
    "outstanding_usage",
  ]);
  expect(responses("/holds/{reference}", "get")).not.toHaveProperty("409");

  let checked = 0;
  for (const [path, item] of Object.entries(paths)) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    for (const operation of Object.values(item)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const code of named(response.description)) {
          const declared = HOST_ERROR_HTTP_STATUS[code] ?? [STABLE_ERROR_HTTP_STATUS[code]];
          expect({ code, statuses: declared }).toEqual({
            code,
            statuses: expect.arrayContaining([Number(status)]),
          });
          checked++;
        }
      }
    }
  }
  expect(checked).toBe(11);
});

test("wallet lot pagination forwards opaque cursors and returns distinct pages", async () => {
  const { request, seen } = fixture();
  const firstResponse = await request(`/v1/organizations/${ORG}/wallet/lots?limit=1`, "reader");
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as {
    lots: { reference: string }[];
    cursor: string | null;
  };
  expect(first.lots.map((lot) => lot.reference)).toEqual(["lot-1"]);
  expect(first.lots[0]).toMatchObject({ amountMicros: "0", consumptionClass: "purchased" });
  expect(first.cursor).toBe("next");

  const secondResponse = await request(
    `/v1/organizations/${ORG}/wallet/lots?limit=1&cursor=${first.cursor}`,
    "reader",
  );
  expect(secondResponse.status).toBe(200);
  const second = (await secondResponse.json()) as {
    lots: { reference: string }[];
    cursor: string | null;
  };
  expect(second.lots.map((lot) => lot.reference)).toEqual(["lot-2"]);
  expect(second.cursor).toBeNull();
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
  expect(first.usageRecords.map((record) => record.reference)).toEqual(["usage-1"]);
  expect(first.usageRecords[0]).toMatchObject({ amountMicros: "0", moneyPolicy: "usd-micros-v2" });
  expect(first.cursor).toBe("next");

  const secondResponse = await request(
    `/v1/organizations/${ORG}/wallet/usage-records?limit=1&cursor=${first.cursor}`,
    "usageReader",
  );
  expect(secondResponse.status).toBe(200);
  const second = (await secondResponse.json()) as {
    usageRecords: { reference: string }[];
    cursor: string | null;
  };
  expect(second.usageRecords.map((record) => record.reference)).toEqual(["usage-2"]);
  expect(second.cursor).toBeNull();
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
